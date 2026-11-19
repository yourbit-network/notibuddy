// Screen template resolution, attestation, refresh-on-send, registration, and settlement verification.

import { sha256, toHex } from './crypto.js';
import { DeadlineError, RelayHTTPError, relayJSON, type CallOptions } from './client-http.js';
import { normalizeRelay } from './relay-url.js';
import { canonJson, isPlainObject, type ScreenCanonValue } from './screen-canon.js';
import {
  getScreenCatalogBySlug,
  getScreenCatalogByTemplateId,
  type ScreenSignedTemplateRecord,
  type ScreenTaPublicKey,
} from './screen-catalog.js';
import { evaluateScreenPredicates, validateScreenForm } from './screen-form.js';
import {
  serializeTemplateRecord,
  verifySignedTemplateRecord,
} from './screen-record.js';
import {
  SKELETONIZER_VERSION,
  assertBindingSchemaCompatible,
  rehydrateScreenFeedback,
  rehydrateSuggestedTemplate,
  skeletonizeScreenTemplate,
  type ScreenFeedbackItem,
  type ScreenOrdinalMap,
} from './screen-skeletonizer.js';
import {
  ScreenTemplateStore,
  needsTemplateRefresh,
  relayOriginOf,
  type CachedScreenTemplateEntry,
} from './screen-store.js';
import {
  isValidTemplateId,
  type ScreenDataValue,
  type ScreenSkeleton,
  type ScreenTemplateId,
  type ScreenThread,
} from './screen-types.js';
import { validateScreenSkeleton, verifyScreenAnswer } from './screen-wire.js';
import type { AnswerPayload, NotiBuddyConfig } from './types.js';

export const MAX_PUBLIC_TEMPLATE_BYTES = 98_304;

export interface ScreenAskInput {
  templateId?: string;
  template?: Record<string, unknown>;
  labels?: Record<string, string>;
  data?: Record<string, ScreenDataValue>;
  thread?: ScreenThread;
  mode?: 'auto' | 'strict';
}

export interface ScreenRuntimeOptions {
  now?: () => number;
  resolveTaPublicKey?: (kid: string) => ScreenTaPublicKey | undefined;
}

export interface PendingScreenContext {
  templateId: ScreenTemplateId;
  contextDigest: string;
  skeleton: ScreenSkeleton;
  checklistCounts: Record<string, number>;
  pickerOptionCounts: Record<string, number>;
  sensitive?: boolean;
  requiresAuth?: boolean;
}

export function parseScreenAskInput(value: unknown): ScreenAskInput {
  if (!isPlainObject(value)) {
    throw new Error('Invalid screen: must be a JSON object');
  }
  const allowed = new Set(['templateId', 'template', 'labels', 'data', 'thread', 'mode']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid screen: unexpected property "${key}"`);
    }
  }
  const hasTemplateId = value.templateId !== undefined;
  const hasTemplate = value.template !== undefined;
  if (hasTemplateId === hasTemplate) {
    throw new Error('Invalid screen: provide exactly one of templateId or template');
  }
  const out: ScreenAskInput = {};
  if (hasTemplateId) {
    if (typeof value.templateId !== 'string' || value.templateId.trim().length === 0) {
      throw new Error('Invalid screen.templateId: must be a non-empty template ID or catalog slug');
    }
    if (value.mode !== undefined) {
      throw new Error('Invalid screen.mode: mode is only supported with inline template');
    }
    out.templateId = value.templateId;
  }
  if (hasTemplate) {
    if (!isPlainObject(value.template)) {
      throw new Error('Invalid screen.template: must be a template object');
    }
    out.template = value.template;
  }
  if (value.labels !== undefined) {
    if (!isPlainObject(value.labels)) {
      throw new Error('Invalid screen.labels: must be a string map');
    }
    for (const [k, v] of Object.entries(value.labels)) {
      if (typeof v !== 'string') {
        throw new Error(`Invalid screen.labels.${k}: must be a string`);
      }
    }
    out.labels = value.labels as Record<string, string>;
  }
  if (value.data !== undefined) {
    if (!isPlainObject(value.data)) {
      throw new Error('Invalid screen.data: must be an object');
    }
    out.data = value.data as Record<string, ScreenDataValue>;
  }
  if (value.thread !== undefined) {
    if (!isPlainObject(value.thread)) {
      throw new Error('Invalid screen.thread: must be an object');
    }
    out.thread = value.thread as unknown as ScreenThread;
  }
  if (value.mode !== undefined) {
    if (value.mode !== 'auto' && value.mode !== 'strict') {
      throw new Error('Invalid screen.mode: must be "auto" or "strict"');
    }
    out.mode = value.mode;
  }
  return out;
}

export class ScreenTemplateVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenTemplateVerificationError';
  }
}

/**
 * Unauthenticated public `GET /templates/:templateId`.
 * Sends zero `Authorization` or `X-Sender-*` headers and verifies the returned signed record.
 */
export async function fetchPublicTemplateRecord(
  relayUrl: string,
  templateId: ScreenTemplateId,
  options: CallOptions = {},
  runtime: ScreenRuntimeOptions = {}
): Promise<{ status: 200; record: ScreenSignedTemplateRecord } | { status: 404 }> {
  if (!isValidTemplateId(templateId)) {
    throw new ScreenTemplateVerificationError('Invalid templateId');
  }
  const remaining = Math.min(15_000, (options.deadline ?? Date.now() + 15_000) - Date.now());
  if (remaining <= 0) throw new DeadlineError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineError()), remaining);
  const onAbort = () =>
    controller.abort(options.signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
  if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  }
  const signal = controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onSignalAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onSignalAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onSignalAbort, { once: true });
  });
  void aborted.catch(() => {});

  try {
    signal.throwIfAborted();
    const url = `${normalizeRelay(relayUrl)}/templates/${templateId}`;
    const response = await Promise.race([
      fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
        redirect: 'error',
      }),
      aborted,
    ]);
    if (response.status === 404) {
      return { status: 404 };
    }
    if (!response.ok) {
      throw new RelayHTTPError(response.status);
    }
    if (Number(response.headers.get('content-length')) > MAX_PUBLIC_TEMPLATE_BYTES) {
      throw new ScreenTemplateVerificationError('Public template record exceeds maximum byte size');
    }
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        size += value.length;
        if (size > MAX_PUBLIC_TEMPLATE_BYTES) {
          throw new ScreenTemplateVerificationError('Public template record exceeds maximum byte size');
        }
        chunks.push(value);
      }
    }
    let parsed: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      parsed = JSON.parse(text);
    } catch {
      throw new ScreenTemplateVerificationError('Public template record is not valid UTF-8 JSON');
    }
    try {
      const record = await verifySignedTemplateRecord(parsed, {
        expectedTemplateId: templateId,
        expectedPurpose: 'attestation',
        resolveTaPublicKey: runtime.resolveTaPublicKey,
      });
      return { status: 200, record };
    } catch (error) {
      throw new ScreenTemplateVerificationError(
        error instanceof Error ? error.message : 'Template record verification failed'
      );
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onSignalAbort);
    options.signal?.removeEventListener('abort', onAbort);
    if (reader) void reader.cancel().catch(() => {});
  }
}

function parseServerFeedback(raw: unknown): { code: string; message: string; at?: string }[] {
  if (!Array.isArray(raw)) {
    throw new Error('Expected feedback array from template service');
  }
  return raw.map((item, idx) => {
    if (!isPlainObject(item) || typeof item.code !== 'string' || typeof item.message !== 'string') {
      throw new Error(`Invalid feedback item at index ${idx}`);
    }
    if (item.at !== undefined && typeof item.at !== 'string') {
      throw new Error(`Invalid feedback target at index ${idx}`);
    }
    return item.at !== undefined
      ? { code: item.code, message: item.message, at: item.at }
      : { code: item.code, message: item.message };
  });
}

type PostTemplateResponse =
  | {
      outcome: 'certified';
      repaired: boolean;
      record: ScreenSignedTemplateRecord;
      changes: { code: string; message: string; at?: string }[];
    }
  | {
      outcome: 'repair_suggested';
      skeleton: ScreenSkeleton;
      changes: { code: string; message: string; at?: string }[];
    }
  | {
      outcome: 'invalid_template';
      fixes: { code: string; message: string; at?: string }[];
    }
  | {
      outcome: 'rate_limited';
      retryAfter?: string;
    };

async function postTemplateAttestation(
  config: NotiBuddyConfig,
  signingKey: CryptoKey,
  skeleton: ScreenSkeleton,
  mode: 'auto' | 'strict',
  options: CallOptions,
  runtime: ScreenRuntimeOptions
): Promise<PostTemplateResponse> {
  try {
    const { body } = await relayJSON(
      config,
      '/v2/templates',
      {
        method: 'POST',
        body: JSON.stringify({ skeleton, mode }),
      },
      options,
      signingKey
    );
    if (!isPlainObject(body) || body.status !== 'certified' || typeof body.repaired !== 'boolean') {
      throw new ScreenTemplateVerificationError('Unrecognized certified template response');
    }
    if (mode === 'strict' && body.repaired) {
      throw new ScreenTemplateVerificationError('Strict registration must not return a repaired record');
    }
    if (!isValidTemplateId(body.templateId)) {
      throw new ScreenTemplateVerificationError('Invalid templateId in certified response');
    }
    const record = await verifySignedTemplateRecord(body.record, {
      expectedTemplateId: body.templateId,
      expectedPurpose: 'attestation',
      resolveTaPublicKey: runtime.resolveTaPublicKey,
    });
    if (body.skeleton !== undefined) {
      const returnedSkeleton = validateScreenSkeleton(body.skeleton);
      if (
        canonJson(returnedSkeleton as unknown as ScreenCanonValue) !==
        canonJson(record.skeleton as unknown as ScreenCanonValue)
      ) {
        throw new ScreenTemplateVerificationError('Certified response skeleton does not match signed record');
      }
    }
    assertBindingSchemaCompatible(skeleton, record.skeleton);
    const changes = body.changes !== undefined ? parseServerFeedback(body.changes) : [];
    return {
      outcome: 'certified',
      repaired: body.repaired,
      record,
      changes,
    };
  } catch (error) {
    if (error instanceof RelayHTTPError) {
      if (error.status === 429) {
        return { outcome: 'rate_limited', retryAfter: error.retryAfter };
      }
      if (error.status === 422 && isPlainObject(error.body)) {
        if (error.body.status === 'repair_suggested') {
          const suggested = validateScreenSkeleton(error.body.skeleton);
          assertBindingSchemaCompatible(skeleton, suggested);
          const changes = parseServerFeedback(error.body.changes);
          return { outcome: 'repair_suggested', skeleton: suggested, changes };
        }
        if (error.body.status === 'invalid_template') {
          const fixes = parseServerFeedback(error.body.fixes);
          return { outcome: 'invalid_template', fixes };
        }
      }
    }
    throw error;
  }
}

type EnsureFreshResult =
  | { ok: true }
  | { ok: false; errorCode: string; message: string; shouldReattest?: boolean };

async function ensureTemplateFreshOnRelay(
  config: NotiBuddyConfig,
  signingKey: CryptoKey,
  store: ScreenTemplateStore,
  relayOrigin: string,
  entry: CachedScreenTemplateEntry,
  options: CallOptions,
  runtime: ScreenRuntimeOptions
): Promise<EnsureFreshResult> {
  const now = (runtime.now ?? Date.now)();
  if (!needsTemplateRefresh(entry.lastRefreshedAt, now)) {
    return { ok: true };
  }

  try {
    const { body } = await relayJSON(
      config,
      `/v2/templates/${entry.templateId}`,
      {
        method: 'PUT',
        body: serializeTemplateRecord(entry.record),
      },
      options,
      signingKey
    );
    const status = isPlainObject(body) ? body.status : undefined;
    if (status !== 'fresh' && status !== 'refreshed' && status !== 'restored') {
      throw new Error('Unexpected template refresh response');
    }
    await store.writeRecord(relayOrigin, {
      templateId: entry.templateId,
      record: entry.record,
      lastRefreshedAt: now,
    });
    return { ok: true };
  } catch (putError) {
    // A failed PUT is non-fatal ONLY if public GET confirms R2 still serves a verified copy.
    let getStatus: 200 | 404 | 'failed' = 'failed';
    try {
      const check = await fetchPublicTemplateRecord(config.relay, entry.templateId, options, runtime);
      if (check.status === 200) {
        getStatus = 200;
      } else {
        getStatus = 404;
      }
    } catch {
      getStatus = 'failed';
    }

    if (getStatus === 200) {
      return { ok: true };
    }

    if (putError instanceof RelayHTTPError && putError.status >= 400 && putError.status < 500) {
      const code = putError.code ?? `HTTP_${putError.status}`;
      const message =
        code === 'TEMPLATE_KEY_RETIRED'
          ? 'Template signing key is retired and the template is no longer available on the relay; re-register the template before sending.'
          : putError.message;
      const isAuthStatus = putError.status === 401 || putError.status === 403;
      return {
        ok: false,
        errorCode: code,
        message,
        shouldReattest: getStatus === 404 && !isAuthStatus,
      };
    }
    if (getStatus === 404) {
      return {
        ok: false,
        errorCode: 'TEMPLATE_EXPIRED',
        message: 'Template expired on the relay and could not be restored.',
      };
    }
    throw putError;
  }
}

export type ScreenResolutionOutcome =
  | {
      ok: true;
      templateId: ScreenTemplateId;
      skeleton: ScreenSkeleton;
      labels: Record<string, string>;
      data: Record<string, ScreenDataValue>;
      repaired?: true;
      suggestedTemplate?: Record<string, unknown>;
      changes?: ScreenFeedbackItem[];
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
      suggestedTemplate?: Record<string, unknown>;
      changes?: ScreenFeedbackItem[];
      fixes?: ScreenFeedbackItem[];
    };

/**
 * Resolves a screen request before sealing or posting `/v2/requests`:
 * - Catalog table -> local persistent cache -> unauthenticated `GET /templates/:id` -> `TEMPLATE_EXPIRED`
 * - Inline templates: local skeletonizer -> catalog -> inline memo -> `POST /v2/templates`
 * - Non-catalog templates: awaits `PUT /v2/templates/:id` when `lastRefreshedAt` is absent or >= 15d old
 */
export async function resolveScreenForDispatch(
  config: NotiBuddyConfig,
  signingKey: CryptoKey,
  store: ScreenTemplateStore,
  input: ScreenAskInput,
  options: CallOptions,
  runtime: ScreenRuntimeOptions = {}
): Promise<ScreenResolutionOutcome> {
  const relayOrigin = relayOriginOf(config.relay);
  const now = (runtime.now ?? Date.now)();

  if (input.templateId !== undefined) {
    const labels = input.labels ?? {};
    const data = input.data ?? {};

    // 1. Catalog table (slug or templateId): never GET or PUT.
    const catalogHit =
      getScreenCatalogBySlug(input.templateId) ?? getScreenCatalogByTemplateId(input.templateId);
    if (catalogHit) {
      return {
        ok: true,
        templateId: catalogHit.templateId,
        skeleton: catalogHit.skeleton,
        labels,
        data,
      };
    }

    if (!isValidTemplateId(input.templateId)) {
      throw new Error(
        `Invalid screen.templateId "${input.templateId}": expected a built-in catalog slug or tpl_<64 lowercase hex>`
      );
    }

    // 2. Local persistent record cache.
    let cached = await store.readRecord(relayOrigin, input.templateId);

    // 3. Unauthenticated GET /templates/:id fallback.
    if (!cached) {
      let fetched: { status: 200; record: ScreenSignedTemplateRecord } | { status: 404 };
      try {
        fetched = await fetchPublicTemplateRecord(config.relay, input.templateId, options, runtime);
      } catch (error) {
        if (error instanceof ScreenTemplateVerificationError) {
          return {
            ok: false,
            errorCode: 'TEMPLATE_INVALID',
            message: `Template record from relay failed verification: ${error.message}`,
          };
        }
        throw error;
      }
      if (fetched.status === 404) {
        return {
          ok: false,
          errorCode: 'TEMPLATE_EXPIRED',
          message: `Template "${input.templateId}" is not in the local cache and was not found on the relay.`,
        };
      }
      // Persist without lastRefreshedAt so refresh-on-send checks/refreshes R2 immediately.
      cached = { templateId: input.templateId, record: fetched.record };
      await store.writeRecord(relayOrigin, cached);
    }

    const fresh = await ensureTemplateFreshOnRelay(
      config,
      signingKey,
      store,
      relayOrigin,
      cached,
      options,
      runtime
    );
    if (!fresh.ok) {
      return { ok: false, errorCode: fresh.errorCode, message: fresh.message };
    }

    return {
      ok: true,
      templateId: cached.templateId,
      skeleton: cached.record.skeleton,
      labels,
      data,
    };
  }

  // Inline ad-hoc template flow.
  const mode = input.mode ?? 'auto';
  const skeletonized = await skeletonizeScreenTemplate(input.template, input.labels, input.data);
  const candidateId: ScreenTemplateId = `tpl_${skeletonized.inputSkeletonHash}`;

  // 1. Catalog hit on exact skeleton hash: 0 POST, 0 GET, 0 PUT.
  const catalogMatch = getScreenCatalogByTemplateId(candidateId);
  if (catalogMatch) {
    return {
      ok: true,
      templateId: catalogMatch.templateId,
      skeleton: catalogMatch.skeleton,
      labels: skeletonized.labels,
      data: skeletonized.data,
    };
  }

  // 2. Local inline memo hit: 0 POST /v2/templates calls.
  const memo = store.readInlineMemo(relayOrigin, SKELETONIZER_VERSION, skeletonized.inputSkeletonHash);
  if (memo && (mode === 'auto' || !memo.repaired)) {
    const memoCatalog = getScreenCatalogByTemplateId(memo.templateId);
    const cached = memoCatalog
      ? { templateId: memoCatalog.templateId, record: memoCatalog.record }
      : await store.readRecord(relayOrigin, memo.templateId);
    if (cached) {
      let fallThroughToReattest = false;
      if (!memoCatalog) {
        const fresh = await ensureTemplateFreshOnRelay(
          config,
          signingKey,
          store,
          relayOrigin,
          cached,
          options,
          runtime
        );
        if (!fresh.ok) {
          if (fresh.shouldReattest) {
            fallThroughToReattest = true;
          } else {
            return { ok: false, errorCode: fresh.errorCode, message: fresh.message };
          }
        }
      }
      if (!fallThroughToReattest) {
        if (memo.repaired) {
          const changes = rehydrateScreenFeedback(memo.changes ?? [], skeletonized.ordinalMap);
          const suggestedTemplate = rehydrateSuggestedTemplate(
            cached.record.skeleton,
            skeletonized.labels,
            skeletonized.data,
            skeletonized.ordinalMap
          );
          return {
            ok: true,
            templateId: cached.templateId,
            skeleton: cached.record.skeleton,
            labels: skeletonized.labels,
            data: skeletonized.data,
            repaired: true,
            suggestedTemplate,
            changes,
          };
        }
        return {
          ok: true,
          templateId: cached.templateId,
          skeleton: cached.record.skeleton,
          labels: skeletonized.labels,
          data: skeletonized.data,
        };
      }
    }
  }

  // 3. Inline memo miss: submit zero-literal skeleton to POST /v2/templates.
  const attested = await postTemplateAttestation(
    config,
    signingKey,
    skeletonized.skeleton,
    mode,
    options,
    runtime
  );

  if (attested.outcome === 'rate_limited') {
    return {
      ok: false,
      errorCode: 'RATE_LIMITED',
      message: attested.retryAfter
        ? `Template registration rate limit reached; retry after ${attested.retryAfter}s.`
        : 'Template registration rate limit reached; retry later.',
    };
  }
  if (attested.outcome === 'repair_suggested') {
    const changes = rehydrateScreenFeedback(attested.changes, skeletonized.ordinalMap);
    const suggestedTemplate = rehydrateSuggestedTemplate(
      attested.skeleton,
      skeletonized.labels,
      skeletonized.data,
      skeletonized.ordinalMap
    );
    return {
      ok: false,
      errorCode: 'REPAIR_SUGGESTED',
      message: 'Template requires standardization changes (strict mode rejected auto-repair).',
      suggestedTemplate,
      changes,
    };
  }
  if (attested.outcome === 'invalid_template') {
    const fixes = rehydrateScreenFeedback(attested.fixes, skeletonized.ordinalMap);
    return {
      ok: false,
      errorCode: 'INVALID_TEMPLATE',
      message: 'Template could not be certified; see fixes for required changes.',
      fixes,
    };
  }

  // Certified: persist record cache (fresh at `now`) and inline memo.
  const record = attested.record;
  await store.writeRecord(relayOrigin, {
    templateId: record.templateId,
    record,
    lastRefreshedAt: now,
  });
  store.writeInlineMemo({
    relayOrigin,
    skeletonizerVersion: SKELETONIZER_VERSION,
    inputSkeletonHash: skeletonized.inputSkeletonHash,
    templateId: record.templateId,
    repaired: attested.repaired,
    ...(attested.repaired
      ? { changes: attested.changes, repairedSkeleton: record.skeleton }
      : {}),
  });

  if (attested.repaired) {
    const repairedHash = toHex(
      await sha256(new TextEncoder().encode(canonJson(record.skeleton as unknown as ScreenCanonValue)))
    );
    store.writeInlineMemo({
      relayOrigin,
      skeletonizerVersion: SKELETONIZER_VERSION,
      inputSkeletonHash: repairedHash,
      templateId: record.templateId,
      repaired: false,
    });
    const changes = rehydrateScreenFeedback(attested.changes, skeletonized.ordinalMap);
    const suggestedTemplate = rehydrateSuggestedTemplate(
      record.skeleton,
      skeletonized.labels,
      skeletonized.data,
      skeletonized.ordinalMap
    );
    return {
      ok: true,
      templateId: record.templateId,
      skeleton: record.skeleton,
      labels: skeletonized.labels,
      data: skeletonized.data,
      repaired: true,
      suggestedTemplate,
      changes,
    };
  }

  return {
    ok: true,
    templateId: record.templateId,
    skeleton: record.skeleton,
    labels: skeletonized.labels,
    data: skeletonized.data,
  };
}

export type RegisterScreenTemplateResult =
  | {
      status: 'certified';
      templateId: ScreenTemplateId;
      repaired: false;
      skeleton: ScreenSkeleton;
      record: ScreenSignedTemplateRecord;
    }
  | {
      status: 'certified';
      templateId: ScreenTemplateId;
      repaired: true;
      skeleton: ScreenSkeleton;
      suggestedTemplate: Record<string, unknown>;
      changes: ScreenFeedbackItem[];
      record: ScreenSignedTemplateRecord;
    }
  | {
      status: 'repair_suggested';
      skeleton: ScreenSkeleton;
      suggestedTemplate: Record<string, unknown>;
      changes: ScreenFeedbackItem[];
    }
  | {
      status: 'invalid_template';
      fixes: ScreenFeedbackItem[];
    }
  | {
      status: 'rate_limited';
      retryAfter?: string;
    };

function extractRegistrationTarget(input: unknown): {
  template: unknown;
  labels?: Record<string, string>;
  data?: Record<string, ScreenDataValue>;
} {
  if (!isPlainObject(input)) {
    throw new Error('Template input must be a JSON object');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'root')) {
    return { template: input };
  }
  if (Object.prototype.hasOwnProperty.call(input, 'template')) {
    return {
      template: input.template,
      labels: isPlainObject(input.labels) ? (input.labels as Record<string, string>) : undefined,
      data: isPlainObject(input.data) ? (input.data as Record<string, ScreenDataValue>) : undefined,
    };
  }
  if (Object.prototype.hasOwnProperty.call(input, 'skeleton')) {
    return {
      template: input.skeleton,
      labels: isPlainObject(input.labels) ? (input.labels as Record<string, string>) : undefined,
      data: isPlainObject(input.data) ? (input.data as Record<string, ScreenDataValue>) : undefined,
    };
  }
  throw new Error('Template file must contain a template object with root/actions, or { template } / { skeleton }');
}

/**
 * Registers a screen template via `POST /v2/templates` (`nb screen register <file> [--strict]`).
 */
export async function registerScreenTemplateOnRelay(
  config: NotiBuddyConfig,
  signingKey: CryptoKey,
  store: ScreenTemplateStore,
  input: unknown,
  options: CallOptions & { strict?: boolean } = {},
  runtime: ScreenRuntimeOptions = {}
): Promise<RegisterScreenTemplateResult> {
  const { template, labels, data } = extractRegistrationTarget(input);
  const skeletonized = await skeletonizeScreenTemplate(template, labels, data);
  const candidateId: ScreenTemplateId = `tpl_${skeletonized.inputSkeletonHash}`;

  const catalogMatch = getScreenCatalogByTemplateId(candidateId);
  if (catalogMatch) {
    return {
      status: 'certified',
      templateId: catalogMatch.templateId,
      repaired: false,
      skeleton: catalogMatch.skeleton,
      record: catalogMatch.record,
    };
  }

  const mode = options.strict ? 'strict' : 'auto';
  const relayOrigin = relayOriginOf(config.relay);
  const now = (runtime.now ?? Date.now)();
  const attested = await postTemplateAttestation(
    config,
    signingKey,
    skeletonized.skeleton,
    mode,
    options,
    runtime
  );

  if (attested.outcome === 'rate_limited') {
    return { status: 'rate_limited', retryAfter: attested.retryAfter };
  }
  if (attested.outcome === 'repair_suggested') {
    const changes = rehydrateScreenFeedback(attested.changes, skeletonized.ordinalMap);
    const suggestedTemplate = rehydrateSuggestedTemplate(
      attested.skeleton,
      skeletonized.labels,
      skeletonized.data,
      skeletonized.ordinalMap
    );
    return {
      status: 'repair_suggested',
      skeleton: attested.skeleton,
      suggestedTemplate,
      changes,
    };
  }
  if (attested.outcome === 'invalid_template') {
    return {
      status: 'invalid_template',
      fixes: rehydrateScreenFeedback(attested.fixes, skeletonized.ordinalMap),
    };
  }

  const record = attested.record;
  await store.writeRecord(relayOrigin, {
    templateId: record.templateId,
    record,
    lastRefreshedAt: now,
  });
  store.writeInlineMemo({
    relayOrigin,
    skeletonizerVersion: SKELETONIZER_VERSION,
    inputSkeletonHash: skeletonized.inputSkeletonHash,
    templateId: record.templateId,
    repaired: attested.repaired,
    ...(attested.repaired
      ? { changes: attested.changes, repairedSkeleton: record.skeleton }
      : {}),
  });

  if (attested.repaired) {
    const repairedHash = toHex(
      await sha256(new TextEncoder().encode(canonJson(record.skeleton as unknown as ScreenCanonValue)))
    );
    store.writeInlineMemo({
      relayOrigin,
      skeletonizerVersion: SKELETONIZER_VERSION,
      inputSkeletonHash: repairedHash,
      templateId: record.templateId,
      repaired: false,
    });
    const changes = rehydrateScreenFeedback(attested.changes, skeletonized.ordinalMap);
    const suggestedTemplate = rehydrateSuggestedTemplate(
      record.skeleton,
      skeletonized.labels,
      skeletonized.data,
      skeletonized.ordinalMap
    );
    return {
      status: 'certified',
      templateId: record.templateId,
      repaired: true,
      skeleton: record.skeleton,
      suggestedTemplate,
      changes,
      record,
    };
  }

  return {
    status: 'certified',
    templateId: record.templateId,
    repaired: false,
    skeleton: record.skeleton,
    record,
  };
}

export type VerifiedScreenSettlementResult =
  | { status: 'resolved'; answer: AnswerPayload }
  | { status: 'error'; errorCode: 'TEMPLATE_UNAVAILABLE_ON_DEVICE' | 'SETTLEMENT_UNVERIFIED'; message: string };

/**
 * Verifies a decrypted screen reply against the saved `PendingScreenContext`:
 * - Unavailable dismiss variant -> `status: 'error', errorCode: 'TEMPLATE_UNAVAILABLE_ON_DEVICE'`
 * - Rendered answer -> checks renderDigest, action membership, total form shape, predicates, and auth
 * - Any malformed or unverified answer -> `status: 'error', errorCode: 'SETTLEMENT_UNVERIFIED'`
 */
export async function verifyScreenSettlement(
  pending: PendingScreenContext | undefined,
  rawAnswer: unknown
): Promise<VerifiedScreenSettlementResult> {
  if (!pending) {
    return {
      status: 'error',
      errorCode: 'SETTLEMENT_UNVERIFIED',
      message: 'Missing saved screen settlement context for this request.',
    };
  }
  try {
    const verified = await verifyScreenAnswer(pending.contextDigest, rawAnswer);
    if (verified.kind === 'unavailable') {
      return {
        status: 'error',
        errorCode: 'TEMPLATE_UNAVAILABLE_ON_DEVICE',
        message: 'The device could not load or verify the screen template and dismissed the request.',
      };
    }
    const action = pending.skeleton.actions.find((a) => a.id === verified.action);
    if (!action) {
      return {
        status: 'error',
        errorCode: 'SETTLEMENT_UNVERIFIED',
        message: `Screen answer referenced unknown action "${verified.action}".`,
      };
    }
    const shape = validateScreenForm(
      pending.skeleton,
      verified.form,
      pending.checklistCounts,
      pending.pickerOptionCounts
    );
    if (!shape.ok) {
      return {
        status: 'error',
        errorCode: 'SETTLEMENT_UNVERIFIED',
        message: `Screen answer form failed validation: ${shape.error}`,
      };
    }
    if (!evaluateScreenPredicates(action, pending.skeleton, verified.form)) {
      return {
        status: 'error',
        errorCode: 'SETTLEMENT_UNVERIFIED',
        message: `Screen answer did not satisfy required fields or enabledWhen predicates for ${action.id}.`,
      };
    }
    const authRequired =
      action.role !== 'decline' &&
      Boolean(pending.sensitive || pending.requiresAuth || action.requireBio);
    if (authRequired && verified.authenticated !== true) {
      return {
        status: 'error',
        errorCode: 'SETTLEMENT_UNVERIFIED',
        message: `Screen answer for ${action.id} requires user authentication.`,
      };
    }
    const normalizedAnswer: AnswerPayload = {
      action: verified.action,
      values: {
        form: verified.form,
        render: { v: 1, digest: verified.renderDigest },
      },
      ...(verified.authenticated !== undefined ? { authenticated: verified.authenticated } : {}),
    };
    return {
      status: 'resolved',
      answer: normalizedAnswer,
    };
  } catch (error) {
    return {
      status: 'error',
      errorCode: 'SETTLEMENT_UNVERIFIED',
      message: `Screen answer failed settlement verification: ${error instanceof Error ? error.message : 'malformed answer'}`,
    };
  }
}

export type { ScreenOrdinalMap };
