// Public 3-part wire validation and cryptographic digests for certified screen templates.

import { fromHex, isValidP256PublicKey, sha256, toHex } from './crypto.js';
import {
  canonJson,
  canonRenderInput,
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
  type ScreenAction,
  type ScreenActionRole,
  type ScreenAlertSeverity,
  type ScreenAnswer,
  type ScreenAnswerValues,
  type ScreenBadgeTone,
  type ScreenBlock,
  type ScreenDataSlot,
  type ScreenDataValue,
  type ScreenDiffSlot,
  type ScreenFormFieldBlock,
  type ScreenFormMap,
  type ScreenFormValue,
  type ScreenHeadingLevel,
  type ScreenPredicate,
  type ScreenPresentation,
  type ScreenRenderedAnswer,
  type ScreenRenderedAnswerValues,
  type ScreenRequestPlaintext,
  type ScreenSkeleton,
  type ScreenSpacing,
  type ScreenTemplateId,
  type ScreenTextSlot,
  type ScreenTextStyle,
  type ScreenThread,
  type ScreenUnavailableAnswer,
  type ScreenUnavailableAnswerValues,
  type VerifiedScreenAnswer,
} from './screen-types.js';

const utf8Encoder = new TextEncoder();
const CONTEXT_DIGEST_DOMAIN = utf8Encoder.encode('nb-screen-ctx-v1');
const RENDER_DIGEST_DOMAIN = utf8Encoder.encode('nb-screen-render-v1');

const SPACINGS = new Set<string>(['compact', 'regular', 'relaxed']);
const TEXT_STYLES = new Set<string>(['body', 'caption', 'mono']);
const BADGE_TONES = new Set<string>(['neutral', 'info', 'success', 'warning', 'danger']);
const ALERT_SEVERITIES = new Set<string>(['info', 'success', 'warning', 'danger']);
const ACTION_ROLES = new Set<string>(['primary', 'secondary', 'destructive', 'decline']);
const TEXT_FIELD_TYPES = new Set<string>(['text', 'email', 'url', 'secret', 'date']);

function assertAllowedKeys(
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

function assertLabelText(value: unknown, maxBytes: number, context: string, allowEmpty = false): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string`);
  }
  if (!isValidUnicodeString(value)) {
    throw new Error(`${context} must be valid Unicode`);
  }
  if (hasControlOrFormatScalar(value)) {
    throw new Error(`${context} must not contain control or format characters`);
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
 * Computes `templateId = "tpl_" + hex(SHA-256(UTF-8(canon(skeleton))))`.
 */
export async function computeTemplateId(skeleton: ScreenSkeleton): Promise<ScreenTemplateId> {
  const canonical = canonJson(skeleton as unknown as ScreenCanonValue);
  const digest = await sha256(utf8Encoder.encode(canonical));
  return `tpl_${toHex(digest)}`;
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
