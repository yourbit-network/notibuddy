import {
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
  Aes256Gcm,
} from '@hpke/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Standard NotiBuddy HPKE Suite: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM
const hpkeSuite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

/**
 * Base64url encoding without padding (=)
 */
export function toB64u(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64url')
    .replace(/=+$/, '');
}

/**
 * Base64url decoding
 */
export function fromB64u(str: string): Uint8Array {
  return Uint8Array.from(Buffer.from(str, 'base64url'));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function toBufferSource(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', toBufferSource(data));
  return new Uint8Array(hash);
}

/**
 * Validates uncompressed SEC1 P-256 point (65 bytes, leading 0x04)
 */
export function isValidP256PublicKey(b64uStr: string): boolean {
  try {
    const bytes = fromB64u(b64uStr);
    return bytes.length === 65 && bytes[0] === 0x04;
  } catch {
    return false;
  }
}

/**
 * Derives deviceId: "dev_" + hex(SHA-256(DE.pub ‖ DS.pub))[0:24]
 */
export async function deriveDeviceId(encPubB64u: string, sigPubB64u: string): Promise<string> {
  const encPub = fromB64u(encPubB64u);
  const sigPub = fromB64u(sigPubB64u);
  const combined = new Uint8Array(encPub.length + sigPub.length);
  combined.set(encPub, 0);
  combined.set(sigPub, encPub.length);
  const hash = await sha256(combined);
  return 'dev_' + toHex(hash).slice(0, 24);
}

/**
 * Derives senderKeyId: "snd_" + hex(SHA-256(SS.pub))[0:24]
 */
export async function deriveSenderKeyId(senderPubB64u: string): Promise<string> {
  const senderPub = fromB64u(senderPubB64u);
  const hash = await sha256(senderPub);
  return 'snd_' + toHex(hash).slice(0, 24);
}

/**
 * Pairing MAC computation:
 * mac = HMAC-SHA256(pairSecret,
 *         UTF-8("nb1|sender|" + deviceId + "|" + senderKeyId) ‖ 0x00 ‖ senderPub ‖ 0x00 ‖ UTF-8(label))
 */
export async function computePairingMac(
  pairSecretB64u: string,
  deviceId: string,
  senderKeyId: string,
  senderPubB64u: string,
  label: string
): Promise<string> {
  const pairSecret = fromB64u(pairSecretB64u);
  const key = await crypto.subtle.importKey(
    'raw',
    toBufferSource(pairSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const prefix = encoder.encode(`nb1|sender|${deviceId}|${senderKeyId}`);
  const senderPub = fromB64u(senderPubB64u);
  const labelBytes = encoder.encode(label);

  const msg = new Uint8Array(prefix.length + 1 + senderPub.length + 1 + labelBytes.length);
  let offset = 0;
  msg.set(prefix, offset); offset += prefix.length;
  msg[offset] = 0x00; offset += 1;
  msg.set(senderPub, offset); offset += senderPub.length;
  msg[offset] = 0x00; offset += 1;
  msg.set(labelBytes, offset);

  const sig = await crypto.subtle.sign('HMAC', key, toBufferSource(msg));
  return toB64u(new Uint8Array(sig));
}

/**
 * Constant-time comparison for MAC verification
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Generates an ephemeral P-256 key agreement pair for single-use reply encryption
 */
export async function generateReplyKeyPair(): Promise<{
  publicKeyB64u: string;
  privateKey: CryptoKey;
}> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
  const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
  return {
    publicKeyB64u: toB64u(new Uint8Array(rawPub)),
    privateKey: kp.privateKey,
  };
}

/**
 * HPKE SealBase:
 * Encrypts plaintext string to recipient P-256 public key (Base64url SEC1 uncompressed)
 */
export async function hpkeSeal(
  recipientPubB64u: string,
  infoStr: string,
  aadStr: string,
  plaintextUtf8: string
): Promise<{ enc: string; ct: string }> {
  const pubBytes = fromB64u(recipientPubB64u);
  const recipientKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(pubBytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );

  const senderContext = await hpkeSuite.createSenderContext({
    recipientPublicKey: recipientKey,
    info: encoder.encode(infoStr),
  });

  const ct = await senderContext.seal(
    encoder.encode(plaintextUtf8),
    encoder.encode(aadStr)
  );

  return {
    enc: toB64u(new Uint8Array(senderContext.enc)),
    ct: toB64u(new Uint8Array(ct)),
  };
}

/**
 * HPKE OpenBase:
 * Decrypts ciphertext using recipient private key
 */
export async function hpkeOpen(
  recipientPrivKey: CryptoKey,
  encB64u: string,
  infoStr: string,
  aadStr: string,
  ctB64u: string
): Promise<string> {
  const encBytes = fromB64u(encB64u);
  const ctBytes = fromB64u(ctB64u);

  const recipientContext = await hpkeSuite.createRecipientContext({
    recipientKey: recipientPrivKey,
    enc: encBytes,
    info: encoder.encode(infoStr),
  });

  const pt = await recipientContext.open(ctBytes, encoder.encode(aadStr));
  return decoder.decode(pt);
}

/**
 * Generates an ECDSA P-256 key pair for the sender
 */
export async function generateSenderSigningKeyPair(): Promise<{
  senderKeyId: string;
  publicKeyB64u: string;
  privateKey: CryptoKey;
  privateKeyJwk: JsonWebKey;
}> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
  const publicKeyB64u = toB64u(new Uint8Array(rawPub));
  const senderKeyId = await deriveSenderKeyId(publicKeyB64u);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

  return {
    senderKeyId,
    publicKeyB64u,
    privateKey: kp.privateKey,
    privateKeyJwk,
  };
}

/**
 * Imports ECDSA P-256 private key from stored JWK
 */
export async function importSenderPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/**
 * Imports ECDSA P-256 public key from uncompressed 65-byte Base64url representation
 */
export async function importEcdsaPublicKey(b64uStr: string): Promise<CryptoKey> {
  const bytes = fromB64u(b64uStr);
  return await crypto.subtle.importKey(
    'raw',
    toBufferSource(bytes),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

/**
 * Signs data using ECDSA P-256 with SHA-256.
 * Output is raw IEEE P1363 64-byte r||s representation encoded in base64url.
 */
export async function ecdsaSign(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    toBufferSource(data)
  );
  return toB64u(new Uint8Array(sig));
}

/**
 * Verifies raw 64-byte r||s signature against data using public key
 */
export async function ecdsaVerify(
  publicKeyB64u: string,
  data: Uint8Array,
  sigB64u: string
): Promise<boolean> {
  try {
    const pubKey = await importEcdsaPublicKey(publicKeyB64u);
    const sigBytes = fromB64u(sigB64u);
    if (sigBytes.length !== 64) return false;
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      toBufferSource(sigBytes),
      toBufferSource(data)
    );
  } catch {
    return false;
  }
}
