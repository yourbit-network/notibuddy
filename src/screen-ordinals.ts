// Pure pre-order ordinal assignment functions for certified screen templates.

import { isSafeInt53 } from './screen-canon.js';

export const BLOCK_KIND_VSTACK = 0;
export const BLOCK_KIND_CARD = 1;
export const BLOCK_KIND_DIVIDER = 2;
export const BLOCK_KIND_HEADING = 3;
export const BLOCK_KIND_TEXT = 4;
export const BLOCK_KIND_BADGE = 5;
export const BLOCK_KIND_ALERT = 6;
export const BLOCK_KIND_KPI_STRIP = 7;
export const BLOCK_KIND_KEY_VALUE_LIST = 8;
export const BLOCK_KIND_CHECKLIST = 9;
export const BLOCK_KIND_DIFF_VIEWER = 10;
export const BLOCK_KIND_FORM_FIELD = 11;

export const OPT_FLAG_HAS_OPTIONAL_TEXT = 1;
export const OPT_FLAG_IS_PICKER = 2;

/**
 * Returns the exact number of contiguous `s<n>` slots consumed by a block kind
 * given its optional-slot flag bitmask (`bit 0`: optional header/body/title/placeholder,
 * `bit 1`: picker options DataSlot on `formField`).
 */
export function slotArity(kindCode: number, optFlags: number): number {
  if (!isSafeInt53(kindCode) || !isSafeInt53(optFlags) || optFlags < 0) {
    return 0;
  }
  const hasOpt = (optFlags & OPT_FLAG_HAS_OPTIONAL_TEXT) !== 0;
  const isPicker = (optFlags & OPT_FLAG_IS_PICKER) !== 0;
  switch (kindCode) {
    case BLOCK_KIND_VSTACK:
    case BLOCK_KIND_DIVIDER:
      return 0;
    case BLOCK_KIND_CARD:
      return hasOpt ? 1 : 0;
    case BLOCK_KIND_HEADING:
    case BLOCK_KIND_TEXT:
    case BLOCK_KIND_BADGE:
    case BLOCK_KIND_KPI_STRIP:
    case BLOCK_KIND_KEY_VALUE_LIST:
    case BLOCK_KIND_DIFF_VIEWER:
      return 1;
    case BLOCK_KIND_ALERT:
    case BLOCK_KIND_CHECKLIST:
      return hasOpt ? 2 : 1;
    case BLOCK_KIND_FORM_FIELD:
      return 1 + (hasOpt ? 1 : 0) + (isPicker ? 1 : 0);
    default:
      return 0;
  }
}

/**
 * Assigns contiguous pre-order starting `s<n>` slot ordinals for each block node
 * (`-1` for blocks that consume zero slots).
 */
export function assignNodeSlotStarts(
  nodeKinds: readonly number[],
  nodeOptFlags: readonly number[]
): number[] {
  const n = Math.min(nodeKinds.length, nodeOptFlags.length);
  const starts: number[] = new Array(n);
  let nextSlot = 0;
  for (let i = 0; i < n; i += 1) {
    const arity = slotArity(nodeKinds[i], nodeOptFlags[i]);
    if (arity > 0) {
      starts[i] = nextSlot;
      nextSlot += arity;
    } else {
      starts[i] = -1;
    }
  }
  return starts;
}

/**
 * Assigns contiguous pre-order `f<k>` ordinals to `formField` nodes (`-1` otherwise).
 */
export function assignFieldOrdinals(nodeKinds: readonly number[]): number[] {
  const out: number[] = new Array(nodeKinds.length);
  let nextField = 0;
  for (let i = 0; i < nodeKinds.length; i += 1) {
    if (nodeKinds[i] === BLOCK_KIND_FORM_FIELD) {
      out[i] = nextField;
      nextField += 1;
    } else {
      out[i] = -1;
    }
  }
  return out;
}

/**
 * Assigns contiguous pre-order `c<k>` ordinals to `checklist` nodes (`-1` otherwise).
 */
export function assignChecklistOrdinals(nodeKinds: readonly number[]): number[] {
  const out: number[] = new Array(nodeKinds.length);
  let nextChecklist = 0;
  for (let i = 0; i < nodeKinds.length; i += 1) {
    if (nodeKinds[i] === BLOCK_KIND_CHECKLIST) {
      out[i] = nextChecklist;
      nextChecklist += 1;
    } else {
      out[i] = -1;
    }
  }
  return out;
}

/**
 * Assigns contiguous `s<n>` label slot ordinals for top-level actions immediately
 * following the slots consumed by `root`.
 */
export function assignActionSlotOrdinals(
  nodeKinds: readonly number[],
  nodeOptFlags: readonly number[],
  actionCount: number
): number[] {
  const n = Math.min(nodeKinds.length, nodeOptFlags.length);
  let nextSlot = 0;
  for (let i = 0; i < n; i += 1) {
    nextSlot += slotArity(nodeKinds[i], nodeOptFlags[i]);
  }
  const count = Math.max(0, isSafeInt53(actionCount) ? actionCount : 0);
  const out: number[] = new Array(count);
  for (let a = 0; a < count; a += 1) {
    out[a] = nextSlot + a;
  }
  return out;
}
