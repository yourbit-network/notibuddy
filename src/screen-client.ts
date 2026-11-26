// Screen template resolution, attestation, refresh-on-send, registration, and settlement verification.

import { fromB64u, sha256, toB64u, toHex } from './crypto.js';
import { DeadlineError, RelayHTTPError, relayJSON, type CallOptions } from './client-http.js';
import { normalizeRelay } from './relay-url.js';
import {
  canonJson,
  isPlainObject,
  isValidUnicodeString,
  utf8ByteLength,
  type ScreenCanonValue,
} from './screen-canon.js';
import {
  SCREEN_CATALOG_SLUGS,
  getScreenCatalogBySlug,
  getScreenCatalogByTemplateId,
  type ScreenSignedTemplateRecord,
  type ScreenTaPublicKey,
} from './screen-catalog.js';
import {
  describeScreenTemplate,
  collectScreenAuthoringFixes,
  formatGeneralScreenRecoveryGuide,
  formatScreenRecoveryGuide,
  renderScreenTextPreview,
  resolveCatalogSlotsToWire,
  type PublicScreenTemplateDescription,
  type ScreenDecodeContext,
} from './screen-describe.js';
import { evaluateScreenPredicates, validateScreenForm } from './screen-form.js';
import {
  collectScreenBindingErrors,
  serializeTemplateRecord,
  verifySignedTemplateRecord,
} from './screen-record.js';
import {
  SKELETONIZER_VERSION,
  ScreenSkeletonizeError,
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
  SCREEN_PUBLIC_CAPS,
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
  slots?: Record<string, unknown>;
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

function localRecoveryHintForRaw(value: Record<string, unknown>): string {
  const rawId = typeof value.templateId === 'string' ? value.templateId.trim() : '';
  const entry = rawId ? (getScreenCatalogBySlug(rawId) ?? getScreenCatalogByTemplateId(rawId)) : undefined;
  const guide = entry ? formatScreenRecoveryGuide(entry.slug) : formatGeneralScreenRecoveryGuide();
  return `\n\n${guide}`;
}

export function parseScreenAskInput(value: unknown): ScreenAskInput {
  if (!isPlainObject(value)) {
    throw new Error(
      `Invalid screen: must be a JSON object with { templateId | template, slots | labels/data }.\n\n${formatGeneralScreenRecoveryGuide()}`
    );
  }
  const hint = value.template === undefined ? localRecoveryHintForRaw(value) : '';
  const allowed = new Set(['templateId', 'template', 'slots', 'labels', 'data', 'thread', 'mode']);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    const label =
      unexpected.length === 1
        ? `unexpected property "${unexpected[0]}"`
        : `unexpected properties ${unexpected.map((k) => `"${k}"`).join(', ')}`;
    throw new Error(
      `Invalid screen: ${label}. Allowed screen properties are templateId, template, slots, labels, data, thread, and mode (pass flat values in screen.slots, or blocks in screen.template).${hint}`
    );
  }
  const hasTemplateId = value.templateId !== undefined;
  const hasTemplate = value.template !== undefined;
  if (hasTemplateId === hasTemplate) {
    throw new Error(`Invalid screen: provide exactly one of templateId or template${hint}`);
  }
  const out: ScreenAskInput = {};
  if (hasTemplateId) {
    if (typeof value.templateId !== 'string' || value.templateId.trim().length === 0) {
      throw new Error(
        `Invalid screen.templateId: must be a non-empty template ID or catalog slug\n\n${formatGeneralScreenRecoveryGuide()}`
      );
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
  if (value.slots !== undefined) {
    if (hasTemplate) {
      throw new Error('Invalid screen.slots: only supported with built-in catalog templateId (inline screen.template embeds values directly inside blocks)');
    }
    if (value.labels !== undefined || value.data !== undefined) {
      throw new Error(`Invalid screen: pass either screen.slots or legacy screen.labels/screen.data, not both.${hint}`);
    }
    if (!isPlainObject(value.slots)) {
      throw new Error(`Invalid screen.slots: must be an object mapping slot names to values.${hint}`);
    }
    out.slots = value.slots as Record<string, unknown>;
  }
  if (value.labels !== undefined) {
    if (!isPlainObject(value.labels)) {
      throw new Error(`Invalid screen.labels: must be a map of slot IDs (s0, s1, ...) to strings${hint}`);
    }
    for (const [k, v] of Object.entries(value.labels)) {
      if (typeof v !== 'string') {
        throw new Error(
          `Invalid screen.labels.${k}: must be a string (screen.labels holds display text strings; put arrays, objects, or diffs in screen.data instead)${hint}`
        );
      }
    }
    out.labels = value.labels as Record<string, string>;
  }
  if (value.data !== undefined) {
    if (!isPlainObject(value.data)) {
      throw new Error(`Invalid screen.data: must be an object mapping slot IDs (s0, s1, ...) to arrays or diff objects${hint}`);
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
      templateSlug?: string;
      skeleton: ScreenSkeleton;
      labels: Record<string, string>;
      data: Record<string, ScreenDataValue>;
      repaired?: true;
      suggestedTemplate?: Record<string, unknown>;
      changes?: ScreenFeedbackItem[];
      ordinalMap?: ScreenOrdinalMap;
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
    let labels = input.labels ?? {};
    let data = input.data ?? {};

    // 1. Catalog table (slug or templateId): never GET or PUT.
    const catalogHit =
      getScreenCatalogBySlug(input.templateId) ?? getScreenCatalogByTemplateId(input.templateId);
    if (catalogHit) {
      if (input.slots !== undefined) {
        const mapped = resolveCatalogSlotsToWire(catalogHit.slug, input.slots);
        if (mapped.errors.length > 0) {
          throw new Error(
            `${mapped.errors.join('; ')} ${formatScreenRecoveryGuide(catalogHit.slug)}`.trim(),
          );
        }
        labels = mapped.labels;
        data = mapped.data;
      }
      return {
        ok: true,
        templateId: catalogHit.templateId,
        templateSlug: catalogHit.slug,
        skeleton: catalogHit.skeleton,
        labels,
        data,
      };
    }

    if (input.slots !== undefined) {
      throw new Error(
        `screen.slots is only supported for named built-in templates (not bare templateId "${input.templateId}"). Pass labels/data for raw template hashes, or use screen.template / a catalog slug (${SCREEN_CATALOG_SLUGS.join(', ')}).`,
      );
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
  let skeletonized: Awaited<ReturnType<typeof skeletonizeScreenTemplate>>;
  try {
    skeletonized = await skeletonizeScreenTemplate(input.template, input.labels, input.data);
  } catch (error) {
    if (error instanceof ScreenSkeletonizeError) {
      const authoringFixes = error.partial
        ? collectScreenAuthoringFixes(
            error.partial.skeleton,
            error.partial.labels,
            error.partial.data,
            error.partial.ordinalMap
          )
        : [];
      const fixes = [...error.fixes, ...authoringFixes];
      return {
        ok: false,
        errorCode: 'INVALID_TEMPLATE',
        message: fixes.map((f) => `${f.at ? `${f.at}: ` : ''}${f.message}`).join('\n'),
        fixes,
      };
    }
    throw error;
  }
  const candidateId: ScreenTemplateId = `tpl_${skeletonized.inputSkeletonHash}`;

  // 1. Catalog hit on exact skeleton hash: 0 POST, 0 GET, 0 PUT.
  const catalogMatch = getScreenCatalogByTemplateId(candidateId);
  if (catalogMatch) {
    return {
      ok: true,
      templateId: catalogMatch.templateId,
      templateSlug: catalogMatch.slug,
      skeleton: catalogMatch.skeleton,
      labels: skeletonized.labels,
      data: skeletonized.data,
      ordinalMap: skeletonized.ordinalMap,
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
            ordinalMap: skeletonized.ordinalMap,
          };
        }
        return {
          ok: true,
          templateId: cached.templateId,
          skeleton: cached.record.skeleton,
          labels: skeletonized.labels,
          data: skeletonized.data,
          ordinalMap: skeletonized.ordinalMap,
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
      ordinalMap: skeletonized.ordinalMap,
    };
  }

  return {
    ok: true,
    templateId: record.templateId,
    skeleton: record.skeleton,
    labels: skeletonized.labels,
    data: skeletonized.data,
    ordinalMap: skeletonized.ordinalMap,
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

const DECODE_CTX_DOMAIN = 'nb-local-screen-decode-v1';
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

async function deriveLocalScreenDecodeKey(
  requestId: string,
  privateKeyJwk: JsonWebKey
): Promise<CryptoKey | undefined> {
  if (typeof privateKeyJwk.d !== 'string' || privateKeyJwk.d.length === 0) {
    return undefined;
  }
  const digest = await sha256(
    utf8Encoder.encode(`${DECODE_CTX_DOMAIN}|${requestId}|${privateKeyJwk.d}`)
  );
  return crypto.subtle.importKey(
    'raw',
    digest as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts human-readable screen labels/options for pending storage using a key derived from the
 * ephemeral reply private key so zero screen plaintext rests on disk (D46).
 */
export async function sealPendingScreenDecodeContext(
  requestId: string,
  privateKeyJwk: JsonWebKey,
  ctx: ScreenDecodeContext
): Promise<{ iv: string; ct: string } | undefined> {
  const aesKey = await deriveLocalScreenDecodeKey(requestId, privateKeyJwk);
  if (!aesKey) return undefined;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = utf8Encoder.encode(`${DECODE_CTX_DOMAIN}|${requestId}`);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad as unknown as BufferSource },
    aesKey,
    utf8Encoder.encode(JSON.stringify(ctx)) as unknown as BufferSource
  );
  return { iv: toB64u(iv), ct: toB64u(new Uint8Array(ct)) };
}

/**
 * Unwraps the encrypted human-readable screen decode context from `PendingReply` on resolution.
 */
export async function openPendingScreenDecodeContext(
  requestId: string,
  privateKeyJwk: JsonWebKey,
  box: { iv: string; ct: string }
): Promise<ScreenDecodeContext | undefined> {
  try {
    const aesKey = await deriveLocalScreenDecodeKey(requestId, privateKeyJwk);
    if (!aesKey) return undefined;
    const iv = fromB64u(box.iv);
    if (iv.length !== 12) return undefined;
    const aad = utf8Encoder.encode(`${DECODE_CTX_DOMAIN}|${requestId}`);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad as unknown as BufferSource },
      aesKey,
      fromB64u(box.ct) as unknown as BufferSource
    );
    const parsed = JSON.parse(utf8Decoder.decode(pt));
    if (!isPlainObject(parsed)) return undefined;
    return parsed as unknown as ScreenDecodeContext;
  } catch {
    return undefined;
  }
}

export interface LocalScreenDryRunResult {
  valid: boolean;
  templateId: string;
  templateSlug?: string;
  errors: string[];
  fixes?: ScreenFeedbackItem[];
  layout?: PublicScreenTemplateDescription;
  preview?: string;
}

/**
 * Validates a local screen ask input offline without registering on or sending to the relay.
 */
export async function dryRunLocalScreen(
  config: NotiBuddyConfig,
  store: ScreenTemplateStore,
  input: ScreenAskInput,
  title?: string
): Promise<LocalScreenDryRunResult> {
  const errors: string[] = [];
  const fixes: ScreenFeedbackItem[] = [];
  if (typeof title === 'string' && utf8ByteLength(title) > SCREEN_PUBLIC_CAPS.maxTitleBytes) {
    const msg = `title exceeds maximum byte length (${SCREEN_PUBLIC_CAPS.maxTitleBytes})`;
    errors.push(msg);
    fixes.push({ code: 'INVALID_TITLE', message: msg, at: 'title' });
  }
  let labels = input.labels ?? {};
  let data = input.data ?? {};

  if (input.templateId !== undefined) {
    const catalogEntry =
      getScreenCatalogBySlug(input.templateId) ?? getScreenCatalogByTemplateId(input.templateId);
    const resolvedEntry =
      catalogEntry ??
      (isValidTemplateId(input.templateId)
        ? (await store.readRecord(relayOriginOf(config.relay), input.templateId))?.record
        : undefined);
    const skeleton = catalogEntry?.skeleton ?? resolvedEntry?.skeleton;
    const templateId = catalogEntry?.templateId ?? resolvedEntry?.templateId ?? input.templateId;
    const templateSlug = catalogEntry?.slug;
    const layout = catalogEntry ? describeScreenTemplate(catalogEntry.slug) : undefined;
    if (!skeleton) {
      const msg = `Template "${input.templateId}" is not a built-in catalog slug and was not found in the local template cache.`;
      errors.push(msg);
      fixes.push({ code: 'TEMPLATE_NOT_FOUND', message: msg, at: 'templateId' });
      return {
        valid: false,
        templateId,
        ...(templateSlug ? { templateSlug } : {}),
        errors,
        fixes,
        ...(layout ? { layout } : {}),
      };
    }

    if (input.slots !== undefined) {
      if (!catalogEntry) {
        const msg =
          'screen.slots is only supported for the 8 built-in catalog templates; pass screen.labels and screen.data for bare templateId hashes.';
        errors.push(msg);
        fixes.push({ code: 'INVALID_SLOTS', message: msg, at: 'slots' });
      } else {
        const mapped = resolveCatalogSlotsToWire(catalogEntry.slug, input.slots);
        for (const e of mapped.errors) {
          errors.push(e);
          fixes.push({ code: 'INVALID_SLOT', message: e, at: 'slots' });
        }
        labels = mapped.labels;
        data = mapped.data;
      }
    }

    const labelKeys = Object.keys(labels);
    if (labelKeys.length > SCREEN_PUBLIC_CAPS.maxLabelsEntries) {
      errors.push('labels exceeds maximum entry count');
      fixes.push({ code: 'INVALID_LABELS', message: 'labels exceeds maximum entry count', at: 'labels' });
    }
    const dataKeys = Object.keys(data);
    if (dataKeys.length > SCREEN_PUBLIC_CAPS.maxDataEntries) {
      errors.push('data exceeds maximum entry count');
      fixes.push({ code: 'INVALID_DATA', message: 'data exceeds maximum entry count', at: 'data' });
    }
    const binding = collectScreenBindingErrors(skeleton, { labels, data }, templateSlug);
    for (const e of binding.errors) {
      if (!errors.includes(e)) errors.push(e);
      fixes.push({ code: 'INVALID_BINDING', message: e });
    }
    for (const af of collectScreenAuthoringFixes(skeleton, labels, data)) {
      fixes.push(af);
      const msg = af.at ? `${af.at}: ${af.message}` : af.message;
      if (!errors.includes(msg)) errors.push(msg);
    }
    const preview = renderScreenTextPreview(skeleton, labels, data, title);
    return {
      valid: errors.length === 0 && fixes.length === 0,
      templateId,
      ...(templateSlug ? { templateSlug } : {}),
      errors,
      ...(fixes.length > 0 ? { fixes } : {}),
      ...(layout ? { layout } : {}),
      preview,
    };
  }

  let skeletonized: Awaited<ReturnType<typeof skeletonizeScreenTemplate>>;
  try {
    skeletonized = await skeletonizeScreenTemplate(input.template!, input.labels, input.data);
  } catch (error) {
    if (error instanceof ScreenSkeletonizeError) {
      fixes.push(...error.fixes);
      for (const f of error.fixes) {
        const msg = f.at ? `${f.at}: ${f.message}` : f.message;
        if (!errors.includes(msg)) errors.push(msg);
      }
      let preview: string | undefined;
      if (error.partial) {
        const extra = collectScreenAuthoringFixes(
          error.partial.skeleton,
          error.partial.labels,
          error.partial.data,
          error.partial.ordinalMap
        );
        for (const af of extra) {
          fixes.push(af);
          const msg = af.at ? `${af.at}: ${af.message}` : af.message;
          if (!errors.includes(msg)) errors.push(msg);
        }
        const binding = collectScreenBindingErrors(error.partial.skeleton, {
          labels: error.partial.labels,
          data: error.partial.data,
        });
        for (const e of binding.errors) {
          if (!errors.includes(e)) errors.push(e);
        }
        preview = renderScreenTextPreview(
          error.partial.skeleton,
          error.partial.labels,
          error.partial.data,
          title,
          error.partial.ordinalMap
        );
      }
      return {
        valid: false,
        templateId: 'inline',
        errors,
        fixes,
        ...(preview !== undefined ? { preview } : {}),
      };
    }
    throw error;
  }

  const candidateId: ScreenTemplateId = `tpl_${skeletonized.inputSkeletonHash}`;
  const catalogMatch = getScreenCatalogByTemplateId(candidateId);
  const layout = catalogMatch ? describeScreenTemplate(catalogMatch.slug) : undefined;
  const binding = collectScreenBindingErrors(
    skeletonized.skeleton,
    {
      labels: skeletonized.labels,
      data: skeletonized.data,
    },
    catalogMatch?.slug
  );
  for (const e of binding.errors) {
    if (!errors.includes(e)) errors.push(e);
    fixes.push({ code: 'INVALID_BINDING', message: e });
  }
  for (const af of collectScreenAuthoringFixes(
    skeletonized.skeleton,
    skeletonized.labels,
    skeletonized.data,
    skeletonized.ordinalMap
  )) {
    fixes.push(af);
    const msg = af.at ? `${af.at}: ${af.message}` : af.message;
    if (!errors.includes(msg)) errors.push(msg);
  }
  const preview = renderScreenTextPreview(
    skeletonized.skeleton,
    skeletonized.labels,
    skeletonized.data,
    title,
    skeletonized.ordinalMap
  );
  return {
    valid: errors.length === 0 && fixes.length === 0,
    templateId: catalogMatch?.templateId ?? candidateId,
    ...(catalogMatch ? { templateSlug: catalogMatch.slug } : {}),
    errors,
    ...(fixes.length > 0 ? { fixes } : {}),
    ...(layout ? { layout } : {}),
    preview,
  };
}

export type { ScreenOrdinalMap };
