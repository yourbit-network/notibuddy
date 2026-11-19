// Signed screen template record verification and runtime binding validation.

import { ecdsaVerify, fromB64u, toB64u } from './crypto.js';
import {
  canonJson,
  hasControlOrFormatScalar,
  isPlainObject,
  isSafeInt53,
  isValidUnicodeString,
  utf8ByteLength,
  type ScreenCanonValue,
} from './screen-canon.js';
import {
  buildScreenTaSigningInput,
  getScreenTaPublicKey,
  type ScreenSignedTemplateRecord,
  type ScreenTaKeyPurpose,
  type ScreenTaPublicKey,
} from './screen-catalog.js';
import {
  SCREEN_PUBLIC_CAPS,
  isValidTemplateId,
  type ScreenBlock,
  type ScreenDataSlot,
  type ScreenDataValue,
  type ScreenDiffSlot,
  type ScreenRequestPlaintext,
  type ScreenSkeleton,
  type ScreenTemplateId,
  type ScreenTextSlot,
} from './screen-types.js';
import { computeTemplateId, validateScreenSkeleton } from './screen-wire.js';

const TA_KID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const CANONICAL_B64U_SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const MAX_DIFF_FILENAME_BYTES = 512;
const MAX_DIFF_LANGUAGE_BYTES = 40;

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

export function countGraphemes(text: string): number {
  let count = 0;
  for (const _segment of graphemeSegmenter.segment(text)) {
    count += 1;
  }
  return count;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function isCanonicalP256Signature(sig: unknown): sig is string {
  if (typeof sig !== 'string' || !CANONICAL_B64U_SIG_RE.test(sig)) return false;
  let bytes: Uint8Array;
  try {
    bytes = fromB64u(sig);
  } catch {
    return false;
  }
  if (bytes.length !== 64 || toB64u(bytes) !== sig) return false;
  const r = bytesToBigInt(bytes.subarray(0, 32));
  const s = bytesToBigInt(bytes.subarray(32, 64));
  return r >= 1n && r < P256_ORDER && s >= 1n && s < P256_ORDER;
}

export interface VerifyTemplateRecordOptions {
  expectedTemplateId?: ScreenTemplateId;
  expectedPurpose?: ScreenTaKeyPurpose;
  resolveTaPublicKey?: (kid: string) => ScreenTaPublicKey | undefined;
}

/**
 * Verifies a signed screen template record against pinned public keys,
 * strict 5-key record format, content-addressed `templateId`, public caps,
 * and ECDSA P-256 signature over `nb-screen-ta-v1 || 0x00 || kid || 0x00 || templateId`.
 */
export async function verifySignedTemplateRecord(
  value: unknown,
  options: VerifyTemplateRecordOptions = {}
): Promise<ScreenSignedTemplateRecord> {
  if (!isPlainObject(value)) {
    throw new Error('Template record must be a JSON object');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 5 || keys.join(',') !== 'kid,sig,skeleton,templateId,v') {
    throw new Error('Template record must contain exact keys v, kid, templateId, skeleton, sig');
  }
  if (value.v !== 1) {
    throw new Error('Unsupported template record version');
  }
  if (typeof value.kid !== 'string' || !TA_KID_RE.test(value.kid)) {
    throw new Error('Invalid template key identifier');
  }
  if (!isValidTemplateId(value.templateId)) {
    throw new Error('Invalid templateId in template record');
  }
  if (options.expectedTemplateId !== undefined && value.templateId !== options.expectedTemplateId) {
    throw new Error('Template record templateId does not match expected templateId');
  }
  if (!isCanonicalP256Signature(value.sig)) {
    throw new Error('Invalid template record signature encoding');
  }

  const skeleton = validateScreenSkeleton(value.skeleton);
  const computedId = await computeTemplateId(skeleton);
  if (computedId !== value.templateId) {
    throw new Error('Template skeleton hash does not match templateId');
  }

  const resolveKey = options.resolveTaPublicKey ?? getScreenTaPublicKey;
  const keyEntry = resolveKey(value.kid);
  if (!keyEntry || keyEntry.algorithm !== 'ES256') {
    throw new Error(`Unknown template signing key: ${value.kid}`);
  }
  if (options.expectedPurpose !== undefined && keyEntry.purpose !== options.expectedPurpose) {
    throw new Error(`Template signing key ${value.kid} has unexpected purpose`);
  }

  const signingInput = buildScreenTaSigningInput(value.kid, value.templateId);
  const verified = await ecdsaVerify(keyEntry.publicKeyB64u, signingInput, value.sig);
  if (!verified) {
    throw new Error('Template record signature verification failed');
  }

  return {
    v: 1,
    kid: value.kid,
    templateId: value.templateId,
    skeleton,
    sig: value.sig,
  };
}

export function serializeTemplateRecord(record: ScreenSignedTemplateRecord): string {
  return canonJson({
    v: 1,
    kid: record.kid,
    templateId: record.templateId,
    skeleton: record.skeleton as unknown as ScreenCanonValue,
    sig: record.sig,
  });
}

interface TextSlotEntry {
  slot: ScreenTextSlot;
  required: boolean;
}

type DataSlotBinding =
  | { kind: 'checklist'; checklistId: string; slot: ScreenDataSlot }
  | { kind: 'picker'; fieldId: string; slot: ScreenDataSlot }
  | { kind: 'kpiStrip'; slot: ScreenDataSlot }
  | { kind: 'keyValueList'; slot: ScreenDataSlot };

interface SlotInventory {
  textSlots: Map<string, TextSlotEntry>;
  dataSlots: Map<string, DataSlotBinding>;
  diffSlots: Map<string, ScreenDiffSlot>;
}

function collectSlotInventory(skeleton: ScreenSkeleton): SlotInventory {
  const textSlots = new Map<string, TextSlotEntry>();
  const dataSlots = new Map<string, DataSlotBinding>();
  const diffSlots = new Map<string, ScreenDiffSlot>();

  const visit = (block: ScreenBlock): void => {
    switch (block.kind) {
      case 'vstack':
        for (const child of block.children) visit(child);
        break;
      case 'card':
        if (block.header) textSlots.set(block.header.slot, { slot: block.header, required: false });
        for (const child of block.children) visit(child);
        break;
      case 'divider':
        break;
      case 'heading':
      case 'text':
        textSlots.set(block.text.slot, { slot: block.text, required: true });
        break;
      case 'badge':
        textSlots.set(block.label.slot, { slot: block.label, required: true });
        break;
      case 'alert':
        textSlots.set(block.title.slot, { slot: block.title, required: true });
        if (block.body) textSlots.set(block.body.slot, { slot: block.body, required: false });
        break;
      case 'kpiStrip':
        dataSlots.set(block.items.slot, { kind: 'kpiStrip', slot: block.items });
        break;
      case 'keyValueList':
        dataSlots.set(block.rows.slot, { kind: 'keyValueList', slot: block.rows });
        break;
      case 'checklist':
        if (block.title) textSlots.set(block.title.slot, { slot: block.title, required: false });
        dataSlots.set(block.items.slot, { kind: 'checklist', checklistId: block.id, slot: block.items });
        break;
      case 'diffViewer':
        diffSlots.set(block.diff.slot, block.diff);
        break;
      case 'formField':
        textSlots.set(block.label.slot, { slot: block.label, required: true });
        if (
          (block.fieldType === 'text' ||
            block.fieldType === 'email' ||
            block.fieldType === 'url' ||
            block.fieldType === 'secret' ||
            block.fieldType === 'date' ||
            block.fieldType === 'picker') &&
          block.placeholder
        ) {
          textSlots.set(block.placeholder.slot, { slot: block.placeholder, required: false });
        }
        if (block.fieldType === 'picker') {
          dataSlots.set(block.options.slot, { kind: 'picker', fieldId: block.id, slot: block.options });
        }
        break;
    }
  };

  visit(skeleton.root);
  for (const action of skeleton.actions) {
    textSlots.set(action.label.slot, { slot: action.label, required: true });
  }

  return { textSlots, dataSlots, diffSlots };
}

function validateScalarValue(value: ScreenDataValue, context: string): void {
  if (typeof value === 'string') {
    if (!isValidUnicodeString(value) || hasControlOrFormatScalar(value)) {
      throw new Error(`${context} contains invalid or control characters`);
    }
    return;
  }
  if (typeof value === 'boolean') return;
  if (isSafeInt53(value)) return;
  throw new Error(`${context} must be a scalar string, boolean, or safe integer`);
}

function validateStructuredRow(item: ScreenDataValue, primaryKey: 'label' | 'key', context: string): void {
  if (!isPlainObject(item)) {
    throw new Error(`${context} must be an object`);
  }
  const primary = item[primaryKey];
  if (
    typeof primary !== 'string' ||
    !isValidUnicodeString(primary) ||
    hasControlOrFormatScalar(primary) ||
    primary.trim().length === 0
  ) {
    throw new Error(`${context}.${primaryKey} must be a non-empty display string`);
  }
  if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
    throw new Error(`${context}.value is required`);
  }
  for (const [k, v] of Object.entries(item)) {
    if (hasControlOrFormatScalar(k)) {
      throw new Error(`${context} key contains control or format characters`);
    }
    validateScalarValue(v as ScreenDataValue, `${context}.${k}`);
  }
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0x0a) lines += 1;
  }
  return lines;
}

export interface ScreenRuntimeCounts {
  checklistCounts: Record<string, number>;
  pickerOptionCounts: Record<string, number>;
}

/**
 * Validates runtime `labels` and `data` in a `ScreenRequestPlaintext` against
 * a verified `ScreenSkeleton`, returning derived checklist and picker option counts.
 */
export function validateScreenRequestBindings(
  skeleton: ScreenSkeleton,
  request: Pick<ScreenRequestPlaintext, 'labels' | 'data'>
): ScreenRuntimeCounts {
  const inventory = collectSlotInventory(skeleton);

  for (const key of Object.keys(request.labels)) {
    if (!inventory.textSlots.has(key)) {
      throw new Error(`Undeclared label slot "${key}" for screen template`);
    }
  }

  for (const [slotId, entry] of inventory.textSlots) {
    const text = Object.prototype.hasOwnProperty.call(request.labels, slotId)
      ? request.labels[slotId]
      : undefined;
    if (text === undefined) {
      if (entry.required) {
        throw new Error(`Missing required label for slot "${slotId}"`);
      }
      continue;
    }
    const maxBytes = Math.min(entry.slot.maxBytes, SCREEN_PUBLIC_CAPS.maxLabelBytes);
    const maxGraphemes = Math.min(entry.slot.maxGraphemes, SCREEN_PUBLIC_CAPS.maxSlotGraphemes);
    if (hasControlOrFormatScalar(text) || !isValidUnicodeString(text)) {
      throw new Error(`Label for slot "${slotId}" contains invalid characters`);
    }
    if (utf8ByteLength(text) > maxBytes) {
      throw new Error(`Label for slot "${slotId}" exceeds maxBytes (${maxBytes})`);
    }
    if (countGraphemes(text) > maxGraphemes) {
      throw new Error(`Label for slot "${slotId}" exceeds maxGraphemes (${maxGraphemes})`);
    }
    if (entry.required && text.trim().length === 0) {
      throw new Error(`Required label for slot "${slotId}" must not be empty`);
    }
    if (!entry.required && text.length > 0 && text.trim().length === 0) {
      throw new Error(`Optional label for slot "${slotId}" cannot be whitespace only`);
    }
  }

  for (const key of Object.keys(request.data)) {
    if (!inventory.dataSlots.has(key) && !inventory.diffSlots.has(key)) {
      throw new Error(`Undeclared data slot "${key}" for screen template`);
    }
  }

  const checklistCounts: Record<string, number> = {};
  const pickerOptionCounts: Record<string, number> = {};

  for (const [slotId, binding] of inventory.dataSlots) {
    if (!Object.prototype.hasOwnProperty.call(request.data, slotId)) {
      throw new Error(`Missing required data for slot "${slotId}"`);
    }
    const value = request.data[slotId];
    if (!Array.isArray(value)) {
      throw new Error(`Data slot "${slotId}" must be an array`);
    }
    const minItems = binding.slot.minItems ?? 0;
    const maxItems = Math.min(binding.slot.maxItems, SCREEN_PUBLIC_CAPS.maxItemsPerList);
    if (value.length < minItems || value.length > maxItems) {
      throw new Error(`Data slot "${slotId}" item count (${value.length}) outside [${minItems}, ${maxItems}]`);
    }
    const maxBytes = Math.min(binding.slot.maxBytes, SCREEN_PUBLIC_CAPS.maxSlotBytes);
    const canonicalBytes = utf8ByteLength(canonJson(value as unknown as ScreenCanonValue));
    if (canonicalBytes > maxBytes) {
      throw new Error(`Data slot "${slotId}" exceeds maxBytes (${maxBytes})`);
    }

    if (binding.kind === 'checklist' || binding.kind === 'picker') {
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        if (
          typeof item !== 'string' ||
          !isValidUnicodeString(item) ||
          hasControlOrFormatScalar(item) ||
          item.trim().length === 0
        ) {
          throw new Error(`Data slot "${slotId}[${i}]" must be a non-empty display string`);
        }
      }
      if (binding.kind === 'checklist') {
        checklistCounts[binding.checklistId] = value.length;
      } else {
        pickerOptionCounts[binding.fieldId] = value.length;
      }
    } else if (binding.kind === 'kpiStrip') {
      for (let i = 0; i < value.length; i += 1) {
        validateStructuredRow(value[i] as ScreenDataValue, 'label', `data.${slotId}[${i}]`);
      }
    } else if (binding.kind === 'keyValueList') {
      for (let i = 0; i < value.length; i += 1) {
        validateStructuredRow(value[i] as ScreenDataValue, 'key', `data.${slotId}[${i}]`);
      }
    }
  }

  for (const [slotId, diffSlot] of inventory.diffSlots) {
    if (!Object.prototype.hasOwnProperty.call(request.data, slotId)) {
      throw new Error(`Missing required diff data for slot "${slotId}"`);
    }
    const value = request.data[slotId];
    const maxBytes = Math.min(diffSlot.maxBytes, SCREEN_PUBLIC_CAPS.maxDiffBytes);
    const maxLines = Math.min(diffSlot.maxLines, SCREEN_PUBLIC_CAPS.maxDiffLines);
    if (typeof value === 'string') {
      if (utf8ByteLength(value) > maxBytes || countLines(value) > maxLines) {
        throw new Error(`Diff slot "${slotId}" exceeds maxBytes or maxLines`);
      }
    } else if (isPlainObject(value)) {
      const allowed = new Set(['filename', 'language', 'original', 'modified']);
      for (const k of Object.keys(value)) {
        if (!allowed.has(k)) throw new Error(`Unexpected key "${k}" in diff slot "${slotId}"`);
      }
      const { filename, language, original, modified } = value;
      if (
        typeof filename !== 'string' ||
        hasControlOrFormatScalar(filename) ||
        filename.trim().length === 0 ||
        utf8ByteLength(filename) > MAX_DIFF_FILENAME_BYTES
      ) {
        throw new Error(`Invalid filename in diff slot "${slotId}"`);
      }
      if (
        language !== undefined &&
        (typeof language !== 'string' ||
          hasControlOrFormatScalar(language) ||
          utf8ByteLength(language) > MAX_DIFF_LANGUAGE_BYTES)
      ) {
        throw new Error(`Invalid language in diff slot "${slotId}"`);
      }
      if (typeof original !== 'string' || typeof modified !== 'string') {
        throw new Error(`Diff slot "${slotId}" requires string original and modified`);
      }
      if (
        utf8ByteLength(original) + utf8ByteLength(modified) > maxBytes ||
        countLines(original) + countLines(modified) > maxLines
      ) {
        throw new Error(`Diff slot "${slotId}" exceeds maxBytes or maxLines`);
      }
    } else {
      throw new Error(`Diff slot "${slotId}" must be a diff object or unified diff string`);
    }
  }

  return { checklistCounts, pickerOptionCounts };
}
