// Zero-Node-dependency public screen skeleton validator, grapheme counter, and WebCrypto SHA-256 helpers.

import { canonJson, isPlainObject, isSafeInt53, utf8ByteLength, type ScreenCanonValue } from './screen-canon.js';
import {
  SCREEN_PUBLIC_CAPS,
  isActionOrdinal,
  isChecklistOrdinal,
  isFieldOrdinal,
  isSlotOrdinal,
  type ScreenAction,
  type ScreenActionRole,
  type ScreenAlertSeverity,
  type ScreenBadgeTone,
  type ScreenBlock,
  type ScreenDataSlot,
  type ScreenDiffSlot,
  type ScreenFormFieldBlock,
  type ScreenHeadingLevel,
  type ScreenPredicate,
  type ScreenSkeleton,
  type ScreenSpacing,
  type ScreenTemplateId,
  type ScreenTextSlot,
  type ScreenTextStyle,
} from './screen-types.js';

const utf8Encoder = new TextEncoder();
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

const SPACINGS = new Set<string>(['compact', 'regular', 'relaxed']);
const TEXT_STYLES = new Set<string>(['body', 'caption', 'mono']);
const BADGE_TONES = new Set<string>(['neutral', 'info', 'success', 'warning', 'danger']);
const ALERT_SEVERITIES = new Set<string>(['info', 'success', 'warning', 'danger']);
const ACTION_ROLES = new Set<string>(['primary', 'secondary', 'destructive', 'decline']);
const TEXT_FIELD_TYPES = new Set<string>(['text', 'email', 'url', 'secret', 'date']);

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function countGraphemes(text: string): number {
  let count = 0;
  for (const _segment of graphemeSegmenter.segment(text)) {
    count += 1;
  }
  return count;
}

export function assertAllowedKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  context: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`Unexpected key "${key}" in ${context}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === undefined) {
      throw new Error(`Missing required key "${key}" in ${context}`);
    }
  }
}

interface TraversalCounters {
  nodes: number;
  nextSlot: number;
  nextField: number;
  nextChecklist: number;
  fieldTypes: Map<string, string>;
  checklists: Set<string>;
}

function claimSlot(rawSlot: unknown, counters: TraversalCounters, context: string): `s${number}` {
  if (!isSlotOrdinal(rawSlot)) {
    throw new Error(`${context}.slot must be a valid slot ordinal (s0..)`);
  }
  const expected = `s${counters.nextSlot}`;
  if (rawSlot !== expected) {
    throw new Error(`${context}.slot expected "${expected}", got "${rawSlot}"`);
  }
  counters.nextSlot += 1;
  if (counters.nextSlot > SCREEN_PUBLIC_CAPS.maxSkeletonSlots) {
    throw new Error('Skeleton exceeds maximum slot count');
  }
  return rawSlot;
}

function validateTextSlot(value: unknown, counters: TraversalCounters, context: string): ScreenTextSlot {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  assertAllowedKeys(value, ['slot', 'maxGraphemes', 'maxBytes'], [], context);
  const slot = claimSlot(value.slot, counters, context);
  const maxGraphemes = value.maxGraphemes;
  const maxBytes = value.maxBytes;
  if (
    !isSafeInt53(maxGraphemes) ||
    maxGraphemes < 1 ||
    maxGraphemes > SCREEN_PUBLIC_CAPS.maxSlotGraphemes
  ) {
    throw new Error(`${context}.maxGraphemes out of public wire bounds`);
  }
  if (
    !isSafeInt53(maxBytes) ||
    maxBytes < maxGraphemes ||
    maxBytes > SCREEN_PUBLIC_CAPS.maxSlotBytes
  ) {
    throw new Error(`${context}.maxBytes out of public wire bounds`);
  }
  return { slot, maxGraphemes, maxBytes };
}

function validateDataSlot(value: unknown, counters: TraversalCounters, context: string): ScreenDataSlot {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  assertAllowedKeys(value, ['slot', 'maxItems', 'maxBytes'], ['minItems'], context);
  const slot = claimSlot(value.slot, counters, context);
  const maxItems = value.maxItems;
  const maxBytes = value.maxBytes;
  if (!isSafeInt53(maxItems) || maxItems < 1 || maxItems > SCREEN_PUBLIC_CAPS.maxItemsPerList) {
    throw new Error(`${context}.maxItems out of public wire bounds`);
  }
  if (!isSafeInt53(maxBytes) || maxBytes < 1 || maxBytes > SCREEN_PUBLIC_CAPS.maxSlotBytes) {
    throw new Error(`${context}.maxBytes out of public wire bounds`);
  }
  const result: ScreenDataSlot = { slot, maxItems, maxBytes };
  if (value.minItems !== undefined) {
    if (!isSafeInt53(value.minItems) || value.minItems < 0 || value.minItems > maxItems) {
      throw new Error(`${context}.minItems out of public wire bounds`);
    }
    result.minItems = value.minItems;
  }
  return result;
}

function validateDiffSlot(value: unknown, counters: TraversalCounters, context: string): ScreenDiffSlot {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  assertAllowedKeys(value, ['slot', 'maxBytes', 'maxLines'], [], context);
  const slot = claimSlot(value.slot, counters, context);
  const maxBytes = value.maxBytes;
  const maxLines = value.maxLines;
  if (!isSafeInt53(maxBytes) || maxBytes < 1 || maxBytes > SCREEN_PUBLIC_CAPS.maxDiffBytes) {
    throw new Error(`${context}.maxBytes out of public wire bounds`);
  }
  if (!isSafeInt53(maxLines) || maxLines < 1 || maxLines > SCREEN_PUBLIC_CAPS.maxDiffLines) {
    throw new Error(`${context}.maxLines out of public wire bounds`);
  }
  return { slot, maxBytes, maxLines };
}

function validateFormFieldBlock(
  obj: Record<string, unknown>,
  counters: TraversalCounters
): ScreenFormFieldBlock {
  const id = obj.id;
  if (!isFieldOrdinal(id)) {
    throw new Error('formField.id must be a valid field ordinal (f0..)');
  }
  const expectedId = `f${counters.nextField}`;
  if (id !== expectedId) {
    throw new Error(`formField.id expected "${expectedId}", got "${id}"`);
  }
  counters.nextField += 1;
  if (counters.nextField > SCREEN_PUBLIC_CAPS.maxSkeletonFields) {
    throw new Error('Skeleton exceeds maximum form field count');
  }

  const fieldType = obj.fieldType;
  if (typeof fieldType !== 'string') {
    throw new Error(`formField ${id} missing fieldType`);
  }
  counters.fieldTypes.set(id, fieldType);

  if (obj.required !== undefined && typeof obj.required !== 'boolean') {
    throw new Error(`formField ${id}.required must be boolean`);
  }

  if (TEXT_FIELD_TYPES.has(fieldType)) {
    assertAllowedKeys(
      obj,
      ['kind', 'id', 'fieldType', 'label'],
      ['placeholder', 'required', 'maxGraphemes', 'maxBytes'],
      `formField(${id})`
    );
    const label = validateTextSlot(obj.label, counters, `${id}.label`);
    const result: ScreenFormFieldBlock = {
      kind: 'formField',
      id,
      fieldType: fieldType as 'text' | 'email' | 'url' | 'secret' | 'date',
      label,
    };
    if (obj.placeholder !== undefined) {
      result.placeholder = validateTextSlot(obj.placeholder, counters, `${id}.placeholder`);
    }
    if (obj.required !== undefined) result.required = obj.required;
    if (obj.maxGraphemes !== undefined) {
      if (
        !isSafeInt53(obj.maxGraphemes) ||
        obj.maxGraphemes < 1 ||
        obj.maxGraphemes > SCREEN_PUBLIC_CAPS.maxSlotGraphemes
      ) {
        throw new Error(`${id}.maxGraphemes out of bounds`);
      }
      result.maxGraphemes = obj.maxGraphemes;
    }
    if (obj.maxBytes !== undefined) {
      if (
        !isSafeInt53(obj.maxBytes) ||
        obj.maxBytes < 1 ||
        obj.maxBytes > SCREEN_PUBLIC_CAPS.maxSlotBytes
      ) {
        throw new Error(`${id}.maxBytes out of bounds`);
      }
      if (result.maxGraphemes !== undefined && obj.maxBytes < result.maxGraphemes) {
        throw new Error(`${id}.maxBytes must be >= maxGraphemes`);
      }
      result.maxBytes = obj.maxBytes;
    }
    return result;
  }

  if (fieldType === 'toggle') {
    assertAllowedKeys(
      obj,
      ['kind', 'id', 'fieldType', 'label'],
      ['required', 'defaultBool'],
      `formField(${id})`
    );
    const label = validateTextSlot(obj.label, counters, `${id}.label`);
    const result: ScreenFormFieldBlock = { kind: 'formField', id, fieldType: 'toggle', label };
    if (obj.required !== undefined) result.required = obj.required;
    if (obj.defaultBool !== undefined) {
      if (typeof obj.defaultBool !== 'boolean') {
        throw new Error(`${id}.defaultBool must be boolean`);
      }
      result.defaultBool = obj.defaultBool;
    }
    return result;
  }

  if (fieldType === 'stepper') {
    assertAllowedKeys(
      obj,
      ['kind', 'id', 'fieldType', 'label', 'min', 'max'],
      ['required', 'defaultInt'],
      `formField(${id})`
    );
    const label = validateTextSlot(obj.label, counters, `${id}.label`);
    const min = obj.min;
    const max = obj.max;
    if (!isSafeInt53(min) || !isSafeInt53(max) || min > max) {
      throw new Error(`${id} stepper requires safe integer min <= max`);
    }
    const result: ScreenFormFieldBlock = {
      kind: 'formField',
      id,
      fieldType: 'stepper',
      label,
      min: Object.is(min, -0) ? 0 : min,
      max: Object.is(max, -0) ? 0 : max,
    };
    if (obj.required !== undefined) result.required = obj.required;
    if (obj.defaultInt !== undefined) {
      if (!isSafeInt53(obj.defaultInt) || obj.defaultInt < result.min || obj.defaultInt > result.max) {
        throw new Error(`${id}.defaultInt must be within [min, max]`);
      }
      result.defaultInt = Object.is(obj.defaultInt, -0) ? 0 : obj.defaultInt;
    }
    return result;
  }

  if (fieldType === 'picker') {
    assertAllowedKeys(
      obj,
      ['kind', 'id', 'fieldType', 'label', 'options'],
      ['placeholder', 'required', 'defaultOptionIndex'],
      `formField(${id})`
    );
    const label = validateTextSlot(obj.label, counters, `${id}.label`);
    const placeholder =
      obj.placeholder !== undefined
        ? validateTextSlot(obj.placeholder, counters, `${id}.placeholder`)
        : undefined;
    const options = validateDataSlot(obj.options, counters, `${id}.options`);
    const result: ScreenFormFieldBlock = {
      kind: 'formField',
      id,
      fieldType: 'picker',
      label,
      options,
    };
    if (placeholder !== undefined) result.placeholder = placeholder;
    if (obj.required !== undefined) result.required = obj.required;
    if (obj.defaultOptionIndex !== undefined) {
      if (
        !isSafeInt53(obj.defaultOptionIndex) ||
        obj.defaultOptionIndex < -1 ||
        obj.defaultOptionIndex >= options.maxItems
      ) {
        throw new Error(`${id}.defaultOptionIndex out of bounds`);
      }
      result.defaultOptionIndex = Object.is(obj.defaultOptionIndex, -0) ? 0 : obj.defaultOptionIndex;
    }
    return result;
  }

  throw new Error(`Unsupported formField fieldType "${fieldType}"`);
}

function validateBlock(value: unknown, depth: number, counters: TraversalCounters): ScreenBlock {
  if (depth > SCREEN_PUBLIC_CAPS.maxSkeletonDepth) {
    throw new Error('Skeleton exceeds maximum nesting depth');
  }
  counters.nodes += 1;
  if (counters.nodes > SCREEN_PUBLIC_CAPS.maxSkeletonNodes) {
    throw new Error('Skeleton exceeds maximum node count');
  }
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    throw new Error('Block must be an object with a string kind');
  }

  switch (value.kind) {
    case 'vstack': {
      assertAllowedKeys(value, ['kind', 'children'], ['spacing'], 'vstack');
      if (!Array.isArray(value.children)) {
        throw new Error('vstack.children must be an array');
      }
      const result: ScreenBlock = {
        kind: 'vstack',
        children: value.children.map((child) => validateBlock(child, depth + 1, counters)),
      };
      if (value.spacing !== undefined) {
        if (typeof value.spacing !== 'string' || !SPACINGS.has(value.spacing)) {
          throw new Error('vstack.spacing must be compact | regular | relaxed');
        }
        result.spacing = value.spacing as ScreenSpacing;
      }
      return result;
    }
    case 'card': {
      assertAllowedKeys(value, ['kind', 'children'], ['header'], 'card');
      const header =
        value.header !== undefined
          ? validateTextSlot(value.header, counters, 'card.header')
          : undefined;
      if (!Array.isArray(value.children)) {
        throw new Error('card.children must be an array');
      }
      const children = value.children.map((child) => validateBlock(child, depth + 1, counters));
      return header !== undefined
        ? { kind: 'card', header, children }
        : { kind: 'card', children };
    }
    case 'divider': {
      assertAllowedKeys(value, ['kind'], [], 'divider');
      return { kind: 'divider' };
    }
    case 'heading': {
      assertAllowedKeys(value, ['kind', 'text'], ['level'], 'heading');
      const text = validateTextSlot(value.text, counters, 'heading.text');
      if (value.level !== undefined) {
        if (value.level !== 1 && value.level !== 2 && value.level !== 3) {
          throw new Error('heading.level must be 1, 2, or 3');
        }
        return { kind: 'heading', level: value.level as ScreenHeadingLevel, text };
      }
      return { kind: 'heading', text };
    }
    case 'text': {
      assertAllowedKeys(value, ['kind', 'text'], ['style'], 'text');
      const text = validateTextSlot(value.text, counters, 'text.text');
      if (value.style !== undefined) {
        if (typeof value.style !== 'string' || !TEXT_STYLES.has(value.style)) {
          throw new Error('text.style must be body | caption | mono');
        }
        return { kind: 'text', style: value.style as ScreenTextStyle, text };
      }
      return { kind: 'text', text };
    }
    case 'badge': {
      assertAllowedKeys(value, ['kind', 'tone', 'label'], [], 'badge');
      if (typeof value.tone !== 'string' || !BADGE_TONES.has(value.tone)) {
        throw new Error('badge.tone is invalid');
      }
      const label = validateTextSlot(value.label, counters, 'badge.label');
      return { kind: 'badge', tone: value.tone as ScreenBadgeTone, label };
    }
    case 'alert': {
      assertAllowedKeys(value, ['kind', 'severity', 'title'], ['body'], 'alert');
      if (typeof value.severity !== 'string' || !ALERT_SEVERITIES.has(value.severity)) {
        throw new Error('alert.severity is invalid');
      }
      const title = validateTextSlot(value.title, counters, 'alert.title');
      if (value.body !== undefined) {
        const body = validateTextSlot(value.body, counters, 'alert.body');
        return { kind: 'alert', severity: value.severity as ScreenAlertSeverity, title, body };
      }
      return { kind: 'alert', severity: value.severity as ScreenAlertSeverity, title };
    }
    case 'kpiStrip': {
      assertAllowedKeys(value, ['kind', 'items'], [], 'kpiStrip');
      const items = validateDataSlot(value.items, counters, 'kpiStrip.items');
      return { kind: 'kpiStrip', items };
    }
    case 'keyValueList': {
      assertAllowedKeys(value, ['kind', 'rows'], [], 'keyValueList');
      const rows = validateDataSlot(value.rows, counters, 'keyValueList.rows');
      return { kind: 'keyValueList', rows };
    }
    case 'checklist': {
      assertAllowedKeys(value, ['kind', 'id', 'items'], ['title'], 'checklist');
      if (!isChecklistOrdinal(value.id)) {
        throw new Error('checklist.id must be a valid checklist ordinal (c0..)');
      }
      const expectedId = `c${counters.nextChecklist}`;
      if (value.id !== expectedId) {
        throw new Error(`checklist.id expected "${expectedId}", got "${value.id}"`);
      }
      counters.nextChecklist += 1;
      if (counters.nextChecklist > SCREEN_PUBLIC_CAPS.maxSkeletonChecklists) {
        throw new Error('Skeleton exceeds maximum checklist count');
      }
      counters.checklists.add(value.id);
      const title =
        value.title !== undefined
          ? validateTextSlot(value.title, counters, `${value.id}.title`)
          : undefined;
      const items = validateDataSlot(value.items, counters, `${value.id}.items`);
      return title !== undefined
        ? { kind: 'checklist', id: value.id, title, items }
        : { kind: 'checklist', id: value.id, items };
    }
    case 'diffViewer': {
      assertAllowedKeys(value, ['kind', 'diff'], [], 'diffViewer');
      const diff = validateDiffSlot(value.diff, counters, 'diffViewer.diff');
      return { kind: 'diffViewer', diff };
    }
    case 'formField':
      return validateFormFieldBlock(value, counters);
    default:
      throw new Error(`Unknown screen block kind "${value.kind}"`);
  }
}

function validatePredicate(value: unknown, counters: TraversalCounters): ScreenPredicate {
  if (!isPlainObject(value) || typeof value.op !== 'string') {
    throw new Error('Predicate must be an object with op');
  }
  switch (value.op) {
    case 'allChecked': {
      assertAllowedKeys(value, ['op', 'checklist'], [], 'predicate(allChecked)');
      if (!isChecklistOrdinal(value.checklist) || !counters.checklists.has(value.checklist)) {
        throw new Error(`Predicate references unknown checklist "${String(value.checklist)}"`);
      }
      return { op: 'allChecked', checklist: value.checklist };
    }
    case 'isNotEmpty': {
      assertAllowedKeys(value, ['op', 'field'], [], 'predicate(isNotEmpty)');
      if (!isFieldOrdinal(value.field) || !counters.fieldTypes.has(value.field)) {
        throw new Error(`Predicate references unknown field "${String(value.field)}"`);
      }
      const fieldType = counters.fieldTypes.get(value.field);
      if (!fieldType || !TEXT_FIELD_TYPES.has(fieldType)) {
        throw new Error(`isNotEmpty predicate requires a text-like field (${value.field})`);
      }
      return { op: 'isNotEmpty', field: value.field };
    }
    case 'equals': {
      assertAllowedKeys(value, ['op', 'field', 'value'], [], 'predicate(equals)');
      if (!isFieldOrdinal(value.field) || !counters.fieldTypes.has(value.field)) {
        throw new Error(`Predicate references unknown field "${String(value.field)}"`);
      }
      const fieldType = counters.fieldTypes.get(value.field);
      if (typeof value.value === 'boolean') {
        if (fieldType !== 'toggle') {
          throw new Error(`equals(bool) predicate requires a toggle field (${value.field})`);
        }
        return { op: 'equals', field: value.field, value: value.value };
      }
      if (isSafeInt53(value.value)) {
        if (fieldType !== 'picker' || value.value < -1) {
          throw new Error(`equals(optionIndex) predicate requires a picker field (${value.field})`);
        }
        return {
          op: 'equals',
          field: value.field,
          value: Object.is(value.value, -0) ? 0 : value.value,
        };
      }
      throw new Error('equals predicate value must be boolean or option index integer');
    }
    default:
      throw new Error(`Unknown predicate op "${value.op}"`);
  }
}

/**
 * Validates a public screen template skeleton against strict keys, 12-block syntax,
 * contiguous pre-order traversal ordinals (`s0..`, `f0..`, `c0..`, `a0..`),
 * and loose public wire caps.
 */
export function validateScreenSkeleton(value: unknown): ScreenSkeleton {
  if (!isPlainObject(value)) {
    throw new Error('Screen skeleton must be a JSON object');
  }
  assertAllowedKeys(value, ['v', 'root', 'actions'], [], 'skeleton');
  if (value.v !== 1) {
    throw new Error('Screen skeleton version must be 1');
  }

  const counters: TraversalCounters = {
    nodes: 0,
    nextSlot: 0,
    nextField: 0,
    nextChecklist: 0,
    fieldTypes: new Map(),
    checklists: new Set(),
  };

  const root = validateBlock(value.root, 1, counters);

  if (
    !Array.isArray(value.actions) ||
    value.actions.length < 1 ||
    value.actions.length > SCREEN_PUBLIC_CAPS.maxSkeletonActions
  ) {
    throw new Error('Screen skeleton must define between 1 and 16 actions');
  }

  const actions: ScreenAction[] = value.actions.map((rawAction, idx) => {
    if (!isPlainObject(rawAction)) {
      throw new Error(`Action ${idx} must be an object`);
    }
    assertAllowedKeys(
      rawAction,
      ['id', 'label', 'role', 'requireBio'],
      ['enabledWhen'],
      `actions[${idx}]`
    );
    const expectedId = `a${idx}`;
    if (!isActionOrdinal(rawAction.id) || rawAction.id !== expectedId) {
      throw new Error(`actions[${idx}].id expected "${expectedId}", got "${String(rawAction.id)}"`);
    }
    const label = validateTextSlot(rawAction.label, counters, `actions[${idx}].label`);
    if (typeof rawAction.role !== 'string' || !ACTION_ROLES.has(rawAction.role)) {
      throw new Error(`actions[${idx}].role is invalid`);
    }
    if (typeof rawAction.requireBio !== 'boolean') {
      throw new Error(`actions[${idx}].requireBio must be boolean`);
    }
    const action: ScreenAction = {
      id: rawAction.id,
      label,
      role: rawAction.role as ScreenActionRole,
      requireBio: rawAction.requireBio,
    };
    if (rawAction.enabledWhen !== undefined) {
      if (
        !Array.isArray(rawAction.enabledWhen) ||
        rawAction.enabledWhen.length > SCREEN_PUBLIC_CAPS.maxPredicatesPerAction
      ) {
        throw new Error(`actions[${idx}].enabledWhen exceeds predicate limit`);
      }
      action.enabledWhen = rawAction.enabledWhen.map((p) => validatePredicate(p, counters));
    }
    return action;
  });

  const skeleton: ScreenSkeleton = { v: 1, root, actions };
  const canonicalBytes = utf8ByteLength(canonJson(skeleton as unknown as ScreenCanonValue));
  if (canonicalBytes > SCREEN_PUBLIC_CAPS.maxSkeletonBytes) {
    throw new Error('Screen skeleton exceeds maximum serialized byte cap');
  }
  return skeleton;
}

/**
 * Computes `templateId = "tpl_" + hex(SHA-256(UTF-8(canon(skeleton))))`.
 */
export async function computeTemplateId(skeleton: ScreenSkeleton): Promise<ScreenTemplateId> {
  const canonical = canonJson(skeleton as unknown as ScreenCanonValue);
  const digest = await sha256Bytes(utf8Encoder.encode(canonical));
  return `tpl_${bytesToHex(digest)}`;
}
