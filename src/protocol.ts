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
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
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
  const timeout = params.timeoutSeconds ?? 300;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('timeoutSeconds must be between 1 and 3600');
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
 */
export async function openReply(params: {
  envelope: ReplyEnvelope;
  replyPrivateKey: CryptoKey;
  expectedDeviceId: string;
  deviceSigningPublicKey: string; // DS.pub in Base64url
}): Promise<AnswerPayload> {
  const { envelope, replyPrivateKey, expectedDeviceId, deviceSigningPublicKey } = params;

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

  return JSON.parse(answerJson) as AnswerPayload;
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
 */
export async function openError(params: {
  envelope: ErrorEnvelope;
  expectedDeviceId: string;
  deviceSigningPublicKey: string;
}): Promise<ErrorCode> {
  const { envelope, expectedDeviceId, deviceSigningPublicKey } = params;

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
  const trimmed = bundleString.trim();
  if (!trimmed.startsWith('nbpair1.')) {
    throw new Error('Invalid pairing bundle: must start with "nbpair1."');
  }

  const payloadB64u = trimmed.slice('nbpair1.'.length);
  const rawBytes = fromB64u(payloadB64u);
  const jsonStr = new TextDecoder().decode(rawBytes);
  const bundle = JSON.parse(jsonStr) as PairingBundle;

  const relay = new URL(bundle.relay);
  if (relay.protocol !== 'https:' && !(relay.protocol === 'http:' && ['localhost','127.0.0.1'].includes(relay.hostname))) throw new Error('Pairing requires an HTTPS relay');
  if (relay.username || relay.password || relay.search || relay.hash) throw new Error('Invalid relay URL');
  if (typeof bundle.pairSecret !== 'string' || fromB64u(bundle.pairSecret).length !== 32) throw new Error('Pairing secret must contain 32 bytes');
  if (bundle.v !== 1) {
    throw new Error(`Unsupported pairing bundle version: ${bundle.v}`);
  }

  if (!bundle.relay || !bundle.token || !bundle.device || !bundle.pairSecret) {
    throw new Error('Malformed pairing bundle: missing required fields');
  }

  if (!isValidP256PublicKey(bundle.device.encPub)) {
    throw new Error('Invalid device encryption public key: must be 65-byte uncompressed point');
  }

  if (!isValidP256PublicKey(bundle.device.sigPub)) {
    throw new Error('Invalid device signing public key: must be 65-byte uncompressed point');
  }

  // MUST verify deviceId == "dev_" + hex(SHA256(DE.pub || DS.pub))[0:24]
  const expectedDeviceId = await deriveDeviceId(bundle.device.encPub, bundle.device.sigPub);
  if (bundle.device.id !== expectedDeviceId) {
    throw new Error(
      `Pairing security failure: Device ID ${bundle.device.id} does not match derived ID ${expectedDeviceId}`
    );
  }

  return bundle;
}
