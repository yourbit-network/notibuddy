// Total form projection, shape validation, and AND-only predicate evaluation for certified screens.

import { isPlainObject, isSafeInt53, isValidUnicodeString, utf8ByteLength } from './screen-canon.js';
import {
  SCREEN_PUBLIC_CAPS,
  type ScreenAction,
  type ScreenBlock,
  type ScreenChecklistBlock,
  type ScreenFormFieldBlock,
  type ScreenFormMap,
  type ScreenFormValue,
  type ScreenSkeleton,
} from './screen-types.js';

export const FORM_KIND_TEXT = 0;
export const FORM_KIND_TOGGLE = 1;
export const FORM_KIND_STEPPER = 2;
export const FORM_KIND_PICKER = 3;
export const FORM_KIND_CHECKLIST = 4;

export const PRED_OP_ALL_CHECKED = 0;
export const PRED_OP_IS_NOT_EMPTY = 1;
export const PRED_OP_EQUALS_BOOL = 2;
export const PRED_OP_EQUALS_OPTION = 3;

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

function countFormGraphemes(text: string): number {
  let count = 0;
  for (const _segment of graphemeSegmenter.segment(text)) {
    count += 1;
  }
  return count;
}

export interface ScreenInteractiveElements {
  fields: ScreenFormFieldBlock[];
  checklists: ScreenChecklistBlock[];
}

export function collectInteractiveElements(skeleton: ScreenSkeleton): ScreenInteractiveElements {
  const fields: ScreenFormFieldBlock[] = [];
  const checklists: ScreenChecklistBlock[] = [];

  const visit = (block: ScreenBlock): void => {
    switch (block.kind) {
      case 'vstack':
      case 'card':
        for (const child of block.children) visit(child);
        break;
      case 'formField':
        fields.push(block);
        break;
      case 'checklist':
        checklists.push(block);
        break;
      default:
        break;
    }
  };

  visit(skeleton.root);
  return { fields, checklists };
}

/**
 * True iff a checklist has at least one item and every item is strictly `true`.
 */
export function allChecked(items: readonly boolean[]): boolean {
  if (!Array.isArray(items) || items.length === 0) return false;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i] !== true) return false;
  }
  return true;
}

/**
 * Total projection for a picker option index into `[-1, optionCount - 1]`.
 */
export function projectPickerIndex(
  rawIndex: number,
  defaultIndex: number,
  optionCount: number,
  hasRaw: boolean
): number {
  if (
    !isSafeInt53(rawIndex) ||
    !isSafeInt53(defaultIndex) ||
    !isSafeInt53(optionCount) ||
    optionCount < 0 ||
    typeof hasRaw !== 'boolean'
  ) {
    throw new Error('Invalid picker projection arguments');
  }
  if (hasRaw && rawIndex >= -1 && rawIndex < optionCount) {
    return Object.is(rawIndex, -0) ? 0 : rawIndex;
  }
  if (defaultIndex >= 0 && defaultIndex < optionCount) {
    return Object.is(defaultIndex, -0) ? 0 : defaultIndex;
  }
  return -1;
}

/**
 * Total projection for a stepper value into `[minVal, maxVal]`.
 */
export function projectStepperValue(
  rawValue: number,
  defaultValue: number,
  minVal: number,
  maxVal: number,
  hasRaw: boolean
): number {
  if (
    !isSafeInt53(rawValue) ||
    !isSafeInt53(defaultValue) ||
    !isSafeInt53(minVal) ||
    !isSafeInt53(maxVal) ||
    minVal > maxVal ||
    typeof hasRaw !== 'boolean'
  ) {
    throw new Error('Invalid stepper projection arguments');
  }
  const candidate = hasRaw ? rawValue : defaultValue;
  const clamped = candidate < minVal ? minVal : candidate > maxVal ? maxVal : candidate;
  return Object.is(clamped, -0) ? 0 : clamped;
}

function isSafeIntArray(values: readonly number[]): boolean {
  if (!Array.isArray(values)) return false;
  for (let i = 0; i < values.length; i += 1) {
    if (!(i in values) || !isSafeInt53(values[i])) return false;
  }
  return true;
}

function isStringArray(values: readonly string[]): boolean {
  if (!Array.isArray(values)) return false;
  for (let i = 0; i < values.length; i += 1) {
    if (!(i in values) || typeof values[i] !== 'string') return false;
  }
  return true;
}

/**
 * Flat structural form-shape verifier matching the total map contract:
 * exact key bijection, exact value kind, and exact bounds/lengths.
 */
export function isValidFormShapeFlat(
  expectedKeys: readonly string[],
  expectedKinds: readonly number[],
  minBounds: readonly number[],
  maxBounds: readonly number[],
  actualKeys: readonly string[],
  actualKinds: readonly number[],
  actualIntVals: readonly number[],
  actualListLens: readonly number[]
): boolean {
  if (
    !isStringArray(expectedKeys) ||
    !isSafeIntArray(expectedKinds) ||
    !isSafeIntArray(minBounds) ||
    !isSafeIntArray(maxBounds) ||
    !isStringArray(actualKeys) ||
    !isSafeIntArray(actualKinds) ||
    !isSafeIntArray(actualIntVals) ||
    !isSafeIntArray(actualListLens)
  ) {
    return false;
  }
  if (
    expectedKeys.length !== expectedKinds.length ||
    expectedKeys.length !== minBounds.length ||
    expectedKeys.length !== maxBounds.length ||
    actualKeys.length !== actualKinds.length ||
    actualKeys.length !== actualIntVals.length ||
    actualKeys.length !== actualListLens.length ||
    expectedKeys.length !== actualKeys.length
  ) {
    return false;
  }

  const actualByKey = new Map<string, number>();
  for (let j = 0; j < actualKeys.length; j += 1) {
    const k = actualKeys[j];
    const ak = actualKinds[j];
    if (ak < 0 || ak > 4 || actualByKey.has(k)) return false;
    actualByKey.set(k, j);
  }

  for (let i = 0; i < expectedKeys.length; i += 1) {
    const kind = expectedKinds[i];
    if (kind < 0 || kind > 4) return false;
    const j = actualByKey.get(expectedKeys[i]);
    if (j === undefined || actualKinds[j] !== kind) return false;
    if (kind === FORM_KIND_STEPPER) {
      const v = actualIntVals[j];
      if (v < minBounds[i] || v > maxBounds[i]) return false;
    } else if (kind === FORM_KIND_PICKER) {
      const v = actualIntVals[j];
      if (v < -1 || v >= maxBounds[i]) return false;
    } else if (kind === FORM_KIND_CHECKLIST && actualListLens[j] !== maxBounds[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Flat AND-only predicate evaluator over field and checklist states.
 */
export function evaluatePredicatesFlat(
  predOps: readonly number[],
  predTargets: readonly number[],
  predExpected: readonly number[],
  fieldKinds: readonly number[],
  fieldNonEmpty: readonly number[],
  fieldIntVals: readonly number[],
  checklistAllChecked: readonly number[]
): boolean {
  if (
    !isSafeIntArray(predOps) ||
    !isSafeIntArray(predTargets) ||
    !isSafeIntArray(predExpected) ||
    !isSafeIntArray(fieldKinds) ||
    !isSafeIntArray(fieldNonEmpty) ||
    !isSafeIntArray(fieldIntVals) ||
    !isSafeIntArray(checklistAllChecked)
  ) {
    return false;
  }
  if (
    predOps.length !== predTargets.length ||
    predOps.length !== predExpected.length ||
    fieldKinds.length !== fieldNonEmpty.length ||
    fieldKinds.length !== fieldIntVals.length
  ) {
    return false;
  }

  for (let i = 0; i < predOps.length; i += 1) {
    const op = predOps[i];
    const target = predTargets[i];
    if (op === PRED_OP_ALL_CHECKED) {
      if (target < 0 || target >= checklistAllChecked.length) return false;
      if (checklistAllChecked[target] !== 1) return false;
    } else if (op === PRED_OP_IS_NOT_EMPTY) {
      if (target < 0 || target >= fieldKinds.length) return false;
      if (fieldKinds[target] !== FORM_KIND_TEXT || fieldNonEmpty[target] !== 1) return false;
    } else if (op === PRED_OP_EQUALS_BOOL) {
      if (target < 0 || target >= fieldKinds.length) return false;
      if (fieldKinds[target] !== FORM_KIND_TOGGLE || fieldIntVals[target] !== predExpected[i]) {
        return false;
      }
    } else if (op === PRED_OP_EQUALS_OPTION) {
      if (target < 0 || target >= fieldKinds.length) return false;
      if (fieldKinds[target] !== FORM_KIND_PICKER || fieldIntVals[target] !== predExpected[i]) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

function fieldKindCode(field: ScreenFormFieldBlock): number {
  switch (field.fieldType) {
    case 'toggle':
      return FORM_KIND_TOGGLE;
    case 'stepper':
      return FORM_KIND_STEPPER;
    case 'picker':
      return FORM_KIND_PICKER;
    default:
      return FORM_KIND_TEXT;
  }
}

/**
 * Projects draft values onto the skeleton's total `form` wire map.
 * Iterates strictly over the skeleton's interactive elements (`f0..`, `c0..`),
 * never over draft keys, and rejects non-integral stepper or picker numbers.
 */
export function projectScreenForm(
  skeleton: ScreenSkeleton,
  draftValues: Readonly<Record<string, unknown>>,
  checklistCounts: Readonly<Record<string, number>> = {},
  pickerOptionCounts: Readonly<Record<string, number>> = {}
): ScreenFormMap {
  if (!isPlainObject(draftValues)) {
    throw new Error('Draft values must be a plain object');
  }
  const { fields, checklists } = collectInteractiveElements(skeleton);
  const projected: ScreenFormMap = {};

  for (const field of fields) {
    const raw = Object.prototype.hasOwnProperty.call(draftValues, field.id)
      ? draftValues[field.id]
      : undefined;

    switch (field.fieldType) {
      case 'toggle': {
        if (raw === undefined || raw === null) {
          projected[field.id] = field.defaultBool ?? false;
        } else if (typeof raw === 'boolean') {
          projected[field.id] = raw;
        } else {
          throw new Error(`Invalid toggle value for ${field.id}`);
        }
        break;
      }
      case 'stepper': {
        if (raw === undefined || raw === null) {
          projected[field.id] = projectStepperValue(
            field.min,
            field.defaultInt ?? field.min,
            field.min,
            field.max,
            false
          );
        } else if (isSafeInt53(raw)) {
          if (raw < field.min || raw > field.max) {
            throw new Error(`Stepper value for ${field.id} out of range [${field.min}, ${field.max}]`);
          }
          projected[field.id] = Object.is(raw, -0) ? 0 : raw;
        } else {
          throw new Error(`Stepper value for ${field.id} must be an integer`);
        }
        break;
      }
      case 'picker': {
        const optionCount = pickerOptionCounts[field.id] ?? 0;
        const minOptions = field.options.minItems ?? 0;
        if (
          !isSafeInt53(optionCount) ||
          optionCount < minOptions ||
          optionCount > field.options.maxItems
        ) {
          throw new Error(`Invalid option count for picker ${field.id}`);
        }
        if (raw === undefined || raw === null) {
          projected[field.id] = projectPickerIndex(
            -1,
            field.defaultOptionIndex ?? -1,
            optionCount,
            false
          );
        } else if (isSafeInt53(raw)) {
          if (raw < -1 || raw >= optionCount) {
            throw new Error(`Picker index for ${field.id} out of range [-1, ${optionCount - 1}]`);
          }
          projected[field.id] = Object.is(raw, -0) ? 0 : raw;
        } else {
          throw new Error(`Picker value for ${field.id} must be an integer option index`);
        }
        break;
      }
      default: {
        const maxBytes = field.maxBytes ?? SCREEN_PUBLIC_CAPS.maxSlotBytes;
        if (raw === undefined || raw === null) {
          projected[field.id] = '';
        } else if (typeof raw === 'string') {
          if (!isValidUnicodeString(raw)) {
            throw new Error(`Invalid Unicode text for ${field.id}`);
          }
          if (utf8ByteLength(raw) > maxBytes) {
            throw new Error(`Text for ${field.id} exceeds maxBytes`);
          }
          projected[field.id] = raw;
        } else {
          throw new Error(`Invalid text value for ${field.id}`);
        }
        break;
      }
    }
  }

  for (const checklist of checklists) {
    const count = checklistCounts[checklist.id] ?? 0;
    const minItems = checklist.items.minItems ?? 0;
    if (!isSafeInt53(count) || count < minItems || count > checklist.items.maxItems) {
      throw new Error(`Invalid runtime item count for checklist ${checklist.id}`);
    }

    const rawList = Object.prototype.hasOwnProperty.call(draftValues, checklist.id)
      ? draftValues[checklist.id]
      : undefined;

    if (Array.isArray(rawList)) {
      if (rawList.length !== count) {
        throw new Error(`Checklist ${checklist.id} length does not match item count`);
      }
      const out: boolean[] = [];
      for (let i = 0; i < count; i += 1) {
        if (typeof rawList[i] !== 'boolean') {
          throw new Error(`Checklist ${checklist.id} item ${i} must be boolean`);
        }
        out.push(rawList[i] as boolean);
      }
      projected[checklist.id] = out;
    } else if (rawList !== undefined && rawList !== null) {
      throw new Error(`Checklist ${checklist.id} must be a boolean array`);
    } else {
      // Support synthesized per-item toggle draft keys `c<k>.<i>`.
      const out: boolean[] = [];
      for (let i = 0; i < count; i += 1) {
        const itemKey = `${checklist.id}.${i}`;
        const itemVal = Object.prototype.hasOwnProperty.call(draftValues, itemKey)
          ? draftValues[itemKey]
          : undefined;
        if (itemVal === undefined || itemVal === null) {
          out.push(false);
        } else if (typeof itemVal === 'boolean') {
          out.push(itemVal);
        } else {
          throw new Error(`Checklist item ${itemKey} must be boolean`);
        }
      }
      projected[checklist.id] = out;
    }
  }

  return projected;
}

export type ScreenFormValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validates that a wire `form` map is a total map matching every interactive element in `skeleton`.
 */
export function validateScreenForm(
  skeleton: ScreenSkeleton,
  form: unknown,
  checklistCounts: Readonly<Record<string, number>> = {},
  pickerOptionCounts: Readonly<Record<string, number>> = {}
): ScreenFormValidationResult {
  if (!isPlainObject(form)) {
    return { ok: false, error: 'Form must be a JSON object' };
  }
  const record = form;
  const { fields, checklists } = collectInteractiveElements(skeleton);

  const expectedKeys: string[] = [];
  const expectedKinds: number[] = [];
  const minBounds: number[] = [];
  const maxBounds: number[] = [];

  for (const field of fields) {
    expectedKeys.push(field.id);
    expectedKinds.push(fieldKindCode(field));
    if (field.fieldType === 'stepper') {
      minBounds.push(field.min);
      maxBounds.push(field.max);
    } else if (field.fieldType === 'picker') {
      const count = pickerOptionCounts[field.id] ?? 0;
      const minOptions = field.options.minItems ?? 0;
      if (!isSafeInt53(count) || count < minOptions || count > field.options.maxItems) {
        return { ok: false, error: `Invalid option count for ${field.id}` };
      }
      minBounds.push(-1);
      maxBounds.push(count);
    } else {
      minBounds.push(0);
      maxBounds.push(0);
    }
  }

  for (const checklist of checklists) {
    const count = checklistCounts[checklist.id] ?? 0;
    const minItems = checklist.items.minItems ?? 0;
    if (!isSafeInt53(count) || count < minItems || count > checklist.items.maxItems) {
      return { ok: false, error: `Invalid item count for ${checklist.id}` };
    }
    expectedKeys.push(checklist.id);
    expectedKinds.push(FORM_KIND_CHECKLIST);
    minBounds.push(minItems);
    maxBounds.push(count);
  }

  const actualKeys = Object.keys(record);
  const actualKinds: number[] = [];
  const actualIntVals: number[] = [];
  const actualListLens: number[] = [];

  const fieldById = new Map(fields.map((f) => [f.id as string, f]));

  for (const key of actualKeys) {
    const val = record[key];
    if (typeof val === 'string') {
      if (!isValidUnicodeString(val)) {
        return { ok: false, error: `Invalid Unicode string for ${key}` };
      }
      const field = fieldById.get(key);
      const isTextLike =
        field !== undefined &&
        field.fieldType !== 'toggle' &&
        field.fieldType !== 'stepper' &&
        field.fieldType !== 'picker';
      const maxBytes = isTextLike
        ? (field.maxBytes ?? SCREEN_PUBLIC_CAPS.maxSlotBytes)
        : SCREEN_PUBLIC_CAPS.maxSlotBytes;
      const maxGraphemes = isTextLike
        ? (field.maxGraphemes ?? SCREEN_PUBLIC_CAPS.maxSlotGraphemes)
        : SCREEN_PUBLIC_CAPS.maxSlotGraphemes;
      if (utf8ByteLength(val) > maxBytes) {
        return { ok: false, error: `Text value for ${key} exceeds maxBytes` };
      }
      if (countFormGraphemes(val) > maxGraphemes) {
        return { ok: false, error: `Text value for ${key} exceeds maxGraphemes` };
      }
      actualKinds.push(FORM_KIND_TEXT);
      actualIntVals.push(0);
      actualListLens.push(0);
    } else if (typeof val === 'boolean') {
      actualKinds.push(FORM_KIND_TOGGLE);
      actualIntVals.push(val ? 1 : 0);
      actualListLens.push(0);
    } else if (isSafeInt53(val)) {
      const field = fieldById.get(key);
      actualKinds.push(field?.fieldType === 'picker' ? FORM_KIND_PICKER : FORM_KIND_STEPPER);
      actualIntVals.push(val);
      actualListLens.push(0);
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i += 1) {
        if (typeof val[i] !== 'boolean') {
          return { ok: false, error: `Checklist ${key} must contain booleans only` };
        }
      }
      actualKinds.push(FORM_KIND_CHECKLIST);
      actualIntVals.push(0);
      actualListLens.push(val.length);
    } else {
      return { ok: false, error: `Unsupported form value type for ${key}` };
    }
  }

  if (
    !isValidFormShapeFlat(
      expectedKeys,
      expectedKinds,
      minBounds,
      maxBounds,
      actualKeys,
      actualKinds,
      actualIntVals,
      actualListLens
    )
  ) {
    return { ok: false, error: 'Form does not match skeleton interactive schema' };
  }

  return { ok: true };
}

/**
 * Evaluates implicit required-field checks and explicit AND-only `enabledWhen` predicates for an action.
 * Decline actions skip implicit required-field checks (explicit `enabledWhen` still applies if present).
 */
export function evaluateScreenPredicates(
  action: ScreenAction,
  skeleton: ScreenSkeleton,
  form: ScreenFormMap
): boolean {
  const { fields, checklists } = collectInteractiveElements(skeleton);
  const fieldIndexById = new Map<string, number>();
  const fieldKinds: number[] = [];
  const fieldNonEmpty: number[] = [];
  const fieldIntVals: number[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    fieldIndexById.set(field.id, i);
    const kind = fieldKindCode(field);
    fieldKinds.push(kind);
    const val: ScreenFormValue | undefined = form[field.id];
    if (kind === FORM_KIND_TEXT) {
      const nonEmpty = typeof val === 'string' && val.trim().length > 0;
      fieldNonEmpty.push(nonEmpty ? 1 : 0);
      fieldIntVals.push(0);
      if (action.role !== 'decline' && field.required && !nonEmpty) {
        return false;
      }
    } else if (kind === FORM_KIND_TOGGLE) {
      fieldNonEmpty.push(0);
      fieldIntVals.push(val === true ? 1 : 0);
    } else if (kind === FORM_KIND_PICKER) {
      const idx = typeof val === 'number' && isSafeInt53(val) ? val : -1;
      fieldNonEmpty.push(idx >= 0 ? 1 : 0);
      fieldIntVals.push(idx);
      if (action.role !== 'decline' && field.required && idx < 0) {
        return false;
      }
    } else {
      const num = typeof val === 'number' && isSafeInt53(val) ? val : 0;
      fieldNonEmpty.push(1);
      fieldIntVals.push(num);
    }
  }

  const checklistIndexById = new Map<string, number>();
  const checklistAllChecked: number[] = [];
  for (let i = 0; i < checklists.length; i += 1) {
    const cl = checklists[i];
    checklistIndexById.set(cl.id, i);
    const val = form[cl.id];
    const checked = Array.isArray(val) && allChecked(val);
    checklistAllChecked.push(checked ? 1 : 0);
  }

  const preds = action.enabledWhen ?? [];
  const predOps: number[] = [];
  const predTargets: number[] = [];
  const predExpected: number[] = [];

  for (const pred of preds) {
    if (pred.op === 'allChecked') {
      const idx = checklistIndexById.get(pred.checklist);
      if (idx === undefined) return false;
      predOps.push(PRED_OP_ALL_CHECKED);
      predTargets.push(idx);
      predExpected.push(1);
    } else if (pred.op === 'isNotEmpty') {
      const idx = fieldIndexById.get(pred.field);
      if (idx === undefined) return false;
      predOps.push(PRED_OP_IS_NOT_EMPTY);
      predTargets.push(idx);
      predExpected.push(1);
    } else if (pred.op === 'equals') {
      const idx = fieldIndexById.get(pred.field);
      if (idx === undefined) return false;
      if (typeof pred.value === 'boolean') {
        predOps.push(PRED_OP_EQUALS_BOOL);
        predTargets.push(idx);
        predExpected.push(pred.value ? 1 : 0);
      } else if (isSafeInt53(pred.value)) {
        predOps.push(PRED_OP_EQUALS_OPTION);
        predTargets.push(idx);
        predExpected.push(pred.value);
      } else {
        return false;
      }
    } else {
      return false;
    }
  }

  return evaluatePredicatesFlat(
    predOps,
    predTargets,
    predExpected,
    fieldKinds,
    fieldNonEmpty,
    fieldIntVals,
    checklistAllChecked
  );
}
