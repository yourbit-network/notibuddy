// Client-side screen template skeletonizer, pre-order ordinal assigner, and feedback re-hydrator.
// Separates inline text/data literals into encrypted `labels` and `data` locally before
// transmitting zero-literal skeletons to `POST /v2/templates`.

import { bytesToHex, countGraphemes, sha256Bytes, validateScreenSkeleton } from './screen-skeleton.js';
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
  SCREEN_PUBLIC_CAPS,
  isActionOrdinal,
  isChecklistOrdinal,
  isFieldOrdinal,
  isSlotOrdinal,
  type ScreenAction,
  type ScreenActionId,
  type ScreenActionRole,
  type ScreenAlertSeverity,
  type ScreenBadgeTone,
  type ScreenBlock,
  type ScreenChecklistId,
  type ScreenDataSlot,
  type ScreenDataValue,
  type ScreenDiffSlot,
  type ScreenFieldId,
  type ScreenFormFieldBlock,
  type ScreenHeadingLevel,
  type ScreenPredicate,
  type ScreenSkeleton,
  type ScreenSlotId,
  type ScreenSpacing,
  type ScreenTextSlot,
  type ScreenTextStyle,
} from './screen-types.js';

import {
  BLOCK_KIND_ALERT,
  BLOCK_KIND_BADGE,
  BLOCK_KIND_CARD,
  BLOCK_KIND_CHECKLIST,
  BLOCK_KIND_DIFF_VIEWER,
  BLOCK_KIND_DIVIDER,
  BLOCK_KIND_FORM_FIELD,
  BLOCK_KIND_HEADING,
  BLOCK_KIND_KEY_VALUE_LIST,
  BLOCK_KIND_KPI_STRIP,
  BLOCK_KIND_TEXT,
  BLOCK_KIND_VSTACK,
  OPT_FLAG_HAS_OPTIONAL_TEXT,
  OPT_FLAG_IS_PICKER,
  assignActionSlotOrdinals,
  assignChecklistOrdinals,
  assignFieldOrdinals,
  assignNodeSlotStarts,
  slotArity,
} from './screen-ordinals.js';
export {
  BLOCK_KIND_ALERT,
  BLOCK_KIND_BADGE,
  BLOCK_KIND_CARD,
  BLOCK_KIND_CHECKLIST,
  BLOCK_KIND_DIFF_VIEWER,
  BLOCK_KIND_DIVIDER,
  BLOCK_KIND_FORM_FIELD,
  BLOCK_KIND_HEADING,
  BLOCK_KIND_KEY_VALUE_LIST,
  BLOCK_KIND_KPI_STRIP,
  BLOCK_KIND_TEXT,
  BLOCK_KIND_VSTACK,
  OPT_FLAG_HAS_OPTIONAL_TEXT,
  OPT_FLAG_IS_PICKER,
  assignActionSlotOrdinals,
  assignChecklistOrdinals,
  assignFieldOrdinals,
  assignNodeSlotStarts,
  slotArity,
} from './screen-ordinals.js';

export const SKELETONIZER_VERSION = 1 as const;

const BLOCK_KIND_CODES: Readonly<Record<string, number>> = {
  vstack: BLOCK_KIND_VSTACK,
  card: BLOCK_KIND_CARD,
  divider: BLOCK_KIND_DIVIDER,
  heading: BLOCK_KIND_HEADING,
  text: BLOCK_KIND_TEXT,
  badge: BLOCK_KIND_BADGE,
  alert: BLOCK_KIND_ALERT,
  kpiStrip: BLOCK_KIND_KPI_STRIP,
  keyValueList: BLOCK_KIND_KEY_VALUE_LIST,
  checklist: BLOCK_KIND_CHECKLIST,
  diffViewer: BLOCK_KIND_DIFF_VIEWER,
  formField: BLOCK_KIND_FORM_FIELD,
};

export interface ScreenFeedbackItem {
  code: string;
  message: string;
  at?: string;
  ordinal?: string;
}

export interface ScreenOrdinalMap {
  fieldToAuthored: Record<string, string>;
  authoredToField: Record<string, ScreenFieldId>;
  checklistToAuthored: Record<string, string>;
  authoredToChecklist: Record<string, ScreenChecklistId>;
  actionToAuthored: Record<string, string>;
  authoredToAction: Record<string, ScreenActionId>;
  slotOrigin: Record<string, { path: string; inline: boolean }>;
  usedSemanticIds: boolean;
  usedInlineLiterals: boolean;
}

export interface SkeletonizedScreen {
  skeleton: ScreenSkeleton;
  labels: Record<string, string>;
  data: Record<string, ScreenDataValue>;
  inputSkeletonHash: string;
  ordinalMap: ScreenOrdinalMap;
}

export class ScreenSkeletonizeError extends Error {
  readonly code = 'INVALID_TEMPLATE';
  readonly fixes: ScreenFeedbackItem[];
  readonly partial?: {
    skeleton: ScreenSkeleton;
    labels: Record<string, string>;
    data: Record<string, ScreenDataValue>;
    ordinalMap: ScreenOrdinalMap;
  };

  constructor(
    fixes: ScreenFeedbackItem[],
    partial?: {
      skeleton: ScreenSkeleton;
      labels: Record<string, string>;
      data: Record<string, ScreenDataValue>;
      ordinalMap: ScreenOrdinalMap;
    }
  ) {
    const lines = fixes.map((f) => `- ${f.at ? `${f.at}: ` : ''}${f.message}`);
    super(
      fixes.length === 1
        ? `${fixes[0]!.at ? `${fixes[0]!.at}: ` : ''}${fixes[0]!.message}`
        : `Screen template validation failed (${fixes.length} issues):\n${lines.join('\n')}`
    );
    this.name = 'ScreenSkeletonizeError';
    this.fixes = fixes;
    if (partial) this.partial = partial;
  }
}

const SPACINGS = new Set<string>(['compact', 'regular', 'relaxed']);
const TEXT_STYLES = new Set<string>(['body', 'caption', 'mono']);
const BADGE_TONES = new Set<string>(['neutral', 'info', 'success', 'warning', 'danger']);
const ALERT_SEVERITIES = new Set<string>(['info', 'success', 'warning', 'danger']);
const ACTION_ROLES = new Set<string>(['primary', 'secondary', 'destructive', 'decline']);
const TEXT_FIELD_TYPES = new Set<string>(['text', 'email', 'url', 'secret', 'date']);
const SEMANTIC_ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const GRAPHEME_TIERS = [32, 64, 128, 256, 512, 1024, 2048, 4096] as const;
const ITEM_TIERS = [4, 8, 16, 32, 64, 128, 256] as const;
const KPI_ITEM_TIERS = [4, 6] as const;
const BYTE_TIERS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384] as const;
const DIFF_BYTE_TIERS = [4096, 8192, 16384, 32768, 65536, 96000] as const;
const DIFF_LINE_TIERS = [64, 128, 256, 512, 1024, 4096, 20000] as const;

function nextTier(value: number, tiers: readonly number[]): number {
  for (const tier of tiers) {
    if (value <= tier) return tier;
  }
  return tiers[tiers.length - 1]!;
}

function defaultTextBounds(text: string, minTier: number): { maxGraphemes: number; maxBytes: number } {
  const g = Math.max(minTier, countGraphemes(text));
  const maxGraphemes = nextTier(g, GRAPHEME_TIERS);
  const rawBytes = Math.max(utf8ByteLength(text), maxGraphemes * 4);
  const maxBytes = Math.min(
    SCREEN_PUBLIC_CAPS.maxSlotBytes,
    Math.max(maxGraphemes, nextTier(rawBytes, BYTE_TIERS))
  );
  return { maxGraphemes, maxBytes };
}

function defaultDataBounds(
  items: readonly ScreenDataValue[],
  requireNonEmpty: boolean,
  itemTiers: readonly number[] = ITEM_TIERS
): { minItems: number; maxItems: number; maxBytes: number } {
  const maxItems =
    itemTiers === KPI_ITEM_TIERS && items.length <= 6
      ? nextTier(Math.max(1, items.length), KPI_ITEM_TIERS)
      : nextTier(Math.max(1, items.length), ITEM_TIERS);
  const bytes = utf8ByteLength(canonJson(items as unknown as ScreenCanonValue));
  const maxBytes = Math.min(SCREEN_PUBLIC_CAPS.maxSlotBytes, nextTier(Math.max(512, bytes), BYTE_TIERS));
  return {
    minItems: requireNonEmpty ? 1 : 0,
    maxItems,
    maxBytes,
  };
}

function defaultDiffBounds(value: ScreenDataValue): { maxBytes: number; maxLines: number } {
  let bytes = 0;
  let lines = 1;
  if (typeof value === 'string') {
    bytes = utf8ByteLength(value);
    lines = value.split('\n').length;
  } else if (isPlainObject(value) && typeof value.original === 'string' && typeof value.modified === 'string') {
    bytes = utf8ByteLength(value.original) + utf8ByteLength(value.modified);
    lines = value.original.split('\n').length + value.modified.split('\n').length;
  }
  return {
    maxBytes: nextTier(Math.max(4096, bytes), DIFF_BYTE_TIERS),
    maxLines: nextTier(Math.max(64, lines), DIFF_LINE_TIERS),
  };
}

function isTextSlotSpec(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    (Object.prototype.hasOwnProperty.call(value, 'maxGraphemes') ||
      Object.prototype.hasOwnProperty.call(value, 'maxBytes') ||
      Object.prototype.hasOwnProperty.call(value, 'slot') ||
      Object.prototype.hasOwnProperty.call(value, 'value'))
  );
}

function isDataSlotSpec(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    (Object.prototype.hasOwnProperty.call(value, 'maxItems') ||
      Object.prototype.hasOwnProperty.call(value, 'minItems') ||
      Object.prototype.hasOwnProperty.call(value, 'slot') ||
      Object.prototype.hasOwnProperty.call(value, 'value'))
  );
}

function isDiffSlotSpec(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    !Object.prototype.hasOwnProperty.call(value, 'original') &&
    (Object.prototype.hasOwnProperty.call(value, 'maxLines') ||
      Object.prototype.hasOwnProperty.call(value, 'maxBytes') ||
      Object.prototype.hasOwnProperty.call(value, 'slot') ||
      Object.prototype.hasOwnProperty.call(value, 'value'))
  );
}

interface PreOrderNodeMeta {
  kindCode: number;
  optFlags: number;
}

function collectPreOrderMeta(block: unknown, meta: PreOrderNodeMeta[], depth: number): void {
  if (depth > SCREEN_PUBLIC_CAPS.maxSkeletonDepth) {
    throw new Error('Template exceeds maximum nesting depth');
  }
  if (meta.length >= SCREEN_PUBLIC_CAPS.maxSkeletonNodes) {
    throw new Error('Template exceeds maximum block count');
  }
  if (!isPlainObject(block) || typeof block.kind !== 'string') {
    throw new Error('Each screen block must be an object with a string kind');
  }
  const kindCode = BLOCK_KIND_CODES[block.kind];
  if (kindCode === undefined) {
    throw new Error(`Unknown screen block kind "${block.kind}"`);
  }

  let optFlags = 0;
  if (block.kind === 'card' && block.header !== undefined) optFlags |= OPT_FLAG_HAS_OPTIONAL_TEXT;
  if (block.kind === 'alert' && block.body !== undefined) optFlags |= OPT_FLAG_HAS_OPTIONAL_TEXT;
  if (block.kind === 'checklist' && block.title !== undefined) optFlags |= OPT_FLAG_HAS_OPTIONAL_TEXT;
  if (block.kind === 'formField') {
    if (block.placeholder !== undefined) optFlags |= OPT_FLAG_HAS_OPTIONAL_TEXT;
    if (block.fieldType === 'picker') optFlags |= OPT_FLAG_IS_PICKER;
  }

  meta.push({ kindCode, optFlags });

  if (block.kind === 'vstack' || block.kind === 'card') {
    if (!Array.isArray(block.children)) {
      throw new Error(`${block.kind}.children must be an array`);
    }
    for (const child of block.children) {
      collectPreOrderMeta(child, meta, depth + 1);
    }
  }
}

function validateInlineDataValue(value: unknown, depth: number, context: string): ScreenDataValue {
  if (depth > SCREEN_PUBLIC_CAPS.maxDataDepth) {
    throw new Error(`${context} exceeds maximum nesting depth`);
  }
  if (typeof value === 'string') {
    if (!isValidUnicodeString(value)) throw new Error(`${context} must be valid Unicode`);
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!isSafeInt53(value)) throw new Error(`${context} numbers must be safe integers (int53)`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > SCREEN_PUBLIC_CAPS.maxItemsPerList) {
      throw new Error(`${context} exceeds maximum array length`);
    }
    return value.map((item, idx) => validateInlineDataValue(item, depth + 1, `${context}[${idx}]`));
  }
  if (isPlainObject(value)) {
    const out: Record<string, ScreenDataValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!isValidUnicodeString(k)) throw new Error(`${context} key must be valid Unicode`);
      Object.defineProperty(out, k, {
        value: validateInlineDataValue(v, depth + 1, `${context}.${k}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  throw new Error(`${context} must use string, boolean, safe integer, array, or object values`);
}

function checkAllowedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
  onError?: (code: string, message: string, at?: string) => void
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      const msg = `Unexpected key "${key}" in ${context}`;
      if (onError) onError('UNEXPECTED_KEY', msg, context);
      else throw new Error(msg);
    }
  }
}

/**
 * Skeletonizes an inline ad-hoc template or raw skeleton into a zero-literal
 * `ScreenSkeleton` plus extracted `labels` and `data`, assigning contiguous pre-order
 * ordinals (`s0..`, `f0..`, `c0..`, `a0..`) and computing `inputSkeletonHash`.
 */
export async function skeletonizeScreenTemplate(
  input: unknown,
  explicitLabels?: Record<string, string>,
  explicitData?: Record<string, ScreenDataValue>
): Promise<SkeletonizedScreen> {
  if (!isPlainObject(input)) {
    throw new ScreenSkeletonizeError([{ code: 'INVALID_TEMPLATE', message: 'Screen template must be a JSON object' }]);
  }
  const fixes: ScreenFeedbackItem[] = [];
  const pushFix = (code: string, message: string, at?: string): void => {
    fixes.push(at ? { code, message, at } : { code, message });
  };
  checkAllowedKeys(input, ['v', 'root', 'actions'], 'screen template', pushFix);
  if (input.v !== undefined && input.v !== 1) {
    pushFix('INVALID_TEMPLATE', 'Screen template version v must be 1', 'v');
  }
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > SCREEN_PUBLIC_CAPS.maxSkeletonActions) {
    throw new ScreenSkeletonizeError([
      ...fixes,
      {
        code: 'INVALID_ACTION_COUNT',
        message: 'Provide between 1 and 3 top-level actions.',
        at: 'actions',
      },
    ]);
  }

  // Pass 1: collect flat pre-order metadata and compute all ordinals via the pure pre-order assigners.
  const meta: PreOrderNodeMeta[] = [];
  try {
    collectPreOrderMeta(input.root, meta, 1);
  } catch (error) {
    throw new ScreenSkeletonizeError([
      ...fixes,
      {
        code: 'INVALID_TEMPLATE',
        message: error instanceof Error ? error.message : 'Invalid screen block tree',
        at: 'root',
      },
    ]);
  }
  const nodeKinds = meta.map((m) => m.kindCode);
  const nodeOptFlags = meta.map((m) => m.optFlags);

  const nodeSlotStarts = assignNodeSlotStarts(nodeKinds, nodeOptFlags);
  const nodeFieldOrdinals = assignFieldOrdinals(nodeKinds);
  const nodeChecklistOrdinals = assignChecklistOrdinals(nodeKinds);
  const actionSlotOrdinals = assignActionSlotOrdinals(nodeKinds, nodeOptFlags, input.actions.length);

  const labels: Record<string, string> = {};
  const data: Record<string, ScreenDataValue> = {};
  if (explicitLabels) {
    if (!isPlainObject(explicitLabels)) {
      pushFix('INVALID_LABELS', 'screen.labels must be an object', 'labels');
    } else {
      for (const [k, v] of Object.entries(explicitLabels)) {
        if (!isSlotOrdinal(k) || typeof v !== 'string') {
          pushFix('INVALID_LABELS', `Invalid explicit label entry "${k}"`, `labels.${k}`);
        } else {
          labels[k] = v;
        }
      }
    }
  }
  if (explicitData) {
    if (!isPlainObject(explicitData)) {
      pushFix('INVALID_DATA', 'screen.data must be an object', 'data');
    } else {
      for (const [k, v] of Object.entries(explicitData)) {
        if (!isSlotOrdinal(k)) {
          pushFix('INVALID_DATA', `Invalid explicit data key "${k}"`, `data.${k}`);
        } else {
          try {
            data[k] = validateInlineDataValue(v, 1, `data.${k}`);
          } catch (error) {
            pushFix('INVALID_DATA', error instanceof Error ? error.message : `Invalid data.${k}`, `data.${k}`);
          }
        }
      }
    }
  }

  const ordinalMap: ScreenOrdinalMap = {
    fieldToAuthored: {},
    authoredToField: {},
    checklistToAuthored: {},
    authoredToChecklist: {},
    actionToAuthored: {},
    authoredToAction: {},
    slotOrigin: {},
    usedSemanticIds: false,
    usedInlineLiterals: false,
  };

  const fieldTypesByOrdinal = new Map<ScreenFieldId, string>();
  const pickerOptionsByOrdinal = new Map<ScreenFieldId, string[]>();
  const checklistOrdinalsSet = new Set<ScreenChecklistId>();

  const buildTextSlot = (
    raw: unknown,
    slotIndex: number,
    minTier: number,
    originPath: string,
    context: string
  ): ScreenTextSlot => {
    const slot: ScreenSlotId = `s${slotIndex}`;
    if (typeof raw === 'string') {
      if (!isValidUnicodeString(raw)) {
        pushFix('INVALID_TEXT', `${context} must be valid Unicode`, originPath);
      } else {
        const badChar = describeDisallowedControlOrFormatScalar(raw);
        if (badChar) {
          pushFix(
            'DISALLOWED_CHARACTER',
            `${context} contains disallowed ${badChar} (text blocks do not allow newlines or control characters; split lines into multiple text blocks, use keyValueList rows, or use diffViewer for multi-line output)`,
            originPath
          );
        }
      }
      ordinalMap.usedInlineLiterals = true;
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: true };
      if (Object.prototype.hasOwnProperty.call(labels, slot)) {
        pushFix('DUPLICATE_SLOT', `Duplicate label binding for slot "${slot}"`, originPath);
      } else {
        labels[slot] = raw;
      }
      const bounds = defaultTextBounds(raw, minTier);
      return { slot, maxGraphemes: bounds.maxGraphemes, maxBytes: bounds.maxBytes };
    }
    if (isTextSlotSpec(raw)) {
      checkAllowedKeys(raw, ['slot', 'maxGraphemes', 'maxBytes', 'value'], context, pushFix);
      if (raw.slot !== undefined && raw.slot !== slot) {
        pushFix('SLOT_ORDER_MISMATCH', `${context}.slot expected "${slot}", got "${String(raw.slot)}"`, originPath);
      }
      let inlineText: string | undefined;
      if (raw.value !== undefined) {
        if (typeof raw.value !== 'string' || !isValidUnicodeString(raw.value)) {
          pushFix('INVALID_TEXT', `${context}.value must be a valid Unicode display string`, originPath);
        } else {
          const badChar = describeDisallowedControlOrFormatScalar(raw.value);
          if (badChar) {
            pushFix(
              'DISALLOWED_CHARACTER',
              `${context}.value contains disallowed ${badChar} (text blocks do not allow newlines or control characters; split lines into multiple text blocks, use keyValueList rows, or use diffViewer for multi-line output)`,
              originPath
            );
          }
          inlineText = raw.value;
          ordinalMap.usedInlineLiterals = true;
          if (Object.prototype.hasOwnProperty.call(labels, slot)) {
            pushFix('DUPLICATE_SLOT', `Duplicate label binding for slot "${slot}"`, originPath);
          } else {
            labels[slot] = inlineText;
          }
        }
      }
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: inlineText !== undefined };
      const fallback = inlineText !== undefined ? defaultTextBounds(inlineText, minTier) : undefined;
      const maxGraphemes = raw.maxGraphemes ?? fallback?.maxGraphemes;
      const maxBytes = raw.maxBytes ?? fallback?.maxBytes;
      if (!isSafeInt53(maxGraphemes) || !isSafeInt53(maxBytes)) {
        pushFix('INVALID_SLOT_BOUND', `${context} requires safe integer maxGraphemes and maxBytes`, originPath);
        return { slot, maxGraphemes: minTier, maxBytes: minTier * 4 };
      }
      return { slot, maxGraphemes, maxBytes };
    }
    pushFix('INVALID_TEXT_SLOT', `${context} must be a display string or text slot descriptor`, originPath);
    return { slot, maxGraphemes: minTier, maxBytes: minTier * 4 };
  };

  const buildDataSlot = (
    raw: unknown,
    slotIndex: number,
    requireNonEmpty: boolean,
    originPath: string,
    context: string,
    onInlineItems?: (items: ScreenDataValue[]) => void,
    itemTiers: readonly number[] = ITEM_TIERS
  ): ScreenDataSlot => {
    const slot: ScreenSlotId = `s${slotIndex}`;
    if (Array.isArray(raw)) {
      let validated: ScreenDataValue[] = [];
      try {
        validated = validateInlineDataValue(raw, 1, context) as ScreenDataValue[];
      } catch (error) {
        pushFix('INVALID_DATA', error instanceof Error ? error.message : `Invalid data in ${context}`, originPath);
      }
      ordinalMap.usedInlineLiterals = true;
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: true };
      if (Object.prototype.hasOwnProperty.call(data, slot)) {
        pushFix('DUPLICATE_SLOT', `Duplicate data binding for slot "${slot}"`, originPath);
      } else {
        data[slot] = validated;
      }
      onInlineItems?.(validated);
      const bounds = defaultDataBounds(validated, requireNonEmpty, itemTiers);
      return requireNonEmpty
        ? { slot, minItems: bounds.minItems, maxItems: bounds.maxItems, maxBytes: bounds.maxBytes }
        : { slot, maxItems: bounds.maxItems, maxBytes: bounds.maxBytes };
    }
    if (isDataSlotSpec(raw)) {
      checkAllowedKeys(raw, ['slot', 'minItems', 'maxItems', 'maxBytes', 'value'], context, pushFix);
      if (raw.slot !== undefined && raw.slot !== slot) {
        pushFix('SLOT_ORDER_MISMATCH', `${context}.slot expected "${slot}", got "${String(raw.slot)}"`, originPath);
      }
      let inlineArray: ScreenDataValue[] | undefined;
      if (raw.value !== undefined) {
        if (!Array.isArray(raw.value)) {
          pushFix('INVALID_DATA', `${context}.value must be an array`, originPath);
        } else {
          try {
            inlineArray = validateInlineDataValue(raw.value, 1, `${context}.value`) as ScreenDataValue[];
          } catch (error) {
            pushFix('INVALID_DATA', error instanceof Error ? error.message : `Invalid ${context}.value`, originPath);
          }
          if (inlineArray) {
            ordinalMap.usedInlineLiterals = true;
            if (Object.prototype.hasOwnProperty.call(data, slot)) {
              pushFix('DUPLICATE_SLOT', `Duplicate data binding for slot "${slot}"`, originPath);
            } else {
              data[slot] = inlineArray;
            }
            onInlineItems?.(inlineArray);
          }
        }
      }
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: inlineArray !== undefined };
      const fallback =
        inlineArray !== undefined ? defaultDataBounds(inlineArray, requireNonEmpty, itemTiers) : undefined;
      const maxItems = raw.maxItems ?? fallback?.maxItems;
      const maxBytes = raw.maxBytes ?? fallback?.maxBytes;
      if (!isSafeInt53(maxItems) || !isSafeInt53(maxBytes)) {
        pushFix('INVALID_SLOT_BOUND', `${context} requires safe integer maxItems and maxBytes`, originPath);
        return { slot, ...(requireNonEmpty ? { minItems: 1 } : {}), maxItems: 8, maxBytes: 1024 };
      }
      const out: ScreenDataSlot = { slot, maxItems, maxBytes };
      const minItems = raw.minItems ?? (requireNonEmpty ? fallback?.minItems : undefined);
      if (minItems !== undefined) {
        if (!isSafeInt53(minItems)) {
          pushFix('INVALID_SLOT_BOUND', `${context}.minItems must be a safe integer`, originPath);
        } else {
          out.minItems = minItems;
        }
      }
      return out;
    }
    pushFix('INVALID_DATA_SLOT', `${context} must be an array or data slot descriptor`, originPath);
    return { slot, ...(requireNonEmpty ? { minItems: 1 } : {}), maxItems: 8, maxBytes: 1024 };
  };

  const buildDiffSlot = (
    raw: unknown,
    slotIndex: number,
    originPath: string,
    context: string
  ): ScreenDiffSlot => {
    const slot: ScreenSlotId = `s${slotIndex}`;
    if (typeof raw === 'string' || (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, 'original'))) {
      let validated: ScreenDataValue = '';
      try {
        validated = validateInlineDataValue(raw, 1, context);
      } catch (error) {
        pushFix('INVALID_DATA', error instanceof Error ? error.message : `Invalid diff in ${context}`, originPath);
      }
      ordinalMap.usedInlineLiterals = true;
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: true };
      if (Object.prototype.hasOwnProperty.call(data, slot)) {
        pushFix('DUPLICATE_SLOT', `Duplicate diff binding for slot "${slot}"`, originPath);
      } else {
        data[slot] = validated;
      }
      const bounds = defaultDiffBounds(validated);
      return { slot, maxBytes: bounds.maxBytes, maxLines: bounds.maxLines };
    }
    if (isDiffSlotSpec(raw)) {
      checkAllowedKeys(raw, ['slot', 'maxBytes', 'maxLines', 'value'], context, pushFix);
      if (raw.slot !== undefined && raw.slot !== slot) {
        pushFix('SLOT_ORDER_MISMATCH', `${context}.slot expected "${slot}", got "${String(raw.slot)}"`, originPath);
      }
      let inlineVal: ScreenDataValue | undefined;
      if (raw.value !== undefined) {
        try {
          inlineVal = validateInlineDataValue(raw.value, 1, `${context}.value`);
          ordinalMap.usedInlineLiterals = true;
          if (Object.prototype.hasOwnProperty.call(data, slot)) {
            pushFix('DUPLICATE_SLOT', `Duplicate diff binding for slot "${slot}"`, originPath);
          } else {
            data[slot] = inlineVal;
          }
        } catch (error) {
          pushFix('INVALID_DATA', error instanceof Error ? error.message : `Invalid diff in ${context}.value`, originPath);
        }
      }
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: inlineVal !== undefined };
      const fallback = inlineVal !== undefined ? defaultDiffBounds(inlineVal) : undefined;
      const maxBytes = raw.maxBytes ?? fallback?.maxBytes;
      const maxLines = raw.maxLines ?? fallback?.maxLines;
      if (!isSafeInt53(maxBytes) || !isSafeInt53(maxLines)) {
        pushFix('INVALID_SLOT_BOUND', `${context} requires safe integer maxBytes and maxLines`, originPath);
        return { slot, maxBytes: 4096, maxLines: 64 };
      }
      return { slot, maxBytes, maxLines };
    }
    pushFix('INVALID_DIFF_SLOT', `${context} must be a diff payload or diff slot descriptor`, originPath);
    return { slot, maxBytes: 4096, maxLines: 64 };
  };

  const registerSemanticId = (
    rawId: unknown,
    assigned: string,
    toAuthored: Record<string, string>,
    fromAuthored: Record<string, any>,
    kindLabel: string,
    context: string
  ): string => {
    if (rawId === undefined) {
      toAuthored[assigned] = assigned;
      fromAuthored[assigned] = assigned;
      return assigned;
    }
    if (typeof rawId !== 'string' || !SEMANTIC_ID_RE.test(rawId)) {
      pushFix('INVALID_IDENTIFIER', `Invalid ${kindLabel} id "${String(rawId)}"`, context);
      toAuthored[assigned] = assigned;
      fromAuthored[assigned] = assigned;
      return assigned;
    }
    if (Object.prototype.hasOwnProperty.call(fromAuthored, rawId)) {
      pushFix('DUPLICATE_IDENTIFIER', `Duplicate ${kindLabel} id "${rawId}"`, context);
      return rawId;
    }
    toAuthored[assigned] = rawId;
    fromAuthored[rawId] = assigned;
    if (rawId !== assigned) {
      ordinalMap.usedSemanticIds = true;
    }
    return rawId;
  };

  // Pass 2: materialize the ScreenSkeleton using the exact ordinals computed in Pass 1.
  let nodeCursor = 0;

  const transformBlock = (raw: unknown, pathLabel: string): ScreenBlock => {
    const idx = nodeCursor;
    nodeCursor += 1;
    const obj = raw as Record<string, unknown>;
    let slotCursor = nodeSlotStarts[idx]!;

    switch (obj.kind) {
      case 'vstack': {
        checkAllowedKeys(obj, ['kind', 'spacing', 'children'], pathLabel, pushFix);
        const children = (obj.children as unknown[]).map((child, i) =>
          transformBlock(child, `${pathLabel}.children[${i}]`)
        );
        const out: ScreenBlock = { kind: 'vstack', children };
        if (obj.spacing !== undefined) {
          if (typeof obj.spacing !== 'string' || !SPACINGS.has(obj.spacing)) {
            pushFix('INVALID_BLOCK_PROPERTY', `${pathLabel}.spacing must be compact | regular | relaxed`, pathLabel);
          } else {
            out.spacing = obj.spacing as ScreenSpacing;
          }
        }
        return out;
      }
      case 'card': {
        checkAllowedKeys(obj, ['kind', 'header', 'children'], pathLabel, pushFix);
        const header =
          obj.header !== undefined
            ? buildTextSlot(obj.header, slotCursor++, 64, `${pathLabel}.header`, `${pathLabel}.header`)
            : undefined;
        const children = (obj.children as unknown[]).map((child, i) =>
          transformBlock(child, `${pathLabel}.children[${i}]`)
        );
        return header !== undefined ? { kind: 'card', header, children } : { kind: 'card', children };
      }
      case 'divider': {
        checkAllowedKeys(obj, ['kind'], pathLabel, pushFix);
        return { kind: 'divider' };
      }
      case 'heading': {
        checkAllowedKeys(obj, ['kind', 'level', 'text'], pathLabel, pushFix);
        const text = buildTextSlot(obj.text, slotCursor++, 64, `${pathLabel}.text`, `${pathLabel}.text`);
        if (obj.level !== undefined) {
          if (obj.level !== 1 && obj.level !== 2 && obj.level !== 3) {
            pushFix('INVALID_BLOCK_PROPERTY', `${pathLabel}.level must be 1, 2, or 3`, pathLabel);
          } else {
            return { kind: 'heading', level: obj.level as ScreenHeadingLevel, text };
          }
        }
        return { kind: 'heading', text };
      }
      case 'text': {
        checkAllowedKeys(obj, ['kind', 'style', 'text'], pathLabel, pushFix);
        const text = buildTextSlot(obj.text, slotCursor++, 128, `${pathLabel}.text`, `${pathLabel}.text`);
        if (obj.style !== undefined) {
          if (typeof obj.style !== 'string' || !TEXT_STYLES.has(obj.style)) {
            pushFix('INVALID_BLOCK_PROPERTY', `${pathLabel}.style must be body | caption | mono`, pathLabel);
          } else {
            return { kind: 'text', style: obj.style as ScreenTextStyle, text };
          }
        }
        return { kind: 'text', text };
      }
      case 'badge': {
        checkAllowedKeys(obj, ['kind', 'tone', 'label'], pathLabel, pushFix);
        let tone: ScreenBadgeTone = 'neutral';
        if (typeof obj.tone !== 'string' || !BADGE_TONES.has(obj.tone)) {
          pushFix('INVALID_TONE_OR_SEVERITY', `${pathLabel}.tone must be neutral | info | success | warning | danger`, pathLabel);
        } else {
          tone = obj.tone as ScreenBadgeTone;
        }
        const label = buildTextSlot(obj.label, slotCursor++, 32, `${pathLabel}.label`, `${pathLabel}.label`);
        return { kind: 'badge', tone, label };
      }
      case 'alert': {
        checkAllowedKeys(obj, ['kind', 'severity', 'title', 'body'], pathLabel, pushFix);
        let severity: ScreenAlertSeverity = 'info';
        if (typeof obj.severity !== 'string' || !ALERT_SEVERITIES.has(obj.severity)) {
          pushFix('INVALID_TONE_OR_SEVERITY', `${pathLabel}.severity must be info | success | warning | danger`, pathLabel);
        } else {
          severity = obj.severity as ScreenAlertSeverity;
        }
        const title = buildTextSlot(obj.title, slotCursor++, 128, `${pathLabel}.title`, `${pathLabel}.title`);
        if (obj.body !== undefined) {
          const body = buildTextSlot(obj.body, slotCursor++, 256, `${pathLabel}.body`, `${pathLabel}.body`);
          return { kind: 'alert', severity, title, body };
        }
        return { kind: 'alert', severity, title };
      }
      case 'kpiStrip': {
        checkAllowedKeys(obj, ['kind', 'items'], pathLabel, pushFix);
        const items = buildDataSlot(
          obj.items,
          slotCursor++,
          false,
          `${pathLabel}.items`,
          `${pathLabel}.items`,
          undefined,
          KPI_ITEM_TIERS
        );
        return { kind: 'kpiStrip', items };
      }
      case 'keyValueList': {
        checkAllowedKeys(obj, ['kind', 'rows'], pathLabel, pushFix);
        const rows = buildDataSlot(obj.rows, slotCursor++, false, `${pathLabel}.rows`, `${pathLabel}.rows`);
        return { kind: 'keyValueList', rows };
      }
      case 'checklist': {
        checkAllowedKeys(obj, ['kind', 'id', 'title', 'items'], pathLabel, pushFix);
        const id: ScreenChecklistId = `c${nodeChecklistOrdinals[idx]!}`;
        const authoredId = registerSemanticId(
          obj.id,
          id,
          ordinalMap.checklistToAuthored,
          ordinalMap.authoredToChecklist,
          'checklist',
          pathLabel
        );
        checklistOrdinalsSet.add(id);
        const title =
          obj.title !== undefined
            ? buildTextSlot(obj.title, slotCursor++, 64, `${authoredId}.title`, `${pathLabel}.title`)
            : undefined;
        const items = buildDataSlot(obj.items, slotCursor++, true, `${authoredId}.items`, `${pathLabel}.items`);
        return title !== undefined
          ? { kind: 'checklist', id, title, items }
          : { kind: 'checklist', id, items };
      }
      case 'diffViewer': {
        checkAllowedKeys(obj, ['kind', 'diff'], pathLabel, pushFix);
        const diff = buildDiffSlot(obj.diff, slotCursor++, `${pathLabel}.diff`, `${pathLabel}.diff`);
        return { kind: 'diffViewer', diff };
      }
      case 'formField': {
        const id: ScreenFieldId = `f${nodeFieldOrdinals[idx]!}`;
        const authoredId = registerSemanticId(
          obj.id,
          id,
          ordinalMap.fieldToAuthored,
          ordinalMap.authoredToField,
          'formField',
          pathLabel
        );
        const fieldType = obj.fieldType;
        if (typeof fieldType !== 'string') {
          pushFix('INVALID_FORM_FIELD', `${pathLabel}.fieldType is required`, pathLabel);
          fieldTypesByOrdinal.set(id, 'text');
          const label = buildTextSlot(obj.label ?? 'Field', slotCursor++, 64, `${authoredId}.label`, `${pathLabel}.label`);
          return { kind: 'formField', id, fieldType: 'text', label };
        }
        fieldTypesByOrdinal.set(id, fieldType);
        if (obj.required !== undefined && typeof obj.required !== 'boolean') {
          pushFix('INVALID_FORM_FIELD', `${pathLabel}.required must be boolean`, authoredId);
        }
        if (TEXT_FIELD_TYPES.has(fieldType)) {
          checkAllowedKeys(
            obj,
            ['kind', 'id', 'fieldType', 'label', 'placeholder', 'required', 'maxGraphemes', 'maxBytes'],
            pathLabel,
            pushFix
          );
          const label = buildTextSlot(obj.label, slotCursor++, 64, `${authoredId}.label`, `${pathLabel}.label`);
          const out: ScreenFormFieldBlock = {
            kind: 'formField',
            id,
            fieldType: fieldType as 'text' | 'email' | 'url' | 'secret' | 'date',
            label,
          };
          if (obj.placeholder !== undefined) {
            out.placeholder = buildTextSlot(
              obj.placeholder,
              slotCursor++,
              64,
              `${authoredId}.placeholder`,
              `${pathLabel}.placeholder`
            );
          }
          if (typeof obj.required === 'boolean') out.required = obj.required;
          if (obj.maxGraphemes !== undefined) {
            if (!isSafeInt53(obj.maxGraphemes)) {
              pushFix('INVALID_FORM_FIELD', `${pathLabel}.maxGraphemes must be integer`, authoredId);
            } else {
              out.maxGraphemes = obj.maxGraphemes;
            }
          }
          if (obj.maxBytes !== undefined) {
            if (!isSafeInt53(obj.maxBytes)) {
              pushFix('INVALID_FORM_FIELD', `${pathLabel}.maxBytes must be integer`, authoredId);
            } else {
              out.maxBytes = obj.maxBytes;
            }
          }
          return out;
        }
        if (fieldType === 'toggle') {
          checkAllowedKeys(obj, ['kind', 'id', 'fieldType', 'label', 'required', 'defaultBool'], pathLabel, pushFix);
          const label = buildTextSlot(obj.label, slotCursor++, 64, `${authoredId}.label`, `${pathLabel}.label`);
          const out: ScreenFormFieldBlock = { kind: 'formField', id, fieldType: 'toggle', label };
          if (typeof obj.required === 'boolean') out.required = obj.required;
          if (obj.defaultBool !== undefined) {
            if (typeof obj.defaultBool !== 'boolean') {
              pushFix('INVALID_FORM_FIELD', `${pathLabel}.defaultBool must be boolean`, authoredId);
            } else {
              out.defaultBool = obj.defaultBool;
            }
          }
          return out;
        }
        if (fieldType === 'stepper') {
          checkAllowedKeys(
            obj,
            ['kind', 'id', 'fieldType', 'label', 'required', 'min', 'max', 'defaultInt'],
            pathLabel,
            pushFix
          );
          const label = buildTextSlot(obj.label, slotCursor++, 64, `${authoredId}.label`, `${pathLabel}.label`);
          const validMinMax = isSafeInt53(obj.min) && isSafeInt53(obj.max);
          if (!validMinMax) {
            pushFix('INVALID_FORM_FIELD', `${pathLabel} stepper requires safe integer min and max`, authoredId);
          }
          const out: ScreenFormFieldBlock = {
            kind: 'formField',
            id,
            fieldType: 'stepper',
            label,
            min: validMinMax ? (Object.is(obj.min, -0) ? 0 : (obj.min as number)) : 0,
            max: validMinMax ? (Object.is(obj.max, -0) ? 0 : (obj.max as number)) : 10,
          };
          if (typeof obj.required === 'boolean') out.required = obj.required;
          if (obj.defaultInt !== undefined) {
            if (!isSafeInt53(obj.defaultInt)) {
              pushFix('INVALID_FORM_FIELD', `${pathLabel}.defaultInt must be safe integer`, authoredId);
            } else {
              out.defaultInt = Object.is(obj.defaultInt, -0) ? 0 : obj.defaultInt;
            }
          }
          return out;
        }
        if (fieldType === 'picker') {
          checkAllowedKeys(
            obj,
            ['kind', 'id', 'fieldType', 'label', 'placeholder', 'required', 'options', 'defaultOptionIndex'],
            pathLabel,
            pushFix
          );
          const label = buildTextSlot(obj.label, slotCursor++, 64, `${authoredId}.label`, `${pathLabel}.label`);
          const placeholder =
            obj.placeholder !== undefined
              ? buildTextSlot(obj.placeholder, slotCursor++, 64, `${authoredId}.placeholder`, `${pathLabel}.placeholder`)
              : undefined;
          const options = buildDataSlot(
            obj.options,
            slotCursor++,
            true,
            `${authoredId}.options`,
            `${pathLabel}.options`,
            (items) => {
              const strs = items.filter((v): v is string => typeof v === 'string');
              if (strs.length === items.length) {
                pickerOptionsByOrdinal.set(id, strs);
              }
            }
          );
          const out: ScreenFormFieldBlock = { kind: 'formField', id, fieldType: 'picker', label, options };
          if (placeholder !== undefined) out.placeholder = placeholder;
          if (typeof obj.required === 'boolean') out.required = obj.required;
          if (obj.defaultOptionIndex !== undefined) {
            if (!isSafeInt53(obj.defaultOptionIndex)) {
              pushFix('INVALID_FORM_FIELD', `${pathLabel}.defaultOptionIndex must be safe integer`, authoredId);
            } else {
              out.defaultOptionIndex = Object.is(obj.defaultOptionIndex, -0) ? 0 : obj.defaultOptionIndex;
            }
          }
          return out;
        }
        pushFix('INVALID_FORM_FIELD', `Unsupported formField fieldType "${fieldType}"`, authoredId);
        const fallbackLabel = buildTextSlot(obj.label ?? 'Field', slotCursor++, 64, `${authoredId}.label`, `${pathLabel}.label`);
        return { kind: 'formField', id, fieldType: 'text', label: fallbackLabel };
      }
      default:
        pushFix('UNKNOWN_BLOCK_KIND', `Unknown screen block kind "${String(obj.kind)}"`, pathLabel);
        return { kind: 'divider' };
    }
  };

  const root = transformBlock(input.root, 'root');

  const actions: ScreenAction[] = input.actions.map((rawAction, idx) => {
    const actionCtx = `actions[${idx}]`;
    if (!isPlainObject(rawAction)) {
      pushFix('INVALID_ACTION', `${actionCtx} must be an object`, actionCtx);
      const id: ScreenActionId = `a${idx}`;
      return { id, label: { slot: `s${actionSlotOrdinals[idx]!}`, maxGraphemes: 32, maxBytes: 128 }, role: 'secondary', requireBio: false };
    }
    checkAllowedKeys(rawAction, ['id', 'label', 'role', 'requireBio', 'enabledWhen'], actionCtx, pushFix);
    if (rawAction.id === 'dismiss') {
      pushFix('RESERVED_IDENTIFIER', 'Action id "dismiss" is reserved for host-owned unavailable dismissal', actionCtx);
    }
    const id: ScreenActionId = `a${idx}`;
    const authoredId = registerSemanticId(
      rawAction.id === 'dismiss' ? undefined : rawAction.id,
      id,
      ordinalMap.actionToAuthored,
      ordinalMap.authoredToAction,
      'action',
      actionCtx
    );
    const label = buildTextSlot(
      rawAction.label,
      actionSlotOrdinals[idx]!,
      32,
      `actions.${authoredId}.label`,
      `${actionCtx}.label`
    );
    let role: ScreenActionRole = 'secondary';
    if (typeof rawAction.role !== 'string' || !ACTION_ROLES.has(rawAction.role)) {
      pushFix('INVALID_ACTION_ROLE', `${actionCtx}.role must be primary | secondary | destructive | decline`, authoredId);
    } else {
      role = rawAction.role as ScreenActionRole;
    }
    let requireBio = false;
    if (typeof rawAction.requireBio !== 'boolean') {
      pushFix('INVALID_ACTION', `${actionCtx}.requireBio must be boolean`, authoredId);
    } else {
      requireBio = rawAction.requireBio;
    }
    const action: ScreenAction = {
      id,
      label,
      role,
      requireBio,
    };
    if (rawAction.enabledWhen !== undefined) {
      if (!Array.isArray(rawAction.enabledWhen)) {
        pushFix('INVALID_ACTION_CONDITION', `${actionCtx}.enabledWhen must be an array`, authoredId);
      } else {
        const preds: ScreenPredicate[] = [];
        rawAction.enabledWhen.forEach((rawPred, pIdx) => {
          if (!isPlainObject(rawPred) || typeof rawPred.op !== 'string') {
            pushFix('INVALID_ACTION_CONDITION', `${actionCtx}.enabledWhen[${pIdx}] must be an object with op`, authoredId);
            return;
          }
          if (rawPred.op === 'allChecked') {
            checkAllowedKeys(rawPred, ['op', 'checklist'], `${actionCtx}.enabledWhen[${pIdx}]`, pushFix);
            const target = typeof rawPred.checklist === 'string' ? rawPred.checklist : '';
            const mapped =
              ordinalMap.authoredToChecklist[target] ??
              (isChecklistOrdinal(target) && checklistOrdinalsSet.has(target) ? target : undefined);
            if (!mapped) {
              pushFix('INVALID_ACTION_CONDITION', `Predicate references unknown checklist "${target}"`, authoredId);
              return;
            }
            preds.push({ op: 'allChecked', checklist: mapped });
            return;
          }
          if (rawPred.op === 'isNotEmpty') {
            checkAllowedKeys(rawPred, ['op', 'field'], `${actionCtx}.enabledWhen[${pIdx}]`, pushFix);
            const target = typeof rawPred.field === 'string' ? rawPred.field : '';
            const mapped =
              ordinalMap.authoredToField[target] ??
              (isFieldOrdinal(target) && fieldTypesByOrdinal.has(target) ? target : undefined);
            if (!mapped) {
              pushFix('INVALID_ACTION_CONDITION', `Predicate references unknown field "${target}"`, authoredId);
              return;
            }
            preds.push({ op: 'isNotEmpty', field: mapped });
            return;
          }
          if (rawPred.op === 'equals') {
            checkAllowedKeys(rawPred, ['op', 'field', 'value'], `${actionCtx}.enabledWhen[${pIdx}]`, pushFix);
            const target = typeof rawPred.field === 'string' ? rawPred.field : '';
            const mapped =
              ordinalMap.authoredToField[target] ??
              (isFieldOrdinal(target) && fieldTypesByOrdinal.has(target) ? target : undefined);
            if (!mapped) {
              pushFix('INVALID_ACTION_CONDITION', `Predicate references unknown field "${target}"`, authoredId);
              return;
            }
            if (typeof rawPred.value === 'boolean') {
              preds.push({ op: 'equals', field: mapped, value: rawPred.value });
              return;
            }
            if (isSafeInt53(rawPred.value)) {
              preds.push({ op: 'equals', field: mapped, value: Object.is(rawPred.value, -0) ? 0 : rawPred.value });
              return;
            }
            if (typeof rawPred.value === 'string' && fieldTypesByOrdinal.get(mapped) === 'picker') {
              const opts = pickerOptionsByOrdinal.get(mapped);
              if (opts) {
                const optIdx = opts.indexOf(rawPred.value);
                if (optIdx >= 0) {
                  preds.push({ op: 'equals', field: mapped, value: optIdx });
                  return;
                }
                pushFix(
                  'INVALID_ACTION_CONDITION',
                  `${actionCtx}.enabledWhen[${pIdx}].value "${rawPred.value}" does not match any option in picker "${target}" (options: ${opts.map((o) => JSON.stringify(o)).join(', ')})`,
                  authoredId
                );
                return;
              }
              pushFix(
                'INVALID_ACTION_CONDITION',
                `${actionCtx}.enabledWhen[${pIdx}].value cannot match by string label unless picker "${target}" has inline options; pass 0-based integer index`,
                authoredId
              );
              return;
            }
            pushFix(
              'INVALID_ACTION_CONDITION',
              `${actionCtx}.enabledWhen[${pIdx}].value must be boolean (for toggle), integer index, or picker option label string`,
              authoredId
            );
            return;
          }
          pushFix('INVALID_ACTION_CONDITION', `Unknown predicate op "${rawPred.op}"`, authoredId);
        });
        action.enabledWhen = preds;
      }
    }
    return action;
  });

  if (fixes.length > 0) {
    throw new ScreenSkeletonizeError(fixes, {
      skeleton: { v: 1, root, actions },
      labels,
      data,
      ordinalMap,
    });
  }

  let skeleton: ScreenSkeleton;
  try {
    skeleton = validateScreenSkeleton({ v: 1, root, actions });
  } catch (error) {
    throw new ScreenSkeletonizeError(
      [
        {
          code: 'INVALID_TEMPLATE',
          message: error instanceof Error ? error.message : 'Invalid screen skeleton',
        },
      ],
      { skeleton: { v: 1, root, actions }, labels, data, ordinalMap }
    );
  }
  const inputSkeletonHash = bytesToHex(
    await sha256Bytes(new TextEncoder().encode(canonJson(skeleton as unknown as ScreenCanonValue)))
  );

  return {
    skeleton,
    labels,
    data,
    inputSkeletonHash,
    ordinalMap,
  };
}

/**
 * Re-hydrates server `changes` or `fixes` by mapping ordinal references (`s<n>`, `f<n>`, `c<n>`, `a<n>`)
 * back to the caller's authored semantic IDs / paths when semantic IDs or inline literals were used.
 */
export function rehydrateScreenFeedback(
  items: readonly { code: string; message: string; at?: string }[],
  ordinalMap: ScreenOrdinalMap
): ScreenFeedbackItem[] {
  return items.map((item) => {
    const out: ScreenFeedbackItem = { code: item.code, message: item.message };
    if (item.at === undefined) return out;

    let mapped: string | undefined;
    if (isFieldOrdinal(item.at)) {
      mapped = ordinalMap.fieldToAuthored[item.at];
    } else if (isChecklistOrdinal(item.at)) {
      mapped = ordinalMap.checklistToAuthored[item.at];
    } else if (isActionOrdinal(item.at)) {
      mapped = ordinalMap.actionToAuthored[item.at];
    } else if (isSlotOrdinal(item.at)) {
      const origin = ordinalMap.slotOrigin[item.at];
      if (origin && (ordinalMap.usedSemanticIds || ordinalMap.usedInlineLiterals)) {
        mapped = origin.path;
      }
    }

    if (mapped && mapped !== item.at) {
      out.at = mapped;
      out.ordinal = item.at;
    } else {
      out.at = item.at;
    }
    return out;
  });
}

/**
 * Re-hydrates a server-standardized `ScreenSkeleton` into a caller-ready `suggestedTemplate`
 * preserving authored semantic IDs and inline values (when used) so re-submitting it converges
 * to the exact standardized skeleton with `repaired: false`.
 */
export function rehydrateSuggestedTemplate(
  repairedSkeleton: ScreenSkeleton,
  labels: Readonly<Record<string, string>>,
  data: Readonly<Record<string, ScreenDataValue>>,
  ordinalMap: ScreenOrdinalMap
): Record<string, unknown> {
  if (!ordinalMap.usedSemanticIds && !ordinalMap.usedInlineLiterals) {
    return structuredClone(repairedSkeleton) as unknown as Record<string, unknown>;
  }

  const rehydrateTextSlot = (slot: ScreenTextSlot): unknown => {
    const origin = ordinalMap.slotOrigin[slot.slot];
    if (origin?.inline && Object.prototype.hasOwnProperty.call(labels, slot.slot)) {
      return {
        maxGraphemes: slot.maxGraphemes,
        maxBytes: slot.maxBytes,
        value: labels[slot.slot],
      };
    }
    return { ...slot };
  };

  const rehydrateDataSlot = (slot: ScreenDataSlot): unknown => {
    const origin = ordinalMap.slotOrigin[slot.slot];
    if (origin?.inline && Object.prototype.hasOwnProperty.call(data, slot.slot)) {
      return {
        ...(slot.minItems !== undefined ? { minItems: slot.minItems } : {}),
        maxItems: slot.maxItems,
        maxBytes: slot.maxBytes,
        value: structuredClone(data[slot.slot]),
      };
    }
    return { ...slot };
  };

  const rehydrateDiffSlot = (slot: ScreenDiffSlot): unknown => {
    const origin = ordinalMap.slotOrigin[slot.slot];
    if (origin?.inline && Object.prototype.hasOwnProperty.call(data, slot.slot)) {
      return {
        maxBytes: slot.maxBytes,
        maxLines: slot.maxLines,
        value: structuredClone(data[slot.slot]),
      };
    }
    return { ...slot };
  };

  const rehydrateBlock = (block: ScreenBlock): Record<string, unknown> => {
    switch (block.kind) {
      case 'vstack':
        return {
          kind: 'vstack',
          ...(block.spacing !== undefined ? { spacing: block.spacing } : {}),
          children: block.children.map(rehydrateBlock),
        };
      case 'card':
        return {
          kind: 'card',
          ...(block.header !== undefined ? { header: rehydrateTextSlot(block.header) } : {}),
          children: block.children.map(rehydrateBlock),
        };
      case 'divider':
        return { kind: 'divider' };
      case 'heading':
        return {
          kind: 'heading',
          ...(block.level !== undefined ? { level: block.level } : {}),
          text: rehydrateTextSlot(block.text),
        };
      case 'text':
        return {
          kind: 'text',
          ...(block.style !== undefined ? { style: block.style } : {}),
          text: rehydrateTextSlot(block.text),
        };
      case 'badge':
        return { kind: 'badge', tone: block.tone, label: rehydrateTextSlot(block.label) };
      case 'alert':
        return {
          kind: 'alert',
          severity: block.severity,
          title: rehydrateTextSlot(block.title),
          ...(block.body !== undefined ? { body: rehydrateTextSlot(block.body) } : {}),
        };
      case 'kpiStrip':
        return { kind: 'kpiStrip', items: rehydrateDataSlot(block.items) };
      case 'keyValueList':
        return { kind: 'keyValueList', rows: rehydrateDataSlot(block.rows) };
      case 'checklist':
        return {
          kind: 'checklist',
          id: ordinalMap.checklistToAuthored[block.id] ?? block.id,
          ...(block.title !== undefined ? { title: rehydrateTextSlot(block.title) } : {}),
          items: rehydrateDataSlot(block.items),
        };
      case 'diffViewer':
        return { kind: 'diffViewer', diff: rehydrateDiffSlot(block.diff) };
      case 'formField': {
        const base: Record<string, unknown> = {
          kind: 'formField',
          id: ordinalMap.fieldToAuthored[block.id] ?? block.id,
          fieldType: block.fieldType,
          label: rehydrateTextSlot(block.label),
          ...(block.required !== undefined ? { required: block.required } : {}),
        };
        if (block.fieldType === 'toggle') {
          if (block.defaultBool !== undefined) base.defaultBool = block.defaultBool;
        } else if (block.fieldType === 'stepper') {
          base.min = block.min;
          base.max = block.max;
          if (block.defaultInt !== undefined) base.defaultInt = block.defaultInt;
        } else if (block.fieldType === 'picker') {
          if (block.placeholder !== undefined) base.placeholder = rehydrateTextSlot(block.placeholder);
          base.options = rehydrateDataSlot(block.options);
          if (block.defaultOptionIndex !== undefined) base.defaultOptionIndex = block.defaultOptionIndex;
        } else {
          if (block.placeholder !== undefined) base.placeholder = rehydrateTextSlot(block.placeholder);
          if (block.maxGraphemes !== undefined) base.maxGraphemes = block.maxGraphemes;
          if (block.maxBytes !== undefined) base.maxBytes = block.maxBytes;
        }
        return base;
      }
    }
  };

  return {
    v: 1,
    root: rehydrateBlock(repairedSkeleton.root),
    actions: repairedSkeleton.actions.map((action) => ({
      id: ordinalMap.actionToAuthored[action.id] ?? action.id,
      label: rehydrateTextSlot(action.label),
      role: action.role,
      requireBio: action.requireBio,
      ...(action.enabledWhen !== undefined
        ? {
            enabledWhen: action.enabledWhen.map((pred) => {
              if (pred.op === 'allChecked') {
                return {
                  op: 'allChecked',
                  checklist: ordinalMap.checklistToAuthored[pred.checklist] ?? pred.checklist,
                };
              }
              if (pred.op === 'isNotEmpty') {
                return {
                  op: 'isNotEmpty',
                  field: ordinalMap.fieldToAuthored[pred.field] ?? pred.field,
                };
              }
              return {
                op: 'equals',
                field: ordinalMap.fieldToAuthored[pred.field] ?? pred.field,
                value: pred.value,
              };
            }),
          }
        : {}),
    })),
  };
}

/**
 * Verifies that a standardized skeleton returned by `POST /v2/templates` preserves
 * the caller's interactive fields, checklists, actions, predicates, and slot bounds
 * (never shrinking slot capacities or altering interactive bindings).
 */
export function assertBindingSchemaCompatible(
  original: ScreenSkeleton,
  repaired: ScreenSkeleton
): void {
  const summarize = (sk: ScreenSkeleton) => {
    const fields: string[] = [];
    const checklists: string[] = [];
    const textSlots = new Map<string, ScreenTextSlot>();
    const dataSlots = new Map<string, { kind: string; slot: ScreenDataSlot }>();
    const diffSlots = new Map<string, ScreenDiffSlot>();

    const visit = (b: ScreenBlock): void => {
      switch (b.kind) {
        case 'vstack':
          for (const c of b.children) visit(c);
          break;
        case 'card':
          if (b.header) textSlots.set(b.header.slot, b.header);
          for (const c of b.children) visit(c);
          break;
        case 'divider':
          break;
        case 'heading':
        case 'text':
          textSlots.set(b.text.slot, b.text);
          break;
        case 'badge':
          textSlots.set(b.label.slot, b.label);
          break;
        case 'alert':
          textSlots.set(b.title.slot, b.title);
          if (b.body) textSlots.set(b.body.slot, b.body);
          break;
        case 'kpiStrip':
          dataSlots.set(b.items.slot, { kind: 'kpiStrip', slot: b.items });
          break;
        case 'keyValueList':
          dataSlots.set(b.rows.slot, { kind: 'keyValueList', slot: b.rows });
          break;
        case 'checklist':
          checklists.push(b.id);
          if (b.title) textSlots.set(b.title.slot, b.title);
          dataSlots.set(b.items.slot, { kind: 'checklist', slot: b.items });
          break;
        case 'diffViewer':
          diffSlots.set(b.diff.slot, b.diff);
          break;
        case 'formField':
          fields.push(`${b.id}:${b.fieldType}:${b.required ? 1 : 0}`);
          textSlots.set(b.label.slot, b.label);
          if (
            (b.fieldType === 'text' ||
              b.fieldType === 'email' ||
              b.fieldType === 'url' ||
              b.fieldType === 'secret' ||
              b.fieldType === 'date' ||
              b.fieldType === 'picker') &&
            b.placeholder
          ) {
            textSlots.set(b.placeholder.slot, b.placeholder);
          }
          if (b.fieldType === 'picker') {
            dataSlots.set(b.options.slot, { kind: 'picker', slot: b.options });
          }
          break;
      }
    };
    visit(sk.root);
    const actions = sk.actions.map((a) => {
      textSlots.set(a.label.slot, a.label);
      return `${a.id}:${a.role}:${a.requireBio ? 1 : 0}:${canonJson((a.enabledWhen ?? []) as unknown as ScreenCanonValue)}`;
    });
    return { fields, checklists, actions, textSlots, dataSlots, diffSlots };
  };

  const orig = summarize(original);
  const rep = summarize(repaired);
  if (
    orig.fields.join(',') !== rep.fields.join(',') ||
    orig.checklists.join(',') !== rep.checklists.join(',') ||
    orig.actions.join(',') !== rep.actions.join(',') ||
    orig.textSlots.size !== rep.textSlots.size ||
    orig.dataSlots.size !== rep.dataSlots.size ||
    orig.diffSlots.size !== rep.diffSlots.size
  ) {
    throw new Error('Returned template skeleton does not match original interactive bindings');
  }
  for (const [slotId, origSlot] of orig.textSlots) {
    const repSlot = rep.textSlots.get(slotId);
    if (!repSlot || repSlot.maxGraphemes < origSlot.maxGraphemes || repSlot.maxBytes < origSlot.maxBytes) {
      throw new Error(`Returned template shrank or changed text slot ${slotId}`);
    }
  }
  for (const [slotId, origEntry] of orig.dataSlots) {
    const repEntry = rep.dataSlots.get(slotId);
    if (
      !repEntry ||
      repEntry.kind !== origEntry.kind ||
      repEntry.slot.maxItems < origEntry.slot.maxItems ||
      repEntry.slot.maxBytes < origEntry.slot.maxBytes ||
      (repEntry.slot.minItems ?? 0) > (origEntry.slot.minItems ?? 0)
    ) {
      throw new Error(`Returned template shrank or changed data slot ${slotId}`);
    }
  }
  for (const [slotId, origDiff] of orig.diffSlots) {
    const repDiff = rep.diffSlots.get(slotId);
    if (!repDiff || repDiff.maxBytes < origDiff.maxBytes || repDiff.maxLines < origDiff.maxLines) {
      throw new Error(`Returned template shrank or changed diff slot ${slotId}`);
    }
  }
}
