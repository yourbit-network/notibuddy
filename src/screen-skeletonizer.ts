// Client-side screen template skeletonizer, pre-order ordinal assigner, and feedback re-hydrator.
// Separates inline text/data literals into encrypted `labels` and `data` locally before
// transmitting zero-literal skeletons to `POST /v2/templates`.

import { sha256, toHex } from './crypto.js';
import {
  canonJson,
  hasControlOrFormatScalar,
  isPlainObject,
  isSafeInt53,
  isValidUnicodeString,
  utf8ByteLength,
  type ScreenCanonValue,
} from './screen-canon.js';
import { countGraphemes } from './screen-record.js';
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
import { validateScreenSkeleton } from './screen-wire.js';

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

const SPACINGS = new Set<string>(['compact', 'regular', 'relaxed']);
const TEXT_STYLES = new Set<string>(['body', 'caption', 'mono']);
const BADGE_TONES = new Set<string>(['neutral', 'info', 'success', 'warning', 'danger']);
const ALERT_SEVERITIES = new Set<string>(['info', 'success', 'warning', 'danger']);
const ACTION_ROLES = new Set<string>(['primary', 'secondary', 'destructive', 'decline']);
const TEXT_FIELD_TYPES = new Set<string>(['text', 'email', 'url', 'secret', 'date']);
const SEMANTIC_ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const GRAPHEME_TIERS = [32, 64, 128, 256, 512, 1024, 2048, 4096] as const;
const ITEM_TIERS = [4, 8, 16, 32, 64, 128, 256] as const;
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
  requireNonEmpty: boolean
): { minItems: number; maxItems: number; maxBytes: number } {
  const maxItems = nextTier(Math.max(1, items.length), ITEM_TIERS);
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
  context: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new Error(`Unexpected key "${key}" in ${context}`);
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
    throw new Error('Screen template must be a JSON object');
  }
  checkAllowedKeys(input, ['v', 'root', 'actions'], 'screen template');
  if (input.v !== undefined && input.v !== 1) {
    throw new Error('Screen template version v must be 1');
  }
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > SCREEN_PUBLIC_CAPS.maxSkeletonActions) {
    throw new Error('Screen template must define between 1 and 16 actions');
  }

  // Pass 1: collect flat pre-order metadata and compute all ordinals via the pure pre-order assigners.
  const meta: PreOrderNodeMeta[] = [];
  collectPreOrderMeta(input.root, meta, 1);
  const nodeKinds = meta.map((m) => m.kindCode);
  const nodeOptFlags = meta.map((m) => m.optFlags);

  const nodeSlotStarts = assignNodeSlotStarts(nodeKinds, nodeOptFlags);
  const nodeFieldOrdinals = assignFieldOrdinals(nodeKinds);
  const nodeChecklistOrdinals = assignChecklistOrdinals(nodeKinds);
  const actionSlotOrdinals = assignActionSlotOrdinals(nodeKinds, nodeOptFlags, input.actions.length);

  const labels: Record<string, string> = {};
  const data: Record<string, ScreenDataValue> = {};
  if (explicitLabels) {
    if (!isPlainObject(explicitLabels)) throw new Error('screen.labels must be an object');
    for (const [k, v] of Object.entries(explicitLabels)) {
      if (!isSlotOrdinal(k) || typeof v !== 'string') {
        throw new Error(`Invalid explicit label entry "${k}"`);
      }
      labels[k] = v;
    }
  }
  if (explicitData) {
    if (!isPlainObject(explicitData)) throw new Error('screen.data must be an object');
    for (const [k, v] of Object.entries(explicitData)) {
      if (!isSlotOrdinal(k)) throw new Error(`Invalid explicit data key "${k}"`);
      data[k] = validateInlineDataValue(v, 1, `data.${k}`);
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
      if (!isValidUnicodeString(raw) || hasControlOrFormatScalar(raw)) {
        throw new Error(`${context} contains invalid or control characters`);
      }
      ordinalMap.usedInlineLiterals = true;
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: true };
      if (Object.prototype.hasOwnProperty.call(labels, slot)) {
        throw new Error(`Duplicate label binding for slot "${slot}"`);
      }
      labels[slot] = raw;
      const bounds = defaultTextBounds(raw, minTier);
      return { slot, maxGraphemes: bounds.maxGraphemes, maxBytes: bounds.maxBytes };
    }
    if (isTextSlotSpec(raw)) {
      checkAllowedKeys(raw, ['slot', 'maxGraphemes', 'maxBytes', 'value'], context);
      if (raw.slot !== undefined && raw.slot !== slot) {
        throw new Error(`${context}.slot expected "${slot}", got "${String(raw.slot)}"`);
      }
      let inlineText: string | undefined;
      if (raw.value !== undefined) {
        if (typeof raw.value !== 'string' || !isValidUnicodeString(raw.value) || hasControlOrFormatScalar(raw.value)) {
          throw new Error(`${context}.value must be a valid display string`);
        }
        inlineText = raw.value;
        ordinalMap.usedInlineLiterals = true;
        if (Object.prototype.hasOwnProperty.call(labels, slot)) {
          throw new Error(`Duplicate label binding for slot "${slot}"`);
        }
        labels[slot] = inlineText;
      }
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: inlineText !== undefined };
      const fallback = inlineText !== undefined ? defaultTextBounds(inlineText, minTier) : undefined;
      const maxGraphemes = raw.maxGraphemes ?? fallback?.maxGraphemes;
      const maxBytes = raw.maxBytes ?? fallback?.maxBytes;
      if (!isSafeInt53(maxGraphemes) || !isSafeInt53(maxBytes)) {
        throw new Error(`${context} requires safe integer maxGraphemes and maxBytes`);
      }
      return { slot, maxGraphemes, maxBytes };
    }
    throw new Error(`${context} must be a display string or text slot descriptor`);
  };

  const buildDataSlot = (
    raw: unknown,
    slotIndex: number,
    requireNonEmpty: boolean,
    originPath: string,
    context: string
  ): ScreenDataSlot => {
    const slot: ScreenSlotId = `s${slotIndex}`;
    if (Array.isArray(raw)) {
      const validated = validateInlineDataValue(raw, 1, context) as ScreenDataValue[];
      ordinalMap.usedInlineLiterals = true;
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: true };
      if (Object.prototype.hasOwnProperty.call(data, slot)) {
        throw new Error(`Duplicate data binding for slot "${slot}"`);
      }
      data[slot] = validated;
      const bounds = defaultDataBounds(validated, requireNonEmpty);
      return requireNonEmpty
        ? { slot, minItems: bounds.minItems, maxItems: bounds.maxItems, maxBytes: bounds.maxBytes }
        : { slot, maxItems: bounds.maxItems, maxBytes: bounds.maxBytes };
    }
    if (isDataSlotSpec(raw)) {
      checkAllowedKeys(raw, ['slot', 'minItems', 'maxItems', 'maxBytes', 'value'], context);
      if (raw.slot !== undefined && raw.slot !== slot) {
        throw new Error(`${context}.slot expected "${slot}", got "${String(raw.slot)}"`);
      }
      let inlineArray: ScreenDataValue[] | undefined;
      if (raw.value !== undefined) {
        if (!Array.isArray(raw.value)) {
          throw new Error(`${context}.value must be an array`);
        }
        inlineArray = validateInlineDataValue(raw.value, 1, `${context}.value`) as ScreenDataValue[];
        ordinalMap.usedInlineLiterals = true;
        if (Object.prototype.hasOwnProperty.call(data, slot)) {
          throw new Error(`Duplicate data binding for slot "${slot}"`);
        }
        data[slot] = inlineArray;
      }
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: inlineArray !== undefined };
      const fallback = inlineArray !== undefined ? defaultDataBounds(inlineArray, requireNonEmpty) : undefined;
      const maxItems = raw.maxItems ?? fallback?.maxItems;
      const maxBytes = raw.maxBytes ?? fallback?.maxBytes;
      if (!isSafeInt53(maxItems) || !isSafeInt53(maxBytes)) {
        throw new Error(`${context} requires safe integer maxItems and maxBytes`);
      }
      const out: ScreenDataSlot = { slot, maxItems, maxBytes };
      const minItems = raw.minItems ?? (requireNonEmpty ? fallback?.minItems : undefined);
      if (minItems !== undefined) {
        if (!isSafeInt53(minItems)) throw new Error(`${context}.minItems must be a safe integer`);
        out.minItems = minItems;
      }
      return out;
    }
    throw new Error(`${context} must be an array or data slot descriptor`);
  };

  const buildDiffSlot = (
    raw: unknown,
    slotIndex: number,
    originPath: string,
    context: string
  ): ScreenDiffSlot => {
    const slot: ScreenSlotId = `s${slotIndex}`;
    if (typeof raw === 'string' || (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, 'original'))) {
      const validated = validateInlineDataValue(raw, 1, context);
      ordinalMap.usedInlineLiterals = true;
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: true };
      if (Object.prototype.hasOwnProperty.call(data, slot)) {
        throw new Error(`Duplicate diff binding for slot "${slot}"`);
      }
      data[slot] = validated;
      const bounds = defaultDiffBounds(validated);
      return { slot, maxBytes: bounds.maxBytes, maxLines: bounds.maxLines };
    }
    if (isDiffSlotSpec(raw)) {
      checkAllowedKeys(raw, ['slot', 'maxBytes', 'maxLines', 'value'], context);
      if (raw.slot !== undefined && raw.slot !== slot) {
        throw new Error(`${context}.slot expected "${slot}", got "${String(raw.slot)}"`);
      }
      let inlineVal: ScreenDataValue | undefined;
      if (raw.value !== undefined) {
        inlineVal = validateInlineDataValue(raw.value, 1, `${context}.value`);
        ordinalMap.usedInlineLiterals = true;
        if (Object.prototype.hasOwnProperty.call(data, slot)) {
          throw new Error(`Duplicate diff binding for slot "${slot}"`);
        }
        data[slot] = inlineVal;
      }
      ordinalMap.slotOrigin[slot] = { path: originPath, inline: inlineVal !== undefined };
      const fallback = inlineVal !== undefined ? defaultDiffBounds(inlineVal) : undefined;
      const maxBytes = raw.maxBytes ?? fallback?.maxBytes;
      const maxLines = raw.maxLines ?? fallback?.maxLines;
      if (!isSafeInt53(maxBytes) || !isSafeInt53(maxLines)) {
        throw new Error(`${context} requires safe integer maxBytes and maxLines`);
      }
      return { slot, maxBytes, maxLines };
    }
    throw new Error(`${context} must be a diff payload or diff slot descriptor`);
  };

  const registerSemanticId = (
    rawId: unknown,
    assigned: string,
    toAuthored: Record<string, string>,
    fromAuthored: Record<string, any>,
    kindLabel: string
  ): string => {
    if (rawId === undefined) {
      toAuthored[assigned] = assigned;
      fromAuthored[assigned] = assigned;
      return assigned;
    }
    if (typeof rawId !== 'string' || !SEMANTIC_ID_RE.test(rawId)) {
      throw new Error(`Invalid ${kindLabel} id "${String(rawId)}"`);
    }
    if (Object.prototype.hasOwnProperty.call(fromAuthored, rawId)) {
      throw new Error(`Duplicate ${kindLabel} id "${rawId}"`);
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
        checkAllowedKeys(obj, ['kind', 'spacing', 'children'], pathLabel);
        const children = (obj.children as unknown[]).map((child, i) =>
          transformBlock(child, `${pathLabel}.children[${i}]`)
        );
        const out: ScreenBlock = { kind: 'vstack', children };
        if (obj.spacing !== undefined) {
          if (typeof obj.spacing !== 'string' || !SPACINGS.has(obj.spacing)) {
            throw new Error(`${pathLabel}.spacing must be compact | regular | relaxed`);
          }
          out.spacing = obj.spacing as ScreenSpacing;
        }
        return out;
      }
      case 'card': {
        checkAllowedKeys(obj, ['kind', 'header', 'children'], pathLabel);
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
        checkAllowedKeys(obj, ['kind'], pathLabel);
        return { kind: 'divider' };
      }
      case 'heading': {
        checkAllowedKeys(obj, ['kind', 'level', 'text'], pathLabel);
        const text = buildTextSlot(obj.text, slotCursor++, 64, `${pathLabel}.text`, `${pathLabel}.text`);
        if (obj.level !== undefined) {
          if (obj.level !== 1 && obj.level !== 2 && obj.level !== 3) {
            throw new Error(`${pathLabel}.level must be 1, 2, or 3`);
          }
          return { kind: 'heading', level: obj.level as ScreenHeadingLevel, text };
        }
        return { kind: 'heading', text };
      }
      case 'text': {
        checkAllowedKeys(obj, ['kind', 'style', 'text'], pathLabel);
        const text = buildTextSlot(obj.text, slotCursor++, 128, `${pathLabel}.text`, `${pathLabel}.text`);
        if (obj.style !== undefined) {
          if (typeof obj.style !== 'string' || !TEXT_STYLES.has(obj.style)) {
            throw new Error(`${pathLabel}.style must be body | caption | mono`);
          }
          return { kind: 'text', style: obj.style as ScreenTextStyle, text };
        }
        return { kind: 'text', text };
      }
      case 'badge': {
        checkAllowedKeys(obj, ['kind', 'tone', 'label'], pathLabel);
        if (typeof obj.tone !== 'string' || !BADGE_TONES.has(obj.tone)) {
          throw new Error(`${pathLabel}.tone is invalid`);
        }
        const label = buildTextSlot(obj.label, slotCursor++, 32, `${pathLabel}.label`, `${pathLabel}.label`);
        return { kind: 'badge', tone: obj.tone as ScreenBadgeTone, label };
      }
      case 'alert': {
        checkAllowedKeys(obj, ['kind', 'severity', 'title', 'body'], pathLabel);
        if (typeof obj.severity !== 'string' || !ALERT_SEVERITIES.has(obj.severity)) {
          throw new Error(`${pathLabel}.severity is invalid`);
        }
        const title = buildTextSlot(obj.title, slotCursor++, 128, `${pathLabel}.title`, `${pathLabel}.title`);
        if (obj.body !== undefined) {
          const body = buildTextSlot(obj.body, slotCursor++, 256, `${pathLabel}.body`, `${pathLabel}.body`);
          return { kind: 'alert', severity: obj.severity as ScreenAlertSeverity, title, body };
        }
        return { kind: 'alert', severity: obj.severity as ScreenAlertSeverity, title };
      }
      case 'kpiStrip': {
        checkAllowedKeys(obj, ['kind', 'items'], pathLabel);
        const items = buildDataSlot(obj.items, slotCursor++, false, `${pathLabel}.items`, `${pathLabel}.items`);
        return { kind: 'kpiStrip', items };
      }
      case 'keyValueList': {
        checkAllowedKeys(obj, ['kind', 'rows'], pathLabel);
        const rows = buildDataSlot(obj.rows, slotCursor++, false, `${pathLabel}.rows`, `${pathLabel}.rows`);
        return { kind: 'keyValueList', rows };
      }
      case 'checklist': {
        checkAllowedKeys(obj, ['kind', 'id', 'title', 'items'], pathLabel);
        const id: ScreenChecklistId = `c${nodeChecklistOrdinals[idx]!}`;
        const authoredId = registerSemanticId(
          obj.id,
          id,
          ordinalMap.checklistToAuthored,
          ordinalMap.authoredToChecklist,
          'checklist'
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
        checkAllowedKeys(obj, ['kind', 'diff'], pathLabel);
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
          'formField'
        );
        const fieldType = obj.fieldType;
        if (typeof fieldType !== 'string') {
          throw new Error(`${pathLabel}.fieldType is required`);
        }
        fieldTypesByOrdinal.set(id, fieldType);
        if (obj.required !== undefined && typeof obj.required !== 'boolean') {
          throw new Error(`${pathLabel}.required must be boolean`);
        }
        if (TEXT_FIELD_TYPES.has(fieldType)) {
          checkAllowedKeys(
            obj,
            ['kind', 'id', 'fieldType', 'label', 'placeholder', 'required', 'maxGraphemes', 'maxBytes'],
            pathLabel
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
          if (obj.required !== undefined) out.required = obj.required;
          if (obj.maxGraphemes !== undefined) {
            if (!isSafeInt53(obj.maxGraphemes)) throw new Error(`${pathLabel}.maxGraphemes must be integer`);
            out.maxGraphemes = obj.maxGraphemes;
          }
          if (obj.maxBytes !== undefined) {
            if (!isSafeInt53(obj.maxBytes)) throw new Error(`${pathLabel}.maxBytes must be integer`);
            out.maxBytes = obj.maxBytes;
          }
          return out;
        }
        if (fieldType === 'toggle') {
          checkAllowedKeys(obj, ['kind', 'id', 'fieldType', 'label', 'required', 'defaultBool'], pathLabel);
          const label = buildTextSlot(obj.label, slotCursor++, 64, `${authoredId}.label`, `${pathLabel}.label`);
          const out: ScreenFormFieldBlock = { kind: 'formField', id, fieldType: 'toggle', label };
          if (obj.required !== undefined) out.required = obj.required;
          if (obj.defaultBool !== undefined) {
            if (typeof obj.defaultBool !== 'boolean') throw new Error(`${pathLabel}.defaultBool must be boolean`);
            out.defaultBool = obj.defaultBool;
          }
          return out;
        }
        if (fieldType === 'stepper') {
          checkAllowedKeys(
            obj,
            ['kind', 'id', 'fieldType', 'label', 'required', 'min', 'max', 'defaultInt'],
            pathLabel
          );
          const label = buildTextSlot(obj.label, slotCursor++, 64, `${authoredId}.label`, `${pathLabel}.label`);
          if (!isSafeInt53(obj.min) || !isSafeInt53(obj.max)) {
            throw new Error(`${pathLabel} stepper requires safe integer min and max`);
          }
          const out: ScreenFormFieldBlock = {
            kind: 'formField',
            id,
            fieldType: 'stepper',
            label,
            min: Object.is(obj.min, -0) ? 0 : obj.min,
            max: Object.is(obj.max, -0) ? 0 : obj.max,
          };
          if (obj.required !== undefined) out.required = obj.required;
          if (obj.defaultInt !== undefined) {
            if (!isSafeInt53(obj.defaultInt)) throw new Error(`${pathLabel}.defaultInt must be safe integer`);
            out.defaultInt = Object.is(obj.defaultInt, -0) ? 0 : obj.defaultInt;
          }
          return out;
        }
        if (fieldType === 'picker') {
          checkAllowedKeys(
            obj,
            ['kind', 'id', 'fieldType', 'label', 'placeholder', 'required', 'options', 'defaultOptionIndex'],
            pathLabel
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
            `${pathLabel}.options`
          );
          const out: ScreenFormFieldBlock = { kind: 'formField', id, fieldType: 'picker', label, options };
          if (placeholder !== undefined) out.placeholder = placeholder;
          if (obj.required !== undefined) out.required = obj.required;
          if (obj.defaultOptionIndex !== undefined) {
            if (!isSafeInt53(obj.defaultOptionIndex)) {
              throw new Error(`${pathLabel}.defaultOptionIndex must be safe integer`);
            }
            out.defaultOptionIndex = Object.is(obj.defaultOptionIndex, -0) ? 0 : obj.defaultOptionIndex;
          }
          return out;
        }
        throw new Error(`Unsupported formField fieldType "${fieldType}"`);
      }
      default:
        throw new Error(`Unknown screen block kind "${String(obj.kind)}"`);
    }
  };

  const root = transformBlock(input.root, 'root');

  const actions: ScreenAction[] = input.actions.map((rawAction, idx) => {
    if (!isPlainObject(rawAction)) {
      throw new Error(`actions[${idx}] must be an object`);
    }
    checkAllowedKeys(rawAction, ['id', 'label', 'role', 'requireBio', 'enabledWhen'], `actions[${idx}]`);
    if (rawAction.id === 'dismiss') {
      throw new Error('Action id "dismiss" is reserved for host-owned unavailable dismissal');
    }
    const id: ScreenActionId = `a${idx}`;
    const authoredId = registerSemanticId(
      rawAction.id,
      id,
      ordinalMap.actionToAuthored,
      ordinalMap.authoredToAction,
      'action'
    );
    const label = buildTextSlot(
      rawAction.label,
      actionSlotOrdinals[idx]!,
      32,
      `actions.${authoredId}.label`,
      `actions[${idx}].label`
    );
    if (typeof rawAction.role !== 'string' || !ACTION_ROLES.has(rawAction.role)) {
      throw new Error(`actions[${idx}].role is invalid`);
    }
    if (typeof rawAction.requireBio !== 'boolean') {
      throw new Error(`actions[${idx}].requireBio must be boolean`);
    }
    const action: ScreenAction = {
      id,
      label,
      role: rawAction.role as ScreenActionRole,
      requireBio: rawAction.requireBio,
    };
    if (rawAction.enabledWhen !== undefined) {
      if (!Array.isArray(rawAction.enabledWhen)) {
        throw new Error(`actions[${idx}].enabledWhen must be an array`);
      }
      action.enabledWhen = rawAction.enabledWhen.map((rawPred, pIdx): ScreenPredicate => {
        if (!isPlainObject(rawPred) || typeof rawPred.op !== 'string') {
          throw new Error(`actions[${idx}].enabledWhen[${pIdx}] must be an object with op`);
        }
        if (rawPred.op === 'allChecked') {
          checkAllowedKeys(rawPred, ['op', 'checklist'], `actions[${idx}].enabledWhen[${pIdx}]`);
          const target = typeof rawPred.checklist === 'string' ? rawPred.checklist : '';
          const mapped =
            ordinalMap.authoredToChecklist[target] ??
            (isChecklistOrdinal(target) && checklistOrdinalsSet.has(target) ? target : undefined);
          if (!mapped) {
            throw new Error(`Predicate references unknown checklist "${target}"`);
          }
          return { op: 'allChecked', checklist: mapped };
        }
        if (rawPred.op === 'isNotEmpty') {
          checkAllowedKeys(rawPred, ['op', 'field'], `actions[${idx}].enabledWhen[${pIdx}]`);
          const target = typeof rawPred.field === 'string' ? rawPred.field : '';
          const mapped =
            ordinalMap.authoredToField[target] ??
            (isFieldOrdinal(target) && fieldTypesByOrdinal.has(target) ? target : undefined);
          if (!mapped) {
            throw new Error(`Predicate references unknown field "${target}"`);
          }
          return { op: 'isNotEmpty', field: mapped };
        }
        if (rawPred.op === 'equals') {
          checkAllowedKeys(rawPred, ['op', 'field', 'value'], `actions[${idx}].enabledWhen[${pIdx}]`);
          const target = typeof rawPred.field === 'string' ? rawPred.field : '';
          const mapped =
            ordinalMap.authoredToField[target] ??
            (isFieldOrdinal(target) && fieldTypesByOrdinal.has(target) ? target : undefined);
          if (!mapped) {
            throw new Error(`Predicate references unknown field "${target}"`);
          }
          if (typeof rawPred.value === 'boolean') {
            return { op: 'equals', field: mapped, value: rawPred.value };
          }
          if (isSafeInt53(rawPred.value)) {
            return { op: 'equals', field: mapped, value: Object.is(rawPred.value, -0) ? 0 : rawPred.value };
          }
          throw new Error(`actions[${idx}].enabledWhen[${pIdx}].value must be boolean or safe integer`);
        }
        throw new Error(`Unknown predicate op "${rawPred.op}"`);
      });
    }
    return action;
  });

  const skeleton = validateScreenSkeleton({ v: 1, root, actions });
  const inputSkeletonHash = toHex(await sha256(new TextEncoder().encode(canonJson(skeleton as unknown as ScreenCanonValue))));

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
