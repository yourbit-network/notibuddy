import { MAX_ACTIVITY_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS, requestTimeoutSeconds } from './request-timeout.js';
import { answerSchema } from './answer-validation.js';
import { z } from 'zod';
import { normalizeRelay } from './relay-url.js';
import { firstUseSchema, validateFirstUse } from './pairing-invitation.js';
import {
  RequestEnvelope,
  ReplyEnvelope,
  ErrorEnvelope,
  AskPayload,
  ActivityPayload,
  AnswerPayload,
  PairingBundle,
  PrimitiveType,
  ErrorCode,
} from './types.js';
import {
  toB64u,
  fromB64u,
  hpkeSeal,
  hpkeOpen,
  ecdsaSign,
  ecdsaVerify,
  deriveDeviceId,
  isValidP256PublicKey,
} from './crypto.js';

const encoder = new TextEncoder();

export function validateIdentifier(id: string, name: string): void {
  if (typeof id!=='string' || /^[A-Za-z0-9_-]{1,64}$/.exec(id)?.[0]!==id) {
    throw new Error(`Invalid ${name}: must match ^[A-Za-z0-9_-]{1,64}$`);
  }
}

/**
 * Builds request header string:
 * "nb1|request|" + requestId + "|" + deviceId + "|" + senderKeyId + "|" + primitive + "|" + createdAt + "|" + expiresAt
 */
export function buildRequestHeader(
  requestId: string,
  deviceId: string,
  senderKeyId: string,
  primitive: PrimitiveType,
  createdAt: number,
  expiresAt: number
): string {
  validateIdentifier(requestId, 'requestId');
  validateIdentifier(deviceId, 'deviceId');
  validateIdentifier(senderKeyId, 'senderKeyId');
  validateIdentifier(primitive, 'primitive');
  return `nb1|request|${requestId}|${deviceId}|${senderKeyId}|${primitive}|${createdAt}|${expiresAt}`;
}

/**
 * Seals a Request Envelope according to Section 5 of PROTOCOL.md
 */
export async function sealRequest(params: {
  requestId: string;
  deviceId: string;
  senderKeyId: string;
  senderSigningPrivateKey: CryptoKey;
  deviceEncryptionPublicKey: string; // DE.pub in Base64url
  primitive: PrimitiveType;
  payload: AskPayload | ActivityPayload;
  timeoutSeconds?: number;
}): Promise<RequestEnvelope> {
  const now = Math.floor(Date.now() / 1000);
  // Low-level activity calls retain their existing default; client.activity supplies one hour.
  const activity = params.primitive.startsWith('activity_');
  const timeout = requestTimeoutSeconds(params.timeoutSeconds, activity ? 300 : undefined,
    activity ? MAX_ACTIVITY_TIMEOUT_SECONDS : MAX_REQUEST_TIMEOUT_SECONDS);
  const createdAt = now;
  const expiresAt = now + timeout;

  const header = buildRequestHeader(
    params.requestId,
    params.deviceId,
    params.senderKeyId,
    params.primitive,
    createdAt,
    expiresAt
  );

  const payloadJson = JSON.stringify(params.payload);
  if(encoder.encode(payloadJson).length>149984)throw Error('Encrypted content exceeds the request limit');
  const { enc, ct } = await hpkeSeal(
    params.deviceEncryptionPublicKey,
    'notibuddy/v1/request',
    header,
    payloadJson
  );

  // sig = ECDSA-Sign(SS, UTF-8(header) ‖ 0x00 ‖ enc ‖ ct)
  const headerBytes = encoder.encode(header);
  const encBytes = fromB64u(enc);
  const ctBytes = fromB64u(ct);

  const signBuffer = new Uint8Array(headerBytes.length + 1 + encBytes.length + ctBytes.length);
  let offset = 0;
  signBuffer.set(headerBytes, offset); offset += headerBytes.length;
  signBuffer[offset] = 0x00; offset += 1;
  signBuffer.set(encBytes, offset); offset += encBytes.length;
  signBuffer.set(ctBytes, offset);

  const sig = await ecdsaSign(params.senderSigningPrivateKey, signBuffer);

  return {
    v: 1,
    kind: 'request',
    requestId: params.requestId,
    deviceId: params.deviceId,
    senderKeyId: params.senderKeyId,
    primitive: params.primitive,
    createdAt,
    expiresAt,
    enc,
    ct,
    sig,
  };
}

/**
 * Builds reply header string:
 * "nb1|reply|" + requestId + "|" + deviceId + "|" + createdAt
 */
export function buildReplyHeader(
  requestId: string,
  deviceId: string,
  createdAt: number
): string {
  validateIdentifier(requestId, 'requestId');
  validateIdentifier(deviceId, 'deviceId');
  return `nb1|reply|${requestId}|${deviceId}|${createdAt}`;
}

/**
 * Seals a Reply Envelope according to Section 6 of PROTOCOL.md (Device -> Sender)
 */
export async function sealReply(params: {
  requestId: string;
  deviceId: string;
  deviceSigningPrivateKey: CryptoKey;
  replyPublicKey: string; // R.pub in Base64url
  answer: AnswerPayload;
  createdAt?: number;
}): Promise<ReplyEnvelope> {
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const header = buildReplyHeader(params.requestId, params.deviceId, createdAt);

  const answerJson = JSON.stringify(params.answer);
  const { enc, ct } = await hpkeSeal(
    params.replyPublicKey,
    'notibuddy/v1/reply',
    header,
    answerJson
  );

  // sig = ECDSA-Sign(DS, UTF-8(header) ‖ 0x00 ‖ enc ‖ ct)
  const headerBytes = encoder.encode(header);
  const encBytes = fromB64u(enc);
  const ctBytes = fromB64u(ct);

  const signBuffer = new Uint8Array(headerBytes.length + 1 + encBytes.length + ctBytes.length);
  let offset = 0;
  signBuffer.set(headerBytes, offset); offset += headerBytes.length;
  signBuffer[offset] = 0x00; offset += 1;
  signBuffer.set(encBytes, offset); offset += encBytes.length;
  signBuffer.set(ctBytes, offset);

  const sig = await ecdsaSign(params.deviceSigningPrivateKey, signBuffer);

  return {
    v: 1,
    kind: 'reply',
    requestId: params.requestId,
    deviceId: params.deviceId,
    createdAt,
    enc,
    ct,
    sig,
  };
}

/**
 * Opens and verifies a Reply Envelope according to Section 6 of PROTOCOL.md
 * The expected ID must come from saved request state, never from the response.
 * Callers also enforce the original request lifetime and single-answer policy.
 */
export async function openReply(params: {
  envelope: ReplyEnvelope;
  replyPrivateKey: CryptoKey;
  expectedRequestId: string;
  expectedDeviceId: string;
  deviceSigningPublicKey: string; // DS.pub in Base64url
}): Promise<AnswerPayload> {
  const { replyPrivateKey, expectedRequestId, expectedDeviceId, deviceSigningPublicKey } = params;
  const envelope=structuredClone(params.envelope);
  validateResponseWire(envelope);
  validateIdentifier(expectedRequestId, 'expectedRequestId');
  if (envelope.requestId !== expectedRequestId) throw new Error('Request ID mismatch on reply envelope');

  if (envelope.v !== 1 || envelope.kind !== 'reply') {
    throw new Error(`Unsupported envelope: v=${envelope.v}, kind=${envelope.kind}`);
  }

  if (envelope.deviceId !== expectedDeviceId) {
    throw new Error(`Device ID mismatch: got ${envelope.deviceId}, expected ${expectedDeviceId}`);
  }

  const header = buildReplyHeader(envelope.requestId, envelope.deviceId, envelope.createdAt);
  const headerBytes = encoder.encode(header);
  const encBytes = fromB64u(envelope.enc);
  const ctBytes = fromB64u(envelope.ct);

  const signBuffer = new Uint8Array(headerBytes.length + 1 + encBytes.length + ctBytes.length);
  let offset = 0;
  signBuffer.set(headerBytes, offset); offset += headerBytes.length;
  signBuffer[offset] = 0x00; offset += 1;
  signBuffer.set(encBytes, offset); offset += encBytes.length;
  signBuffer.set(ctBytes, offset);

  // Verify signature under pinned device public key
  const validSig = await ecdsaVerify(deviceSigningPublicKey, signBuffer, envelope.sig);
  if (!validSig) {
    throw new Error('Device signature verification failed on reply envelope');
  }

  // Open HPKE ciphertext
  const answerJson = await hpkeOpen(
    replyPrivateKey,
    envelope.enc,
    'notibuddy/v1/reply',
    header,
    envelope.ct
  );

  return answerSchema.parse(JSON.parse(answerJson));
}

/**
 * Builds error header string:
 * "nb1|error|" + requestId + "|" + deviceId + "|" + createdAt + "|" + code
 */
export function buildErrorHeader(
  requestId: string,
  deviceId: string,
  createdAt: number,
  code: ErrorCode
): string {
  validateIdentifier(requestId, 'requestId');
  validateIdentifier(deviceId, 'deviceId');
  validateIdentifier(code, 'code');
  return `nb1|error|${requestId}|${deviceId}|${createdAt}|${code}`;
}

/**
 * Opens and verifies an Error Envelope according to Section 7 of PROTOCOL.md
 * The expected ID must come from saved request state, never from the response.
 * Callers also enforce the original request lifetime and terminal-state policy.
 */
export async function openError(params: {
  envelope: ErrorEnvelope;
  expectedRequestId: string;
  expectedDeviceId: string;
  deviceSigningPublicKey: string;
}): Promise<ErrorCode> {
  const { expectedRequestId, expectedDeviceId, deviceSigningPublicKey } = params;
  const envelope=structuredClone(params.envelope);
  validateResponseWire(envelope);
  validateIdentifier(expectedRequestId, 'expectedRequestId');
  if (envelope.requestId !== expectedRequestId) throw new Error('Request ID mismatch on error envelope');

  if (envelope.v !== 1 || envelope.kind !== 'error') {
    throw new Error(`Unsupported envelope: v=${envelope.v}, kind=${envelope.kind}`);
  }

  if (envelope.deviceId !== expectedDeviceId) {
    throw new Error(`Device ID mismatch: got ${envelope.deviceId}, expected ${expectedDeviceId}`);
  }

  const header = buildErrorHeader(
    envelope.requestId,
    envelope.deviceId,
    envelope.createdAt,
    envelope.code
  );

  const headerBytes = encoder.encode(header);
  const signBuffer = new Uint8Array(headerBytes.length + 1);
  signBuffer.set(headerBytes, 0);
  signBuffer[headerBytes.length] = 0x00;

  const validSig = await ecdsaVerify(deviceSigningPublicKey, signBuffer, envelope.sig);
  if (!validSig) {
    throw new Error('Device signature verification failed on error envelope');
  }

  return envelope.code;
}

/**
 * Parses and verifies an out-of-band Pairing Bundle (nbpair1.<b64u>)
 */
export async function parsePairingBundle(bundleString: string): Promise<PairingBundle> {
  if (typeof bundleString !== 'string' || bundleString.length > 32768) throw new Error('Pairing data is too large or is not text');
  const trimmed = bundleString.trim();
  if (!trimmed.startsWith('nbpair1.')) {
    throw new Error('Invalid pairing bundle: must start with "nbpair1."');
  }

  const rawBytes = pairingBytes(trimmed.slice('nbpair1.'.length), 1, 16384);
  let json: string, value: unknown;
  try { json = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes); }
  catch { throw new Error('Pairing data must be valid UTF-8'); }
  try { value = JSON.parse(json); }
  catch { throw new Error('Pairing data must be valid JSON'); }
  return validatePairingBundle(value);
}

const pairingSchema = z.object({
  v: z.literal(1), relay: z.string().min(1).max(2048).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  token: z.string().max(263).refine(value => /^nb_snd_[A-Za-z0-9_-]{1,256}$/.exec(value)?.[0] === value),
  pairSecret: z.string().max(43),
  device: z.object({ id: z.string().max(64), encPub: z.string().max(87), sigPub: z.string().max(87),
    name: z.string().max(256).refine(value => Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)).optional(),
  }).strict(),
  requestProtocol: z.union([z.literal(1), z.literal(2)]).optional(),
  minimumRecipientGeneration: z.number().int().safe().nonnegative().optional(),
  firstUse: firstUseSchema.optional(),
}).strict();

function pairingBytes(value: string, min: number, max: number): Uint8Array {
  if (value.length > Math.ceil(max * 4 / 3) || /^[A-Za-z0-9_-]+$/.exec(value)?.[0] !== value) throw new Error('Invalid pairing encoding or data too large');
  const bytes = fromB64u(value);
  if (bytes.length < min || bytes.length > max || toB64u(bytes) !== value) throw new Error('Invalid pairing encoding or data too large');
  return bytes;
}

/** Validate and snapshot typed or decoded pairing data before any destination write. */
export async function validatePairingBundle(value: unknown): Promise<PairingBundle> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed pairing bundle');
  validateRequestSettings(value as Record<string, unknown>);
  const parsed = pairingSchema.safeParse(value);
  if (!parsed.success) throw new Error('Malformed pairing bundle: share fresh setup data from NotiBuddy');
  const bundle = parsed.data;
  bundle.relay = normalizeRelay(bundle.relay);
  if (bundle.relay.length > 2048) throw new Error('Pairing relay URL is too long');
  pairingBytes(bundle.pairSecret, 32, 32);

  if (!isValidP256PublicKey(bundle.device.encPub)) {
    throw new Error('Invalid device encryption public key: must be a canonical uncompressed P-256 point');
  }

  if (!isValidP256PublicKey(bundle.device.sigPub)) {
    throw new Error('Invalid device signing public key: must be a canonical uncompressed P-256 point');
  }

  // MUST verify deviceId == "dev_" + hex(SHA256(DE.pub || DS.pub))[0:24]
  const expectedDeviceId = await deriveDeviceId(bundle.device.encPub, bundle.device.sigPub);
  if (bundle.device.id !== expectedDeviceId) {
    throw new Error('Pairing security failure: device ID does not match its public keys');
  }

  if (bundle.firstUse) {
    if (bundle.requestProtocol !== 2) throw new Error('First-use pairing requires the current request protocol');
    bundle.firstUse = validateFirstUse(bundle.firstUse, bundle);
  }

  return bundle;
}

/** Protocol upgrades are explicit pairing data; network failures never downgrade them. */
export function validateRequestSettings(value:{requestProtocol?:unknown;minimumRecipientGeneration?:unknown}):void {
  if(value.requestProtocol!==undefined && value.requestProtocol!==1 && value.requestProtocol!==2)throw Error('Unsupported request protocol; update the client before pairing');
  if(value.minimumRecipientGeneration!==undefined && (value.requestProtocol!==2 || !Number.isSafeInteger(value.minimumRecipientGeneration) || (value.minimumRecipientGeneration as number)<0))throw Error('Invalid minimum recipient generation');
}

function validateResponseWire(value:ReplyEnvelope|ErrorEnvelope):void {
  if(!value || typeof value!=='object')throw Error('Invalid response envelope');
  const fields=value.kind==='reply'?'createdAt,ct,deviceId,enc,kind,requestId,sig,v':'code,createdAt,deviceId,kind,requestId,sig,v';
  const binary=(v:unknown,min:number,max:number)=>typeof v==='string' && v.length<=200000 && /^[A-Za-z0-9_-]+$/.exec(v)?.[0]===v && fromB64u(v).length>=min && fromB64u(v).length<=max && toB64u(fromB64u(v))===v;
  const sequence=(value as typeof value & {seq?:number}).seq;
  if(sequence!==undefined && (!Number.isSafeInteger(sequence) || sequence<1))throw Error('Invalid response sequence');
  if(Object.keys(value).filter(key=>key!=='seq').sort().join(',')!==fields || value.v!==1 || !['reply','error'].includes(value.kind) ||
    !Number.isSafeInteger(value.createdAt) || value.createdAt<1 || !binary(value.sig,64,64))throw Error('Invalid response envelope');
  validateIdentifier(value.requestId,'requestId');validateIdentifier(value.deviceId,'deviceId');
  if(value.kind==='reply') {
    if(!binary(value.enc,65,65) || fromB64u(value.enc)[0]!==4 || !binary(value.ct,16,150000))throw Error('Invalid response ciphertext');
  }else if(!['undecryptable','bad_signature','unknown_sender','expired','replayed','unsupported','wrong_device'].includes(value.code))throw Error('Invalid response error code');
}
