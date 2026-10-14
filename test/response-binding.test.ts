import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildErrorHeader, openError, openReply, sealReply } from '../src/protocol.js';
import { ecdsaSign, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';
import type { ErrorEnvelope } from '../src/types.js';

async function fixture() {
  const signing = await generateSenderSigningKeyPair(), reply = await generateReplyKeyPair();
  const expected = { expectedRequestId: 'request_expected', expectedDeviceId: 'device_expected', deviceSigningPublicKey: signing.publicKeyB64u };
  const envelope = await sealReply({ requestId: expected.expectedRequestId, deviceId: expected.expectedDeviceId,
    deviceSigningPrivateKey: signing.privateKey, replyPublicKey: reply.publicKeyB64u, answer: { action: 'Approve', authenticated: true } });
  const error = async (requestId = expected.expectedRequestId, createdAt = Math.floor(Date.now() / 1000)): Promise<ErrorEnvelope> => {
    const raw: ErrorEnvelope = { v: 1, kind: 'error', requestId, deviceId: expected.expectedDeviceId, createdAt, code: 'unsupported', sig: '' };
    raw.sig = await ecdsaSign(signing.privateKey, Buffer.concat([Buffer.from(buildErrorHeader(requestId, raw.deviceId, createdAt, raw.code)), Buffer.from([0])]));
    return raw;
  };
  return { signing, reply, expected, envelope, error };
}

test('exported reply helper rejects another request even with a valid device signature and usable reply key', async () => {
  const f = await fixture();
  const other = await sealReply({ requestId: 'request_other', deviceId: f.expected.expectedDeviceId,
    deviceSigningPrivateKey: f.signing.privateKey, replyPublicKey: f.reply.publicKeyB64u, answer: { action: 'Approve' } });
  await assert.rejects(openReply({ ...f.expected, envelope: other, replyPrivateKey: f.reply.privateKey }), /Request ID mismatch/);
  assert.deepEqual(await openReply({ ...f.expected, envelope: f.envelope, replyPrivateKey: f.reply.privateKey }), { action: 'Approve', authenticated: true });
});

test('exported error helper binds a correctly signed error to the caller request', async () => {
  const f = await fixture();
  await assert.rejects(openError({ ...f.expected, envelope: await f.error('request_other') }), /Request ID mismatch/);
  assert.equal(await openError({ ...f.expected, envelope: await f.error() }), 'unsupported');
});

test('JavaScript callers cannot omit or provide malformed expected request IDs', async () => {
  const f = await fixture(), error = await f.error();
  for (const expectedRequestId of [undefined, null, '', 'request_expected\n', 'x'.repeat(65)]) {
    const expected = { ...f.expected, expectedRequestId } as any;
    await assert.rejects(openReply({ ...expected, envelope: f.envelope, replyPrivateKey: f.reply.privateKey }), /expectedRequestId/);
    await assert.rejects(openError({ ...expected, envelope: error }), /expectedRequestId/);
  }
});

test('binding keeps pinned-device checks and does not impose fresh-arrival age on signed errors', async () => {
  const f = await fixture();
  const older = await f.error(f.expected.expectedRequestId, Math.floor(Date.now() / 1000) - 3500);
  assert.equal(await openError({ ...f.expected, envelope: older }), 'unsupported');
  await assert.rejects(openError({ ...f.expected, expectedDeviceId: 'device_other', envelope: older }), /Device ID mismatch/);
  await assert.rejects(openReply({ ...f.expected, expectedDeviceId: 'device_other', envelope: f.envelope, replyPrivateKey: f.reply.privateKey }), /Device ID mismatch/);
});
