import { createECDH, createHash, createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { isValidP256PublicKey } from './crypto.js';
import { normalizeRelay } from './relay-url.js';
import type { FirstUsePairing, PairingBundle, PairingClaimProof, PairingInvitation, SenderRegistrationPayload } from './types.js';

const hex = (prefix: string, size: number) => z.string().length(prefix.length + size).regex(new RegExp(`^${prefix}[a-f0-9]{${size}}$`));
const binary = (size: number) => z.string().max(Math.ceil(size * 4 / 3)).refine(value =>
  /^[A-Za-z0-9_-]+$/.exec(value)?.[0] === value && Buffer.from(value, 'base64url').length === size && Buffer.from(value, 'base64url').toString('base64url') === value);
const publicKey = binary(65).refine(isValidP256PublicKey);
export const firstUseSchema = z.object({
  invitation: z.object({
    v: z.literal(1), id: hex('pin_', 32), accountId: hex('', 32), deviceId: hex('dev_', 24),
    devicePub: publicKey, relay: z.string().min(1).max(2048), publicKey,
    createdAt: z.number().int().safe().positive(), expiresAt: z.number().int().safe().positive(),
  }).strict(),
  privateKey: binary(32),
}).strict();
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new Error('Invalid first-use pairing code. Share fresh setup from NotiBuddy.');
type Scope = Pick<PairingBundle, 'relay' | 'token' | 'device'>;

/** Strict snapshot and binding checks before a destination write or relay call.
 * Expired codes retain ordinary manual pairing; future issues are not trusted. */
export function validateFirstUse(value: unknown, scope: Scope, now = Date.now()): FirstUsePairing {
  const parsed = firstUseSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const result = parsed.data, i = result.invitation;
  try {
    const url = new URL(i.relay);
    if (i.relay !== url.origin || url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) ||
        i.relay !== normalizeRelay(scope.relay) || /^nb_snd_[A-Za-z0-9_-]{1,256}$/.exec(scope.token)?.[0] !== scope.token ||
        i.accountId !== digest(scope.token.slice(7)).slice(0, 32) || i.deviceId !== scope.device.id || i.devicePub !== scope.device.sigPub ||
        i.id !== 'pin_' + digest(Buffer.from(i.publicKey, 'base64url')).slice(0, 32) ||
        i.expiresAt <= i.createdAt || i.expiresAt - i.createdAt > 600_000 || !Number.isFinite(now) || i.createdAt > now + 120_000) throw invalid();
    const key = createECDH('prime256v1'); key.setPrivateKey(Buffer.from(result.privateKey, 'base64url'));
    if (key.getPublicKey().toString('base64url') !== i.publicKey) throw invalid();
  } catch { throw invalid(); }
  return result;
}

export function pairingRegistrationHash(r: SenderRegistrationPayload): string {
  if (!/^snd_[a-f0-9]{24}$/.test(r.senderKeyId) || r.senderKeyId.length !== 28 ||
      !isValidP256PublicKey(r.senderPub) || r.senderKeyId !== 'snd_' + digest(Buffer.from(r.senderPub, 'base64url')).slice(0, 24) ||
      typeof r.label !== 'string' || r.label.length > 200 || !binary(32).safeParse(r.mac).success ||
      !r.fileEncPub || !isValidP256PublicKey(r.fileEncPub) || !r.fileDeviceId || !/^dev_[a-f0-9]{24}$/.test(r.fileDeviceId) || r.fileDeviceId.length !== 28) throw invalid();
  return digest(Buffer.concat([Buffer.from(`nb2|sender-registration|${r.senderKeyId}|${r.fileDeviceId}`), Buffer.from([0]),
    Buffer.from(r.senderPub, 'base64url'), Buffer.from(r.mac, 'base64url'), Buffer.from(r.fileEncPub, 'base64url'),
    Buffer.from([0]), Buffer.from(r.label)]));
}

export function pairingClaimInput(i: PairingInvitation, hash: string): Buffer {
  return Buffer.from(JSON.stringify(['nb2', 'pairing-invitation-claim', i.accountId, i.deviceId, i.devicePub,
    i.relay, i.id, i.publicKey, i.createdAt, i.expiresAt, hash]));
}

export function createPairingClaim(value: FirstUsePairing, scope: Scope, registration: SenderRegistrationPayload): PairingClaimProof {
  const firstUse = validateFirstUse(value, scope), i = firstUse.invitation;
  if (registration.fileDeviceId !== i.deviceId) throw invalid();
  const hash = pairingRegistrationHash(registration), pub = Buffer.from(i.publicKey, 'base64url');
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: firstUse.privateKey,
    x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  return { invitationId: i.id, signature: sign('sha256', pairingClaimInput(i, hash), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
}
