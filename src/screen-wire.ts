// Public 3-part wire validation and cryptographic digests for certified screen templates.

import { fromHex, isValidP256PublicKey, sha256, toHex } from './crypto.js';
import {
  canonJson,
  canonRenderInput,
  describeDisallowedControlOrFormatScalar,
  hasControlOrFormatScalar,
  isPlainObject,
  isSafeInt53,
  isValidUnicodeString,
  utf8ByteLength,
  type ScreenCanonValue,
} from './screen-canon.js';
import {
  SCREEN_PUBLIC_CAPS,
  SCREEN_UNAVAILABLE_ACTION,
  isActionOrdinal,
  isChecklistOrdinal,
  isFieldOrdinal,
  isHex64,
  isRoutingIdentifier,
  isScreenUnavailableAction,
  isSlotOrdinal,
  isValidTemplateId,
  type ScreenAnswer,
  type ScreenAnswerValues,
  type ScreenDataValue,
  type ScreenFormMap,
  type ScreenPresentation,
  type ScreenRenderedAnswer,
  type ScreenRenderedAnswerValues,
  type ScreenRequestPlaintext,
  type ScreenThread,
  type ScreenUnavailableAnswer,
  type ScreenUnavailableAnswerValues,
  type VerifiedScreenAnswer,
} from './screen-types.js';
import { assertAllowedKeys, computeTemplateId, validateScreenSkeleton } from './screen-skeleton.js';
export { computeTemplateId, validateScreenSkeleton };

const utf8Encoder = new TextEncoder();
const CONTEXT_DIGEST_DOMAIN = utf8Encoder.encode('nb-screen-ctx-v1');
const RENDER_DIGEST_DOMAIN = utf8Encoder.encode('nb-screen-render-v1');

function assertLabelText(value: unknown, maxBytes: number, context: string, allowEmpty = false): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string`);
  }
  if (!isValidUnicodeString(value)) {
    throw new Error(`${context} must be valid Unicode`);
  }
  const badChar = describeDisallowedControlOrFormatScalar(value);
  if (badChar) {
    throw new Error(
      `${context} contains disallowed ${badChar} (display labels and text blocks do not allow newlines or control characters; split lines into multiple text blocks, keyValueList, or diffViewer)`
    );
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new Error(`${context} must not be empty`);
  }
  if (utf8ByteLength(value) > maxBytes) {
    throw new Error(`${context} exceeds maximum byte length (${maxBytes})`);
  }
  return value;
}

function validateDataValue(value: unknown, depth: number, context: string): ScreenDataValue {
  if (depth > SCREEN_PUBLIC_CAPS.maxDataDepth) {
    throw new Error(`${context} exceeds maximum nesting depth`);
  }
  if (typeof value === 'string') {
    if (!isValidUnicodeString(value)) {
      throw new Error(`${context} string must be valid Unicode`);
    }
    return value;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!isSafeInt53(value)) {
      throw new Error(`${context} number must be a safe integer (int53)`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > SCREEN_PUBLIC_CAPS.maxItemsPerList) {
      throw new Error(`${context} array exceeds maximum length`);
    }
    return value.map((item, i) => validateDataValue(item, depth + 1, `${context}[${i}]`));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > SCREEN_PUBLIC_CAPS.maxDataEntries) {
      throw new Error(`${context} object exceeds maximum key count`);
    }
    const out: Record<string, ScreenDataValue> = {};
    for (const key of keys) {
      if (!isValidUnicodeString(key)) {
        throw new Error(`${context} object key must be valid Unicode`);
      }
      Object.defineProperty(out, key, {
        value: validateDataValue(value[key], depth + 1, `${context}.${key}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  throw new Error(`${context} must belong to string | boolean | int53 domain`);
}

/**
 * Validates the strict decrypted request plaintext for `primitive: "screen"`.
 */
export function validateScreenRequestPlaintext(value: unknown): ScreenRequestPlaintext {
  if (!isPlainObject(value)) {
    throw new Error('Screen request plaintext must be a JSON object');
  }
  assertAllowedKeys(
    value,
    ['type', 'replyPub', 'source', 'title', 'templateId', 'labels', 'data'],
    ['presentation', 'sensitive', 'requiresAuth', 'thread'],
    'screen request plaintext'
  );

  if (value.type !== 'ask') {
    throw new Error('Screen request plaintext type must be "ask"');
  }
  if (typeof value.replyPub !== 'string' || !isValidP256PublicKey(value.replyPub)) {
    throw new Error('Screen request replyPub must be a valid canonical P-256 public key');
  }

  if (!isPlainObject(value.source)) {
    throw new Error('Screen request source must be an object');
  }
  assertAllowedKeys(value.source, ['label'], [], 'source');
  const sourceLabel = assertLabelText(
    value.source.label,
    SCREEN_PUBLIC_CAPS.maxSourceLabelUtf16 * 4,
    'source.label'
  );
  if (sourceLabel.trim().length === 0 || sourceLabel.trim().length > SCREEN_PUBLIC_CAPS.maxSourceLabelUtf16) {
    throw new Error('source.label must be 1..100 UTF-16 code units');
  }

  const title = assertLabelText(value.title, SCREEN_PUBLIC_CAPS.maxTitleBytes, 'title');

  let presentation: ScreenPresentation | undefined;
  if (value.presentation !== undefined) {
    if (!isPlainObject(value.presentation)) {
      throw new Error('presentation must be an object');
    }
    assertAllowedKeys(value.presentation, [], ['shortTitle', 'summary'], 'presentation');
    presentation = {};
    if (value.presentation.shortTitle !== undefined) {
      presentation.shortTitle = assertLabelText(
        value.presentation.shortTitle,
        SCREEN_PUBLIC_CAPS.maxPresentationFieldBytes,
        'presentation.shortTitle'
      );
    }
    if (value.presentation.summary !== undefined) {
      presentation.summary = assertLabelText(
        value.presentation.summary,
        SCREEN_PUBLIC_CAPS.maxPresentationFieldBytes,
        'presentation.summary'
      );
    }
  }

  if (value.sensitive !== undefined && typeof value.sensitive !== 'boolean') {
    throw new Error('sensitive must be boolean');
  }
  if (value.requiresAuth !== undefined && typeof value.requiresAuth !== 'boolean') {
    throw new Error('requiresAuth must be boolean');
  }

  if (!isValidTemplateId(value.templateId)) {
    throw new Error('templateId must match tpl_<64 lowercase hex>');
  }

  if (!isPlainObject(value.labels)) {
    throw new Error('labels must be an object');
  }
  const labelKeys = Object.keys(value.labels);
  if (labelKeys.length > SCREEN_PUBLIC_CAPS.maxLabelsEntries) {
    throw new Error('labels exceeds maximum entry count');
  }
  const labels: Record<string, string> = {};
  for (const key of labelKeys) {
    if (!isSlotOrdinal(key)) {
      throw new Error(`Invalid label slot key "${key}"`);
    }
    labels[key] = assertLabelText(
      value.labels[key],
      SCREEN_PUBLIC_CAPS.maxLabelBytes,
      `labels.${key}`,
      true
    );
  }

  if (!isPlainObject(value.data)) {
    throw new Error('data must be an object');
  }
  const dataKeys = Object.keys(value.data);
  if (dataKeys.length > SCREEN_PUBLIC_CAPS.maxDataEntries) {
    throw new Error('data exceeds maximum entry count');
  }
  const data: Record<string, ScreenDataValue> = {};
  for (const key of dataKeys) {
    if (!isSlotOrdinal(key)) {
      throw new Error(`Invalid data slot key "${key}"`);
    }
    data[key] = validateDataValue(value.data[key], 1, `data.${key}`);
  }

  let thread: ScreenThread | undefined;
  if (value.thread !== undefined) {
    if (!isPlainObject(value.thread)) {
      throw new Error('thread must be an object');
    }
    assertAllowedKeys(value.thread, ['id', 'step', 'of'], ['prev'], 'thread');
    if (!isRoutingIdentifier(value.thread.id)) {
      throw new Error('thread.id must be a valid routing identifier');
    }
    if (
      !isSafeInt53(value.thread.step) ||
      !isSafeInt53(value.thread.of) ||
      value.thread.step < 1 ||
      value.thread.of < value.thread.step ||
      value.thread.of > SCREEN_PUBLIC_CAPS.maxThreadSteps
    ) {
      throw new Error('thread step/of out of bounds');
    }
    thread = {
      id: value.thread.id,
      step: value.thread.step,
      of: value.thread.of,
    };
    if (value.thread.step === 1) {
      if (value.thread.prev !== undefined) {
        throw new Error('thread.prev must be omitted on step 1');
      }
    } else {
      if (!isPlainObject(value.thread.prev)) {
        throw new Error('thread.prev is required when step > 1');
      }
      assertAllowedKeys(value.thread.prev, ['requestId', 'renderDigest'], [], 'thread.prev');
      if (!isRoutingIdentifier(value.thread.prev.requestId)) {
        throw new Error('thread.prev.requestId must be a valid routing identifier');
      }
      if (!isHex64(value.thread.prev.renderDigest)) {
        throw new Error('thread.prev.renderDigest must be 64 lowercase hex characters');
      }
      thread.prev = {
        requestId: value.thread.prev.requestId,
        renderDigest: value.thread.prev.renderDigest,
      };
    }
  }

  const out: ScreenRequestPlaintext = {
    type: 'ask',
    replyPub: value.replyPub,
    source: { label: sourceLabel },
    title,
    templateId: value.templateId,
    labels,
    data,
  };
  if (presentation !== undefined) out.presentation = presentation;
  if (value.sensitive !== undefined) out.sensitive = value.sensitive;
  if (value.requiresAuth !== undefined) out.requiresAuth = value.requiresAuth;
  if (thread !== undefined) out.thread = thread;

  if (utf8ByteLength(JSON.stringify(out)) > SCREEN_PUBLIC_CAPS.maxRequestPlaintextBytes) {
    throw new Error('Screen request plaintext exceeds maximum byte cap');
  }
  return out;
}

function validateScreenFormMap(value: unknown): ScreenFormMap {
  if (!isPlainObject(value)) {
    throw new Error('answer.values.form must be an object');
  }
  const formEntries = Object.entries(value);
  if (
    formEntries.length >
    SCREEN_PUBLIC_CAPS.maxSkeletonFields + SCREEN_PUBLIC_CAPS.maxSkeletonChecklists
  ) {
    throw new Error('answer.values.form exceeds maximum key count');
  }
  const form: ScreenFormMap = {};
  for (const [key, entry] of formEntries) {
    if (isChecklistOrdinal(key)) {
      if (!Array.isArray(entry) || entry.length > SCREEN_PUBLIC_CAPS.maxItemsPerList) {
        throw new Error(`Invalid checklist array in form.${key}`);
      }
      const bools: boolean[] = [];
      for (const item of entry) {
        if (typeof item !== 'boolean') {
          throw new Error(`Checklist form.${key} must contain booleans only`);
        }
        bools.push(item);
      }
      form[key] = bools;
    } else if (isFieldOrdinal(key)) {
      if (typeof entry === 'string') {
        if (!isValidUnicodeString(entry) || utf8ByteLength(entry) > SCREEN_PUBLIC_CAPS.maxSlotBytes) {
          throw new Error(`Invalid string in form.${key}`);
        }
        form[key] = entry;
      } else if (typeof entry === 'boolean') {
        form[key] = entry;
      } else if (isSafeInt53(entry)) {
        form[key] = Object.is(entry, -0) ? 0 : entry;
      } else {
        throw new Error(`Unsupported field value in form.${key}`);
      }
    } else {
      throw new Error(`Invalid form key "${key}"`);
    }
  }
  return form;
}

function validateRenderedAnswerValues(value: unknown): ScreenRenderedAnswerValues {
  if (!isPlainObject(value)) {
    throw new Error('Screen answer values must be an object');
  }
  assertAllowedKeys(value, ['form', 'render'], [], 'answer.values');

  const form = validateScreenFormMap(value.form);

  if (!isPlainObject(value.render)) {
    throw new Error('answer.values.render must be an object');
  }
  assertAllowedKeys(value.render, ['v', 'digest'], [], 'answer.values.render');
  if (value.render.v !== 1) {
    throw new Error('answer.values.render.v must be 1');
  }
  if (!isHex64(value.render.digest)) {
    throw new Error('answer.values.render.digest must be 64 lowercase hex characters');
  }

  return {
    form,
    render: {
      v: 1,
      digest: value.render.digest,
    },
  };
}

function validateUnavailableAnswerValues(value: unknown): ScreenUnavailableAnswerValues {
  if (!isPlainObject(value)) {
    throw new Error('Screen answer values must be an object');
  }
  assertAllowedKeys(value, ['render'], [], 'answer.values');

  if (!isPlainObject(value.render)) {
    throw new Error('answer.values.render must be an object');
  }
  assertAllowedKeys(value.render, ['v', 'unavailable'], [], 'answer.values.render');
  if (value.render.v !== 1) {
    throw new Error('answer.values.render.v must be 1');
  }
  if (value.render.unavailable !== true) {
    throw new Error('answer.values.render.unavailable must be true');
  }

  return {
    render: {
      v: 1,
      unavailable: true,
    },
  };
}

/**
 * Validates the strict two-variant `values` object carried inside `GroupAnswer.values` for a screen reply:
 * - Rendered: `{ form, render: { v: 1, digest } }`
 * - Unavailable: `{ render: { v: 1, unavailable: true } }`
 */
export function validateScreenAnswerValues(value: unknown): ScreenAnswerValues {
  if (!isPlainObject(value)) {
    throw new Error('Screen answer values must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'form')) {
    return validateRenderedAnswerValues(value);
  }
  return validateUnavailableAnswerValues(value);
}

/**
 * Validates a complete decrypted screen `GroupAnswer` against the strict two-variant union:
 * - Rendered: `{ action: "a<n>", values: { form, render: { v: 1, digest } }, authenticated?: boolean }`
 * - Unavailable: `{ action: "dismiss", values: { render: { v: 1, unavailable: true } }, authenticated?: boolean }`
 *
 * Top-level `text`, unknown keys, and any cross-variant combinations are rejected.
 */
export function validateScreenAnswer(value: unknown): ScreenAnswer {
  if (!isPlainObject(value)) {
    throw new Error('Screen answer must be a JSON object');
  }
  assertAllowedKeys(value, ['action', 'values'], ['authenticated'], 'screen answer');
  if (value.authenticated !== undefined && typeof value.authenticated !== 'boolean') {
    throw new Error('Screen answer authenticated must be boolean');
  }

  let out: ScreenAnswer;
  if (isActionOrdinal(value.action)) {
    const values = validateRenderedAnswerValues(value.values);
    out =
      value.authenticated !== undefined
        ? { action: value.action, values, authenticated: value.authenticated }
        : { action: value.action, values };
  } else if (isScreenUnavailableAction(value.action)) {
    const values = validateUnavailableAnswerValues(value.values);
    out =
      value.authenticated !== undefined
        ? { action: SCREEN_UNAVAILABLE_ACTION, values, authenticated: value.authenticated }
        : { action: SCREEN_UNAVAILABLE_ACTION, values };
  } else {
    throw new Error('Screen answer action must be an action ordinal (a0..) or "dismiss"');
  }

  if (utf8ByteLength(JSON.stringify(out)) > SCREEN_PUBLIC_CAPS.maxRequestPlaintextBytes) {
    throw new Error('Screen answer exceeds maximum byte cap');
  }
  return out;
}

/**
 * Computes `contextDigest = hex(SHA-256("nb-screen-ctx-v1" || 0x00 || UTF-8(requestId) || 0x00 || plaintextBytes))`.
 */
export async function computeScreenContextDigest(
  requestId: string,
  plaintextBytes: Uint8Array
): Promise<string> {
  if (!isRoutingIdentifier(requestId)) {
    throw new Error('Invalid requestId for screen contextDigest');
  }
  if (plaintextBytes.length > SCREEN_PUBLIC_CAPS.maxRequestPlaintextBytes) {
    throw new Error('Screen plaintextBytes exceeds maximum byte cap');
  }
  const idBytes = utf8Encoder.encode(requestId);
  const buf = new Uint8Array(CONTEXT_DIGEST_DOMAIN.length + 1 + idBytes.length + 1 + plaintextBytes.length);
  let offset = 0;
  buf.set(CONTEXT_DIGEST_DOMAIN, offset);
  offset += CONTEXT_DIGEST_DOMAIN.length;
  buf[offset] = 0x00;
  offset += 1;
  buf.set(idBytes, offset);
  offset += idBytes.length;
  buf[offset] = 0x00;
  offset += 1;
  buf.set(plaintextBytes, offset);
  return toHex(await sha256(buf));
}

/**
 * Computes `renderDigest = hex(SHA-256("nb-screen-render-v1" || 0x00 || raw(contextDigest) || UTF-8(canon({ action, form }))))`.
 */
export async function computeScreenRenderDigest(
  contextDigestHex: string,
  action: string,
  form: ScreenFormMap
): Promise<string> {
  if (!isHex64(contextDigestHex)) {
    throw new Error('contextDigestHex must be 64 lowercase hex characters');
  }
  if (!isActionOrdinal(action)) {
    throw new Error('action must be a valid action ordinal (a0..)');
  }
  const contextBytes = fromHex(contextDigestHex);
  const canonBytes = utf8Encoder.encode(canonRenderInput(action, form));
  const buf = new Uint8Array(RENDER_DIGEST_DOMAIN.length + 1 + contextBytes.length + canonBytes.length);
  let offset = 0;
  buf.set(RENDER_DIGEST_DOMAIN, offset);
  offset += RENDER_DIGEST_DOMAIN.length;
  buf[offset] = 0x00;
  offset += 1;
  buf.set(contextBytes, offset);
  offset += contextBytes.length;
  buf.set(canonBytes, offset);
  return toHex(await sha256(buf));
}

export async function buildScreenAnswerValues(
  contextDigestHex: string,
  action: string,
  form: ScreenFormMap
): Promise<ScreenRenderedAnswerValues> {
  const validatedForm = validateScreenFormMap(form);
  const digest = await computeScreenRenderDigest(contextDigestHex, action, validatedForm);
  return validateRenderedAnswerValues({
    form: validatedForm,
    render: { v: 1, digest },
  });
}

export function buildScreenUnavailableAnswerValues(): ScreenUnavailableAnswerValues {
  return {
    render: { v: 1, unavailable: true },
  };
}

export async function buildScreenRenderedAnswer(
  contextDigestHex: string,
  action: string,
  form: ScreenFormMap,
  authenticated?: boolean
): Promise<ScreenRenderedAnswer> {
  if (!isActionOrdinal(action)) {
    throw new Error('action must be a valid action ordinal (a0..)');
  }
  const values = await buildScreenAnswerValues(contextDigestHex, action, form);
  const candidate =
    authenticated !== undefined ? { action, values, authenticated } : { action, values };
  return validateScreenAnswer(candidate) as ScreenRenderedAnswer;
}

export function buildScreenUnavailableAnswer(authenticated?: boolean): ScreenUnavailableAnswer {
  const values = buildScreenUnavailableAnswerValues();
  return authenticated !== undefined
    ? { action: SCREEN_UNAVAILABLE_ACTION, values, authenticated }
    : { action: SCREEN_UNAVAILABLE_ACTION, values };
}

export async function verifyScreenAnswerDigest(
  contextDigestHex: string,
  action: string,
  values: unknown
): Promise<{ form: ScreenFormMap; renderDigest: string }> {
  if (!isActionOrdinal(action)) {
    throw new Error('action must be a valid action ordinal (a0..)');
  }
  const parsed = validateRenderedAnswerValues(values);
  const expected = await computeScreenRenderDigest(contextDigestHex, action, parsed.form);
  if (parsed.render.digest !== expected) {
    throw new Error('Screen answer renderDigest mismatch');
  }
  return { form: parsed.form, renderDigest: parsed.render.digest };
}

export async function verifyScreenAnswer(
  contextDigestHex: string,
  answer: unknown
): Promise<VerifiedScreenAnswer> {
  if (!isHex64(contextDigestHex)) {
    throw new Error('contextDigestHex must be 64 lowercase hex characters');
  }
  const parsed = validateScreenAnswer(answer);
  if (parsed.action === SCREEN_UNAVAILABLE_ACTION) {
    return parsed.authenticated !== undefined
      ? { kind: 'unavailable', action: parsed.action, authenticated: parsed.authenticated }
      : { kind: 'unavailable', action: parsed.action };
  }
  const expected = await computeScreenRenderDigest(contextDigestHex, parsed.action, parsed.values.form);
  if (parsed.values.render.digest !== expected) {
    throw new Error('Screen answer renderDigest mismatch');
  }
  return parsed.authenticated !== undefined
    ? {
        kind: 'rendered',
        action: parsed.action,
        form: parsed.values.form,
        renderDigest: parsed.values.render.digest,
        authenticated: parsed.authenticated,
      }
    : {
        kind: 'rendered',
        action: parsed.action,
        form: parsed.values.form,
        renderDigest: parsed.values.render.digest,
      };
}
