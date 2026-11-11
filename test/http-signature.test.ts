import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { relayJSON, httpSigningAccount, httpSigningInput } from '../src/client-http.js';
import { deriveDeviceId, ecdsaVerify, generateReplyKeyPair, generateSenderSigningKeyPair, sha256, toHex } from '../src/crypto.js';
import type { NotiBuddyConfig } from '../src/types.js';

const vector = JSON.parse(fs.readFileSync(new URL('../test-vectors/http-signature-v2.json', import.meta.url), 'utf8'));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test('the shared vector token derives the vector account and signing input', async () => {
  assert.equal(httpSigningAccount(vector.token), vector.accountId);
  assert.equal(httpSigningAccount(vector.token.replace('nb_snd_', 'nb_dev_')), vector.accountId);
  assert.equal(toHex(await sha256(new TextEncoder().encode(vector.body))), vector.bodySha256);
  assert.equal(text(httpSigningInput(vector.token, vector.method, vector.path, vector.timestamp, vector.nonce, vector.bodySha256)), vector.v2Input);
});

test('relay HTTP requests carry an nb2 signature that verifies over the account-bound input', async () => {
  const encryption = await generateReplyKeyPair(), signing = await generateSenderSigningKeyPair(), sender = await generateSenderSigningKeyPair();
  const device = { id: await deriveDeviceId(encryption.publicKeyB64u, signing.publicKeyB64u), encPub: encryption.publicKeyB64u, sigPub: signing.publicKeyB64u };
  const config: NotiBuddyConfig = { relay: 'https://relay.test', token: 'nb_snd_' + randomUUID(), device,
    senderKeyId: sender.senderKeyId, senderPub: sender.publicKeyB64u, senderLabel: 'Synthetic signature fixture' };
  const original = globalThis.fetch;
  let verified = false;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers), u = new URL(String(url));
    const body = typeof init?.body === 'string' ? init.body : '';
    const account = httpSigningAccount(config.token);
    const input = new TextEncoder().encode(`nb2|http|${account}|POST|${u.pathname}${u.search}|${headers.get('X-Sender-Timestamp')}|${headers.get('X-Sender-Nonce')}|${toHex(await sha256(new TextEncoder().encode(body)))}`);
    assert(await ecdsaVerify(sender.publicKeyB64u, input, headers.get('X-Sender-Signature')!));
    const v1 = new TextEncoder().encode(`nb1|http|POST|${u.pathname}${u.search}|${headers.get('X-Sender-Timestamp')}|${headers.get('X-Sender-Nonce')}|${toHex(await sha256(new TextEncoder().encode(body)))}`);
    assert(!await ecdsaVerify(sender.publicKeyB64u, v1, headers.get('X-Sender-Signature')!));
    verified = true;
    return Response.json({ ok: true });
  };
  try {
    await relayJSON(config, '/v2/requests', { method: 'POST', body: JSON.stringify({ a: 1 }) }, {}, sender.privateKey);
  } finally { globalThis.fetch = original; }
  assert(verified);
});
