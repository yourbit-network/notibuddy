// Signed screen template record verification and runtime binding validation.

import { ecdsaVerify, fromB64u, toB64u } from './crypto.js';
import {
  canonJson,
  describeDisallowedControlOrFormatScalar,
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
import { formatScreenTemplateBriefHint, getSemanticSlotName } from './screen-describe.js';
import { computeTemplateId, countGraphemes, validateScreenSkeleton } from './screen-skeleton.js';
export { countGraphemes };
import {
  SCREEN_PUBLIC_CAPS,
  isSlotOrdinal,
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

const TA_KID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const CANONICAL_B64U_SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const MAX_DIFF_FILENAME_BYTES = 512;
const MAX_DIFF_LANGUAGE_BYTES = 40;

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
  element: string;
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
        if (block.header) {
          textSlots.set(block.header.slot, { slot: block.header, required: false, element: 'card header' });
        }
        for (const child of block.children) visit(child);
        break;
      case 'divider':
        break;
      case 'heading':
        textSlots.set(block.text.slot, {
          slot: block.text,
          required: true,
          element: `heading (h${block.level ?? 2})`,
        });
        break;
      case 'text':
        textSlots.set(block.text.slot, {
          slot: block.text,
          required: true,
          element: `text (${block.style ?? 'body'})`,
        });
        break;
      case 'badge':
        textSlots.set(block.label.slot, {
          slot: block.label,
          required: true,
          element: `badge (${block.tone})`,
        });
        break;
      case 'alert':
        textSlots.set(block.title.slot, {
          slot: block.title,
          required: true,
          element: `alert title (${block.severity})`,
        });
        if (block.body) {
          textSlots.set(block.body.slot, {
            slot: block.body,
            required: false,
            element: `alert body (${block.severity})`,
          });
        }
        break;
      case 'kpiStrip':
        dataSlots.set(block.items.slot, { kind: 'kpiStrip', slot: block.items });
        break;
      case 'keyValueList':
        dataSlots.set(block.rows.slot, { kind: 'keyValueList', slot: block.rows });
        break;
      case 'checklist':
        if (block.title) {
          textSlots.set(block.title.slot, {
            slot: block.title,
            required: false,
            element: `checklist title (${block.id})`,
          });
        }
        dataSlots.set(block.items.slot, { kind: 'checklist', checklistId: block.id, slot: block.items });
        break;
      case 'diffViewer':
        diffSlots.set(block.diff.slot, block.diff);
        break;
      case 'formField':
        textSlots.set(block.label.slot, {
          slot: block.label,
          required: true,
          element: `${block.fieldType} field label (${block.id})`,
        });
        if (
          (block.fieldType === 'text' ||
            block.fieldType === 'email' ||
            block.fieldType === 'url' ||
            block.fieldType === 'secret' ||
            block.fieldType === 'date' ||
            block.fieldType === 'picker') &&
          block.placeholder
        ) {
          textSlots.set(block.placeholder.slot, {
            slot: block.placeholder,
            required: false,
            element: `${block.fieldType} placeholder (${block.id})`,
          });
        }
        if (block.fieldType === 'picker') {
          dataSlots.set(block.options.slot, { kind: 'picker', fieldId: block.id, slot: block.options });
        }
        break;
    }
  };

  visit(skeleton.root);
  for (const action of skeleton.actions) {
    const bioSuffix = action.requireBio ? ', Face ID' : '';
    textSlots.set(action.label.slot, {
      slot: action.label,
      required: true,
      element: `${action.role} action button (${action.id}${bioSuffix})`,
    });
  }

  return { textSlots, dataSlots, diffSlots };
}

function describeDataSlotShape(binding: DataSlotBinding): string {
  switch (binding.kind) {
    case 'kpiStrip':
      return 'kpiStrip: Array<{ label, value }>';
    case 'keyValueList':
      return 'keyValueList: Array<{ key, value }>';
    case 'checklist':
      return `checklist (${binding.checklistId}): string[]`;
    case 'picker':
      return `picker (${binding.fieldId}): string[]`;
  }
}

function validateScalarValueErrors(value: ScreenDataValue, context: string, errors: string[]): void {
  if (typeof value === 'string') {
    if (!isValidUnicodeString(value)) {
      errors.push(`${context} must be valid Unicode`);
      return;
    }
    const badChar = describeDisallowedControlOrFormatScalar(value);
    if (badChar) {
      errors.push(
        `${context} contains disallowed ${badChar} (display values do not allow newlines or control characters)`
      );
    }
    return;
  }
  if (typeof value === 'boolean') return;
  if (isSafeInt53(value)) return;
  errors.push(`${context} must be a scalar string, boolean, or safe integer`);
}

function validateStructuredRowErrors(
  item: ScreenDataValue,
  primaryKey: 'label' | 'key',
  context: string,
  shapeHint: string,
  errors: string[]
): void {
  if (!isPlainObject(item)) {
    errors.push(`${context} must be an object (${shapeHint})`);
    return;
  }
  const primary = item[primaryKey];
  if (typeof primary !== 'string' || !isValidUnicodeString(primary) || primary.trim().length === 0) {
    errors.push(`${context}.${primaryKey} must be a non-empty display string (${shapeHint})`);
  } else {
    const badPrimaryChar = describeDisallowedControlOrFormatScalar(primary);
    if (badPrimaryChar) {
      errors.push(`${context}.${primaryKey} contains disallowed ${badPrimaryChar}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
    errors.push(`${context}.value is required (${shapeHint})`);
  }
  for (const [k, v] of Object.entries(item)) {
    const badKeyChar = describeDisallowedControlOrFormatScalar(k);
    if (badKeyChar) {
      errors.push(`${context} key "${k}" contains disallowed ${badKeyChar}`);
    }
    validateScalarValueErrors(v as ScreenDataValue, `${context}.${k}`, errors);
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

export interface CollectScreenBindingErrorsResult extends ScreenRuntimeCounts {
  errors: string[];
}

/**
 * Collects all label, data, and diff binding validation errors in one pass
 * against a `ScreenSkeleton`, returning derived counts and actionable error messages.
 */
export function collectScreenBindingErrors(
  skeleton: ScreenSkeleton,
  request: Pick<ScreenRequestPlaintext, 'labels' | 'data'>,
  templateSlug?: string
): CollectScreenBindingErrorsResult {
  const inventory = collectSlotInventory(skeleton);
  const errors: string[] = [];
  const slotTag = (slotId: string) => {
    const sem = templateSlug ? getSemanticSlotName(templateSlug, slotId) : undefined;
    return sem ? `"${sem}" / ${slotId}` : slotId;
  };
  const validLabelSlots = [...inventory.textSlots.keys()].map(slotTag).join(', ') || 'none';
  const validDataSlots =
    [...inventory.dataSlots.keys(), ...inventory.diffSlots.keys()].map(slotTag).join(', ') || 'none';

  for (const key of Object.keys(request.labels)) {
    if (!inventory.textSlots.has(key)) {
      if (!isSlotOrdinal(key)) {
        errors.push(
          `Invalid label slot key "${key}" (templates use numbered slots s0, s1, ...; valid screen.labels slots here: ${validLabelSlots})`
        );
      } else if (inventory.dataSlots.has(key)) {
        const shape = describeDataSlotShape(inventory.dataSlots.get(key)!);
        errors.push(
          `Undeclared label slot "${key}" for screen template ("${key}" is a ${shape} slot — move it into screen.data.${key})`
        );
      } else if (inventory.diffSlots.has(key)) {
        errors.push(
          `Undeclared label slot "${key}" for screen template ("${key}" is a diffViewer slot — move it into screen.data.${key})`
        );
      } else {
        errors.push(
          `Undeclared label slot "${key}" for screen template (valid screen.labels slots here: ${validLabelSlots})`
        );
      }
    }
  }

  for (const [slotId, entry] of inventory.textSlots) {
    const maxBytes = Math.min(entry.slot.maxBytes, SCREEN_PUBLIC_CAPS.maxLabelBytes);
    const maxGraphemes = Math.min(entry.slot.maxGraphemes, SCREEN_PUBLIC_CAPS.maxSlotGraphemes);
    const sem = templateSlug ? getSemanticSlotName(templateSlug, slotId) : undefined;
    const semPrefix = sem ? `"${sem}", ` : '';
    const text = Object.prototype.hasOwnProperty.call(request.labels, slotId)
      ? request.labels[slotId]
      : undefined;
    if (text === undefined) {
      if (entry.required) {
        errors.push(
          `Missing required label for slot "${slotId}" (${semPrefix}${entry.element}, max ${maxGraphemes} chars)`
        );
      }
      continue;
    }
    if (typeof text !== 'string') {
      errors.push(`Label for slot "${slotId}" (${semPrefix}${entry.element}) must be a string`);
      continue;
    }
    if (!isValidUnicodeString(text)) {
      errors.push(`Label for slot "${slotId}" contains invalid Unicode (${semPrefix}${entry.element})`);
    } else {
      const badChar = describeDisallowedControlOrFormatScalar(text);
      if (badChar) {
        errors.push(
          `Label for slot "${slotId}" contains disallowed ${badChar} (${semPrefix}${entry.element}; text blocks do not allow newlines or control characters — split lines into multiple text blocks, keyValueList, or diffViewer)`
        );
      }
    }
    if (utf8ByteLength(text) > maxBytes) {
      errors.push(
        `Label for slot "${slotId}" exceeds maxBytes (${maxBytes}) (${semPrefix}for ${entry.element}; shorten to <= ${maxBytes} UTF-8 bytes)`
      );
    }
    const graphemes = countGraphemes(text);
    if (graphemes > maxGraphemes) {
      errors.push(
        `Label for slot "${slotId}" exceeds maxGraphemes (${maxGraphemes}) (got ${graphemes} chars for ${semPrefix}${entry.element}; shorten to <= ${maxGraphemes} chars)`
      );
    }
    if (entry.required && text.trim().length === 0) {
      errors.push(`Required label for slot "${slotId}" must not be empty (${semPrefix}${entry.element})`);
    }
    if (!entry.required && text.length > 0 && text.trim().length === 0) {
      errors.push(`Optional label for slot "${slotId}" cannot be whitespace only (${semPrefix}${entry.element})`);
    }
  }

  for (const key of Object.keys(request.data)) {
    if (!inventory.dataSlots.has(key) && !inventory.diffSlots.has(key)) {
      if (!isSlotOrdinal(key)) {
        errors.push(
          `Invalid data slot key "${key}" (templates use numbered slots s0, s1, ...; valid screen.data slots here: ${validDataSlots})`
        );
      } else if (inventory.textSlots.has(key)) {
        const textEntry = inventory.textSlots.get(key)!;
        errors.push(
          `Undeclared data slot "${key}" for screen template ("${key}" is a text label [${textEntry.element}] — move it into screen.labels.${key})`
        );
      } else {
        errors.push(
          `Undeclared data slot "${key}" for screen template (valid screen.data slots here: ${validDataSlots})`
        );
      }
    }
  }

  const checklistCounts: Record<string, number> = {};
  const pickerOptionCounts: Record<string, number> = {};

  for (const [slotId, binding] of inventory.dataSlots) {
    const minItems = binding.slot.minItems ?? 0;
    const maxItems = Math.min(binding.slot.maxItems, SCREEN_PUBLIC_CAPS.maxItemsPerList);
    const sem = templateSlug ? getSemanticSlotName(templateSlug, slotId) : undefined;
    const shapeDesc = `${sem ? `"${sem}", ` : ''}${describeDataSlotShape(binding)}`;
    if (!Object.prototype.hasOwnProperty.call(request.data, slotId)) {
      errors.push(`Missing required data for slot "${slotId}" (${shapeDesc}, ${minItems}..${maxItems} items)`);
      continue;
    }
    const value = request.data[slotId];
    if (!Array.isArray(value)) {
      errors.push(`Data slot "${slotId}" must be an array (${shapeDesc}, ${minItems}..${maxItems} items)`);
      continue;
    }
    if (value.length < minItems || value.length > maxItems) {
      errors.push(`Data slot "${slotId}" item count (${value.length}) outside [${minItems}, ${maxItems}] (${shapeDesc})`);
    }
    const maxBytes = Math.min(binding.slot.maxBytes, SCREEN_PUBLIC_CAPS.maxSlotBytes);
    try {
      const canonicalBytes = utf8ByteLength(canonJson(value as unknown as ScreenCanonValue));
      if (canonicalBytes > maxBytes) {
        errors.push(`Data slot "${slotId}" exceeds maxBytes (${maxBytes}) (${shapeDesc})`);
      }
    } catch (error) {
      errors.push(
        `Data slot "${slotId}" contains unsupported value: ${error instanceof Error ? error.message : 'invalid JSON value'}`
      );
    }

    if (binding.kind === 'checklist' || binding.kind === 'picker') {
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        if (typeof item !== 'string' || !isValidUnicodeString(item) || item.trim().length === 0) {
          errors.push(`Data slot "${slotId}[${i}]" must be a non-empty display string (${shapeDesc})`);
        } else {
          const badItemChar = describeDisallowedControlOrFormatScalar(item);
          if (badItemChar) {
            errors.push(`Data slot "${slotId}[${i}]" contains disallowed ${badItemChar} (${shapeDesc})`);
          }
        }
      }
      if (binding.kind === 'checklist') {
        checklistCounts[binding.checklistId] = value.length;
      } else {
        pickerOptionCounts[binding.fieldId] = value.length;
      }
    } else if (binding.kind === 'kpiStrip') {
      for (let i = 0; i < value.length; i += 1) {
        validateStructuredRowErrors(
          value[i] as ScreenDataValue,
          'label',
          `data.${slotId}[${i}]`,
          'kpiStrip items require { label, value }, not { key, value }',
          errors
        );
      }
    } else if (binding.kind === 'keyValueList') {
      for (let i = 0; i < value.length; i += 1) {
        validateStructuredRowErrors(
          value[i] as ScreenDataValue,
          'key',
          `data.${slotId}[${i}]`,
          'keyValueList items require { key, value }, not { label, value }',
          errors
        );
      }
    }
  }

  for (const [slotId, diffSlot] of inventory.diffSlots) {
    const maxBytes = Math.min(diffSlot.maxBytes, SCREEN_PUBLIC_CAPS.maxDiffBytes);
    const maxLines = Math.min(diffSlot.maxLines, SCREEN_PUBLIC_CAPS.maxDiffLines);
    const sem = templateSlug ? getSemanticSlotName(templateSlug, slotId) : undefined;
    const semPrefix = sem ? `"${sem}", ` : '';
    if (!Object.prototype.hasOwnProperty.call(request.data, slotId)) {
      errors.push(
        `Missing required diff data for slot "${slotId}" (${semPrefix}{ filename, language?, original, modified } or unified diff string, max ${maxLines} lines)`
      );
      continue;
    }
    const value = request.data[slotId];
    if (typeof value === 'string') {
      if (utf8ByteLength(value) > maxBytes || countLines(value) > maxLines) {
        errors.push(`Diff slot "${slotId}" exceeds maxBytes or maxLines (max ${maxBytes} B / ${maxLines} lines)`);
      }
    } else if (isPlainObject(value)) {
      const allowed = new Set(['filename', 'language', 'original', 'modified']);
      for (const k of Object.keys(value)) {
        if (!allowed.has(k)) {
          errors.push(`Unexpected key "${k}" in diff slot "${slotId}" (allowed: filename, language, original, modified)`);
        }
      }
      const { filename, language, original, modified } = value;
      if (
        typeof filename !== 'string' ||
        hasControlOrFormatScalar(filename) ||
        filename.trim().length === 0 ||
        utf8ByteLength(filename) > MAX_DIFF_FILENAME_BYTES
      ) {
        errors.push(`Invalid filename in diff slot "${slotId}"`);
      }
      if (
        language !== undefined &&
        (typeof language !== 'string' ||
          hasControlOrFormatScalar(language) ||
          utf8ByteLength(language) > MAX_DIFF_LANGUAGE_BYTES)
      ) {
        errors.push(`Invalid language in diff slot "${slotId}"`);
      }
      if (typeof original !== 'string' || typeof modified !== 'string') {
        errors.push(`Diff slot "${slotId}" requires string original and modified`);
      } else if (
        utf8ByteLength(original) + utf8ByteLength(modified) > maxBytes ||
        countLines(original) + countLines(modified) > maxLines
      ) {
        errors.push(`Diff slot "${slotId}" exceeds maxBytes or maxLines (max ${maxBytes} B / ${maxLines} lines)`);
      }
    } else {
      errors.push(`Diff slot "${slotId}" must be a diff object or unified diff string`);
    }
  }

  return { errors, checklistCounts, pickerOptionCounts };
}

/**
 * Validates runtime `labels` and `data` in a `ScreenRequestPlaintext` against
 * a verified `ScreenSkeleton`, returning derived checklist and picker option counts.
 */
export function validateScreenRequestBindings(
  skeleton: ScreenSkeleton,
  request: Pick<ScreenRequestPlaintext, 'labels' | 'data'>,
  templateSlug?: string
): ScreenRuntimeCounts {
  const { errors, checklistCounts, pickerOptionCounts } = collectScreenBindingErrors(
    skeleton,
    request,
    templateSlug
  );
  if (errors.length === 0) {
    return { checklistCounts, pickerOptionCounts };
  }
  const briefHint = templateSlug ? formatScreenTemplateBriefHint(templateSlug) : '';
  const suffix = briefHint ? `\n\n${briefHint}` : '';
  if (errors.length === 1) {
    throw new Error(`${errors[0]}${suffix}`);
  }
  throw new Error(`Screen validation failed (${errors.length} errors):\n- ${errors.join('\n- ')}${suffix}`);
}
