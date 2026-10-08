/**
 * NotiBuddy Protocol v1 Types
 * Normative according to PROTOCOL.md
 */

export type PrimitiveType =
  | 'approval'
  | 'text_input'
  | 'form'
  | 'activity_start'
  | 'activity_update'
  | 'activity_end';

export interface FormFieldOption {
  id: string;
  label: string;
}

export interface FormField {
  id: string;
  type: 'text' | 'email' | 'url' | 'toggle' | 'stepper' | 'picker' | 'date';
  label: string;
  placeholder?: string;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  options?: FormFieldOption[];
}

export interface PresentationHints {
  shortTitle?: string;
  summary?: string;
}

export interface AskPayload {
  presentation?: PresentationHints;
  sensitive?: boolean;
  type: 'ask';
  replyPub: string; // Base64url SEC1 uncompressed P-256 public key (65 bytes)
  title: string;
  message?: string;
  options?: string[];
  inputPlaceholder?: string;
  fields?: FormField[];
  requiresAuth?: boolean;
}

export interface ActivityPayload {
  presentation?: PresentationHints;
  sensitive?: boolean;
  type: 'activity';
  action?: 'start' | 'update' | 'end';
  revision?: number;
  primitive?: 'timer' | 'stepper';
  controls?: string[];
  replyPub?: string;
  activityId: string;
  title: string;
  status?: string;
  step?: number;
  totalSteps?: number;
  timerEndsAt?: number;
  state?: 'running' | 'paused' | 'cancelled';
  remainingSeconds?: number;
}

export type Payload = AskPayload | ActivityPayload;

export interface RequestEnvelope {
  v: 1;
  kind: 'request';
  requestId: string;
  deviceId: string;
  senderKeyId: string;
  primitive: PrimitiveType;
  createdAt: number;
  expiresAt: number;
  enc: string; // Base64url 65-byte uncompressed point
  ct: string;  // Base64url ciphertext + auth tag
  sig: string; // Base64url 64-byte raw r||s signature
}

export interface AnswerPayload {
  action: string;
  text?: string;
  values?: Record<string, unknown>;
  authenticated?: boolean;
}

export interface ReplyEnvelope {
  v: 1;
  kind: 'reply';
  requestId: string;
  deviceId: string;
  createdAt: number;
  enc: string; // Base64url 65-byte uncompressed point
  ct: string;  // Base64url ciphertext + auth tag
  sig: string; // Base64url 64-byte raw r||s signature
}

export type ErrorCode =
  | 'undecryptable'
  | 'bad_signature'
  | 'unknown_sender'
  | 'expired'
  | 'replayed'
  | 'unsupported'
  | 'wrong_device';

export interface ErrorEnvelope {
  v: 1;
  kind: 'error';
  requestId: string;
  deviceId: string;
  createdAt: number;
  code: ErrorCode;
  sig: string; // Base64url 64-byte raw r||s signature
}

export type ResponseEnvelope = ReplyEnvelope | ErrorEnvelope;

export interface DeviceInfo {
  id: string;
  encPub: string;
  sigPub: string;
  name?: string;
}

export interface PairingBundle {
  v: 1;
  relay: string;
  token: string;
  device: DeviceInfo;
  pairSecret: string;
}

export interface SenderRegistrationPayload {
  senderKeyId: string;
  senderPub: string;
  label: string;
  mac: string;
}

export interface DeviceRegistrationPayload {
  deviceId: string;
  encPub: string;
  sigPub: string;
  apnsToken?: string;
  pushToStartToken?: string;
  pushEnvironment?: 'sandbox' | 'production';
}

export interface NotiBuddyConfig {
  relay: string;
  token: string;
  device: DeviceInfo;
  senderKeyId: string;
  senderLabel: string;
}

export interface SenderKeyPair {
  senderKeyId: string;
  publicKeyB64u: string;
  privateKeyJwk: JsonWebKey;
}
