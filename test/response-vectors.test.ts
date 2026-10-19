import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createECDH } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

// Optionally exercise an installed public artifact against the same native bytes.
const api = process.argv[2]
  ? await import(pathToFileURL(path.join(path.resolve(process.argv[2]), 'dist/protocol.js')).href)
  : await import('../src/protocol.js');
const fixture = JSON.parse(fs.readFileSync(new URL('../test-vectors/v1-swift-reply.json', import.meta.url), 'utf8'));
assert.equal(fixture.schemaVersion, 1);
assert.equal(fixture.replyPrivateScalar, 6);
assert.deepEqual(fixture.replies.map((v: any) => v.id), ['approval', 'text_input', 'form', 'diff', 'timer', 'stepper']);
assert.equal(fixture.errors.length, 7);
function fixedKey(scalar: number) {
  const bytes = Buffer.alloc(32); bytes[31] = scalar;
  const curve = createECDH('prime256v1'); curve.setPrivateKey(bytes);
  const raw = curve.getPublicKey();
  return { publicKey: raw.toString('base64url'), jwk: { kty: 'EC', crv: 'P-256',
    x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url'),
    d: bytes.toString('base64url'), ext: true } };
}
const key = await crypto.subtle.importKey('jwk', fixedKey(6).jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
const wrong = await crypto.subtle.importKey('jwk', fixedKey(7).jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw Error('Fixed response vectors must not use the network'); };
after(() => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0); });

for (const vector of fixture.replies) test(`Swift ${vector.id} answer opens with exact content and rejects substitutions`, async () => {
  const envelope = vector.envelope;
  const params = { envelope, expectedRequestId: envelope.requestId, expectedDeviceId: fixture.deviceId,
    deviceSigningPublicKey: fixture.deviceSigPub, replyPrivateKey: key };
  assert.deepEqual(await api.openReply(params), vector.answer);
  const changed = { v: 2, kind: 'error', requestId: 'other_request', deviceId: 'other_device',
    createdAt: envelope.createdAt + 1, enc: fixedKey(7).publicKey,
    ct: Buffer.alloc(32).toString('base64url'), sig: Buffer.alloc(64).toString('base64url'), unexpected: true };
  for (const [field, value] of Object.entries(changed)) {
    await assert.rejects(api.openReply({ ...params, envelope: { ...envelope, [field]: value } }), undefined, field);
  }
  await assert.rejects(api.openReply({ ...params, expectedRequestId: 'other_request' }));
  await assert.rejects(api.openReply({ ...params, expectedDeviceId: 'other_device' }));
  await assert.rejects(api.openReply({ ...params, deviceSigningPublicKey: fixedKey(7).publicKey }));
  await assert.rejects(api.openReply({ ...params, replyPrivateKey: wrong }));
  // seq is unsigned relay metadata: structurally bounded, never used as identity.
  assert.deepEqual(await api.openReply({ ...params, envelope: { ...envelope, seq: 1 } }), vector.answer);
  for (const seq of [0, -1, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    await assert.rejects(api.openReply({ ...params, envelope: { ...envelope, seq } }));
  }
});
for (const envelope of fixture.errors) test(`Swift ${envelope.code} error binds the original request and device`, async () => {
  const params = { envelope, expectedRequestId: envelope.requestId, expectedDeviceId: fixture.deviceId,
    deviceSigningPublicKey: fixture.deviceSigPub };
  assert.equal(await api.openError(params), envelope.code);
  const changed = { code: envelope.code === 'unsupported' ? 'expired' : 'unsupported',
    createdAt: envelope.createdAt + 1, requestId: 'other_request', deviceId: 'other_device',
    sig: Buffer.alloc(64).toString('base64url'), unexpected: true };
  for (const [field, value] of Object.entries(changed)) {
    await assert.rejects(api.openError({ ...params, envelope: { ...envelope, [field]: value } }), undefined, field);
  }
  await assert.rejects(api.openError({ ...params, expectedRequestId: 'other_request' }));
  await assert.rejects(api.openError({ ...params, expectedDeviceId: 'other_device' }));
  await assert.rejects(api.openError({ ...params, deviceSigningPublicKey: fixedKey(7).publicKey }));
});
