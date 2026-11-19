// Public wire contract types, ordinal validators, and loose engineering caps for certified screens.

export const SCREEN_MIN_INT53 = -9_007_199_254_740_991;
export const SCREEN_MAX_INT53 = 9_007_199_254_740_991;

export const SCREEN_PUBLIC_CAPS = {
  maxSkeletonBytes: 65_536,
  maxSkeletonNodes: 256,
  maxSkeletonDepth: 16,
  maxSkeletonActions: 16,
  maxSkeletonFields: 128,
  maxSkeletonChecklists: 128,
  maxSkeletonSlots: 256,
  maxPredicatesPerAction: 32,
  maxRequestPlaintextBytes: 149_984,
  maxLabelsEntries: 256,
  maxDataEntries: 256,
  maxDataDepth: 8,
  maxTitleBytes: 1_024,
  maxLabelBytes: 4_096,
  maxSourceLabelUtf16: 100,
  maxPresentationFieldBytes: 1_024,
  maxThreadSteps: 64,
  maxSlotGraphemes: 4_096,
  maxSlotBytes: 16_384,
  maxDiffBytes: 96_000,
  maxDiffLines: 20_000,
  maxItemsPerList: 256,
} as const;

export type ScreenSlotId = `s${number}`;
export type ScreenFieldId = `f${number}`;
export type ScreenChecklistId = `c${number}`;
export type ScreenActionId = `a${number}`;
export const SCREEN_UNAVAILABLE_ACTION = 'dismiss' as const;
export type ScreenUnavailableAction = typeof SCREEN_UNAVAILABLE_ACTION;
export type ScreenAnswerAction = ScreenActionId | ScreenUnavailableAction;
export type ScreenTemplateId = `tpl_${string}`;

export type ScreenSpacing = 'compact' | 'regular' | 'relaxed';
export type ScreenHeadingLevel = 1 | 2 | 3;
export type ScreenTextStyle = 'body' | 'caption' | 'mono';
export type ScreenBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type ScreenAlertSeverity = 'info' | 'success' | 'warning' | 'danger';
export type ScreenActionRole = 'primary' | 'secondary' | 'destructive' | 'decline';
export type ScreenFieldType =
  | 'text'
  | 'email'
  | 'url'
  | 'secret'
  | 'date'
  | 'toggle'
  | 'stepper'
  | 'picker';

export interface ScreenTextSlot {
  slot: ScreenSlotId;
  maxGraphemes: number;
  maxBytes: number;
}

export interface ScreenDataSlot {
  slot: ScreenSlotId;
  minItems?: number;
  maxItems: number;
  maxBytes: number;
}

export interface ScreenDiffSlot {
  slot: ScreenSlotId;
  maxBytes: number;
  maxLines: number;
}

export interface ScreenVStackBlock {
  kind: 'vstack';
  spacing?: ScreenSpacing;
  children: ScreenBlock[];
}

export interface ScreenCardBlock {
  kind: 'card';
  header?: ScreenTextSlot;
  children: ScreenBlock[];
}

export interface ScreenDividerBlock {
  kind: 'divider';
}

export interface ScreenHeadingBlock {
  kind: 'heading';
  level?: ScreenHeadingLevel;
  text: ScreenTextSlot;
}

export interface ScreenTextBlock {
  kind: 'text';
  style?: ScreenTextStyle;
  text: ScreenTextSlot;
}

export interface ScreenBadgeBlock {
  kind: 'badge';
  tone: ScreenBadgeTone;
  label: ScreenTextSlot;
}

export interface ScreenAlertBlock {
  kind: 'alert';
  severity: ScreenAlertSeverity;
  title: ScreenTextSlot;
  body?: ScreenTextSlot;
}

export interface ScreenKpiStripBlock {
  kind: 'kpiStrip';
  items: ScreenDataSlot;
}

export interface ScreenKeyValueListBlock {
  kind: 'keyValueList';
  rows: ScreenDataSlot;
}

export interface ScreenChecklistBlock {
  kind: 'checklist';
  id: ScreenChecklistId;
  title?: ScreenTextSlot;
  items: ScreenDataSlot;
}

export interface ScreenDiffViewerBlock {
  kind: 'diffViewer';
  diff: ScreenDiffSlot;
}

export interface ScreenTextFormFieldBlock {
  kind: 'formField';
  id: ScreenFieldId;
  fieldType: 'text' | 'email' | 'url' | 'secret' | 'date';
  label: ScreenTextSlot;
  placeholder?: ScreenTextSlot;
  required?: boolean;
  maxGraphemes?: number;
  maxBytes?: number;
}

export interface ScreenToggleFormFieldBlock {
  kind: 'formField';
  id: ScreenFieldId;
  fieldType: 'toggle';
  label: ScreenTextSlot;
  required?: boolean;
  defaultBool?: boolean;
}

export interface ScreenStepperFormFieldBlock {
  kind: 'formField';
  id: ScreenFieldId;
  fieldType: 'stepper';
  label: ScreenTextSlot;
  required?: boolean;
  min: number;
  max: number;
  defaultInt?: number;
}

export interface ScreenPickerFormFieldBlock {
  kind: 'formField';
  id: ScreenFieldId;
  fieldType: 'picker';
  label: ScreenTextSlot;
  placeholder?: ScreenTextSlot;
  required?: boolean;
  options: ScreenDataSlot;
  defaultOptionIndex?: number;
}

export type ScreenFormFieldBlock =
  | ScreenTextFormFieldBlock
  | ScreenToggleFormFieldBlock
  | ScreenStepperFormFieldBlock
  | ScreenPickerFormFieldBlock;

export type ScreenBlock =
  | ScreenVStackBlock
  | ScreenCardBlock
  | ScreenDividerBlock
  | ScreenHeadingBlock
  | ScreenTextBlock
  | ScreenBadgeBlock
  | ScreenAlertBlock
  | ScreenKpiStripBlock
  | ScreenKeyValueListBlock
  | ScreenChecklistBlock
  | ScreenDiffViewerBlock
  | ScreenFormFieldBlock;

export type ScreenBlockKind = ScreenBlock['kind'];

export const SCREEN_BLOCK_KINDS: readonly ScreenBlockKind[] = [
  'vstack',
  'card',
  'divider',
  'heading',
  'text',
  'badge',
  'alert',
  'kpiStrip',
  'keyValueList',
  'checklist',
  'diffViewer',
  'formField',
] as const;

export type ScreenPredicate =
  | { op: 'allChecked'; checklist: ScreenChecklistId }
  | { op: 'isNotEmpty'; field: ScreenFieldId }
  | { op: 'equals'; field: ScreenFieldId; value: boolean | number };

export interface ScreenAction {
  id: ScreenActionId;
  label: ScreenTextSlot;
  role: ScreenActionRole;
  requireBio: boolean;
  enabledWhen?: ScreenPredicate[];
}

export interface ScreenSkeleton {
  v: 1;
  root: ScreenBlock;
  actions: ScreenAction[];
}

export type ScreenScalar = string | boolean | number;

export type ScreenDataValue =
  | ScreenScalar
  | readonly ScreenDataValue[]
  | { readonly [key: string]: ScreenDataValue };

export interface ScreenPresentation {
  shortTitle?: string;
  summary?: string;
}

export interface ScreenSource {
  label: string;
}

export interface ScreenThreadPrev {
  requestId: string;
  renderDigest: string;
}

export interface ScreenThread {
  id: string;
  step: number;
  of: number;
  prev?: ScreenThreadPrev;
}

export interface ScreenRequestPlaintext {
  type: 'ask';
  replyPub: string;
  source: ScreenSource;
  title: string;
  presentation?: ScreenPresentation;
  sensitive?: boolean;
  requiresAuth?: boolean;
  templateId: ScreenTemplateId;
  labels: Record<string, string>;
  data: Record<string, ScreenDataValue>;
  thread?: ScreenThread;
}

export type ScreenFormValue = string | boolean | number | readonly boolean[];
export type ScreenFormMap = Record<string, ScreenFormValue>;

export interface ScreenRenderProof {
  v: 1;
  digest: string;
}

export interface ScreenRenderUnavailable {
  v: 1;
  unavailable: true;
}

export type ScreenRenderInfo = ScreenRenderProof | ScreenRenderUnavailable;

export interface ScreenRenderedAnswerValues {
  form: ScreenFormMap;
  render: ScreenRenderProof;
}

export interface ScreenUnavailableAnswerValues {
  render: ScreenRenderUnavailable;
}

export type ScreenAnswerValues = ScreenRenderedAnswerValues | ScreenUnavailableAnswerValues;

export interface ScreenRenderedAnswer {
  action: ScreenActionId;
  values: ScreenRenderedAnswerValues;
  authenticated?: boolean;
}

export interface ScreenUnavailableAnswer {
  action: ScreenUnavailableAction;
  values: ScreenUnavailableAnswerValues;
  authenticated?: boolean;
}

export type ScreenAnswer = ScreenRenderedAnswer | ScreenUnavailableAnswer;

export type VerifiedScreenAnswer =
  | {
      kind: 'rendered';
      action: ScreenActionId;
      form: ScreenFormMap;
      renderDigest: string;
      authenticated?: boolean;
    }
  | {
      kind: 'unavailable';
      action: ScreenUnavailableAction;
      authenticated?: boolean;
    };

const TEMPLATE_ID_RE = /^tpl_[0-9a-f]{64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ROUTING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLOT_ORDINAL_RE = /^s(0|[1-9][0-9]*)$/;
const FIELD_ORDINAL_RE = /^f(0|[1-9][0-9]*)$/;
const CHECKLIST_ORDINAL_RE = /^c(0|[1-9][0-9]*)$/;
const ACTION_ORDINAL_RE = /^a(0|[1-9][0-9]*)$/;

export function isValidTemplateId(value: unknown): value is ScreenTemplateId {
  return typeof value === 'string' && TEMPLATE_ID_RE.test(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_RE.test(value);
}

export function isRoutingIdentifier(value: unknown): value is string {
  return typeof value === 'string' && ROUTING_ID_RE.test(value);
}

export function isSlotOrdinal(value: unknown): value is ScreenSlotId {
  return typeof value === 'string' && SLOT_ORDINAL_RE.test(value);
}

export function isFieldOrdinal(value: unknown): value is ScreenFieldId {
  return typeof value === 'string' && FIELD_ORDINAL_RE.test(value);
}

export function isChecklistOrdinal(value: unknown): value is ScreenChecklistId {
  return typeof value === 'string' && CHECKLIST_ORDINAL_RE.test(value);
}

export function isActionOrdinal(value: unknown): value is ScreenActionId {
  return typeof value === 'string' && ACTION_ORDINAL_RE.test(value);
}

export function isScreenUnavailableAction(value: unknown): value is ScreenUnavailableAction {
  return value === SCREEN_UNAVAILABLE_ACTION;
}
