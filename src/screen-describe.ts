// Public UI descriptor, semantic slot mapper, phone-width text previewer, markdown/cheat-sheet renderers, and reply decoder.

import {
  canonJson,
  isPlainObject,
  utf8ByteLength,
  type ScreenCanonValue,
} from './screen-canon.js';
import {
  SCREEN_CATALOG,
  SCREEN_CATALOG_SLUGS,
  getScreenCatalogBySlug,
  getScreenCatalogByTemplateId,
  type ScreenCatalogSlug,
} from './screen-catalog.js';
import {
  rehydrateScreenFeedback,
  type ScreenOrdinalMap,
} from './screen-skeletonizer.js';
import {
  SCREEN_PUBLIC_CAPS,
  type ScreenActionRole,
  type ScreenBlock,
  type ScreenDataValue,
  type ScreenFieldType,
  type ScreenFormMap,
  type ScreenPredicate,
  type ScreenSkeleton,
} from './screen-types.js';

export interface ScreenValidationFix {
  code: string;
  message: string;
  at?: string;
  ordinal?: string;
}

const authoringGraphemeSeg = new Intl.Segmenter('und', { granularity: 'grapheme' });
function authoringGraphemeLen(text: string): number {
  let n = 0;
  for (const _ of authoringGraphemeSeg.segment(text)) n += 1;
  return n;
}

/**
 * Checks author-facing structural, action, field, block-tier, and payload-size limits
 * for any screen skeleton (including `dry_run: true`) so every issue is reported with
 * structured `{ code, message, at }` fixes before sending to the relay or certifier.
 */
export function collectScreenAuthoringFixes(
  skeleton: ScreenSkeleton,
  labels: Readonly<Record<string, string>>,
  data: Readonly<Record<string, ScreenDataValue>>,
  ordinalMap?: ScreenOrdinalMap
): ScreenValidationFix[] {
  const rawFixes: ScreenValidationFix[] = [];
  const addFix = (code: string, message: string, at?: string): void => {
    rawFixes.push(at ? { code, message, at } : { code, message });
  };

  if (skeleton.root.kind !== 'vstack' && skeleton.root.kind !== 'card') {
    addFix(
      'ROOT_MUST_BE_CONTAINER',
      'Wrap the top-level screen content in a vstack or card container.',
      'root'
    );
  }

  let totalBlocks = 0;
  let maxDepth = 0;
  let formFieldCount = 0;
  let diffViewerCount = 0;
  let depthReported = false;

  const visit = (block: ScreenBlock, depth: number, insideCard: boolean, path: string): void => {
    totalBlocks += 1;
    if (depth > maxDepth) maxDepth = depth;
    if (depth > 6 && !depthReported) {
      depthReported = true;
      addFix(
        'NESTING_TOO_DEEP',
        `Flatten nested layout containers so block depth is at most 6 (got ${depth}).`,
        path
      );
    }

    if (block.kind === 'vstack' || block.kind === 'card') {
      if (block.children.length === 0) {
        addFix(
          'EMPTY_CONTAINER',
          'Each vstack and card container must include at least one child block.',
          path
        );
      }
      if (block.kind === 'card' && block.header) {
        const text = labels[block.header.slot];
        const g = text !== undefined ? authoringGraphemeLen(text) : block.header.maxGraphemes;
        if (block.header.maxGraphemes > 128 || g > 128) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `card.header supports at most 128 characters (got ${Math.max(block.header.maxGraphemes, g)}).`,
            block.header.slot
          );
        }
      }
      for (let i = 0; i < block.children.length; i += 1) {
        visit(block.children[i]!, depth + 1, block.kind === 'card', `${path}.children[${i}]`);
      }
      return;
    }

    switch (block.kind) {
      case 'heading': {
        const text = labels[block.text.slot];
        const g = text !== undefined ? authoringGraphemeLen(text) : block.text.maxGraphemes;
        if (block.text.maxGraphemes > 128 || g > 128) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `heading text supports at most 128 characters (got ${Math.max(block.text.maxGraphemes, g)}).`,
            block.text.slot
          );
        }
        break;
      }
      case 'badge': {
        const text = labels[block.label.slot];
        const g = text !== undefined ? authoringGraphemeLen(text) : block.label.maxGraphemes;
        if (block.label.maxGraphemes > 128 || g > 128) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `badge label supports at most 128 characters (got ${Math.max(block.label.maxGraphemes, g)}).`,
            block.label.slot
          );
        }
        break;
      }
      case 'text': {
        const text = labels[block.text.slot];
        const g = text !== undefined ? authoringGraphemeLen(text) : block.text.maxGraphemes;
        if (block.text.maxGraphemes > 1024 || g > 1024) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `text block supports at most 1024 characters (got ${Math.max(block.text.maxGraphemes, g)}; split into multiple text blocks if needed).`,
            block.text.slot
          );
        }
        break;
      }
      case 'alert': {
        const titleText = labels[block.title.slot];
        const tg = titleText !== undefined ? authoringGraphemeLen(titleText) : block.title.maxGraphemes;
        if (block.title.maxGraphemes > 1024 || tg > 1024) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `alert title supports at most 1024 characters (got ${Math.max(block.title.maxGraphemes, tg)}).`,
            block.title.slot
          );
        }
        if (block.body) {
          const bodyText = labels[block.body.slot];
          const bg = bodyText !== undefined ? authoringGraphemeLen(bodyText) : block.body.maxGraphemes;
          if (block.body.maxGraphemes > 1024 || bg > 1024) {
            addFix(
              'SLOT_BOUND_EXCEEDS_LIMIT',
              `alert body supports at most 1024 characters (got ${Math.max(block.body.maxGraphemes, bg)}).`,
              block.body.slot
            );
          }
        }
        break;
      }
      case 'kpiStrip': {
        const arr = Array.isArray(data[block.items.slot]) ? (data[block.items.slot] as unknown[]) : undefined;
        if (arr && (arr.length < 1 || arr.length > 6)) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `kpiStrip supports 1..6 items (got ${arr.length}).`,
            block.items.slot
          );
        } else if (block.items.maxItems < 1 || block.items.maxItems > 6) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `kpiStrip maxItems supports 1..6 (got maxItems=${block.items.maxItems}).`,
            block.items.slot
          );
        }
        break;
      }
      case 'keyValueList': {
        const arr = Array.isArray(data[block.rows.slot]) ? (data[block.rows.slot] as unknown[]) : undefined;
        if (block.rows.maxItems > 32 || (arr && (arr.length < 1 || arr.length > 32))) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `keyValueList supports 1..32 rows (got ${arr ? arr.length : block.rows.maxItems}).`,
            block.rows.slot
          );
        }
        break;
      }
      case 'checklist': {
        const minItems = block.items.minItems ?? 0;
        const arr = Array.isArray(data[block.items.slot]) ? (data[block.items.slot] as unknown[]) : undefined;
        if (minItems < 1 || block.items.maxItems > 32 || (arr && (arr.length < 1 || arr.length > 32))) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `checklist supports 1..32 items with minItems >= 1 (got ${arr ? arr.length : block.items.maxItems}).`,
            block.items.slot
          );
        }
        break;
      }
      case 'diffViewer': {
        diffViewerCount += 1;
        const d = data[block.diff.slot];
        let lines = 0;
        if (typeof d === 'string') {
          lines = d.split('\n').length;
        } else if (isPlainObject(d) && typeof d.original === 'string' && typeof d.modified === 'string') {
          lines = d.original.split('\n').length + d.modified.split('\n').length;
        }
        if (block.diff.maxLines > 512 || lines > 512) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `diffViewer supports at most 512 lines (got ${Math.max(block.diff.maxLines, lines)}).`,
            block.diff.slot
          );
        }
        break;
      }
      case 'formField': {
        formFieldCount += 1;
        const labelText = labels[block.label.slot];
        const lg = labelText !== undefined ? authoringGraphemeLen(labelText) : block.label.maxGraphemes;
        if (block.label.maxGraphemes > 128 || lg > 128) {
          addFix(
            'SLOT_BOUND_EXCEEDS_LIMIT',
            `formField "${block.id}" label supports at most 128 characters (got ${Math.max(block.label.maxGraphemes, lg)}).`,
            block.id
          );
        }
        if (
          (block.fieldType === 'text' ||
            block.fieldType === 'email' ||
            block.fieldType === 'url' ||
            block.fieldType === 'secret' ||
            block.fieldType === 'date' ||
            block.fieldType === 'picker') &&
          block.placeholder
        ) {
          const phText = labels[block.placeholder.slot];
          const pg = phText !== undefined ? authoringGraphemeLen(phText) : block.placeholder.maxGraphemes;
          if (block.placeholder.maxGraphemes > 128 || pg > 128) {
            addFix(
              'SLOT_BOUND_EXCEEDS_LIMIT',
              `formField "${block.id}" placeholder supports at most 128 characters.`,
              block.id
            );
          }
        }
        if (
          (block.fieldType === 'text' ||
            block.fieldType === 'email' ||
            block.fieldType === 'url' ||
            block.fieldType === 'secret' ||
            block.fieldType === 'date') &&
          block.maxGraphemes !== undefined &&
          (block.maxGraphemes < 1 || block.maxGraphemes > 2048)
        ) {
          addFix(
            'INVALID_FORM_FIELD',
            `formField "${block.id}" maxGraphemes must be within 1..2048.`,
            block.id
          );
        }
        if (
          block.fieldType === 'stepper' &&
          (block.min < -1_000_000 ||
            block.max > 1_000_000 ||
            block.min >= block.max ||
            (block.defaultInt !== undefined && (block.defaultInt < block.min || block.defaultInt > block.max)))
        ) {
          addFix(
            'INVALID_FORM_FIELD',
            `stepper "${block.id}" requires -1,000,000 <= min < max <= 1,000,000 and defaultInt in [min, max].`,
            block.id
          );
        }
        if (block.fieldType === 'picker') {
          const opts = Array.isArray(data[block.options.slot]) ? (data[block.options.slot] as unknown[]) : undefined;
          const optCount = opts ? opts.length : block.options.maxItems;
          if (optCount < 2 || block.options.maxItems > 32 || (opts && opts.length > 32)) {
            addFix(
              'INVALID_FORM_FIELD',
              `picker "${block.id}" supports 2..32 options (got ${opts ? opts.length : block.options.maxItems}).`,
              block.id
            );
          }
          if (
            block.defaultOptionIndex !== undefined &&
            (block.defaultOptionIndex < -1 || block.defaultOptionIndex >= optCount)
          ) {
            addFix(
              'INVALID_FORM_FIELD',
              `picker "${block.id}" defaultOptionIndex must be -1 or a valid 0-based option index (0..${Math.max(0, optCount - 1)}).`,
              block.id
            );
          }
        }
        break;
      }
      case 'divider':
        break;
    }
  };

  visit(skeleton.root, 1, false, 'root');

  if (totalBlocks > 80) {
    addFix('TOO_MANY_BLOCKS', `Reduce the total number of layout blocks to at most 80 (got ${totalBlocks}).`, 'root');
  }
  if (formFieldCount > 50) {
    addFix('TOO_MANY_FORM_FIELDS', `Reduce the number of form fields to at most 50 (got ${formFieldCount}).`);
  }
  if (diffViewerCount > 1) {
    addFix('TOO_MANY_DIFF_VIEWERS', `Include at most one diffViewer block per screen (got ${diffViewerCount}).`);
  }

  if (skeleton.actions.length < 1 || skeleton.actions.length > 3) {
    addFix(
      'INVALID_ACTION_COUNT',
      `Provide between 1 and 3 top-level actions (got ${skeleton.actions.length}).`,
      'actions'
    );
  }
  let declineCount = 0;
  let totalPreds = 0;
  for (const action of skeleton.actions) {
    if (action.role === 'decline') {
      declineCount += 1;
      if (action.requireBio) {
        addFix(
          'DECLINE_CANNOT_REQUIRE_AUTH',
          'Decline actions must not require biometric authentication (set requireBio: false).',
          action.id
        );
      }
    }
    const labelText = labels[action.label.slot];
    const labelG = labelText !== undefined ? authoringGraphemeLen(labelText) : action.label.maxGraphemes;
    if (action.label.maxGraphemes > 64 || labelG > 64) {
      addFix(
        'INVALID_ACTION_LABEL_BOUND',
        `Action label "${action.id}" must be at most 64 characters.`,
        action.id
      );
    }
    totalPreds += action.enabledWhen?.length ?? 0;
  }
  if (declineCount > 1) {
    addFix('TOO_MANY_DECLINE_ACTIONS', 'Include at most one decline action per screen.', 'actions');
  }
  if (totalPreds > 16) {
    addFix(
      'TOO_MANY_ACTION_CONDITIONS',
      `Use at most 16 action enablement conditions across all actions (got ${totalPreds}).`,
      'actions'
    );
  }

  try {
    const skelBytes = utf8ByteLength(canonJson(skeleton as unknown as ScreenCanonValue));
    if (skelBytes > SCREEN_PUBLIC_CAPS.maxSkeletonBytes) {
      addFix(
        'SKELETON_TOO_LARGE',
        `Template structure exceeds ${SCREEN_PUBLIC_CAPS.maxSkeletonBytes} bytes (got ${skelBytes}).`
      );
    }
    const estReqBytes =
      skelBytes +
      utf8ByteLength(JSON.stringify({ labels, data }));
    if (estReqBytes > SCREEN_PUBLIC_CAPS.maxRequestPlaintextBytes) {
      addFix(
        'PAYLOAD_TOO_LARGE',
        `Total screen payload exceeds ~${SCREEN_PUBLIC_CAPS.maxRequestPlaintextBytes} bytes.`
      );
    }
  } catch {
    // Ignore serialization errors here; covered elsewhere.
  }

  if (ordinalMap) {
    const rehydrated = rehydrateScreenFeedback(rawFixes, ordinalMap);
    if (ordinalMap.usedSemanticIds || ordinalMap.usedInlineLiterals) {
      return rehydrated.map(({ ordinal: _omit, ...rest }) => rest);
    }
    return rehydrated;
  }
  return rawFixes;
}

export interface PublicScreenLabelSlot {
  slot: string;
  name: string;
  element: string;
  required: boolean;
  maxGraphemes: number;
  maxBytes: number;
}

export interface PublicScreenDataSlot {
  slot: string;
  name: string;
  kind: 'kpiStrip' | 'keyValueList' | 'checklist' | 'picker' | 'diffViewer';
  shape: string;
  required: true;
  controlId?: string;
  minItems?: number;
  maxItems?: number;
  maxBytes: number;
  maxLines?: number;
}

export interface PublicScreenSlot {
  name: string;
  slot: string;
  bucket: 'labels' | 'data';
  kind: string;
  required: boolean;
  controlId?: string;
  maxGraphemes?: number;
  minItems?: number;
  maxItems?: number;
  maxBytes: number;
  maxLines?: number;
}

export interface PublicScreenAction {
  id: string;
  labelSlot: string;
  labelName: string;
  role: ScreenActionRole;
  requireBio: boolean;
  enabledWhen?: string[];
}

export interface PublicScreenBlock {
  kind: ScreenBlock['kind'];
  spacing?: string;
  headerSlot?: string;
  slot?: string;
  titleSlot?: string;
  bodySlot?: string;
  labelSlot?: string;
  placeholderSlot?: string;
  optionsSlot?: string;
  id?: string;
  tone?: string;
  severity?: string;
  style?: string;
  level?: number;
  fieldType?: ScreenFieldType;
  required?: boolean;
  min?: number;
  max?: number;
  defaultInt?: number;
  defaultBool?: boolean;
  defaultOptionIndex?: number;
  children?: PublicScreenBlock[];
}

export interface PublicScreenTemplateDescription {
  templateId: ScreenCatalogSlug;
  title: string;
  description: string;
  blocks: PublicScreenBlock[];
  slots: PublicScreenSlot[];
  labels: PublicScreenLabelSlot[];
  data: PublicScreenDataSlot[];
  actions: PublicScreenAction[];
  example: {
    templateId: ScreenCatalogSlug;
    slots: Record<string, ScreenDataValue>;
  };
}

export interface ScreenDecodeContext {
  slug?: string;
  actions: Record<string, string>;
  checklists: Record<string, { title?: string; items: string[] }>;
  fields: Record<string, { label: string; options?: string[] }>;
  actionIds?: Record<string, string>;
  checklistIds?: Record<string, string>;
  fieldIds?: Record<string, string>;
}

export interface DecodedScreenAnswer {
  templateId: string;
  action: {
    id: string;
    label?: string;
    role: ScreenActionRole;
    requireBio: boolean;
  };
  checklists?: Array<{
    id: string;
    title?: string;
    checked: string[];
    unchecked: string[];
    allChecked: boolean;
  }>;
  fields?: Array<{
    id: string;
    type: ScreenFieldType;
    label?: string;
    value: string | boolean | number | null;
    touched?: boolean;
    selectedOption?: string | null;
  }>;
}

export const SCREEN_SEMANTIC_SLOTS: Readonly<Record<ScreenCatalogSlug, Readonly<Record<string, string>>>> = {
  db_migration_approval: {
    s0: 'summaryHeader',
    s1: 'badge',
    s2: 'alertTitle',
    s3: 'alertBody',
    s4: 'details',
    s5: 'diffHeader',
    s6: 'diff',
    s7: 'checklistHeader',
    s8: 'checklist',
    s9: 'approveLabel',
    s10: 'declineLabel',
  },
  incident_triage: {
    s0: 'incidentHeader',
    s1: 'badge',
    s2: 'alertTitle',
    s3: 'alertBody',
    s4: 'kpis',
    s5: 'responseHeader',
    s6: 'details',
    s7: 'severityLabel',
    s8: 'severityOptions',
    s9: 'noteLabel',
    s10: 'notePlaceholder',
    s11: 'acknowledgeLabel',
    s12: 'rollbackLabel',
    s13: 'declineLabel',
  },
  code_review_form: {
    s0: 'summaryHeader',
    s1: 'badge',
    s2: 'summary',
    s3: 'details',
    s4: 'diffHeader',
    s5: 'diff',
    s6: 'reviewHeader',
    s7: 'decisionLabel',
    s8: 'decisionOptions',
    s9: 'commentLabel',
    s10: 'commentPlaceholder',
    s11: 'submitLabel',
    s12: 'declineLabel',
  },
  kpi_status_card: {
    s0: 'statusHeader',
    s1: 'heading',
    s2: 'badge',
    s3: 'kpis',
    s4: 'summary',
    s5: 'detailsHeader',
    s6: 'details',
    s7: 'primaryLabel',
    s8: 'secondaryLabel',
  },
  action_checklist: {
    s0: 'overviewHeader',
    s1: 'heading',
    s2: 'summary',
    s3: 'checklistHeader',
    s4: 'checklistTitle',
    s5: 'checklist',
    s6: 'confirmToggle',
    s7: 'approveLabel',
    s8: 'declineLabel',
  },
  parameter_tuning_form: {
    s0: 'currentHeader',
    s1: 'summary',
    s2: 'details',
    s3: 'tuningHeader',
    s4: 'stepperLabel',
    s5: 'modeLabel',
    s6: 'modeOptions',
    s7: 'safetyToggle',
    s8: 'noteLabel',
    s9: 'notePlaceholder',
    s10: 'applyLabel',
    s11: 'declineLabel',
  },
  deployment_gate: {
    s0: 'statusHeader',
    s1: 'badge',
    s2: 'alertTitle',
    s3: 'alertBody',
    s4: 'kpis',
    s5: 'detailsHeader',
    s6: 'details',
    s7: 'checklistHeader',
    s8: 'checklist',
    s9: 'confirmToggle',
    s10: 'approveLabel',
    s11: 'holdLabel',
    s12: 'declineLabel',
  },
  multi_choice_audit: {
    s0: 'evidenceHeader',
    s1: 'heading',
    s2: 'badge',
    s3: 'summary',
    s4: 'details',
    s5: 'decisionHeader',
    s6: 'primaryPickerLabel',
    s7: 'primaryPickerOptions',
    s8: 'secondaryPickerLabel',
    s9: 'secondaryPickerOptions',
    s10: 'noteLabel',
    s11: 'notePlaceholder',
    s12: 'confirmToggle',
    s13: 'approveLabel',
    s14: 'escalateLabel',
    s15: 'declineLabel',
  },
};

export function getSemanticSlotName(slugOrTemplateId: string, slotId: string): string | undefined {
  const entry =
    getScreenCatalogBySlug(slugOrTemplateId) ?? getScreenCatalogByTemplateId(slugOrTemplateId);
  if (!entry) return undefined;
  return SCREEN_SEMANTIC_SLOTS[entry.slug]?.[slotId];
}

function formatPredicate(pred: ScreenPredicate): string {
  switch (pred.op) {
    case 'allChecked':
      return `all items checked in checklist ${pred.checklist}`;
    case 'isNotEmpty':
      return `field ${pred.field} is non-empty`;
    case 'equals':
      return `field ${pred.field} equals ${String(pred.value)}`;
  }
}

function formatCompactPredicate(pred: ScreenPredicate): string {
  switch (pred.op) {
    case 'allChecked':
      return `${pred.checklist}=allChecked`;
    case 'isNotEmpty':
      return `${pred.field}!=empty`;
    case 'equals':
      return `${pred.field}=${String(pred.value)}`;
  }
}

function sampleLabelText(element: string, maxGraphemes: number): string {
  let candidate = 'Sample';
  if (element.includes('card header')) candidate = 'Overview';
  else if (element.includes('badge')) candidate = 'Production';
  else if (element.includes('alert title')) candidate = 'Review before proceeding';
  else if (element.includes('alert body')) candidate = 'Verify all metrics and checks on your iPhone.';
  else if (element.includes('heading')) candidate = 'Status Summary';
  else if (element.includes('text')) candidate = 'Summary details for operator review.';
  else if (element.includes('checklist title')) candidate = 'Pre-flight checks';
  else if (element.includes('toggle')) candidate = 'Confirm readiness';
  else if (element.includes('picker label')) candidate = 'Select decision';
  else if (element.includes('stepper')) candidate = 'Target value';
  else if (element.includes('placeholder')) candidate = 'Optional note';
  else if (element.includes('form field')) candidate = 'Reviewer note';
  else if (element.includes('primary')) candidate = 'Approve';
  else if (element.includes('destructive')) candidate = 'Confirm';
  else if (element.includes('secondary')) candidate = 'Hold';
  else if (element.includes('decline')) candidate = 'Cancel';
  return candidate.slice(0, Math.max(1, maxGraphemes));
}

function walkSkeletonUi(skeleton: ScreenSkeleton, slug: ScreenCatalogSlug): {
  blocks: PublicScreenBlock[];
  slots: PublicScreenSlot[];
  labels: PublicScreenLabelSlot[];
  data: PublicScreenDataSlot[];
  actions: PublicScreenAction[];
  exampleSlots: Record<string, ScreenDataValue>;
} {
  const semanticMap = SCREEN_SEMANTIC_SLOTS[slug];
  const slots: PublicScreenSlot[] = [];
  const labels: PublicScreenLabelSlot[] = [];
  const data: PublicScreenDataSlot[] = [];
  const exampleSlots: Record<string, ScreenDataValue> = {};

  const semanticFor = (slotId: string) => semanticMap[slotId] ?? slotId;

  const addLabel = (
    slot: { slot: string; maxGraphemes: number; maxBytes: number },
    element: string,
    required: boolean
  ) => {
    const name = semanticFor(slot.slot);
    const cappedGraphemes = Math.min(slot.maxGraphemes, SCREEN_PUBLIC_CAPS.maxSlotGraphemes);
    const cappedBytes = Math.min(slot.maxBytes, SCREEN_PUBLIC_CAPS.maxLabelBytes);
    labels.push({
      slot: slot.slot,
      name,
      element,
      required,
      maxGraphemes: cappedGraphemes,
      maxBytes: cappedBytes,
    });
    slots.push({
      name,
      slot: slot.slot,
      bucket: 'labels',
      kind: element,
      required,
      maxGraphemes: cappedGraphemes,
      maxBytes: cappedBytes,
    });
    exampleSlots[name] = sampleLabelText(element, cappedGraphemes);
  };

  const visit = (block: ScreenBlock): PublicScreenBlock => {
    switch (block.kind) {
      case 'vstack':
        return {
          kind: 'vstack',
          ...(block.spacing ? { spacing: block.spacing } : {}),
          children: block.children.map(visit),
        };
      case 'card':
        if (block.header) {
          addLabel(block.header, 'card header', false);
        }
        return {
          kind: 'card',
          ...(block.header ? { headerSlot: block.header.slot } : {}),
          children: block.children.map(visit),
        };
      case 'divider':
        return { kind: 'divider' };
      case 'heading':
        addLabel(block.text, `heading (h${block.level ?? 2})`, true);
        return {
          kind: 'heading',
          ...(block.level !== undefined ? { level: block.level } : {}),
          slot: block.text.slot,
        };
      case 'text':
        addLabel(block.text, `text (${block.style ?? 'body'})`, true);
        return {
          kind: 'text',
          ...(block.style !== undefined ? { style: block.style } : {}),
          slot: block.text.slot,
        };
      case 'badge':
        addLabel(block.label, `badge (${block.tone})`, true);
        return {
          kind: 'badge',
          tone: block.tone,
          slot: block.label.slot,
        };
      case 'alert':
        addLabel(block.title, `alert title (${block.severity})`, true);
        if (block.body) {
          addLabel(block.body, `alert body (${block.severity})`, false);
        }
        return {
          kind: 'alert',
          severity: block.severity,
          titleSlot: block.title.slot,
          ...(block.body ? { bodySlot: block.body.slot } : {}),
        };
      case 'kpiStrip': {
        const name = semanticFor(block.items.slot);
        const minItems = block.items.minItems ?? 0;
        const maxItems = Math.min(block.items.maxItems, SCREEN_PUBLIC_CAPS.maxItemsPerList);
        const maxBytes = Math.min(block.items.maxBytes, SCREEN_PUBLIC_CAPS.maxSlotBytes);
        const shape = 'Array<{ label: string, value: string | number | boolean }>';
        data.push({
          slot: block.items.slot,
          name,
          kind: 'kpiStrip',
          shape,
          required: true,
          minItems,
          maxItems,
          maxBytes,
        });
        slots.push({
          name,
          slot: block.items.slot,
          bucket: 'data',
          kind: `kpiStrip: ${shape}`,
          required: true,
          minItems,
          maxItems,
          maxBytes,
        });
        const sampleCount = Math.max(1, minItems);
        exampleSlots[name] = Array.from({ length: sampleCount }, (_, i) => ({
          label: i === 0 ? 'Status' : `Metric ${i + 1}`,
          value: i === 0 ? 'OK' : '100%',
        }));
        return { kind: 'kpiStrip', slot: block.items.slot };
      }
      case 'keyValueList': {
        const name = semanticFor(block.rows.slot);
        const minItems = block.rows.minItems ?? 0;
        const maxItems = Math.min(block.rows.maxItems, SCREEN_PUBLIC_CAPS.maxItemsPerList);
        const maxBytes = Math.min(block.rows.maxBytes, SCREEN_PUBLIC_CAPS.maxSlotBytes);
        const shape = 'Array<{ key: string, value: string | number | boolean }>';
        data.push({
          slot: block.rows.slot,
          name,
          kind: 'keyValueList',
          shape,
          required: true,
          minItems,
          maxItems,
          maxBytes,
        });
        slots.push({
          name,
          slot: block.rows.slot,
          bucket: 'data',
          kind: `keyValueList: ${shape}`,
          required: true,
          minItems,
          maxItems,
          maxBytes,
        });
        const sampleCount = Math.max(1, minItems);
        exampleSlots[name] = Array.from({ length: sampleCount }, (_, i) => ({
          key: i === 0 ? 'Environment' : `Detail ${i + 1}`,
          value: i === 0 ? 'production' : 'verified',
        }));
        return { kind: 'keyValueList', slot: block.rows.slot };
      }
      case 'checklist': {
        if (block.title) {
          addLabel(block.title, `checklist title (${block.id})`, false);
        }
        const name = semanticFor(block.items.slot);
        const minItems = block.items.minItems ?? 0;
        const maxItems = Math.min(block.items.maxItems, SCREEN_PUBLIC_CAPS.maxItemsPerList);
        const maxBytes = Math.min(block.items.maxBytes, SCREEN_PUBLIC_CAPS.maxSlotBytes);
        data.push({
          slot: block.items.slot,
          name,
          kind: 'checklist',
          shape: 'string[]',
          required: true,
          controlId: block.id,
          minItems,
          maxItems,
          maxBytes,
        });
        slots.push({
          name,
          slot: block.items.slot,
          bucket: 'data',
          kind: 'checklist: string[]',
          required: true,
          controlId: block.id,
          minItems,
          maxItems,
          maxBytes,
        });
        const sampleCount = Math.max(2, minItems);
        exampleSlots[name] = Array.from({ length: sampleCount }, (_, i) =>
          i === 0 ? 'Checks passing' : i === 1 ? 'Rollback ready' : `Check item ${i + 1}`
        );
        return {
          kind: 'checklist',
          id: block.id,
          ...(block.title ? { titleSlot: block.title.slot } : {}),
          slot: block.items.slot,
        };
      }
      case 'diffViewer': {
        const name = semanticFor(block.diff.slot);
        const maxBytes = Math.min(block.diff.maxBytes, SCREEN_PUBLIC_CAPS.maxDiffBytes);
        const maxLines = Math.min(block.diff.maxLines, SCREEN_PUBLIC_CAPS.maxDiffLines);
        const shape = '{ filename: string, language?: string, original: string, modified: string } | string';
        data.push({
          slot: block.diff.slot,
          name,
          kind: 'diffViewer',
          shape,
          required: true,
          maxBytes,
          maxLines,
        });
        slots.push({
          name,
          slot: block.diff.slot,
          bucket: 'data',
          kind: `diffViewer: ${shape}`,
          required: true,
          maxBytes,
          maxLines,
        });
        exampleSlots[name] = {
          filename: 'change.sql',
          language: 'sql',
          original: '-- before',
          modified: '-- after',
        };
        return { kind: 'diffViewer', slot: block.diff.slot };
      }
      case 'formField': {
        const reqSuffix = block.required ? ' (required)' : '';
        addLabel(block.label, `${block.fieldType} field label (${block.id})${reqSuffix}`, true);
        if (
          (block.fieldType === 'text' ||
            block.fieldType === 'email' ||
            block.fieldType === 'url' ||
            block.fieldType === 'secret' ||
            block.fieldType === 'date' ||
            block.fieldType === 'picker') &&
          block.placeholder
        ) {
          addLabel(block.placeholder, `${block.fieldType} placeholder (${block.id})`, false);
        }
        if (block.fieldType === 'picker') {
          const name = semanticFor(block.options.slot);
          const minItems = block.options.minItems ?? 0;
          const maxItems = Math.min(block.options.maxItems, SCREEN_PUBLIC_CAPS.maxItemsPerList);
          const maxBytes = Math.min(block.options.maxBytes, SCREEN_PUBLIC_CAPS.maxSlotBytes);
          data.push({
            slot: block.options.slot,
            name,
            kind: 'picker',
            shape: 'string[]',
            required: true,
            controlId: block.id,
            minItems,
            maxItems,
            maxBytes,
          });
          slots.push({
            name,
            slot: block.options.slot,
            bucket: 'data',
            kind: 'picker options: string[]',
            required: true,
            controlId: block.id,
            minItems,
            maxItems,
            maxBytes,
          });
          const sampleCount = Math.max(2, minItems);
          exampleSlots[name] = Array.from({ length: sampleCount }, (_, i) =>
            i === 0 ? 'Option A' : i === 1 ? 'Option B' : `Option ${i + 1}`
          );
        }
        return {
          kind: 'formField',
          id: block.id,
          fieldType: block.fieldType,
          labelSlot: block.label.slot,
          ...('placeholder' in block && block.placeholder ? { placeholderSlot: block.placeholder.slot } : {}),
          ...(block.fieldType === 'picker' ? { optionsSlot: block.options.slot } : {}),
          ...(block.required !== undefined ? { required: block.required } : {}),
          ...(block.fieldType === 'stepper'
            ? {
                min: block.min,
                max: block.max,
                ...(block.defaultInt !== undefined ? { defaultInt: block.defaultInt } : {}),
              }
            : {}),
          ...(block.fieldType === 'toggle' && block.defaultBool !== undefined
            ? { defaultBool: block.defaultBool }
            : {}),
          ...(block.fieldType === 'picker' && block.defaultOptionIndex !== undefined
            ? { defaultOptionIndex: block.defaultOptionIndex }
            : {}),
        };
      }
    }
  };

  const rootBlock = visit(skeleton.root);
  const blocks = rootBlock.kind === 'vstack' && rootBlock.children ? rootBlock.children : [rootBlock];

  const actions: PublicScreenAction[] = skeleton.actions.map((action) => {
    const faceIdSuffix = action.requireBio ? ', Face ID' : '';
    addLabel(action.label, `${action.role} action button (${action.id}${faceIdSuffix})`, true);
    return {
      id: action.id,
      labelSlot: action.label.slot,
      labelName: semanticFor(action.label.slot),
      role: action.role,
      requireBio: action.requireBio,
      ...(action.enabledWhen && action.enabledWhen.length > 0
        ? { enabledWhen: action.enabledWhen.map(formatPredicate) }
        : {}),
    };
  });

  return { blocks, slots, labels, data, actions, exampleSlots };
}

export function describeScreenTemplate(slugOrTemplateId: string): PublicScreenTemplateDescription | undefined {
  const entry =
    getScreenCatalogBySlug(slugOrTemplateId) ?? getScreenCatalogByTemplateId(slugOrTemplateId);
  if (!entry) return undefined;
  const walked = walkSkeletonUi(entry.skeleton, entry.slug);
  return {
    templateId: entry.slug,
    title: entry.title,
    description: entry.description,
    blocks: walked.blocks,
    slots: walked.slots,
    labels: walked.labels,
    data: walked.data,
    actions: walked.actions,
    example: {
      templateId: entry.slug,
      slots: walked.exampleSlots,
    },
  };
}

export function describeAllScreenTemplates(): PublicScreenTemplateDescription[] {
  return SCREEN_CATALOG.map((entry) => describeScreenTemplate(entry.slug)!);
}

/**
 * Resolves a flat semantic `screen.slots` map (supporting semantic names like `alertTitle`, `checklist`
 * or `s0..sN` keys) into encrypted wire `{ labels, data }` for a built-in catalog template.
 */
export function resolveCatalogSlotsToWire(
  slugOrTemplateId: string,
  rawSlots: Record<string, unknown>
): { labels: Record<string, string>; data: Record<string, ScreenDataValue>; errors: string[] } {
  const desc = describeScreenTemplate(slugOrTemplateId);
  const labels: Record<string, string> = {};
  const data: Record<string, ScreenDataValue> = {};
  const errors: string[] = [];
  if (!desc) {
    return {
      labels,
      data,
      errors: [`Unknown template "${slugOrTemplateId}". Valid templates: ${SCREEN_CATALOG_SLUGS.join(', ')}.`],
    };
  }

  const bySemantic = new Map<string, PublicScreenSlot>();
  const bySlotId = new Map<string, PublicScreenSlot>();
  for (const s of desc.slots) {
    bySemantic.set(s.name, s);
    bySlotId.set(s.slot, s);
  }

  const seenSlotIds = new Map<string, string>();
  const validNames = desc.slots.map((s) => `${s.name} (${s.slot})`).join(', ');

  for (const [key, value] of Object.entries(rawSlots)) {
    const target = bySemantic.get(key) ?? bySlotId.get(key);
    if (!target) {
      errors.push(`Unknown slot "${key}" for "${desc.templateId}" (valid slots: ${validNames})`);
      continue;
    }
    const prevKey = seenSlotIds.get(target.slot);
    if (prevKey !== undefined) {
      errors.push(
        `Conflicting duplicate entries "${prevKey}" and "${key}" for slot ${target.slot} ("${target.name}") — pass only "${target.name}"`
      );
      continue;
    }
    seenSlotIds.set(target.slot, key);
    if (target.bucket === 'labels') {
      if (typeof value !== 'string') {
        errors.push(`Slot "${key}" (${target.slot}, ${target.kind}) must be a string`);
        continue;
      }
      labels[target.slot] = value;
    } else {
      data[target.slot] = value as ScreenDataValue;
    }
  }

  return { labels, data, errors };
}

function wrapTextLines(text: string, width: number): string[] {
  const normalized = text.replaceAll('\r\n', '\n').trim();
  if (!normalized) return [''];
  const out: string[] = [];
  for (const para of normalized.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      if (!line) {
        line = word.length > width ? `${word.slice(0, width - 1)}…` : word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word.length > width ? `${word.slice(0, width - 1)}…` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Renders a compact ~38-column iPhone-width text sketch of any screen for `dry_run: true` responses.
 */
export function renderScreenTextPreview(
  skeleton: ScreenSkeleton,
  labels: Record<string, string>,
  data: Record<string, ScreenDataValue>,
  title?: string,
  ordinalMap?: ScreenOrdinalMap
): string {
  const WIDTH = 38;
  const lines: string[] = [`┌─ iPhone Screen Preview ${'─'.repeat(Math.max(1, WIDTH - 24))}┐`];
  const pickerOptionsByField = new Map<string, string[]>();
  const pushBoxed = (text: string, indent = '') => {
    for (const part of wrapTextLines(text, WIDTH - 2 - indent.length)) {
      lines.push(`│ ${indent}${part}`);
    }
  };
  const labelText = (slotId: string, required = true): string => {
    const v = labels[slotId];
    if (typeof v === 'string' && v.trim().length > 0) return v;
    return required ? `<missing ${slotId}>` : '';
  };

  if (title && title.trim().length > 0) {
    pushBoxed(title.trim());
    lines.push(`├${'─'.repeat(WIDTH)}┤`);
  }

  const visit = (block: ScreenBlock, indent: string): void => {
    switch (block.kind) {
      case 'vstack':
        for (const child of block.children) visit(child, indent);
        break;
      case 'card': {
        const hdr = block.header ? labelText(block.header.slot, false) : '';
        lines.push(`│ ${indent}┌ ${hdr ? `[${hdr}]` : 'Card'}`);
        for (const child of block.children) visit(child, `${indent}│ `);
        lines.push(`│ ${indent}└─`);
        break;
      }
      case 'divider':
        lines.push(`│ ${indent}────────────`);
        break;
      case 'heading':
        pushBoxed(`# ${labelText(block.text.slot, true)}`, indent);
        break;
      case 'text':
        pushBoxed(labelText(block.text.slot, true), indent);
        break;
      case 'badge':
        pushBoxed(`[${block.tone.toUpperCase()}: ${labelText(block.label.slot, true)}]`, indent);
        break;
      case 'alert': {
        pushBoxed(`[!] ${labelText(block.title.slot, true)}`, indent);
        if (block.body) {
          const body = labelText(block.body.slot, false);
          if (body) pushBoxed(body, `${indent}    `);
        }
        break;
      }
      case 'kpiStrip': {
        const items = data[block.items.slot];
        if (!Array.isArray(items) || items.length === 0) {
          pushBoxed(`<missing KPI items (${block.items.slot})>`, indent);
          break;
        }
        const pairs = items.map((it) =>
          it && typeof it === 'object' && !Array.isArray(it)
            ? `${String((it as Record<string, unknown>).label ?? '?')}: ${String((it as Record<string, unknown>).value ?? '?')}`
            : String(it)
        );
        pushBoxed(`[KPIs] ${pairs.join(' | ')}`, indent);
        break;
      }
      case 'keyValueList': {
        const rows = data[block.rows.slot];
        if (!Array.isArray(rows) || rows.length === 0) {
          pushBoxed(`<missing KV rows (${block.rows.slot})>`, indent);
          break;
        }
        for (const row of rows) {
          if (row && typeof row === 'object' && !Array.isArray(row)) {
            const obj = row as Record<string, unknown>;
            pushBoxed(`• ${String(obj.key ?? '?')}: ${String(obj.value ?? '?')}`, indent);
          } else {
            pushBoxed(`• ${String(row)}`, indent);
          }
        }
        break;
      }
      case 'diffViewer': {
        const d = data[block.diff.slot];
        if (typeof d === 'string') {
          const allLines = d ? d.split('\n') : [];
          pushBoxed(`[Diff: unified patch, ${allLines.length} lines]`, indent);
          const shown = allLines.slice(0, 8);
          for (const dl of shown) {
            pushBoxed(dl || ' ', `${indent}  `);
          }
          if (allLines.length > shown.length) {
            pushBoxed(`... (+${allLines.length - shown.length} more lines)`, `${indent}  `);
          }
        } else if (d && typeof d === 'object' && !Array.isArray(d)) {
          const obj = d as Record<string, unknown>;
          const fn = typeof obj.filename === 'string' ? obj.filename : 'diff';
          const origLines = typeof obj.original === 'string' && obj.original ? obj.original.split('\n') : [];
          const modLines = typeof obj.modified === 'string' && obj.modified ? obj.modified.split('\n') : [];
          pushBoxed(`[Diff: ${fn} (-${origLines.length}/+${modLines.length} lines)]`, indent);
          const excerpt: string[] = [];
          const maxLen = Math.max(origLines.length, modLines.length);
          for (let i = 0; i < maxLen && excerpt.length < 8; i += 1) {
            const o = origLines[i];
            const m = modLines[i];
            if (o !== m) {
              if (o !== undefined && excerpt.length < 8) excerpt.push(`- ${o}`);
              if (m !== undefined && excerpt.length < 8) excerpt.push(`+ ${m}`);
            }
          }
          if (excerpt.length === 0 && modLines.length > 0) {
            for (const m of modLines.slice(0, 4)) excerpt.push(`  ${m}`);
          }
          for (const line of excerpt) {
            pushBoxed(line, `${indent}  `);
          }
          const remaining = Math.max(0, origLines.length + modLines.length - excerpt.length);
          if (excerpt.length >= 8 && remaining > 0) {
            pushBoxed(`... (+${remaining} more lines)`, `${indent}  `);
          }
        } else {
          pushBoxed(`<missing diff (${block.diff.slot})>`, indent);
        }
        break;
      }
      case 'checklist': {
        const titleStr = block.title ? labelText(block.title.slot, false) : '';
        if (titleStr) pushBoxed(`${titleStr}:`, indent);
        const items = data[block.items.slot];
        if (!Array.isArray(items) || items.length === 0) {
          pushBoxed(`<missing checklist (${block.items.slot})>`, indent);
          break;
        }
        for (const item of items) {
          pushBoxed(`[ ] ${String(item)}`, indent);
        }
        break;
      }
      case 'formField': {
        const lbl = labelText(block.label.slot, true);
        if (block.fieldType === 'toggle') {
          pushBoxed(`[Toggle (${block.defaultBool ? 'ON' : 'OFF'})] ${lbl}`, indent);
        } else if (block.fieldType === 'stepper') {
          pushBoxed(`[Stepper ${block.min}..${block.max}] ${lbl} (${block.defaultInt ?? block.min})`, indent);
        } else if (block.fieldType === 'picker') {
          const opts = data[block.options.slot];
          if (Array.isArray(opts)) {
            pickerOptionsByField.set(block.id, opts.map(String));
          }
          const optText = Array.isArray(opts) ? opts.map(String).join(' / ') : `<missing ${block.options.slot}>`;
          pushBoxed(`[Picker] ${lbl}: ${optText}`, indent);
        } else {
          const ph = block.placeholder ? labelText(block.placeholder.slot, false) : '';
          pushBoxed(`[${block.fieldType}] ${lbl}${ph ? ` (${ph})` : ''}`, indent);
        }
        break;
      }
    }
  };

  const formatPreviewPredicate = (pred: ScreenPredicate): string => {
    switch (pred.op) {
      case 'allChecked':
        return `${ordinalMap?.checklistToAuthored[pred.checklist] ?? pred.checklist}=allChecked`;
      case 'isNotEmpty':
        return `${ordinalMap?.fieldToAuthored[pred.field] ?? pred.field}!=empty`;
      case 'equals': {
        const name = ordinalMap?.fieldToAuthored[pred.field] ?? pred.field;
        if (typeof pred.value === 'number') {
          const optLabel = pickerOptionsByField.get(pred.field)?.[pred.value];
          if (optLabel !== undefined) {
            return `${name}=${JSON.stringify(optLabel)}`;
          }
        }
        return `${name}=${String(pred.value)}`;
      }
    }
  };

  visit(skeleton.root, '');
  lines.push(`├${'─'.repeat(WIDTH)}┤`);
  for (const action of skeleton.actions) {
    const lbl = labelText(action.label.slot, true);
    const flags: string[] = [action.role];
    if (action.requireBio) flags.push('Face ID');
    if (action.enabledWhen && action.enabledWhen.length > 0) {
      flags.push(`needs ${action.enabledWhen.map(formatPreviewPredicate).join(' & ')}`);
    }
    pushBoxed(`[Button: ${lbl}] (${flags.join(', ')})`);
  }
  lines.push(`└${'─'.repeat(WIDTH)}┘`);
  return lines.join('\n');
}

export function renderScreenTemplateMarkdown(slugOrTemplateId: string): string | undefined {
  const desc = describeScreenTemplate(slugOrTemplateId);
  if (!desc) return undefined;

  const lines: string[] = [
    `# Screen Template: \`${desc.templateId}\` (${desc.title})`,
    '',
    desc.description,
    '',
    'Pass flat semantic keys in `screen.slots`.',
    '',
    '## `screen.slots` Reference',
    '',
    '| Slot Name | Element / Expected Shape | Required | Limits |',
    '|---|---|---|---|',
  ];
  for (const s of desc.slots) {
    const limitParts: string[] = [];
    if (s.maxGraphemes !== undefined) limitParts.push(`<= ${s.maxGraphemes} chars`);
    if (s.minItems !== undefined && s.maxItems !== undefined) limitParts.push(`${s.minItems}..${s.maxItems} items`);
    if (s.maxLines !== undefined) limitParts.push(`<= ${s.maxLines} lines`);
    limitParts.push(`<= ${s.maxBytes} B`);
    lines.push(
      `| \`${s.name}\` | ${s.kind}${s.controlId ? ` [\`${s.controlId}\`]` : ''} | ${s.required ? 'yes' : 'no'} | ${limitParts.join(', ')} |`
    );
  }

  lines.push(
    '',
    '## Action Buttons & Reply Unlock Rules',
    '',
    '| Action ID | Slot Name | Role | Device Auth | Unlock Conditions |',
    '|---|---|---|---|---|'
  );
  for (const a of desc.actions) {
    const unlock = a.enabledWhen && a.enabledWhen.length > 0 ? a.enabledWhen.join('; ') : 'Always enabled';
    lines.push(
      `| \`${a.id}\` | \`${a.labelName}\` | \`${a.role}\` | ${a.requireBio ? 'Face ID / Passcode required' : 'None'} | ${unlock} |`
    );
  }

  lines.push(
    '',
    '## Minimal Valid Example (`notibuddy_notify`)',
    '',
    '```json',
    JSON.stringify(
      {
        title: desc.title,
        dry_run: true,
        screen: desc.example,
      },
      null,
      2
    ),
    '```',
    ''
  );

  return lines.join('\n');
}

export function renderScreenCatalogMarkdown(): string {
  const header = [
    '# NotiBuddy Built-In Native Screen Catalog',
    '',
    'Use `notibuddy_notify` with `{ "title": "...", "screen": { "templateId": "<slug>", "slots": {...} } }`.',
    '',
    '- Prefer flat semantic names inside `screen.slots` (or use `notibuddy://screens/builder` to compose bespoke `screen.template` multi-card block layouts).',
    '- Pass `dry_run: true` to validate any screen payload and render an iPhone-width text preview without pushing to the iPhone.',
    '- Do **not** pass `message`, `options`, `fields`, `input_placeholder`, `diff`, or `resume_id` alongside `screen`.',
    '- On resolution, inspect `status === "resolved"`, `answer.action` (and `decoded.action` for the human-readable button label/role), `answer.authenticated === true` when Face ID was required, and `decoded.checklists` / `decoded.fields`.',
    '',
    '---',
    '',
  ].join('\n');

  const sections = SCREEN_CATALOG.map((entry) => renderScreenTemplateMarkdown(entry.slug)!);
  return header + sections.join('\n---\n\n');
}

export function renderScreenBuilderMarkdown(): string {
  return `# Bespoke Native Screen Builder (\`screen.template\`)

Compose arbitrary multi-card iPhone screens on the fly by passing \`screen: { "template": { "root": ..., "actions": [...] }, "mode": "auto" | "strict" }\` to \`notibuddy_notify\`.
Pass \`dry_run: true\` first to run full validation and get a phone-width text \`preview\` + reusable \`draft_id\` (send via \`{ "draft_id": "drf_..." }\` without resending the full JSON).

## Layout Structure & Hard Limits

- \`template.root\`: top-level container — \`{ "kind": "vstack", "spacing": "compact" | "regular" | "relaxed", "children": [...] }\` (or a single \`card\`).
- \`template.actions\`: **1 to 3 buttons** — \`{ "id"?: "a0", "label": "Approve", "role": "primary" | "secondary" | "destructive" | "decline", "requireBio": boolean, "enabledWhen"?: [...] }\`. At most one \`decline\` action is allowed, and \`decline\` must set \`requireBio: false\`.
- **Optional \`id\` assignment & reserved IDs:** \`id\` is optional on \`actions\`, \`formField\`, and \`checklist\`. If omitted, IDs are auto-assigned in pre-order (\`a0..a2\`, \`f0..\`, \`c0..\`); authored semantic IDs (like \`gate\`, \`lane7\`, \`apply\`) are preserved in \`decoded\`. **Reserved ID:** \`"dismiss"\` is reserved for host-owned unavailable-screen dismissal and cannot be used as an action \`id\` (use \`"cancel"\`, \`"reject"\`, \`"hold"\`, or \`"decline"\` instead).
- **No newlines or control characters in text blocks:** Single-line text scalars only (including \`style: "mono"\` and \`alert\`). For multi-line content, split lines across multiple \`text\` blocks, use \`keyValueList\` rows, or use \`diffViewer\`.

| Limit | Cap | Notes |
|---|---|---|
| Total blocks | 80 blocks max | Counting every container & leaf inside \`root\` |
| Container nesting depth | 6 levels max | \`root\` = depth 1; **no card inside card** |
| Empty containers | Disallowed | Every \`vstack\` / \`card\` needs >= 1 child |
| Actions | **1–3 actions** | Max 1 \`decline\`, max 16 \`enabledWhen\` predicates total, action label <= 64 chars |
| Form fields | 50 fields max | Stepper \`min..max\` within \`-1,000,000..1,000,000\`; picker \`2..32\` options |
| \`diffViewer\` blocks | 1 per screen | <= 512 lines total (\`original\` + \`modified\`) and <= 96,000 bytes |
| \`kpiStrip\` items | 1–6 items | 1–4 fits a compact row/2x2; 5–6 wraps cleanly into a 2-column grid |
| \`keyValueList\` / \`checklist\` | 1–32 items | Empty lists are disallowed |
| Short labels | <= 128 chars | Applies to \`card.header\`, \`heading.text\`, \`badge.label\`, \`formField.label\`, \`placeholder\` |
| Body / alert text | <= 1,024 chars | Applies to \`text.text\`, \`alert.title\`, \`alert.body\` |
| Total payload size | <= 149,984 bytes | Full rendered screen plaintext request JSON |

## \`mode\`, \`date\` Fields, and \`draft_id\`

- \`mode\` (optional on \`screen\`, default \`"auto"\`):
  - \`"auto"\`: automatically snaps minor capacity mismatches to standard tiers and unwraps nested cards / redundant vstack wrappers, returning \`repaired: true\` + \`suggestedTemplate\` + \`changes\`.
  - \`"strict"\`: rejects auto-repair with \`errorCode: "REPAIR_SUGGESTED"\`, returning \`suggestedTemplate\` + \`changes\` so you can inspect before sending.
- \`date\` form field (\`fieldType: "date"\`): starts unset until the user chooses a date (no custom min/max range); \`required: true\` keeps actions disabled until picked. Untouched date fields decode as \`value: null, touched: false\` (\`""\` in raw wire \`answer.form\`); picked dates return ISO-8601 UTC strings (\`YYYY-MM-DDTHH:MM:SSZ\`, or \`YYYY-MM-DD\` if \`maxGraphemes < 20\`) with \`touched: true\`.
- \`draft_id\`: When \`dry_run: true\` returns \`valid: true\`, it includes \`draft_id\` (in RAM for 10 min). Call \`notibuddy_notify({ "draft_id": "drf_..." })\` (optionally overriding \`wait_seconds\`, \`requires_auth\`, \`sensitive\`, or \`title\`) to send the exact checked screen without re-sending the payload.

## Supported Blocks (12 Kinds)

| Block \`kind\` | Inline Properties | Notes |
|---|---|---|
| \`vstack\` | \`children\`, \`spacing?\` | Vertical stack (\`compact\`, \`regular\`, \`relaxed\`). |
| \`card\` | \`header?\`, \`children\` | Rounded section card (cannot nest inside another \`card\`). |
| \`divider\` | *(none)* | Horizontal separator inside a card. |
| \`heading\` | \`text\`, \`level?\` (\`1\\|2\\|3\`) | Section heading (<= 128 chars). |
| \`text\` | \`text\`, \`style?\` (\`body\\|caption\\|mono\`) | Single-line text block (<= 1,024 chars; split multi-line output across blocks). |
| \`badge\` | \`tone\`, \`label\` | Status pill (\`neutral\\|info\\|success\\|warning\\|danger\`). |
| \`alert\` | \`severity\`, \`title\`, \`body?\` | Callout banner (\`info\\|success\\|warning\\|danger\`, <= 1,024 chars). |
| \`kpiStrip\` | \`items\`: \`[{ label, value }]\` | 1..6 metric tiles (5–6 wrap into a 2-column grid). |
| \`keyValueList\` | \`rows\`: \`[{ key, value }]\` | 1..32 key/value rows (scalar string, integer, boolean). |
| \`diffViewer\` | \`diff\`: \`{ filename, language?, original, modified }\` | Code & SQL diff viewer (or unified diff string; newlines allowed; max 1 per screen). |
| \`checklist\` | \`id?\` (\`c0\`), \`title?\`, \`items\`: \`string[]\` | 1..32 interactive checkboxes returning boolean array under \`c0\`. |
| \`formField\` | \`id?\` (\`f0\`), \`fieldType\`, \`label\`, ... | Interactive inputs rendered inside cards (see below). |

### \`formField\` Variants

- Text-like (\`text\`, \`email\`, \`url\`, \`date\`): optional \`placeholder\` (<= 128 chars), \`required\`, \`maxGraphemes\` (1..2048), \`maxBytes\`. *(Note: \`fieldType: "secret"\` is supported only on local \`notibuddy\` connections, not hosted MCP.)*
- \`toggle\`: optional \`defaultBool\`, \`required\`.
- \`stepper\`: \`min\`, \`max\` (\`-1,000,000..1,000,000\`), optional \`defaultInt\`, \`required\`.
- \`picker\`: \`options: string[]\` (2..32 items), optional \`placeholder\`, \`defaultOptionIndex\`, \`required\`.

### Action Unlock Rules (\`enabledWhen\`)

- \`{ "op": "allChecked", "checklist": "c0" }\`
- \`{ "op": "isNotEmpty", "field": "f1" }\` (text-like field)
- \`{ "op": "equals", "field": "f0", "value": true }\` (toggle boolean, 0-based picker index, OR exact picker option label string such as \`"Promote 25%"\`)

## Example Bespoke Multi-Card Deployment Screen

\`\`\`json
{
  "title": "Deploy API v2.14",
  "requires_auth": true,
  "dry_run": true,
  "screen": {
    "template": {
      "root": {
        "kind": "vstack",
        "spacing": "regular",
        "children": [
          {
            "kind": "card",
            "header": "Canary Health",
            "children": [
              { "kind": "badge", "tone": "warning", "label": "p99 +38%" },
              { "kind": "alert", "severity": "warning", "title": "Memory headroom 5%", "body": "Latency rose after batch worker scaled." },
              { "kind": "kpiStrip", "items": [{ "label": "Error Rate", "value": "0.1%" }, { "label": "p99", "value": "412ms" }] }
            ]
          },
          {
            "kind": "card",
            "header": "Rollout Decision",
            "children": [
              { "kind": "checklist", "id": "c0", "items": ["Smoke tests green", "On-call paged"] },
              { "kind": "formField", "id": "f0", "fieldType": "picker", "label": "Target step", "options": ["Promote 25%", "Hold & raise memory", "Roll back"] },
              { "kind": "formField", "id": "f1", "fieldType": "text", "label": "Operator note", "placeholder": "Optional reason" }
            ]
          }
        ]
      },
      "actions": [
        { "id": "a0", "label": "Confirm Promote", "role": "primary", "requireBio": true, "enabledWhen": [{ "op": "allChecked", "checklist": "c0" }, { "op": "equals", "field": "f0", "value": "Promote 25%" }] },
        { "id": "a1", "label": "Dismiss", "role": "decline", "requireBio": false }
      ]
    }
  }
}
\`\`\`
`;
}

function compactSlotSummary(entry: (typeof SCREEN_CATALOG)[number]): string {
  const semanticMap = SCREEN_SEMANTIC_SLOTS[entry.slug];
  const slotTokens: string[] = [];

  const nameOf = (slotId: string) => semanticMap[slotId] ?? slotId;

  const visit = (block: ScreenBlock): void => {
    switch (block.kind) {
      case 'vstack':
        for (const child of block.children) visit(child);
        break;
      case 'card':
        if (block.header) slotTokens.push(`${nameOf(block.header.slot)}?:str(${block.header.maxGraphemes})`);
        for (const child of block.children) visit(child);
        break;
      case 'divider':
        break;
      case 'heading':
      case 'text':
        slotTokens.push(`${nameOf(block.text.slot)}:str(${block.text.maxGraphemes})`);
        break;
      case 'badge':
        slotTokens.push(`${nameOf(block.label.slot)}:str(${block.label.maxGraphemes})`);
        break;
      case 'alert':
        slotTokens.push(`${nameOf(block.title.slot)}:str(${block.title.maxGraphemes})`);
        if (block.body) slotTokens.push(`${nameOf(block.body.slot)}?:str(${block.body.maxGraphemes})`);
        break;
      case 'kpiStrip':
        slotTokens.push(
          `${nameOf(block.items.slot)}:kpi[{label,value}](${block.items.minItems ?? 0}..${block.items.maxItems})`
        );
        break;
      case 'keyValueList':
        slotTokens.push(
          `${nameOf(block.rows.slot)}:kv[{key,value}](${block.rows.minItems ?? 0}..${block.rows.maxItems})`
        );
        break;
      case 'checklist':
        if (block.title) slotTokens.push(`${nameOf(block.title.slot)}?:str(${block.title.maxGraphemes})`);
        slotTokens.push(
          `${nameOf(block.items.slot)}:str[](${block.items.minItems ?? 0}..${block.items.maxItems})`
        );
        break;
      case 'diffViewer':
        slotTokens.push(
          `${nameOf(block.diff.slot)}:diff({filename,language?,original,modified}|str)`
        );
        break;
      case 'formField':
        slotTokens.push(`${nameOf(block.label.slot)}:${block.fieldType}(${block.label.maxGraphemes})`);
        if (
          (block.fieldType === 'text' ||
            block.fieldType === 'email' ||
            block.fieldType === 'url' ||
            block.fieldType === 'secret' ||
            block.fieldType === 'date' ||
            block.fieldType === 'picker') &&
          block.placeholder
        ) {
          slotTokens.push(`${nameOf(block.placeholder.slot)}?:str(${block.placeholder.maxGraphemes})`);
        }
        if (block.fieldType === 'picker') {
          slotTokens.push(
            `${nameOf(block.options.slot)}:str[](${block.options.minItems ?? 0}..${block.options.maxItems})`
          );
        }
        break;
    }
  };

  visit(entry.skeleton.root);
  for (const a of entry.skeleton.actions) {
    const bio = a.requireBio ? '/FaceID' : '';
    slotTokens.push(`${nameOf(a.label.slot)}:btn[${a.id}${bio}](${a.label.maxGraphemes})`);
  }

  const unlockTokens = entry.skeleton.actions
    .filter((a) => a.enabledWhen && a.enabledWhen.length > 0)
    .map((a) => `${a.id}:${a.enabledWhen!.map(formatCompactPredicate).join('&')}`);
  const unlockPart = unlockTokens.length > 0 ? ` unlock{${unlockTokens.join('; ')}}` : '';

  return `- ${entry.slug}: slots{${slotTokens.join(', ')}}${unlockPart}`;
}

export function renderCompactScreenCheatSheet(): string {
  const header =
    'Built-in screen.templateId semantic screen.slots (or compose bespoke layouts with screen.template per notibuddy://screens/builder; "?:" = optional, "(N)" = max chars):';
  return [header, ...SCREEN_CATALOG.map(compactSlotSummary)].join('\n');
}

export const SCREEN_CATALOG_COMPACT_CHEATSHEET = renderCompactScreenCheatSheet();

export function formatScreenRecoveryGuide(slugOrTemplateId: string): string {
  const desc = describeScreenTemplate(slugOrTemplateId);
  const entry =
    getScreenCatalogBySlug(slugOrTemplateId) ?? getScreenCatalogByTemplateId(slugOrTemplateId);
  if (!desc || !entry) return '';
  return [
    `How to make "${desc.templateId}" valid:`,
    '- Pass flat semantic keys in screen.slots:',
    `- ${compactSlotSummary(entry)}`,
    `- Minimal valid screen object: ${JSON.stringify(desc.example)}`,
    `- Read MCP resource notibuddy://screens/${desc.templateId} (or notibuddy://screens/builder for custom block layouts), or pass dry_run: true to preview and get a reusable draft_id without notifying the iPhone.`,
  ].join('\n');
}

export function formatGeneralScreenRecoveryGuide(): string {
  return [
    'How to build a valid screen request:',
    `- Preset layout: pass screen: { "templateId": "<slug>", "slots": { ... } } using one of: ${SCREEN_CATALOG_SLUGS.join(', ')}.`,
    '- Bespoke layout: pass screen: { "template": { "root": ..., "actions": [...] } } (see resource notibuddy://screens/builder).',
    '- Read MCP resource notibuddy://screens/catalog or pass dry_run: true with screen to validate and preview before sending.',
  ].join('\n');
}

export function formatScreenTemplateBriefHint(slugOrTemplateId: string): string {
  return formatScreenRecoveryGuide(slugOrTemplateId);
}

export function extractScreenDecodeContext(
  skeleton: ScreenSkeleton,
  labels: Record<string, string>,
  data: Record<string, ScreenDataValue>,
  slug?: string,
  ordinalMap?: ScreenOrdinalMap
): ScreenDecodeContext {
  const actions: Record<string, string> = {};
  const checklists: Record<string, { title?: string; items: string[] }> = {};
  const fields: Record<string, { label: string; options?: string[] }> = {};

  const visit = (block: ScreenBlock): void => {
    switch (block.kind) {
      case 'vstack':
      case 'card':
        for (const child of block.children) visit(child);
        break;
      case 'checklist': {
        const title = block.title ? labels[block.title.slot] : undefined;
        const rawItems = data[block.items.slot];
        const items = Array.isArray(rawItems)
          ? rawItems.filter((item): item is string => typeof item === 'string')
          : [];
        checklists[block.id] = title !== undefined ? { title, items } : { items };
        break;
      }
      case 'formField': {
        const label = labels[block.label.slot] ?? block.id;
        if (block.fieldType === 'picker') {
          const rawOpts = data[block.options.slot];
          const options = Array.isArray(rawOpts)
            ? rawOpts.filter((item): item is string => typeof item === 'string')
            : [];
          fields[block.id] = { label, options };
        } else {
          fields[block.id] = { label };
        }
        break;
      }
      default:
        break;
    }
  };

  visit(skeleton.root);
  for (const action of skeleton.actions) {
    const label = labels[action.label.slot];
    if (typeof label === 'string') {
      actions[action.id] = label;
    }
  }

  const actionIds =
    ordinalMap?.usedSemanticIds && Object.keys(ordinalMap.actionToAuthored).length > 0
      ? { ...ordinalMap.actionToAuthored }
      : undefined;
  const checklistIds =
    ordinalMap?.usedSemanticIds && Object.keys(ordinalMap.checklistToAuthored).length > 0
      ? { ...ordinalMap.checklistToAuthored }
      : undefined;
  const fieldIds =
    ordinalMap?.usedSemanticIds && Object.keys(ordinalMap.fieldToAuthored).length > 0
      ? { ...ordinalMap.fieldToAuthored }
      : undefined;

  return {
    ...(slug ? { slug } : {}),
    actions,
    checklists,
    fields,
    ...(actionIds ? { actionIds } : {}),
    ...(checklistIds ? { checklistIds } : {}),
    ...(fieldIds ? { fieldIds } : {}),
  };
}

export function decodeScreenAnswer(
  skeleton: ScreenSkeleton,
  form: ScreenFormMap,
  actionId: string,
  decodeCtx?: ScreenDecodeContext,
  fallbackTemplateId = 'custom'
): DecodedScreenAnswer {
  const actionMeta = skeleton.actions.find((a) => a.id === actionId);
  const actionLabel = decodeCtx?.actions[actionId];
  const decodedActionId = decodeCtx?.actionIds?.[actionId] ?? actionId;
  const decoded: DecodedScreenAnswer = {
    templateId: decodeCtx?.slug ?? fallbackTemplateId,
    action: {
      id: decodedActionId,
      ...(actionLabel !== undefined ? { label: actionLabel } : {}),
      role: actionMeta?.role ?? 'secondary',
      requireBio: actionMeta?.requireBio ?? false,
    },
  };

  const checklistBlocks: Array<{ id: string; slot: string }> = [];
  const fieldBlocks: Array<{ id: string; fieldType: ScreenFieldType }> = [];
  const visit = (block: ScreenBlock): void => {
    switch (block.kind) {
      case 'vstack':
      case 'card':
        for (const child of block.children) visit(child);
        break;
      case 'checklist':
        checklistBlocks.push({ id: block.id, slot: block.items.slot });
        break;
      case 'formField':
        fieldBlocks.push({ id: block.id, fieldType: block.fieldType });
        break;
      default:
        break;
    }
  };
  visit(skeleton.root);

  if (checklistBlocks.length > 0) {
    decoded.checklists = checklistBlocks.map(({ id }) => {
      const raw = form[id];
      const states = Array.isArray(raw) ? raw.filter((v): v is boolean => typeof v === 'boolean') : [];
      const ctx = decodeCtx?.checklists[id];
      const checked: string[] = [];
      const unchecked: string[] = [];
      for (let i = 0; i < states.length; i += 1) {
        const text = ctx?.items[i] ?? `Item ${i + 1}`;
        if (states[i] === true) checked.push(text);
        else unchecked.push(text);
      }
      return {
        id: decodeCtx?.checklistIds?.[id] ?? id,
        ...(ctx?.title !== undefined ? { title: ctx.title } : {}),
        checked,
        unchecked,
        allChecked: states.length > 0 && unchecked.length === 0,
      };
    });
  }

  if (fieldBlocks.length > 0) {
    decoded.fields = [];
    for (const { id, fieldType } of fieldBlocks) {
      if (!Object.prototype.hasOwnProperty.call(form, id)) continue;
      const value = form[id];
      if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') {
        continue;
      }
      const ctx = decodeCtx?.fields[id];
      const decodedFieldId = decodeCtx?.fieldIds?.[id] ?? id;
      const item: NonNullable<DecodedScreenAnswer['fields']>[number] = {
        id: decodedFieldId,
        type: fieldType,
        ...(ctx?.label !== undefined ? { label: ctx.label } : {}),
        value,
      };
      if (fieldType === 'date' && typeof value === 'string') {
        if (value.trim().length === 0) {
          item.value = null;
          item.touched = false;
        } else {
          item.value = value;
          item.touched = true;
        }
      } else if (fieldType === 'picker' && typeof value === 'number') {
        if (value === -1) {
          item.selectedOption = null;
        } else if (ctx?.options && value >= 0 && value < ctx.options.length) {
          item.selectedOption = ctx.options[value]!;
        }
      }
      decoded.fields.push(item);
    }
    if (decoded.fields.length === 0) {
      delete decoded.fields;
    }
  }

  return decoded;
}
