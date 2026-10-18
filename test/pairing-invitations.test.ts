import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createECDH, createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePairingBundle } from '../src/protocol.js';
import { createPairingClaim, pairingClaimInput, pairingRegistrationHash, validateFirstUse } from '../src/pairing-invitation.js';
import { pairSender } from '../src/pairing.js';
import { signSenderRegistration } from '../src/sender-registration.js';
import { DestinationStore } from '../src/config.js';
import { computePairingMac, deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';
import type { FirstUsePairing, PairingBundle, SenderRegistrationPayload } from '../src/types.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => 'nbpair1.' + Buffer.from(JSON.stringify(value)).toString('base64url');
async function fixture(offset = 0, privateScalar?: Buffer) {
  const enc = await generateReplyKeyPair(), sig = await generateSenderSigningKeyPair(), now = Date.now() + offset;
  const key = createECDH('prime256v1');
  if (privateScalar) key.setPrivateKey(privateScalar); else key.generateKeys();
  const token = 'nb_snd_synthetic_pairing', device = { id: await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u), encPub: enc.publicKeyB64u, sigPub: sig.publicKeyB64u };
  // Node exports the minimal scalar; the pairing protocol requires all 32 bytes.
  const scalar = key.getPrivateKey(), privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString('base64url');
  const firstUse: FirstUsePairing = { privateKey, invitation: {
    v: 1, id: 'pin_' + hash(key.getPublicKey()).slice(0, 32), accountId: hash(token.slice(7)).slice(0, 32),
    deviceId: device.id, devicePub: device.sigPub, relay: 'https://relay.example.test', publicKey: key.getPublicKey().toString('base64url'),
    createdAt: now, expiresAt: now + 600_000,
  } };
  const bundle: PairingBundle = { v: 1, relay: firstUse.invitation.relay, token, pairSecret: Buffer.alloc(32).toString('base64url'), device,
    requestProtocol: 2, minimumRecipientGeneration: 0, firstUse };
  const sender = await generateSenderSigningKeyPair(), file = await generateReplyKeyPair();
  const registration = { senderKeyId: sender.senderKeyId, senderPub: sender.publicKeyB64u, label: 'Fixture agent',
    mac: await computePairingMac(bundle.pairSecret, device.id, sender.senderKeyId, sender.publicKeyB64u, 'Fixture agent', file.publicKeyB64u),
    fileDeviceId: device.id, fileEncPub: file.publicKeyB64u };
  return { bundle, firstUse, sender, registration, config: { relay: bundle.relay, token, device,
    requestProtocol: 2 as const, minimumRecipientGeneration: 0, senderKeyId: sender.senderKeyId, senderLabel: 'Fixture agent' } };
}
const response = (registration: SenderRegistrationPayload, status: string, expiresAt?: number) => Response.json({ status, senderKeyId: registration.senderKeyId, ...(expiresAt === undefined ? {} : { expiresAt }) });
function publicKey(raw: string) {
  const bytes = Buffer.from(raw, 'base64url');
  return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') } });
}

test('first-use parsing validates exact capability scope and retains expired/manual and legacy documents', async () => {
  const f = await fixture(), parsed = await parsePairingBundle(encode(f.bundle));
  assert.deepEqual(parsed.firstUse, f.firstUse);
  const expired = await fixture(-700_000); assert.deepEqual((await parsePairingBundle(encode(expired.bundle))).firstUse, expired.firstUse);
  const { firstUse, ...legacy } = f.bundle; assert.equal((await parsePairingBundle(encode(legacy))).firstUse, undefined);
  for (const edit of [{ relay: 'https://other.example.test' }, { token: 'nb_snd_other' }, { requestProtocol: 1 }, { firstUse: null }]) {
    await assert.rejects(parsePairingBundle(encode({ ...f.bundle, ...edit })));
  }
  for (const edit of [{ extra: true }, { v: 2 }, { accountId: 'a'.repeat(32) }, { deviceId: 'dev_' + 'a'.repeat(24) },
    { id: 'pin_' + 'a'.repeat(32) }, { createdAt: Date.now() + 121_000 }, { createdAt: 0 },
    { createdAt: 1.5 }, { expiresAt: f.firstUse.invitation.createdAt }, { expiresAt: f.firstUse.invitation.createdAt + 600_001 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { relay: f.bundle.relay + '/' }, { relay: f.bundle.relay + '/path' },
    { publicKey: f.firstUse.invitation.publicKey + '=' }, { publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') }]) {
    await assert.rejects(parsePairingBundle(encode({ ...f.bundle, firstUse: { ...f.firstUse, invitation: { ...f.firstUse.invitation, ...edit } } })));
  }
  const other = await fixture();
  for (const firstUse of [{ ...f.firstUse, privateKey: Buffer.alloc(32).toString('base64url') },
    { ...f.firstUse, privateKey: f.firstUse.privateKey + '=' }, { ...f.firstUse, privateKey: other.firstUse.privateKey },
    { ...f.firstUse, extra: true }]) await assert.rejects(parsePairingBundle(encode({ ...f.bundle, firstUse })));
});

test('shared Swift/Worker vectors match registration hashes, signing bytes and signatures', async () => {
  const vectors = JSON.parse(fs.readFileSync(new URL('../test-vectors/pairing-invitation-v1.json', import.meta.url), 'utf8'));
  for (const item of vectors.cases) {
    const { claim } = item;
    assert.equal(pairingRegistrationHash(claim.registration), claim.registrationHash);
    assert.equal(pairingClaimInput(claim.invitation, claim.registrationHash).toString(), item.claimInput);
    assert(verify('sha256', Buffer.from(item.claimInput), { key: publicKey(claim.invitation.publicKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(claim.signature, 'base64url')));
    const request = item.request;
    assert(verify('sha256', Buffer.from(item.registrationInput), { key: publicKey(request.senderPub), dsaEncoding: 'ieee-p1363' }, Buffer.from(request.sig, 'base64url')));
  }
});

test('sender proof binds invitation presence and signature and excludes private setup fields', async () => {
  const f = await fixture(), proof = createPairingClaim(f.firstUse, f.config, f.registration);
  const payload = { ...f.registration, invitation: proof, firstUse: f.firstUse };
  const pending = signSenderRegistration(payload, f.config.token, f.sender.privateKey);
  payload.label = 'changed after signing began'; payload.invitation.signature = 'x';
  const body = await pending;
  const input = (value = body) => Buffer.from(JSON.stringify(['nb3', 'sender-registration', f.config.token.slice(7),
    value.senderKeyId, value.senderPub, value.label, value.mac, value.createdAt, value.nonce, value.fileDeviceId, value.fileEncPub,
    value.invitation!.invitationId, value.invitation!.signature]));
  assert(verify('sha256', input(), { key: publicKey(f.sender.publicKeyB64u), dsaEncoding: 'ieee-p1363' }, Buffer.from(body.sig, 'base64url')));
  assert(!verify('sha256', input({ ...body, invitation: { ...body.invitation!, signature: 'changed' } }), { key: publicKey(f.sender.publicKeyB64u), dsaEncoding: 'ieee-p1363' }, Buffer.from(body.sig, 'base64url')));
  assert(!JSON.stringify(body).includes(f.firstUse.privateKey)); assert(!('firstUse' in body));
  const claimBytes = pairingClaimInput(f.firstUse.invitation, pairingRegistrationHash(f.registration));
  assert(verify('sha256', claimBytes, { key: publicKey(f.firstUse.invitation.publicKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(body.invitation!.signature, 'base64url')));
});

test('capability is never saved with destination credentials and malformed invitations write nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-first-use-'));
  try {
    const f = await fixture(), store = new DestinationStore(root);
    await store.prepare('phone', f.bundle, 'Fixture agent');
    const file = path.join(root, 'destinations', 'phone.json'), before = fs.readFileSync(file, 'utf8');
    assert(!before.includes(f.firstUse.privateKey)); assert(!before.includes('firstUse')); assert(!before.includes(f.firstUse.invitation.id));
    const retried = await store.prepare('phone', f.bundle, 'Fixture agent');
    assert.equal(retried.record.keys.senderKeyId, JSON.parse(before).keys.senderKeyId);
    const bad = structuredClone(f.bundle); bad.firstUse!.privateKey = Buffer.alloc(32).toString('base64url');
    await assert.rejects(store.prepare('phone', bad, 'Fixture agent')); await assert.rejects(store.prepare('bad', bad, 'Fixture agent'));
    assert.equal(fs.readFileSync(file, 'utf8'), before); assert.deepEqual(store.list().map(d => d.name), ['phone']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('automatic pairing waits using byte-identical signed requests and confirms only matching receipts', async () => {
  const f = await fixture(), original = globalThis.fetch, bodies: string[] = []; let waiting = 0;
  globalThis.fetch = async (_, init) => {
    bodies.push(String(init?.body)); assert(!String(init?.body).includes(f.firstUse.privateKey));
    return response(f.registration, bodies.length === 1 ? 'pending_automatic' : 'registered', bodies.length === 1 ? f.firstUse.invitation.expiresAt : undefined);
  };
  try {
    const result = await pairSender(f.config, f.sender.privateKey, f.registration, f.firstUse, { waitSeconds: 3, onWaiting: () => waiting++ });
    assert.equal(result.status, 'registered'); assert.equal(waiting, 1); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  } finally { globalThis.fetch = original; }
});

test('legacy/manual fallback and already approved senders return immediately without polling', async () => {
  const f = await fixture(), original = globalThis.fetch;
  try {
    for (const status of ['registered', 'pending_approval']) for (const firstUse of [undefined, f.firstUse]) {
      let calls = 0;
      globalThis.fetch = async (_, init) => { calls++; assert.equal(!!JSON.parse(String(init?.body)).invitation, !!firstUse); return response(f.registration, status); };
      assert.equal((await pairSender(f.config, f.sender.privateKey, f.registration, firstUse, { onWaiting: () => assert.fail('No automatic wait') })).status, status);
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('zero wait and cancellation before waiting never pretend pairing succeeded', async () => {
  const f = await fixture(), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return response(f.registration, 'pending_automatic', f.firstUse.invitation.expiresAt); };
  try {
    assert.equal((await pairSender(f.config, f.sender.privateKey, f.registration, f.firstUse, { waitSeconds: 0 })).status, 'pending_automatic');
    assert.equal(calls, 1);
    const controller = new AbortController();
    await assert.rejects(pairSender(f.config, f.sender.privateKey, f.registration, f.firstUse, {
      signal: controller.signal, onWaiting: () => controller.abort(new Error('Synthetic interruption')),
    }), /Synthetic interruption/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

for (const scenario of [
  { name: 'waking at the deadline', wallElapsed: 30, stalled: false },
  { name: 'waking before the deadline', wallElapsed: 29, stalled: false },
  { name: 'a retry stalled at the deadline', wallElapsed: 29, stalled: true },
]) test(`automatic pairing stays pending after ${scenario.name}`, { timeout: 5000 }, async (t) => {
  const f = await fixture(), start = Date.now(), calls: number[] = [], bodies: string[] = [];
  let now = start, aborted = 0, ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  // Timer delivery and Date.now are separate clocks. An early wake can permit
  // another identical POST within the budget, so elapsed time cannot fix its count.
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls.push(Date.now() - start); bodies.push(String(init?.body));
    assert(Date.now() < start + 30, 'No POST may start at or after the deadline');
    if (scenario.stalled && calls.length === 2) {
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { aborted++; reject(init!.signal!.reason); }, { once: true });
      });
    }
    return response(f.registration, 'pending_automatic', f.firstUse.invitation.expiresAt);
  });
  const pending = pairSender(f.config, f.sender.privateKey, f.registration, f.firstUse, { waitSeconds: 0.03, onWaiting: ready });
  await waiting;
  assert.deepEqual(calls, [0]);
  now = start + scenario.wallElapsed; t.mock.timers.tick(30);
  // Drain the immediate response/body microtasks without advancing either clock.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, scenario.wallElapsed === 30 ? [0] : [0, 29]);
  now = start + 30; t.mock.timers.tick(1);
  assert.equal(aborted, scenario.stalled ? 1 : 0, 'The retry must abort at its deadline');
  assert.equal((await pending).status, 'pending_automatic');
  assert.equal(new Set(bodies).size, 1, 'Polling must reuse the exact signed proof');
  const completedCalls = calls.length;
  t.mock.timers.tick(60000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls.length, completedCalls, 'Completed pairing must not leave polling behind');
});

test('cancellation during the pairing wait prevents another POST', { timeout: 5000 }, async (t) => {
  const f = await fixture(), controller = new AbortController(); let calls = 0, cancelled = false, ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; return response(f.registration, 'pending_automatic', f.firstUse.invitation.expiresAt);
  });
  const rejected = assert.rejects(pairSender(f.config, f.sender.privateKey, f.registration, f.firstUse, {
    signal: controller.signal, onWaiting: ready,
  }), /Synthetic interruption/).then(() => { cancelled = true; });
  await waiting;
  controller.abort(new Error('Synthetic interruption'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled, true, 'Cancellation must settle without advancing time');
  await rejected;
  t.mock.timers.tick(60000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('a lost polling response retries the identical proof without reopening pairing', async () => {
  const f = await fixture(), original = globalThis.fetch, bodies: string[] = [];
  globalThis.fetch = async (_, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 2) throw new TypeError('Synthetic lost response');
    return response(f.registration, bodies.length === 1 ? 'pending_automatic' : 'registered', bodies.length === 1 ? f.firstUse.invitation.expiresAt : undefined);
  };
  try {
    assert.equal((await pairSender(f.config, f.sender.privateKey, f.registration, f.firstUse, { waitSeconds: 5 })).status, 'registered');
    assert.equal(bodies.length, 3); assert.equal(new Set(bodies).size, 1);
  } finally { globalThis.fetch = original; }
});

test('revocation, stale invitation and malformed receipt fail instead of silently dropping the proof', async () => {
  const f = await fixture(), original = globalThis.fetch;
  try {
    for (const error of [Response.json({ code: 'SENDER_REVOKED' }, { status: 403 }), Response.json({ code: 'PAIRING_INVITATION_STALE' }, { status: 409 }),
      Response.json({ status: 'registered', senderKeyId: 'snd_' + 'a'.repeat(24) }),
      Response.json({ status: 'registered' }),
      response(f.registration, 'pending_automatic', f.firstUse.invitation.expiresAt + 1), Response.json({ status: 'pending_automatic' }),
      new Response('{malformed', { status: 200 }), new Response('x'.repeat(8193), { status: 200 })]) {
      let calls = 0; globalThis.fetch = async () => { calls++; return error; };
      await assert.rejects(pairSender(f.config, f.sender.privateKey, f.registration, f.firstUse)); assert.equal(calls, 1);
    }
    globalThis.fetch = async () => response(f.registration, 'pending_automatic', f.firstUse.invitation.expiresAt);
    await assert.rejects(pairSender(f.config, f.sender.privateKey, f.registration), /Invalid automatic pairing/);
  } finally { globalThis.fetch = original; }
});

test('invalid waits or mismatched destinations fail before any network request', async () => {
  const f = await fixture(), original = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('Must not contact relay');
  try {
    for (const waitSeconds of [-1, 61, Infinity, NaN]) await assert.rejects(pairSender(f.config, f.sender.privateKey, f.registration, f.firstUse, { waitSeconds }));
    await assert.rejects(pairSender(f.config, f.sender.privateKey, { ...f.registration, fileDeviceId: 'dev_' + 'a'.repeat(24) }, f.firstUse));
    assert.throws(() => validateFirstUse(f.firstUse, { ...f.config, token: 'nb_snd_other' }));
  } finally { globalThis.fetch = original; }
});


test('fixture serializes short P-256 scalars as full-width private keys accepted by real pairing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-leading-zero-'));
  try {
    const store = new DestinationStore(root);
    for (const scalar of [Buffer.from([1]), Buffer.alloc(31, 1)]) {
      const f = await fixture(0, scalar), name = 'key_' + scalar.length;
      // Real pairing requires the canonical 32-byte scalar, including leading zeros.
      await store.prepare(name, f.bundle, 'Fixture agent');
      const encoded = Buffer.from(f.firstUse.privateKey, 'base64url');
      assert.equal(encoded.length, 32);
      assert.deepEqual(encoded, Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]));
      assert.deepEqual((await parsePairingBundle(encode(f.bundle))).firstUse, f.firstUse);
      const claim = createPairingClaim(f.firstUse, f.config, f.registration);
      assert(verify('sha256', pairingClaimInput(f.firstUse.invitation, pairingRegistrationHash(f.registration)),
        { key: publicKey(f.firstUse.invitation.publicKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(claim.signature, 'base64url')));
      const saved = fs.readFileSync(path.join(root, 'destinations', name + '.json'), 'utf8');
      assert(!saved.includes('firstUse')); assert(!saved.includes(f.firstUse.privateKey));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
