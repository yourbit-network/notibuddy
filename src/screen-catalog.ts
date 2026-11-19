// Generated built-in certified screen template catalog and pinned TA public keys.
// Do not edit manually; regenerate with the offline catalog signing tool.

import type { ScreenSkeleton, ScreenTemplateId } from './screen-types.js';

export const SCREEN_TA_SIGNING_DOMAIN = 'nb-screen-ta-v1' as const;

export type ScreenTaKeyPurpose = 'catalog' | 'attestation';
export type ScreenTaKeyStatus = 'active' | 'retiring';

export interface ScreenTaPublicKey {
  readonly kid: string;
  readonly purpose: ScreenTaKeyPurpose;
  readonly status: ScreenTaKeyStatus;
  readonly algorithm: 'ES256';
  readonly publicKeyB64u: string;
}

export interface ScreenSignedTemplateRecord {
  readonly v: 1;
  readonly kid: string;
  readonly templateId: ScreenTemplateId;
  readonly skeleton: ScreenSkeleton;
  readonly sig: string;
}

export const SCREEN_CATALOG_SLUGS = [
  'db_migration_approval',
  'incident_triage',
  'code_review_form',
  'kpi_status_card',
  'action_checklist',
  'parameter_tuning_form',
  'deployment_gate',
  'multi_choice_audit',
] as const;

export type ScreenCatalogSlug = (typeof SCREEN_CATALOG_SLUGS)[number];

export interface ScreenCatalogEntry {
  readonly slug: ScreenCatalogSlug;
  readonly title: string;
  readonly description: string;
  readonly templateId: ScreenTemplateId;
  readonly kid: string;
  readonly sig: string;
  readonly recordB64u: string;
  readonly skeleton: ScreenSkeleton;
  readonly record: ScreenSignedTemplateRecord;
}

export const SCREEN_TA_PUBLIC_KEYS: Readonly<Record<string, ScreenTaPublicKey>> = {
  'ta-catalog-v1': {
    kid: 'ta-catalog-v1',
    purpose: 'catalog',
    status: 'active',
    algorithm: 'ES256',
    publicKeyB64u: 'BAT-aTS73kwce9MOjylY_tC7YZiNNUYQZ9Nk6WgMaDtUdEMWAFTMaUKm6tHCSHkSkGVuTjnY3XBdnJMnGSqw8-0',
  },
  'ta-attest-v1': {
    kid: 'ta-attest-v1',
    purpose: 'attestation',
    status: 'active',
    algorithm: 'ES256',
    publicKeyB64u: 'BPXId3thdKErN9tYDsDbX5rYdQ2blTquTsLJPuftZHCXWeVIJzxuvnGrcDstynBO9GWy1CJyxFub1p61YE-GJgE',
  },
  'ta-attest-v2': {
    kid: 'ta-attest-v2',
    purpose: 'attestation',
    status: 'active',
    algorithm: 'ES256',
    publicKeyB64u: 'BFjQsrSpP0VOMaRAbt10YO8tkCvKpsI-E6O4pY1cknPfHZ5J9fCQk5KNKtXMX0DBN-ODPwDI62PVwaJ38jMRpv4',
  },
};

const utf8Encoder = new TextEncoder();
const TA_KID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const TEMPLATE_ID_RE = /^tpl_[0-9a-f]{64}$/;

export function buildScreenTaSigningInput(
  kid: string,
  templateId: ScreenTemplateId
): Uint8Array {
  if (!TA_KID_RE.test(kid)) {
    throw new Error(`Invalid template authority key id: ${kid}`);
  }
  if (!TEMPLATE_ID_RE.test(templateId)) {
    throw new Error(`Invalid screen templateId: ${templateId}`);
  }
  const domainBytes = utf8Encoder.encode(SCREEN_TA_SIGNING_DOMAIN);
  const kidBytes = utf8Encoder.encode(kid);
  const idBytes = utf8Encoder.encode(templateId);
  const out = new Uint8Array(domainBytes.length + 1 + kidBytes.length + 1 + idBytes.length);
  let offset = 0;
  out.set(domainBytes, offset);
  offset += domainBytes.length;
  out[offset] = 0x00;
  offset += 1;
  out.set(kidBytes, offset);
  offset += kidBytes.length;
  out[offset] = 0x00;
  offset += 1;
  out.set(idBytes, offset);
  return out;
}

export const SCREEN_CATALOG: readonly ScreenCatalogEntry[] = [
  {
    slug: 'db_migration_approval',
    title: 'Database Migration Approval',
    description: 'Schema or data migration sign-off with warning banner, target metadata, DDL diff viewer, pre-flight checklist, and biometric approval.',
    templateId: 'tpl_9a64eaa2fbf40f9821af64340dba6788893684e3c1fd39a2651850130c0cdeb3',
    kid: 'ta-catalog-v1',
    sig: 'kHNJy4nhu-Wj3qqjfOB2OHKRm67DgQ07yilZXHV1MuSTBuV7G_y3Y13mXd5OG1OBhrtkheRJxjW7f3js9W39pQ',
    recordB64u: 'eyJraWQiOiJ0YS1jYXRhbG9nLXYxIiwic2lnIjoia0hOSnk0bmh1LVdqM3FxamZPQjJPSEtSbTY3RGdRMDd5aWxaWEhWMU11U1RCdVY3R195M1kxM21YZDVPRzFPQmhydGtoZVJKeGpXN2YzanM5VzM5cFEiLCJza2VsZXRvbiI6eyJhY3Rpb25zIjpbeyJlbmFibGVkV2hlbiI6W3siY2hlY2tsaXN0IjoiYzAiLCJvcCI6ImFsbENoZWNrZWQifV0sImlkIjoiYTAiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MTI4LCJtYXhHcmFwaGVtZXMiOjMyLCJzbG90IjoiczkifSwicmVxdWlyZUJpbyI6dHJ1ZSwicm9sZSI6ImRlc3RydWN0aXZlIn0seyJpZCI6ImExIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMxMCJ9LCJyZXF1aXJlQmlvIjpmYWxzZSwicm9sZSI6ImRlY2xpbmUifV0sInJvb3QiOnsiY2hpbGRyZW4iOlt7ImNoaWxkcmVuIjpbeyJraW5kIjoiYmFkZ2UiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MTI4LCJtYXhHcmFwaGVtZXMiOjMyLCJzbG90IjoiczEifSwidG9uZSI6Indhcm5pbmcifSx7ImJvZHkiOnsibWF4Qnl0ZXMiOjIwNDgsIm1heEdyYXBoZW1lcyI6NTEyLCJzbG90IjoiczMifSwia2luZCI6ImFsZXJ0Iiwic2V2ZXJpdHkiOiJ3YXJuaW5nIiwidGl0bGUiOnsibWF4Qnl0ZXMiOjUxMiwibWF4R3JhcGhlbWVzIjoxMjgsInNsb3QiOiJzMiJ9fSx7ImtpbmQiOiJrZXlWYWx1ZUxpc3QiLCJyb3dzIjp7Im1heEJ5dGVzIjo0MDk2LCJtYXhJdGVtcyI6OCwibWluSXRlbXMiOjEsInNsb3QiOiJzNCJ9fV0sImhlYWRlciI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczAifSwia2luZCI6ImNhcmQifSx7ImNoaWxkcmVuIjpbeyJkaWZmIjp7Im1heEJ5dGVzIjozMjc2OCwibWF4TGluZXMiOjI1Niwic2xvdCI6InM2In0sImtpbmQiOiJkaWZmVmlld2VyIn1dLCJoZWFkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM1In0sImtpbmQiOiJjYXJkIn0seyJjaGlsZHJlbiI6W3siaWQiOiJjMCIsIml0ZW1zIjp7Im1heEJ5dGVzIjo0MDk2LCJtYXhJdGVtcyI6OCwibWluSXRlbXMiOjEsInNsb3QiOiJzOCJ9LCJraW5kIjoiY2hlY2tsaXN0In1dLCJoZWFkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM3In0sImtpbmQiOiJjYXJkIn1dLCJraW5kIjoidnN0YWNrIiwic3BhY2luZyI6InJlZ3VsYXIifSwidiI6MX0sInRlbXBsYXRlSWQiOiJ0cGxfOWE2NGVhYTJmYmY0MGY5ODIxYWY2NDM0MGRiYTY3ODg4OTM2ODRlM2MxZmQzOWEyNjUxODUwMTMwYzBjZGViMyIsInYiOjF9',
    skeleton: {
      v: 1,
      root: {
        kind: 'vstack',
        children: [
          {
            kind: 'card',
            header: {
              slot: 's0',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'badge',
                tone: 'warning',
                label: {
                  slot: 's1',
                  maxGraphemes: 32,
                  maxBytes: 128,
                },
              },
              {
                kind: 'alert',
                severity: 'warning',
                title: {
                  slot: 's2',
                  maxGraphemes: 128,
                  maxBytes: 512,
                },
                body: {
                  slot: 's3',
                  maxGraphemes: 512,
                  maxBytes: 2048,
                },
              },
              {
                kind: 'keyValueList',
                rows: {
                  slot: 's4',
                  maxItems: 8,
                  maxBytes: 4096,
                  minItems: 1,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's5',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'diffViewer',
                diff: {
                  slot: 's6',
                  maxBytes: 32768,
                  maxLines: 256,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's7',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'checklist',
                id: 'c0',
                items: {
                  slot: 's8',
                  maxItems: 8,
                  maxBytes: 4096,
                  minItems: 1,
                },
              },
            ],
          },
        ],
        spacing: 'regular',
      },
      actions: [
        {
          id: 'a0',
          label: {
            slot: 's9',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'destructive',
          requireBio: true,
          enabledWhen: [
            {
              op: 'allChecked',
              checklist: 'c0',
            },
          ],
        },
        {
          id: 'a1',
          label: {
            slot: 's10',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'decline',
          requireBio: false,
        },
      ],
    },
    record: {
      v: 1,
      kid: 'ta-catalog-v1',
      templateId: 'tpl_9a64eaa2fbf40f9821af64340dba6788893684e3c1fd39a2651850130c0cdeb3',
      skeleton: {
        v: 1,
        root: {
          kind: 'vstack',
          children: [
            {
              kind: 'card',
              header: {
                slot: 's0',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'badge',
                  tone: 'warning',
                  label: {
                    slot: 's1',
                    maxGraphemes: 32,
                    maxBytes: 128,
                  },
                },
                {
                  kind: 'alert',
                  severity: 'warning',
                  title: {
                    slot: 's2',
                    maxGraphemes: 128,
                    maxBytes: 512,
                  },
                  body: {
                    slot: 's3',
                    maxGraphemes: 512,
                    maxBytes: 2048,
                  },
                },
                {
                  kind: 'keyValueList',
                  rows: {
                    slot: 's4',
                    maxItems: 8,
                    maxBytes: 4096,
                    minItems: 1,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's5',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'diffViewer',
                  diff: {
                    slot: 's6',
                    maxBytes: 32768,
                    maxLines: 256,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's7',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'checklist',
                  id: 'c0',
                  items: {
                    slot: 's8',
                    maxItems: 8,
                    maxBytes: 4096,
                    minItems: 1,
                  },
                },
              ],
            },
          ],
          spacing: 'regular',
        },
        actions: [
          {
            id: 'a0',
            label: {
              slot: 's9',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'destructive',
            requireBio: true,
            enabledWhen: [
              {
                op: 'allChecked',
                checklist: 'c0',
              },
            ],
          },
          {
            id: 'a1',
            label: {
              slot: 's10',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'decline',
            requireBio: false,
          },
        ],
      },
      sig: 'kHNJy4nhu-Wj3qqjfOB2OHKRm67DgQ07yilZXHV1MuSTBuV7G_y3Y13mXd5OG1OBhrtkheRJxjW7f3js9W39pQ',
    },
  },
  {
    slug: 'incident_triage',
    title: 'Incident Triage',
    description: 'Production incident response screen with severity alert, live KPI strip, context rows, priority picker, and response note.',
    templateId: 'tpl_efcaca7923b82253ed38e2b0f71950d967bc55d5085fb1d315b55b2953a65294',
    kid: 'ta-catalog-v1',
    sig: 'c2ioQ7BlsVH-C74dxdGwE1eVXx4a9cm6YvF9v1VBK3hCoVsWvDDA-0K5G5VOxJbuWoGLFX_FJexgbXmJEKRbFQ',
    recordB64u: 'eyJraWQiOiJ0YS1jYXRhbG9nLXYxIiwic2lnIjoiYzJpb1E3QmxzVkgtQzc0ZHhkR3dFMWVWWHg0YTljbTZZdkY5djFWQkszaENvVnNXdkREQS0wSzVHNVZPeEpidVdvR0xGWF9GSmV4Z2JYbUpFS1JiRlEiLCJza2VsZXRvbiI6eyJhY3Rpb25zIjpbeyJpZCI6ImEwIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMxMSJ9LCJyZXF1aXJlQmlvIjpmYWxzZSwicm9sZSI6InByaW1hcnkifSx7ImVuYWJsZWRXaGVuIjpbeyJmaWVsZCI6ImYxIiwib3AiOiJpc05vdEVtcHR5In1dLCJpZCI6ImExIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMxMiJ9LCJyZXF1aXJlQmlvIjp0cnVlLCJyb2xlIjoiZGVzdHJ1Y3RpdmUifSx7ImlkIjoiYTIiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MTI4LCJtYXhHcmFwaGVtZXMiOjMyLCJzbG90IjoiczEzIn0sInJlcXVpcmVCaW8iOmZhbHNlLCJyb2xlIjoiZGVjbGluZSJ9XSwicm9vdCI6eyJjaGlsZHJlbiI6W3siY2hpbGRyZW4iOlt7ImtpbmQiOiJiYWRnZSIsImxhYmVsIjp7Im1heEJ5dGVzIjoxMjgsIm1heEdyYXBoZW1lcyI6MzIsInNsb3QiOiJzMSJ9LCJ0b25lIjoiZGFuZ2VyIn0seyJib2R5Ijp7Im1heEJ5dGVzIjoyMDQ4LCJtYXhHcmFwaGVtZXMiOjUxMiwic2xvdCI6InMzIn0sImtpbmQiOiJhbGVydCIsInNldmVyaXR5IjoiZGFuZ2VyIiwidGl0bGUiOnsibWF4Qnl0ZXMiOjUxMiwibWF4R3JhcGhlbWVzIjoxMjgsInNsb3QiOiJzMiJ9fSx7Iml0ZW1zIjp7Im1heEJ5dGVzIjoyMDQ4LCJtYXhJdGVtcyI6NCwibWluSXRlbXMiOjEsInNsb3QiOiJzNCJ9LCJraW5kIjoia3BpU3RyaXAifV0sImhlYWRlciI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczAifSwia2luZCI6ImNhcmQifSx7ImNoaWxkcmVuIjpbeyJraW5kIjoia2V5VmFsdWVMaXN0Iiwicm93cyI6eyJtYXhCeXRlcyI6NDA5NiwibWF4SXRlbXMiOjgsIm1pbkl0ZW1zIjoxLCJzbG90IjoiczYifX0seyJraW5kIjoiZGl2aWRlciJ9LHsiZGVmYXVsdE9wdGlvbkluZGV4IjotMSwiZmllbGRUeXBlIjoicGlja2VyIiwiaWQiOiJmMCIsImtpbmQiOiJmb3JtRmllbGQiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczcifSwib3B0aW9ucyI6eyJtYXhCeXRlcyI6MjA0OCwibWF4SXRlbXMiOjgsIm1pbkl0ZW1zIjoyLCJzbG90IjoiczgifSwicmVxdWlyZWQiOnRydWV9LHsiZmllbGRUeXBlIjoidGV4dCIsImlkIjoiZjEiLCJraW5kIjoiZm9ybUZpZWxkIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM5In0sIm1heEJ5dGVzIjoyMDQ4LCJtYXhHcmFwaGVtZXMiOjUxMiwicGxhY2Vob2xkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InMxMCJ9LCJyZXF1aXJlZCI6ZmFsc2V9XSwiaGVhZGVyIjp7Im1heEJ5dGVzIjoyNTYsIm1heEdyYXBoZW1lcyI6NjQsInNsb3QiOiJzNSJ9LCJraW5kIjoiY2FyZCJ9XSwia2luZCI6InZzdGFjayIsInNwYWNpbmciOiJyZWd1bGFyIn0sInYiOjF9LCJ0ZW1wbGF0ZUlkIjoidHBsX2VmY2FjYTc5MjNiODIyNTNlZDM4ZTJiMGY3MTk1MGQ5NjdiYzU1ZDUwODVmYjFkMzE1YjU1YjI5NTNhNjUyOTQiLCJ2IjoxfQ',
    skeleton: {
      v: 1,
      root: {
        kind: 'vstack',
        children: [
          {
            kind: 'card',
            header: {
              slot: 's0',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'badge',
                tone: 'danger',
                label: {
                  slot: 's1',
                  maxGraphemes: 32,
                  maxBytes: 128,
                },
              },
              {
                kind: 'alert',
                severity: 'danger',
                title: {
                  slot: 's2',
                  maxGraphemes: 128,
                  maxBytes: 512,
                },
                body: {
                  slot: 's3',
                  maxGraphemes: 512,
                  maxBytes: 2048,
                },
              },
              {
                kind: 'kpiStrip',
                items: {
                  slot: 's4',
                  maxItems: 4,
                  maxBytes: 2048,
                  minItems: 1,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's5',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'keyValueList',
                rows: {
                  slot: 's6',
                  maxItems: 8,
                  maxBytes: 4096,
                  minItems: 1,
                },
              },
              {
                kind: 'divider',
              },
              {
                kind: 'formField',
                id: 'f0',
                fieldType: 'picker',
                label: {
                  slot: 's7',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                options: {
                  slot: 's8',
                  maxItems: 8,
                  maxBytes: 2048,
                  minItems: 2,
                },
                required: true,
                defaultOptionIndex: -1,
              },
              {
                kind: 'formField',
                id: 'f1',
                fieldType: 'text',
                label: {
                  slot: 's9',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                placeholder: {
                  slot: 's10',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                required: false,
                maxGraphemes: 512,
                maxBytes: 2048,
              },
            ],
          },
        ],
        spacing: 'regular',
      },
      actions: [
        {
          id: 'a0',
          label: {
            slot: 's11',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'primary',
          requireBio: false,
        },
        {
          id: 'a1',
          label: {
            slot: 's12',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'destructive',
          requireBio: true,
          enabledWhen: [
            {
              op: 'isNotEmpty',
              field: 'f1',
            },
          ],
        },
        {
          id: 'a2',
          label: {
            slot: 's13',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'decline',
          requireBio: false,
        },
      ],
    },
    record: {
      v: 1,
      kid: 'ta-catalog-v1',
      templateId: 'tpl_efcaca7923b82253ed38e2b0f71950d967bc55d5085fb1d315b55b2953a65294',
      skeleton: {
        v: 1,
        root: {
          kind: 'vstack',
          children: [
            {
              kind: 'card',
              header: {
                slot: 's0',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'badge',
                  tone: 'danger',
                  label: {
                    slot: 's1',
                    maxGraphemes: 32,
                    maxBytes: 128,
                  },
                },
                {
                  kind: 'alert',
                  severity: 'danger',
                  title: {
                    slot: 's2',
                    maxGraphemes: 128,
                    maxBytes: 512,
                  },
                  body: {
                    slot: 's3',
                    maxGraphemes: 512,
                    maxBytes: 2048,
                  },
                },
                {
                  kind: 'kpiStrip',
                  items: {
                    slot: 's4',
                    maxItems: 4,
                    maxBytes: 2048,
                    minItems: 1,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's5',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'keyValueList',
                  rows: {
                    slot: 's6',
                    maxItems: 8,
                    maxBytes: 4096,
                    minItems: 1,
                  },
                },
                {
                  kind: 'divider',
                },
                {
                  kind: 'formField',
                  id: 'f0',
                  fieldType: 'picker',
                  label: {
                    slot: 's7',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  options: {
                    slot: 's8',
                    maxItems: 8,
                    maxBytes: 2048,
                    minItems: 2,
                  },
                  required: true,
                  defaultOptionIndex: -1,
                },
                {
                  kind: 'formField',
                  id: 'f1',
                  fieldType: 'text',
                  label: {
                    slot: 's9',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  placeholder: {
                    slot: 's10',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  required: false,
                  maxGraphemes: 512,
                  maxBytes: 2048,
                },
              ],
            },
          ],
          spacing: 'regular',
        },
        actions: [
          {
            id: 'a0',
            label: {
              slot: 's11',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'primary',
            requireBio: false,
          },
          {
            id: 'a1',
            label: {
              slot: 's12',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'destructive',
            requireBio: true,
            enabledWhen: [
              {
                op: 'isNotEmpty',
                field: 'f1',
              },
            ],
          },
          {
            id: 'a2',
            label: {
              slot: 's13',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'decline',
            requireBio: false,
          },
        ],
      },
      sig: 'c2ioQ7BlsVH-C74dxdGwE1eVXx4a9cm6YvF9v1VBK3hCoVsWvDDA-0K5G5VOxJbuWoGLFX_FJexgbXmJEKRbFQ',
    },
  },
  {
    slug: 'code_review_form',
    title: 'Code Review Form',
    description: 'Pull-request or patch review with change summary, metadata rows, unified diff viewer, disposition picker, and required review comment.',
    templateId: 'tpl_516ea85f72e98ed524aed18b1fc44b73f63e0b2a18fd1a85e5b6a64a7c0866d3',
    kid: 'ta-catalog-v1',
    sig: 'kt4CovmloWwgxOGaGpPcrJBtX9PluS9hQDgQPNSfE0NPfNWmrSCFUg9JKmkFX5vOR8MDr8dni8NtDGogEjiQ9Q',
    recordB64u: 'eyJraWQiOiJ0YS1jYXRhbG9nLXYxIiwic2lnIjoia3Q0Q292bWxvV3dneE9HYUdwUGNySkJ0WDlQbHVTOWhRRGdRUE5TZkUwTlBmTldtclNDRlVnOUpLbWtGWDV2T1I4TURyOGRuaThOdERHb2dFamlROVEiLCJza2VsZXRvbiI6eyJhY3Rpb25zIjpbeyJlbmFibGVkV2hlbiI6W3siZmllbGQiOiJmMSIsIm9wIjoiaXNOb3RFbXB0eSJ9XSwiaWQiOiJhMCIsImxhYmVsIjp7Im1heEJ5dGVzIjoxMjgsIm1heEdyYXBoZW1lcyI6MzIsInNsb3QiOiJzMTEifSwicmVxdWlyZUJpbyI6ZmFsc2UsInJvbGUiOiJwcmltYXJ5In0seyJpZCI6ImExIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMxMiJ9LCJyZXF1aXJlQmlvIjpmYWxzZSwicm9sZSI6ImRlY2xpbmUifV0sInJvb3QiOnsiY2hpbGRyZW4iOlt7ImNoaWxkcmVuIjpbeyJraW5kIjoiYmFkZ2UiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MTI4LCJtYXhHcmFwaGVtZXMiOjMyLCJzbG90IjoiczEifSwidG9uZSI6ImluZm8ifSx7ImtpbmQiOiJ0ZXh0Iiwic3R5bGUiOiJib2R5IiwidGV4dCI6eyJtYXhCeXRlcyI6MjA0OCwibWF4R3JhcGhlbWVzIjo1MTIsInNsb3QiOiJzMiJ9fSx7ImtpbmQiOiJrZXlWYWx1ZUxpc3QiLCJyb3dzIjp7Im1heEJ5dGVzIjo0MDk2LCJtYXhJdGVtcyI6OCwibWluSXRlbXMiOjEsInNsb3QiOiJzMyJ9fV0sImhlYWRlciI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczAifSwia2luZCI6ImNhcmQifSx7ImNoaWxkcmVuIjpbeyJkaWZmIjp7Im1heEJ5dGVzIjo2NTUzNiwibWF4TGluZXMiOjUxMiwic2xvdCI6InM1In0sImtpbmQiOiJkaWZmVmlld2VyIn1dLCJoZWFkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM0In0sImtpbmQiOiJjYXJkIn0seyJjaGlsZHJlbiI6W3siZGVmYXVsdE9wdGlvbkluZGV4IjowLCJmaWVsZFR5cGUiOiJwaWNrZXIiLCJpZCI6ImYwIiwia2luZCI6ImZvcm1GaWVsZCIsImxhYmVsIjp7Im1heEJ5dGVzIjoyNTYsIm1heEdyYXBoZW1lcyI6NjQsInNsb3QiOiJzNyJ9LCJvcHRpb25zIjp7Im1heEJ5dGVzIjoxMDI0LCJtYXhJdGVtcyI6NCwibWluSXRlbXMiOjIsInNsb3QiOiJzOCJ9LCJyZXF1aXJlZCI6dHJ1ZX0seyJmaWVsZFR5cGUiOiJ0ZXh0IiwiaWQiOiJmMSIsImtpbmQiOiJmb3JtRmllbGQiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczkifSwibWF4Qnl0ZXMiOjQwOTYsIm1heEdyYXBoZW1lcyI6MTAyNCwicGxhY2Vob2xkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InMxMCJ9LCJyZXF1aXJlZCI6dHJ1ZX1dLCJoZWFkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM2In0sImtpbmQiOiJjYXJkIn1dLCJraW5kIjoidnN0YWNrIiwic3BhY2luZyI6InJlZ3VsYXIifSwidiI6MX0sInRlbXBsYXRlSWQiOiJ0cGxfNTE2ZWE4NWY3MmU5OGVkNTI0YWVkMThiMWZjNDRiNzNmNjNlMGIyYTE4ZmQxYTg1ZTViNmE2NGE3YzA4NjZkMyIsInYiOjF9',
    skeleton: {
      v: 1,
      root: {
        kind: 'vstack',
        children: [
          {
            kind: 'card',
            header: {
              slot: 's0',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'badge',
                tone: 'info',
                label: {
                  slot: 's1',
                  maxGraphemes: 32,
                  maxBytes: 128,
                },
              },
              {
                kind: 'text',
                style: 'body',
                text: {
                  slot: 's2',
                  maxGraphemes: 512,
                  maxBytes: 2048,
                },
              },
              {
                kind: 'keyValueList',
                rows: {
                  slot: 's3',
                  maxItems: 8,
                  maxBytes: 4096,
                  minItems: 1,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's4',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'diffViewer',
                diff: {
                  slot: 's5',
                  maxBytes: 65536,
                  maxLines: 512,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's6',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'formField',
                id: 'f0',
                fieldType: 'picker',
                label: {
                  slot: 's7',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                options: {
                  slot: 's8',
                  maxItems: 4,
                  maxBytes: 1024,
                  minItems: 2,
                },
                required: true,
                defaultOptionIndex: 0,
              },
              {
                kind: 'formField',
                id: 'f1',
                fieldType: 'text',
                label: {
                  slot: 's9',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                placeholder: {
                  slot: 's10',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                required: true,
                maxGraphemes: 1024,
                maxBytes: 4096,
              },
            ],
          },
        ],
        spacing: 'regular',
      },
      actions: [
        {
          id: 'a0',
          label: {
            slot: 's11',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'primary',
          requireBio: false,
          enabledWhen: [
            {
              op: 'isNotEmpty',
              field: 'f1',
            },
          ],
        },
        {
          id: 'a1',
          label: {
            slot: 's12',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'decline',
          requireBio: false,
        },
      ],
    },
    record: {
      v: 1,
      kid: 'ta-catalog-v1',
      templateId: 'tpl_516ea85f72e98ed524aed18b1fc44b73f63e0b2a18fd1a85e5b6a64a7c0866d3',
      skeleton: {
        v: 1,
        root: {
          kind: 'vstack',
          children: [
            {
              kind: 'card',
              header: {
                slot: 's0',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'badge',
                  tone: 'info',
                  label: {
                    slot: 's1',
                    maxGraphemes: 32,
                    maxBytes: 128,
                  },
                },
                {
                  kind: 'text',
                  style: 'body',
                  text: {
                    slot: 's2',
                    maxGraphemes: 512,
                    maxBytes: 2048,
                  },
                },
                {
                  kind: 'keyValueList',
                  rows: {
                    slot: 's3',
                    maxItems: 8,
                    maxBytes: 4096,
                    minItems: 1,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's4',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'diffViewer',
                  diff: {
                    slot: 's5',
                    maxBytes: 65536,
                    maxLines: 512,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's6',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'formField',
                  id: 'f0',
                  fieldType: 'picker',
                  label: {
                    slot: 's7',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  options: {
                    slot: 's8',
                    maxItems: 4,
                    maxBytes: 1024,
                    minItems: 2,
                  },
                  required: true,
                  defaultOptionIndex: 0,
                },
                {
                  kind: 'formField',
                  id: 'f1',
                  fieldType: 'text',
                  label: {
                    slot: 's9',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  placeholder: {
                    slot: 's10',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  required: true,
                  maxGraphemes: 1024,
                  maxBytes: 4096,
                },
              ],
            },
          ],
          spacing: 'regular',
        },
        actions: [
          {
            id: 'a0',
            label: {
              slot: 's11',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'primary',
            requireBio: false,
            enabledWhen: [
              {
                op: 'isNotEmpty',
                field: 'f1',
              },
            ],
          },
          {
            id: 'a1',
            label: {
              slot: 's12',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'decline',
            requireBio: false,
          },
        ],
      },
      sig: 'kt4CovmloWwgxOGaGpPcrJBtX9PluS9hQDgQPNSfE0NPfNWmrSCFUg9JKmkFX5vOR8MDr8dni8NtDGogEjiQ9Q',
    },
  },
  {
    slug: 'kpi_status_card',
    title: 'KPI Status Card',
    description: 'Operational status report with headline metrics, summary narrative, and detailed key-value breakdown.',
    templateId: 'tpl_6fa3fbdf264b1048364bf9b4179464ccc6795a1b5c67ade9e5e2ac8a00262526',
    kid: 'ta-catalog-v1',
    sig: '3yH4eQXJfMOn7y0H4MJiZuAwDJLa1gsINO0mwI9GlnSWiavivrh2g-7cKXtjVBuZ9LoLqgS2HC2nWuDJxnkPMw',
    recordB64u: 'eyJraWQiOiJ0YS1jYXRhbG9nLXYxIiwic2lnIjoiM3lINGVRWEpmTU9uN3kwSDRNSmladUF3REpMYTFnc0lOTzBtd0k5R2xuU1dpYXZpdnJoMmctN2NLWHRqVkJ1WjlMb0xxZ1MySEMybld1REp4bmtQTXciLCJza2VsZXRvbiI6eyJhY3Rpb25zIjpbeyJpZCI6ImEwIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InM3In0sInJlcXVpcmVCaW8iOmZhbHNlLCJyb2xlIjoicHJpbWFyeSJ9LHsiaWQiOiJhMSIsImxhYmVsIjp7Im1heEJ5dGVzIjoxMjgsIm1heEdyYXBoZW1lcyI6MzIsInNsb3QiOiJzOCJ9LCJyZXF1aXJlQmlvIjpmYWxzZSwicm9sZSI6InNlY29uZGFyeSJ9XSwicm9vdCI6eyJjaGlsZHJlbiI6W3siY2hpbGRyZW4iOlt7ImtpbmQiOiJoZWFkaW5nIiwibGV2ZWwiOjIsInRleHQiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InMxIn19LHsia2luZCI6ImJhZGdlIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMyIn0sInRvbmUiOiJpbmZvIn0seyJpdGVtcyI6eyJtYXhCeXRlcyI6NDA5NiwibWF4SXRlbXMiOjYsIm1pbkl0ZW1zIjoxLCJzbG90IjoiczMifSwia2luZCI6ImtwaVN0cmlwIn0seyJraW5kIjoiZGl2aWRlciJ9LHsia2luZCI6InRleHQiLCJzdHlsZSI6ImJvZHkiLCJ0ZXh0Ijp7Im1heEJ5dGVzIjoyMDQ4LCJtYXhHcmFwaGVtZXMiOjUxMiwic2xvdCI6InM0In19XSwiaGVhZGVyIjp7Im1heEJ5dGVzIjoyNTYsIm1heEdyYXBoZW1lcyI6NjQsInNsb3QiOiJzMCJ9LCJraW5kIjoiY2FyZCJ9LHsiY2hpbGRyZW4iOlt7ImtpbmQiOiJrZXlWYWx1ZUxpc3QiLCJyb3dzIjp7Im1heEJ5dGVzIjo4MTkyLCJtYXhJdGVtcyI6MTYsIm1pbkl0ZW1zIjoxLCJzbG90IjoiczYifX1dLCJoZWFkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM1In0sImtpbmQiOiJjYXJkIn1dLCJraW5kIjoidnN0YWNrIiwic3BhY2luZyI6InJlZ3VsYXIifSwidiI6MX0sInRlbXBsYXRlSWQiOiJ0cGxfNmZhM2ZiZGYyNjRiMTA0ODM2NGJmOWI0MTc5NDY0Y2NjNjc5NWExYjVjNjdhZGU5ZTVlMmFjOGEwMDI2MjUyNiIsInYiOjF9',
    skeleton: {
      v: 1,
      root: {
        kind: 'vstack',
        children: [
          {
            kind: 'card',
            header: {
              slot: 's0',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'heading',
                level: 2,
                text: {
                  slot: 's1',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
              },
              {
                kind: 'badge',
                tone: 'info',
                label: {
                  slot: 's2',
                  maxGraphemes: 32,
                  maxBytes: 128,
                },
              },
              {
                kind: 'kpiStrip',
                items: {
                  slot: 's3',
                  maxItems: 6,
                  maxBytes: 4096,
                  minItems: 1,
                },
              },
              {
                kind: 'divider',
              },
              {
                kind: 'text',
                style: 'body',
                text: {
                  slot: 's4',
                  maxGraphemes: 512,
                  maxBytes: 2048,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's5',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'keyValueList',
                rows: {
                  slot: 's6',
                  maxItems: 16,
                  maxBytes: 8192,
                  minItems: 1,
                },
              },
            ],
          },
        ],
        spacing: 'regular',
      },
      actions: [
        {
          id: 'a0',
          label: {
            slot: 's7',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'primary',
          requireBio: false,
        },
        {
          id: 'a1',
          label: {
            slot: 's8',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'secondary',
          requireBio: false,
        },
      ],
    },
    record: {
      v: 1,
      kid: 'ta-catalog-v1',
      templateId: 'tpl_6fa3fbdf264b1048364bf9b4179464ccc6795a1b5c67ade9e5e2ac8a00262526',
      skeleton: {
        v: 1,
        root: {
          kind: 'vstack',
          children: [
            {
              kind: 'card',
              header: {
                slot: 's0',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'heading',
                  level: 2,
                  text: {
                    slot: 's1',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                },
                {
                  kind: 'badge',
                  tone: 'info',
                  label: {
                    slot: 's2',
                    maxGraphemes: 32,
                    maxBytes: 128,
                  },
                },
                {
                  kind: 'kpiStrip',
                  items: {
                    slot: 's3',
                    maxItems: 6,
                    maxBytes: 4096,
                    minItems: 1,
                  },
                },
                {
                  kind: 'divider',
                },
                {
                  kind: 'text',
                  style: 'body',
                  text: {
                    slot: 's4',
                    maxGraphemes: 512,
                    maxBytes: 2048,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's5',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'keyValueList',
                  rows: {
                    slot: 's6',
                    maxItems: 16,
                    maxBytes: 8192,
                    minItems: 1,
                  },
                },
              ],
            },
          ],
          spacing: 'regular',
        },
        actions: [
          {
            id: 'a0',
            label: {
              slot: 's7',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'primary',
            requireBio: false,
          },
          {
            id: 'a1',
            label: {
              slot: 's8',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'secondary',
            requireBio: false,
          },
        ],
      },
      sig: '3yH4eQXJfMOn7y0H4MJiZuAwDJLa1gsINO0mwI9GlnSWiavivrh2g-7cKXtjVBuZ9LoLqgS2HC2nWuDJxnkPMw',
    },
  },
  {
    slug: 'action_checklist',
    title: 'Action Checklist',
    description: 'Step-by-step verification checklist paired with an explicit confirmation toggle gating biometric submission.',
    templateId: 'tpl_ab44ab504d7cc01c05bd68f23d0c31550e6f66b6dc02b30f5a5f903dd068dcaa',
    kid: 'ta-catalog-v1',
    sig: 'wD6Hs3W7FWUXIZBVlYEbXiMgFzkjkkX9Eio8I6jYuCbLdWh3neffG8UnW6OaU-b2DaVYbISMLRw5-3cGtXCH_g',
    recordB64u: 'eyJraWQiOiJ0YS1jYXRhbG9nLXYxIiwic2lnIjoid0Q2SHMzVzdGV1VYSVpCVmxZRWJYaU1nRnpramtrWDlFaW84STZqWXVDYkxkV2gzbmVmZkc4VW5XNk9hVS1iMkRhVlliSVNNTFJ3NS0zY0d0WENIX2ciLCJza2VsZXRvbiI6eyJhY3Rpb25zIjpbeyJlbmFibGVkV2hlbiI6W3siY2hlY2tsaXN0IjoiYzAiLCJvcCI6ImFsbENoZWNrZWQifSx7ImZpZWxkIjoiZjAiLCJvcCI6ImVxdWFscyIsInZhbHVlIjp0cnVlfV0sImlkIjoiYTAiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MTI4LCJtYXhHcmFwaGVtZXMiOjMyLCJzbG90IjoiczcifSwicmVxdWlyZUJpbyI6dHJ1ZSwicm9sZSI6InByaW1hcnkifSx7ImlkIjoiYTEiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MTI4LCJtYXhHcmFwaGVtZXMiOjMyLCJzbG90IjoiczgifSwicmVxdWlyZUJpbyI6ZmFsc2UsInJvbGUiOiJkZWNsaW5lIn1dLCJyb290Ijp7ImNoaWxkcmVuIjpbeyJjaGlsZHJlbiI6W3sia2luZCI6ImhlYWRpbmciLCJsZXZlbCI6MiwidGV4dCI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczEifX0seyJraW5kIjoidGV4dCIsInN0eWxlIjoiYm9keSIsInRleHQiOnsibWF4Qnl0ZXMiOjIwNDgsIm1heEdyYXBoZW1lcyI6NTEyLCJzbG90IjoiczIifX1dLCJoZWFkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InMwIn0sImtpbmQiOiJjYXJkIn0seyJjaGlsZHJlbiI6W3siaWQiOiJjMCIsIml0ZW1zIjp7Im1heEJ5dGVzIjo4MTkyLCJtYXhJdGVtcyI6MTYsIm1pbkl0ZW1zIjoxLCJzbG90IjoiczUifSwia2luZCI6ImNoZWNrbGlzdCIsInRpdGxlIjp7Im1heEJ5dGVzIjoyNTYsIm1heEdyYXBoZW1lcyI6NjQsInNsb3QiOiJzNCJ9fSx7ImtpbmQiOiJkaXZpZGVyIn0seyJkZWZhdWx0Qm9vbCI6ZmFsc2UsImZpZWxkVHlwZSI6InRvZ2dsZSIsImlkIjoiZjAiLCJraW5kIjoiZm9ybUZpZWxkIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM2In0sInJlcXVpcmVkIjp0cnVlfV0sImhlYWRlciI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczMifSwia2luZCI6ImNhcmQifV0sImtpbmQiOiJ2c3RhY2siLCJzcGFjaW5nIjoicmVndWxhciJ9LCJ2IjoxfSwidGVtcGxhdGVJZCI6InRwbF9hYjQ0YWI1MDRkN2NjMDFjMDViZDY4ZjIzZDBjMzE1NTBlNmY2NmI2ZGMwMmIzMGY1YTVmOTAzZGQwNjhkY2FhIiwidiI6MX0',
    skeleton: {
      v: 1,
      root: {
        kind: 'vstack',
        children: [
          {
            kind: 'card',
            header: {
              slot: 's0',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'heading',
                level: 2,
                text: {
                  slot: 's1',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
              },
              {
                kind: 'text',
                style: 'body',
                text: {
                  slot: 's2',
                  maxGraphemes: 512,
                  maxBytes: 2048,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's3',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'checklist',
                id: 'c0',
                title: {
                  slot: 's4',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                items: {
                  slot: 's5',
                  maxItems: 16,
                  maxBytes: 8192,
                  minItems: 1,
                },
              },
              {
                kind: 'divider',
              },
              {
                kind: 'formField',
                id: 'f0',
                fieldType: 'toggle',
                label: {
                  slot: 's6',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                required: true,
                defaultBool: false,
              },
            ],
          },
        ],
        spacing: 'regular',
      },
      actions: [
        {
          id: 'a0',
          label: {
            slot: 's7',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'primary',
          requireBio: true,
          enabledWhen: [
            {
              op: 'allChecked',
              checklist: 'c0',
            },
            {
              op: 'equals',
              field: 'f0',
              value: true,
            },
          ],
        },
        {
          id: 'a1',
          label: {
            slot: 's8',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'decline',
          requireBio: false,
        },
      ],
    },
    record: {
      v: 1,
      kid: 'ta-catalog-v1',
      templateId: 'tpl_ab44ab504d7cc01c05bd68f23d0c31550e6f66b6dc02b30f5a5f903dd068dcaa',
      skeleton: {
        v: 1,
        root: {
          kind: 'vstack',
          children: [
            {
              kind: 'card',
              header: {
                slot: 's0',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'heading',
                  level: 2,
                  text: {
                    slot: 's1',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                },
                {
                  kind: 'text',
                  style: 'body',
                  text: {
                    slot: 's2',
                    maxGraphemes: 512,
                    maxBytes: 2048,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's3',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'checklist',
                  id: 'c0',
                  title: {
                    slot: 's4',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  items: {
                    slot: 's5',
                    maxItems: 16,
                    maxBytes: 8192,
                    minItems: 1,
                  },
                },
                {
                  kind: 'divider',
                },
                {
                  kind: 'formField',
                  id: 'f0',
                  fieldType: 'toggle',
                  label: {
                    slot: 's6',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  required: true,
                  defaultBool: false,
                },
              ],
            },
          ],
          spacing: 'regular',
        },
        actions: [
          {
            id: 'a0',
            label: {
              slot: 's7',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'primary',
            requireBio: true,
            enabledWhen: [
              {
                op: 'allChecked',
                checklist: 'c0',
              },
              {
                op: 'equals',
                field: 'f0',
                value: true,
              },
            ],
          },
          {
            id: 'a1',
            label: {
              slot: 's8',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'decline',
            requireBio: false,
          },
        ],
      },
      sig: 'wD6Hs3W7FWUXIZBVlYEbXiMgFzkjkkX9Eio8I6jYuCbLdWh3neffG8UnW6OaU-b2DaVYbISMLRw5-3cGtXCH_g',
    },
  },
  {
    slug: 'parameter_tuning_form',
    title: 'Parameter Tuning Form',
    description: 'Runtime configuration editor with current parameter summary, integer stepper, mode picker, safety toggle, and rationale note.',
    templateId: 'tpl_dd6f8732c37e901667a0c1e9d9764b36b878121a2ae5beac73bb2ad593dc4e4a',
    kid: 'ta-catalog-v1',
    sig: 'oC8jd4gyKgfutaAY9xgb_AJboKvXAIG41MSEWQh5_cDJ1PZ47RGqN53xnsXTgc7DJ1XjJGt5t04Hy6DXLMk3JA',
    recordB64u: 'eyJraWQiOiJ0YS1jYXRhbG9nLXYxIiwic2lnIjoib0M4amQ0Z3lLZ2Z1dGFBWTl4Z2JfQUpib0t2WEFJRzQxTVNFV1FoNV9jREoxUFo0N1JHcU41M3huc1hUZ2M3REoxWGpKR3Q1dDA0SHk2RFhMTWszSkEiLCJza2VsZXRvbiI6eyJhY3Rpb25zIjpbeyJpZCI6ImEwIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMxMCJ9LCJyZXF1aXJlQmlvIjp0cnVlLCJyb2xlIjoicHJpbWFyeSJ9LHsiaWQiOiJhMSIsImxhYmVsIjp7Im1heEJ5dGVzIjoxMjgsIm1heEdyYXBoZW1lcyI6MzIsInNsb3QiOiJzMTEifSwicmVxdWlyZUJpbyI6ZmFsc2UsInJvbGUiOiJkZWNsaW5lIn1dLCJyb290Ijp7ImNoaWxkcmVuIjpbeyJjaGlsZHJlbiI6W3sia2luZCI6InRleHQiLCJzdHlsZSI6ImJvZHkiLCJ0ZXh0Ijp7Im1heEJ5dGVzIjoxMDI0LCJtYXhHcmFwaGVtZXMiOjI1Niwic2xvdCI6InMxIn19LHsia2luZCI6ImtleVZhbHVlTGlzdCIsInJvd3MiOnsibWF4Qnl0ZXMiOjQwOTYsIm1heEl0ZW1zIjo4LCJtaW5JdGVtcyI6MSwic2xvdCI6InMyIn19XSwiaGVhZGVyIjp7Im1heEJ5dGVzIjoyNTYsIm1heEdyYXBoZW1lcyI6NjQsInNsb3QiOiJzMCJ9LCJraW5kIjoiY2FyZCJ9LHsiY2hpbGRyZW4iOlt7ImRlZmF1bHRJbnQiOjEwLCJmaWVsZFR5cGUiOiJzdGVwcGVyIiwiaWQiOiJmMCIsImtpbmQiOiJmb3JtRmllbGQiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczQifSwibWF4IjoxMDAwLCJtaW4iOjAsInJlcXVpcmVkIjp0cnVlfSx7ImRlZmF1bHRPcHRpb25JbmRleCI6MCwiZmllbGRUeXBlIjoicGlja2VyIiwiaWQiOiJmMSIsImtpbmQiOiJmb3JtRmllbGQiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczUifSwib3B0aW9ucyI6eyJtYXhCeXRlcyI6NDA5NiwibWF4SXRlbXMiOjE2LCJtaW5JdGVtcyI6Miwic2xvdCI6InM2In0sInJlcXVpcmVkIjp0cnVlfSx7ImRlZmF1bHRCb29sIjp0cnVlLCJmaWVsZFR5cGUiOiJ0b2dnbGUiLCJpZCI6ImYyIiwia2luZCI6ImZvcm1GaWVsZCIsImxhYmVsIjp7Im1heEJ5dGVzIjoyNTYsIm1heEdyYXBoZW1lcyI6NjQsInNsb3QiOiJzNyJ9LCJyZXF1aXJlZCI6ZmFsc2V9LHsiZmllbGRUeXBlIjoidGV4dCIsImlkIjoiZjMiLCJraW5kIjoiZm9ybUZpZWxkIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM4In0sIm1heEJ5dGVzIjoxMDI0LCJtYXhHcmFwaGVtZXMiOjI1NiwicGxhY2Vob2xkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM5In0sInJlcXVpcmVkIjpmYWxzZX1dLCJoZWFkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InMzIn0sImtpbmQiOiJjYXJkIn1dLCJraW5kIjoidnN0YWNrIiwic3BhY2luZyI6InJlZ3VsYXIifSwidiI6MX0sInRlbXBsYXRlSWQiOiJ0cGxfZGQ2Zjg3MzJjMzdlOTAxNjY3YTBjMWU5ZDk3NjRiMzZiODc4MTIxYTJhZTViZWFjNzNiYjJhZDU5M2RjNGU0YSIsInYiOjF9',
    skeleton: {
      v: 1,
      root: {
        kind: 'vstack',
        children: [
          {
            kind: 'card',
            header: {
              slot: 's0',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'text',
                style: 'body',
                text: {
                  slot: 's1',
                  maxGraphemes: 256,
                  maxBytes: 1024,
                },
              },
              {
                kind: 'keyValueList',
                rows: {
                  slot: 's2',
                  maxItems: 8,
                  maxBytes: 4096,
                  minItems: 1,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's3',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'formField',
                id: 'f0',
                fieldType: 'stepper',
                label: {
                  slot: 's4',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                min: 0,
                max: 1000,
                required: true,
                defaultInt: 10,
              },
              {
                kind: 'formField',
                id: 'f1',
                fieldType: 'picker',
                label: {
                  slot: 's5',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                options: {
                  slot: 's6',
                  maxItems: 16,
                  maxBytes: 4096,
                  minItems: 2,
                },
                required: true,
                defaultOptionIndex: 0,
              },
              {
                kind: 'formField',
                id: 'f2',
                fieldType: 'toggle',
                label: {
                  slot: 's7',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                required: false,
                defaultBool: true,
              },
              {
                kind: 'formField',
                id: 'f3',
                fieldType: 'text',
                label: {
                  slot: 's8',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                placeholder: {
                  slot: 's9',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                required: false,
                maxGraphemes: 256,
                maxBytes: 1024,
              },
            ],
          },
        ],
        spacing: 'regular',
      },
      actions: [
        {
          id: 'a0',
          label: {
            slot: 's10',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'primary',
          requireBio: true,
        },
        {
          id: 'a1',
          label: {
            slot: 's11',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'decline',
          requireBio: false,
        },
      ],
    },
    record: {
      v: 1,
      kid: 'ta-catalog-v1',
      templateId: 'tpl_dd6f8732c37e901667a0c1e9d9764b36b878121a2ae5beac73bb2ad593dc4e4a',
      skeleton: {
        v: 1,
        root: {
          kind: 'vstack',
          children: [
            {
              kind: 'card',
              header: {
                slot: 's0',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'text',
                  style: 'body',
                  text: {
                    slot: 's1',
                    maxGraphemes: 256,
                    maxBytes: 1024,
                  },
                },
                {
                  kind: 'keyValueList',
                  rows: {
                    slot: 's2',
                    maxItems: 8,
                    maxBytes: 4096,
                    minItems: 1,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's3',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'formField',
                  id: 'f0',
                  fieldType: 'stepper',
                  label: {
                    slot: 's4',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  min: 0,
                  max: 1000,
                  required: true,
                  defaultInt: 10,
                },
                {
                  kind: 'formField',
                  id: 'f1',
                  fieldType: 'picker',
                  label: {
                    slot: 's5',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  options: {
                    slot: 's6',
                    maxItems: 16,
                    maxBytes: 4096,
                    minItems: 2,
                  },
                  required: true,
                  defaultOptionIndex: 0,
                },
                {
                  kind: 'formField',
                  id: 'f2',
                  fieldType: 'toggle',
                  label: {
                    slot: 's7',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  required: false,
                  defaultBool: true,
                },
                {
                  kind: 'formField',
                  id: 'f3',
                  fieldType: 'text',
                  label: {
                    slot: 's8',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  placeholder: {
                    slot: 's9',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  required: false,
                  maxGraphemes: 256,
                  maxBytes: 1024,
                },
              ],
            },
          ],
          spacing: 'regular',
        },
        actions: [
          {
            id: 'a0',
            label: {
              slot: 's10',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'primary',
            requireBio: true,
          },
          {
            id: 'a1',
            label: {
              slot: 's11',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'decline',
            requireBio: false,
          },
        ],
      },
      sig: 'oC8jd4gyKgfutaAY9xgb_AJboKvXAIG41MSEWQh5_cDJ1PZ47RGqN53xnsXTgc7DJ1XjJGt5t04Hy6DXLMk3JA',
    },
  },
  {
    slug: 'deployment_gate',
    title: 'Deployment Gate',
    description: 'Production release promotion gate with warning alert, release metrics, artifact manifest, readiness checklist, and biometric sign-off.',
    templateId: 'tpl_7320257f323bb157a27a9f3eb40ca76a06a63b7cc3a6d877884f2450b68fb75a',
    kid: 'ta-catalog-v1',
    sig: 'EaACxVbr8keuOD-0vrfQQsDetvEJbH6e8oTdtu2SAOVyydMPncwrkVZ2emtBNz1i9k9Z4K1ImiGkpv6l-GUDxw',
    recordB64u: 'eyJraWQiOiJ0YS1jYXRhbG9nLXYxIiwic2lnIjoiRWFBQ3hWYnI4a2V1T0QtMHZyZlFRc0RldHZFSmJINmU4b1RkdHUyU0FPVnl5ZE1QbmN3cmtWWjJlbXRCTnoxaTlrOVo0SzFJbWlHa3B2NmwtR1VEeHciLCJza2VsZXRvbiI6eyJhY3Rpb25zIjpbeyJlbmFibGVkV2hlbiI6W3siY2hlY2tsaXN0IjoiYzAiLCJvcCI6ImFsbENoZWNrZWQifSx7ImZpZWxkIjoiZjAiLCJvcCI6ImVxdWFscyIsInZhbHVlIjp0cnVlfV0sImlkIjoiYTAiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MTI4LCJtYXhHcmFwaGVtZXMiOjMyLCJzbG90IjoiczEwIn0sInJlcXVpcmVCaW8iOnRydWUsInJvbGUiOiJwcmltYXJ5In0seyJpZCI6ImExIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMxMSJ9LCJyZXF1aXJlQmlvIjpmYWxzZSwicm9sZSI6InNlY29uZGFyeSJ9LHsiaWQiOiJhMiIsImxhYmVsIjp7Im1heEJ5dGVzIjoxMjgsIm1heEdyYXBoZW1lcyI6MzIsInNsb3QiOiJzMTIifSwicmVxdWlyZUJpbyI6ZmFsc2UsInJvbGUiOiJkZWNsaW5lIn1dLCJyb290Ijp7ImNoaWxkcmVuIjpbeyJjaGlsZHJlbiI6W3sia2luZCI6ImJhZGdlIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMxIn0sInRvbmUiOiJ3YXJuaW5nIn0seyJib2R5Ijp7Im1heEJ5dGVzIjoxMDI0LCJtYXhHcmFwaGVtZXMiOjI1Niwic2xvdCI6InMzIn0sImtpbmQiOiJhbGVydCIsInNldmVyaXR5Ijoid2FybmluZyIsInRpdGxlIjp7Im1heEJ5dGVzIjo1MTIsIm1heEdyYXBoZW1lcyI6MTI4LCJzbG90IjoiczIifX0seyJpdGVtcyI6eyJtYXhCeXRlcyI6MjA0OCwibWF4SXRlbXMiOjQsIm1pbkl0ZW1zIjoxLCJzbG90IjoiczQifSwia2luZCI6ImtwaVN0cmlwIn1dLCJoZWFkZXIiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InMwIn0sImtpbmQiOiJjYXJkIn0seyJjaGlsZHJlbiI6W3sia2luZCI6ImtleVZhbHVlTGlzdCIsInJvd3MiOnsibWF4Qnl0ZXMiOjgxOTIsIm1heEl0ZW1zIjoxNiwibWluSXRlbXMiOjEsInNsb3QiOiJzNiJ9fV0sImhlYWRlciI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczUifSwia2luZCI6ImNhcmQifSx7ImNoaWxkcmVuIjpbeyJpZCI6ImMwIiwiaXRlbXMiOnsibWF4Qnl0ZXMiOjQwOTYsIm1heEl0ZW1zIjo4LCJtaW5JdGVtcyI6MSwic2xvdCI6InM4In0sImtpbmQiOiJjaGVja2xpc3QifSx7ImtpbmQiOiJkaXZpZGVyIn0seyJkZWZhdWx0Qm9vbCI6ZmFsc2UsImZpZWxkVHlwZSI6InRvZ2dsZSIsImlkIjoiZjAiLCJraW5kIjoiZm9ybUZpZWxkIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM5In0sInJlcXVpcmVkIjp0cnVlfV0sImhlYWRlciI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczcifSwia2luZCI6ImNhcmQifV0sImtpbmQiOiJ2c3RhY2siLCJzcGFjaW5nIjoicmVndWxhciJ9LCJ2IjoxfSwidGVtcGxhdGVJZCI6InRwbF83MzIwMjU3ZjMyM2JiMTU3YTI3YTlmM2ViNDBjYTc2YTA2YTYzYjdjYzNhNmQ4Nzc4ODRmMjQ1MGI2OGZiNzVhIiwidiI6MX0',
    skeleton: {
      v: 1,
      root: {
        kind: 'vstack',
        children: [
          {
            kind: 'card',
            header: {
              slot: 's0',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'badge',
                tone: 'warning',
                label: {
                  slot: 's1',
                  maxGraphemes: 32,
                  maxBytes: 128,
                },
              },
              {
                kind: 'alert',
                severity: 'warning',
                title: {
                  slot: 's2',
                  maxGraphemes: 128,
                  maxBytes: 512,
                },
                body: {
                  slot: 's3',
                  maxGraphemes: 256,
                  maxBytes: 1024,
                },
              },
              {
                kind: 'kpiStrip',
                items: {
                  slot: 's4',
                  maxItems: 4,
                  maxBytes: 2048,
                  minItems: 1,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's5',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'keyValueList',
                rows: {
                  slot: 's6',
                  maxItems: 16,
                  maxBytes: 8192,
                  minItems: 1,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's7',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'checklist',
                id: 'c0',
                items: {
                  slot: 's8',
                  maxItems: 8,
                  maxBytes: 4096,
                  minItems: 1,
                },
              },
              {
                kind: 'divider',
              },
              {
                kind: 'formField',
                id: 'f0',
                fieldType: 'toggle',
                label: {
                  slot: 's9',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                required: true,
                defaultBool: false,
              },
            ],
          },
        ],
        spacing: 'regular',
      },
      actions: [
        {
          id: 'a0',
          label: {
            slot: 's10',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'primary',
          requireBio: true,
          enabledWhen: [
            {
              op: 'allChecked',
              checklist: 'c0',
            },
            {
              op: 'equals',
              field: 'f0',
              value: true,
            },
          ],
        },
        {
          id: 'a1',
          label: {
            slot: 's11',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'secondary',
          requireBio: false,
        },
        {
          id: 'a2',
          label: {
            slot: 's12',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'decline',
          requireBio: false,
        },
      ],
    },
    record: {
      v: 1,
      kid: 'ta-catalog-v1',
      templateId: 'tpl_7320257f323bb157a27a9f3eb40ca76a06a63b7cc3a6d877884f2450b68fb75a',
      skeleton: {
        v: 1,
        root: {
          kind: 'vstack',
          children: [
            {
              kind: 'card',
              header: {
                slot: 's0',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'badge',
                  tone: 'warning',
                  label: {
                    slot: 's1',
                    maxGraphemes: 32,
                    maxBytes: 128,
                  },
                },
                {
                  kind: 'alert',
                  severity: 'warning',
                  title: {
                    slot: 's2',
                    maxGraphemes: 128,
                    maxBytes: 512,
                  },
                  body: {
                    slot: 's3',
                    maxGraphemes: 256,
                    maxBytes: 1024,
                  },
                },
                {
                  kind: 'kpiStrip',
                  items: {
                    slot: 's4',
                    maxItems: 4,
                    maxBytes: 2048,
                    minItems: 1,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's5',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'keyValueList',
                  rows: {
                    slot: 's6',
                    maxItems: 16,
                    maxBytes: 8192,
                    minItems: 1,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's7',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'checklist',
                  id: 'c0',
                  items: {
                    slot: 's8',
                    maxItems: 8,
                    maxBytes: 4096,
                    minItems: 1,
                  },
                },
                {
                  kind: 'divider',
                },
                {
                  kind: 'formField',
                  id: 'f0',
                  fieldType: 'toggle',
                  label: {
                    slot: 's9',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  required: true,
                  defaultBool: false,
                },
              ],
            },
          ],
          spacing: 'regular',
        },
        actions: [
          {
            id: 'a0',
            label: {
              slot: 's10',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'primary',
            requireBio: true,
            enabledWhen: [
              {
                op: 'allChecked',
                checklist: 'c0',
              },
              {
                op: 'equals',
                field: 'f0',
                value: true,
              },
            ],
          },
          {
            id: 'a1',
            label: {
              slot: 's11',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'secondary',
            requireBio: false,
          },
          {
            id: 'a2',
            label: {
              slot: 's12',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'decline',
            requireBio: false,
          },
        ],
      },
      sig: 'EaACxVbr8keuOD-0vrfQQsDetvEJbH6e8oTdtu2SAOVyydMPncwrkVZ2emtBNz1i9k9Z4K1ImiGkpv6l-GUDxw',
    },
  },
  {
    slug: 'multi_choice_audit',
    title: 'Multi-Choice Audit',
    description: 'Structured compliance or security audit review with evidence rows, dual choice pickers, required auditor note, and attestation toggle.',
    templateId: 'tpl_33d53edadb953581c0d1dfe4c857c86c5a42d53e8dba668a4b091081057dbc99',
    kid: 'ta-catalog-v1',
    sig: '63AIuoM5lUM2TX-tF1TQGJ8mDGpxd5zbQJqHxswv2ApsLhkLFWoDlbd_-d_X43uhzSmRpHS7d1yPVk0XC7ZNew',
    recordB64u: 'eyJraWQiOiJ0YS1jYXRhbG9nLXYxIiwic2lnIjoiNjNBSXVvTTVsVU0yVFgtdEYxVFFHSjhtREdweGQ1emJRSnFIeHN3djJBcHNMaGtMRldvRGxiZF8tZF9YNDN1aHpTbVJwSFM3ZDF5UFZrMFhDN1pOZXciLCJza2VsZXRvbiI6eyJhY3Rpb25zIjpbeyJlbmFibGVkV2hlbiI6W3siZmllbGQiOiJmMiIsIm9wIjoiaXNOb3RFbXB0eSJ9LHsiZmllbGQiOiJmMyIsIm9wIjoiZXF1YWxzIiwidmFsdWUiOnRydWV9XSwiaWQiOiJhMCIsImxhYmVsIjp7Im1heEJ5dGVzIjoxMjgsIm1heEdyYXBoZW1lcyI6MzIsInNsb3QiOiJzMTMifSwicmVxdWlyZUJpbyI6dHJ1ZSwicm9sZSI6InByaW1hcnkifSx7ImVuYWJsZWRXaGVuIjpbeyJmaWVsZCI6ImYyIiwib3AiOiJpc05vdEVtcHR5In1dLCJpZCI6ImExIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMxNCJ9LCJyZXF1aXJlQmlvIjp0cnVlLCJyb2xlIjoiZGVzdHJ1Y3RpdmUifSx7ImlkIjoiYTIiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MTI4LCJtYXhHcmFwaGVtZXMiOjMyLCJzbG90IjoiczE1In0sInJlcXVpcmVCaW8iOmZhbHNlLCJyb2xlIjoiZGVjbGluZSJ9XSwicm9vdCI6eyJjaGlsZHJlbiI6W3siY2hpbGRyZW4iOlt7ImtpbmQiOiJoZWFkaW5nIiwibGV2ZWwiOjIsInRleHQiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InMxIn19LHsia2luZCI6ImJhZGdlIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjEyOCwibWF4R3JhcGhlbWVzIjozMiwic2xvdCI6InMyIn0sInRvbmUiOiJuZXV0cmFsIn0seyJraW5kIjoidGV4dCIsInN0eWxlIjoiYm9keSIsInRleHQiOnsibWF4Qnl0ZXMiOjIwNDgsIm1heEdyYXBoZW1lcyI6NTEyLCJzbG90IjoiczMifX0seyJraW5kIjoia2V5VmFsdWVMaXN0Iiwicm93cyI6eyJtYXhCeXRlcyI6ODE5MiwibWF4SXRlbXMiOjE2LCJtaW5JdGVtcyI6MSwic2xvdCI6InM0In19XSwiaGVhZGVyIjp7Im1heEJ5dGVzIjoyNTYsIm1heEdyYXBoZW1lcyI6NjQsInNsb3QiOiJzMCJ9LCJraW5kIjoiY2FyZCJ9LHsiY2hpbGRyZW4iOlt7ImRlZmF1bHRPcHRpb25JbmRleCI6LTEsImZpZWxkVHlwZSI6InBpY2tlciIsImlkIjoiZjAiLCJraW5kIjoiZm9ybUZpZWxkIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM2In0sIm9wdGlvbnMiOnsibWF4Qnl0ZXMiOjQwOTYsIm1heEl0ZW1zIjoxNiwibWluSXRlbXMiOjIsInNsb3QiOiJzNyJ9LCJyZXF1aXJlZCI6dHJ1ZX0seyJkZWZhdWx0T3B0aW9uSW5kZXgiOjAsImZpZWxkVHlwZSI6InBpY2tlciIsImlkIjoiZjEiLCJraW5kIjoiZm9ybUZpZWxkIiwibGFiZWwiOnsibWF4Qnl0ZXMiOjI1NiwibWF4R3JhcGhlbWVzIjo2NCwic2xvdCI6InM4In0sIm9wdGlvbnMiOnsibWF4Qnl0ZXMiOjIwNDgsIm1heEl0ZW1zIjo4LCJtaW5JdGVtcyI6Miwic2xvdCI6InM5In0sInJlcXVpcmVkIjp0cnVlfSx7ImZpZWxkVHlwZSI6InRleHQiLCJpZCI6ImYyIiwia2luZCI6ImZvcm1GaWVsZCIsImxhYmVsIjp7Im1heEJ5dGVzIjoyNTYsIm1heEdyYXBoZW1lcyI6NjQsInNsb3QiOiJzMTAifSwibWF4Qnl0ZXMiOjIwNDgsIm1heEdyYXBoZW1lcyI6NTEyLCJwbGFjZWhvbGRlciI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczExIn0sInJlcXVpcmVkIjp0cnVlfSx7ImRlZmF1bHRCb29sIjpmYWxzZSwiZmllbGRUeXBlIjoidG9nZ2xlIiwiaWQiOiJmMyIsImtpbmQiOiJmb3JtRmllbGQiLCJsYWJlbCI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczEyIn0sInJlcXVpcmVkIjp0cnVlfV0sImhlYWRlciI6eyJtYXhCeXRlcyI6MjU2LCJtYXhHcmFwaGVtZXMiOjY0LCJzbG90IjoiczUifSwia2luZCI6ImNhcmQifV0sImtpbmQiOiJ2c3RhY2siLCJzcGFjaW5nIjoicmVndWxhciJ9LCJ2IjoxfSwidGVtcGxhdGVJZCI6InRwbF8zM2Q1M2VkYWRiOTUzNTgxYzBkMWRmZTRjODU3Yzg2YzVhNDJkNTNlOGRiYTY2OGE0YjA5MTA4MTA1N2RiYzk5IiwidiI6MX0',
    skeleton: {
      v: 1,
      root: {
        kind: 'vstack',
        children: [
          {
            kind: 'card',
            header: {
              slot: 's0',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'heading',
                level: 2,
                text: {
                  slot: 's1',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
              },
              {
                kind: 'badge',
                tone: 'neutral',
                label: {
                  slot: 's2',
                  maxGraphemes: 32,
                  maxBytes: 128,
                },
              },
              {
                kind: 'text',
                style: 'body',
                text: {
                  slot: 's3',
                  maxGraphemes: 512,
                  maxBytes: 2048,
                },
              },
              {
                kind: 'keyValueList',
                rows: {
                  slot: 's4',
                  maxItems: 16,
                  maxBytes: 8192,
                  minItems: 1,
                },
              },
            ],
          },
          {
            kind: 'card',
            header: {
              slot: 's5',
              maxGraphemes: 64,
              maxBytes: 256,
            },
            children: [
              {
                kind: 'formField',
                id: 'f0',
                fieldType: 'picker',
                label: {
                  slot: 's6',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                options: {
                  slot: 's7',
                  maxItems: 16,
                  maxBytes: 4096,
                  minItems: 2,
                },
                required: true,
                defaultOptionIndex: -1,
              },
              {
                kind: 'formField',
                id: 'f1',
                fieldType: 'picker',
                label: {
                  slot: 's8',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                options: {
                  slot: 's9',
                  maxItems: 8,
                  maxBytes: 2048,
                  minItems: 2,
                },
                required: true,
                defaultOptionIndex: 0,
              },
              {
                kind: 'formField',
                id: 'f2',
                fieldType: 'text',
                label: {
                  slot: 's10',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                placeholder: {
                  slot: 's11',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                required: true,
                maxGraphemes: 512,
                maxBytes: 2048,
              },
              {
                kind: 'formField',
                id: 'f3',
                fieldType: 'toggle',
                label: {
                  slot: 's12',
                  maxGraphemes: 64,
                  maxBytes: 256,
                },
                required: true,
                defaultBool: false,
              },
            ],
          },
        ],
        spacing: 'regular',
      },
      actions: [
        {
          id: 'a0',
          label: {
            slot: 's13',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'primary',
          requireBio: true,
          enabledWhen: [
            {
              op: 'isNotEmpty',
              field: 'f2',
            },
            {
              op: 'equals',
              field: 'f3',
              value: true,
            },
          ],
        },
        {
          id: 'a1',
          label: {
            slot: 's14',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'destructive',
          requireBio: true,
          enabledWhen: [
            {
              op: 'isNotEmpty',
              field: 'f2',
            },
          ],
        },
        {
          id: 'a2',
          label: {
            slot: 's15',
            maxGraphemes: 32,
            maxBytes: 128,
          },
          role: 'decline',
          requireBio: false,
        },
      ],
    },
    record: {
      v: 1,
      kid: 'ta-catalog-v1',
      templateId: 'tpl_33d53edadb953581c0d1dfe4c857c86c5a42d53e8dba668a4b091081057dbc99',
      skeleton: {
        v: 1,
        root: {
          kind: 'vstack',
          children: [
            {
              kind: 'card',
              header: {
                slot: 's0',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'heading',
                  level: 2,
                  text: {
                    slot: 's1',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                },
                {
                  kind: 'badge',
                  tone: 'neutral',
                  label: {
                    slot: 's2',
                    maxGraphemes: 32,
                    maxBytes: 128,
                  },
                },
                {
                  kind: 'text',
                  style: 'body',
                  text: {
                    slot: 's3',
                    maxGraphemes: 512,
                    maxBytes: 2048,
                  },
                },
                {
                  kind: 'keyValueList',
                  rows: {
                    slot: 's4',
                    maxItems: 16,
                    maxBytes: 8192,
                    minItems: 1,
                  },
                },
              ],
            },
            {
              kind: 'card',
              header: {
                slot: 's5',
                maxGraphemes: 64,
                maxBytes: 256,
              },
              children: [
                {
                  kind: 'formField',
                  id: 'f0',
                  fieldType: 'picker',
                  label: {
                    slot: 's6',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  options: {
                    slot: 's7',
                    maxItems: 16,
                    maxBytes: 4096,
                    minItems: 2,
                  },
                  required: true,
                  defaultOptionIndex: -1,
                },
                {
                  kind: 'formField',
                  id: 'f1',
                  fieldType: 'picker',
                  label: {
                    slot: 's8',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  options: {
                    slot: 's9',
                    maxItems: 8,
                    maxBytes: 2048,
                    minItems: 2,
                  },
                  required: true,
                  defaultOptionIndex: 0,
                },
                {
                  kind: 'formField',
                  id: 'f2',
                  fieldType: 'text',
                  label: {
                    slot: 's10',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  placeholder: {
                    slot: 's11',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  required: true,
                  maxGraphemes: 512,
                  maxBytes: 2048,
                },
                {
                  kind: 'formField',
                  id: 'f3',
                  fieldType: 'toggle',
                  label: {
                    slot: 's12',
                    maxGraphemes: 64,
                    maxBytes: 256,
                  },
                  required: true,
                  defaultBool: false,
                },
              ],
            },
          ],
          spacing: 'regular',
        },
        actions: [
          {
            id: 'a0',
            label: {
              slot: 's13',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'primary',
            requireBio: true,
            enabledWhen: [
              {
                op: 'isNotEmpty',
                field: 'f2',
              },
              {
                op: 'equals',
                field: 'f3',
                value: true,
              },
            ],
          },
          {
            id: 'a1',
            label: {
              slot: 's14',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'destructive',
            requireBio: true,
            enabledWhen: [
              {
                op: 'isNotEmpty',
                field: 'f2',
              },
            ],
          },
          {
            id: 'a2',
            label: {
              slot: 's15',
              maxGraphemes: 32,
              maxBytes: 128,
            },
            role: 'decline',
            requireBio: false,
          },
        ],
      },
      sig: '63AIuoM5lUM2TX-tF1TQGJ8mDGpxd5zbQJqHxswv2ApsLhkLFWoDlbd_-d_X43uhzSmRpHS7d1yPVk0XC7ZNew',
    },
  },
];

export const SCREEN_CATALOG_BY_SLUG: Readonly<Record<ScreenCatalogSlug, ScreenCatalogEntry>> = {
  db_migration_approval: SCREEN_CATALOG[0]!,
  incident_triage: SCREEN_CATALOG[1]!,
  code_review_form: SCREEN_CATALOG[2]!,
  kpi_status_card: SCREEN_CATALOG[3]!,
  action_checklist: SCREEN_CATALOG[4]!,
  parameter_tuning_form: SCREEN_CATALOG[5]!,
  deployment_gate: SCREEN_CATALOG[6]!,
  multi_choice_audit: SCREEN_CATALOG[7]!,
};

export const SCREEN_CATALOG_BY_TEMPLATE_ID: Readonly<Record<string, ScreenCatalogEntry>> = Object.fromEntries(
  SCREEN_CATALOG.map((entry) => [entry.templateId, entry])
);

export function getScreenTaPublicKey(kid: string): ScreenTaPublicKey | undefined {
  if (Object.prototype.hasOwnProperty.call(SCREEN_TA_PUBLIC_KEYS, kid)) {
    return SCREEN_TA_PUBLIC_KEYS[kid];
  }
  return undefined;
}

export function getScreenCatalogBySlug(slug: string): ScreenCatalogEntry | undefined {
  if (Object.prototype.hasOwnProperty.call(SCREEN_CATALOG_BY_SLUG, slug)) {
    return SCREEN_CATALOG_BY_SLUG[slug as ScreenCatalogSlug];
  }
  return undefined;
}

export function getScreenCatalogByTemplateId(templateId: string): ScreenCatalogEntry | undefined {
  if (Object.prototype.hasOwnProperty.call(SCREEN_CATALOG_BY_TEMPLATE_ID, templateId)) {
    return SCREEN_CATALOG_BY_TEMPLATE_ID[templateId];
  }
  return undefined;
}
