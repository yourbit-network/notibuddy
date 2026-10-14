import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createECDH } from 'node:crypto';
import { parsePairingBundle } from '../src/protocol.js';
import { DestinationStore } from '../src/config.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair, isValidP256PublicKey, toB64u } from '../src/crypto.js';
import type { PairingBundle } from '../src/types.js';

const encode = (value: unknown) => 'nbpair1.' + Buffer.from(JSON.stringify(value)).toString('base64url');
const alias = (value: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)!) | 1];
};
async function fixture(): Promise<PairingBundle> {
  const enc = await generateReplyKeyPair(), sig = await generateSenderSigningKeyPair();
  return { v: 1, relay: 'https://relay.test/', token: 'nb_snd_synthetic_pairing', pairSecret: toB64u(new Uint8Array(32)),
    device: { id: await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u), encPub: enc.publicKeyB64u, sigPub: sig.publicKeyB64u, name: 'iPhone de José' } };
}

test('pairing rejects off-curve device keys even when the device ID matches their bytes', async () => {
  const good = await fixture(), invalid = toB64u(Uint8Array.from([4, ...new Uint8Array(64)]));
  for (const field of ['encPub', 'sigPub'] as const) {
    const bad = structuredClone(good); bad.device[field] = invalid;
    bad.device.id = await deriveDeviceId(bad.device.encPub, bad.device.sigPub);
    await assert.rejects(parsePairingBundle(encode(bad)), /public key/);
  }
});

test('public point validation requires canonical encoding, uncompressed form and a real curve point', async () => {
  const good = (await fixture()).device.encPub;
  assert.equal(isValidP256PublicKey(good), true);
  const alternateCurve = createECDH('secp256k1'); alternateCurve.generateKeys();
  for (const bad of [toB64u(Uint8Array.from([4, ...new Uint8Array(64)])), toB64u(Uint8Array.from([4, ...new Uint8Array(64).fill(255)])),
    good + '=', alias(good), good + '\n', toB64u(alternateCurve.getPublicKey()), toB64u(alternateCurve.getPublicKey(undefined, 'compressed')),
    'A'.repeat(200000), null, undefined]) assert.equal(isValidP256PublicKey(bad as any), false);
});

test('pairing rejects noncanonical inner and outer Base64URL encodings', async () => {
  const good = await fixture();
  for (const field of ['pairSecret', 'encPub', 'sigPub']) {
    const original = field === 'pairSecret' ? good.pairSecret : good.device[field as 'encPub' | 'sigPub'];
    for (const changed of [original + '=', alias(original)]) {
      assert.deepEqual(Buffer.from(changed, 'base64url'), Buffer.from(original, 'base64url'));
      const bad = structuredClone(good);
      if (field === 'pairSecret') bad.pairSecret = changed; else bad.device[field as 'encPub' | 'sigPub'] = changed;
      await assert.rejects(parsePairingBundle(encode(bad)));
    }
  }
  let json = JSON.stringify(good); while (Buffer.byteLength(json) % 3 === 0) json += ' ';
  const outer = Buffer.from(json).toString('base64url');
  for (const bad of [outer + '=', alias(outer), outer + '\nA']) await assert.rejects(parsePairingBundle('nbpair1.' + bad));
});

test('pairing rejects invalid shapes, privilege tokens, control names and unsupported fields', async () => {
  const good = await fixture();
  for (const bad of [null, [], { ...good, token: 'nb_dev_synthetic' }, { ...good, token: 1 }, { ...good, token: 'nb_snd_secret\n' },
    { ...good, token: 'nb_snd_' + 'x'.repeat(257) }, { ...good, unsupported: true }, { ...good, device: { ...good.device, futureKey: 'unknown' } },
    { ...good, device: { ...good.device, name: 1 } }, { ...good, device: { ...good.device, name: 'name\nforged log' } },
    { ...good, device: { ...good.device, name: 'é'.repeat(129) } }]) await assert.rejects(parsePairingBundle(encode(bad)));
});

test('pairing UTF-8 decoding fails instead of replacing invalid bytes in device names', async () => {
  const good = await fixture(); good.device.name = 'MARKER';
  const json = Buffer.from(JSON.stringify(good)), at = json.indexOf('MARKER'); assert(at >= 0);
  const bad = Buffer.concat([json.subarray(0, at), Buffer.from([255]), json.subarray(at + 6)]);
  await assert.rejects(parsePairingBundle('nbpair1.' + bad.toString('base64url')), /UTF-8/);
});

test('pairing caps decoded JSON before parsing and retains the exact 16 KiB boundary', async () => {
  const json = Buffer.from(JSON.stringify(await fixture()));
  const padded = (size: number) => 'nbpair1.' + Buffer.concat([json, Buffer.alloc(size - json.length, 32)]).toString('base64url');
  assert.equal((await parsePairingBundle(padded(16384))).v, 1);
  await assert.rejects(parsePairingBundle(padded(16385)), /too large|encoding/);
  await assert.rejects(parsePairingBundle(padded(32768)), /too large|encoding/);
});

test('valid legacy and negotiated bundles retain URL normalization and all loopback forms', async () => {
  const good = await fixture();
  assert.equal((await parsePairingBundle(' \n' + encode(good) + '\n')).relay, 'https://relay.test');
  for (const relay of ['http://localhost:8123/', 'http://127.0.0.1:8123/', 'http://[::1]:8123/']) {
    const parsed = await parsePairingBundle(encode({ ...good, relay, requestProtocol: 2, minimumRecipientGeneration: 0 }));
    assert.equal(parsed.relay, relay.slice(0, -1)); assert.equal(parsed.requestProtocol, 2); assert.equal(parsed.minimumRecipientGeneration, 0);
  }
  for (const relay of ['http://relay.test', 'https://user:password@relay.test', 'https://relay.test/?secret=x', 'https://relay.test/#x']) await assert.rejects(parsePairingBundle(encode({ ...good, relay })));
});

test('invalid direct pairing does not create or overwrite a destination', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-pairing-validation-'));
  try {
    const store = new DestinationStore(root), good = await fixture(), bad = structuredClone(good);
    bad.device.encPub = toB64u(Uint8Array.from([4, ...new Uint8Array(64)]));
    bad.device.id = await deriveDeviceId(bad.device.encPub, bad.device.sigPub);
    await assert.rejects(store.prepare('invalid', bad, 'Fixture'));
    assert.deepEqual(store.list(), []);
    await store.prepare('valid', good, 'Fixture');
    const before = fs.readFileSync(path.join(root, 'destinations', 'valid.json'));
    await assert.rejects(store.prepare('valid', { ...good, pairSecret: good.pairSecret + '=' }, 'Fixture'));
    assert.deepEqual(fs.readFileSync(path.join(root, 'destinations', 'valid.json')), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('direct pairing snapshots nested device data before asynchronous key work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-pairing-snapshot-'));
  try {
    const store = new DestinationStore(root), good = await fixture(), expectedId = good.device.id;
    const preparing = store.prepare('snapshot', good, 'Fixture'); good.device.id = 'dev_changed';
    assert.equal((await preparing).record.config.device.id, expectedId);
    assert.equal((await store.open('snapshot')).record.config.device.id, expectedId);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('opening malformed stored device keys fails without deleting or rewriting the record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-pairing-stored-'));
  try {
    const store = new DestinationStore(root); await store.prepare('phone', await fixture(), 'Fixture');
    const file = path.join(root, 'destinations', 'phone.json'), original = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const publicKey of [original.config.device.encPub + '=', toB64u(Uint8Array.from([4, ...new Uint8Array(64)]))]) {
      const bad = structuredClone(original); bad.config.device.encPub = publicKey;
      bad.config.device.id = await deriveDeviceId(publicKey, bad.config.device.sigPub);
      const bytes = JSON.stringify(bad); fs.writeFileSync(file, bytes);
      await assert.rejects(store.open('phone'), /mismatched keys/);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pairing flush failure preserves the prior identity and negotiation until a successful retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-pairing-flush-'));
  const originalSync = fs.fsyncSync;
  try {
    const store = new DestinationStore(root), bundle = await fixture();
    const original = (await store.prepare('phone', bundle, 'Fixture')).record;
    const directory = path.join(root, 'destinations'), file = path.join(directory, 'phone.json');
    const before = fs.readFileSync(file);
    const upgrade = { ...bundle, requestProtocol: 2 as const, minimumRecipientGeneration: 0 };
    let fileFlushes = 0;
    fs.fsyncSync = fd => {
      if (fs.fstatSync(fd).isFile()) {
        fileFlushes++;
        throw Object.assign(new Error('Synthetic file flush failure'), { code: 'EIO' });
      }
      originalSync(fd);
    };
    await assert.rejects(store.prepare('phone', upgrade, 'Fixture'), /Synthetic file flush failure/);
    assert.equal(fileFlushes, 1);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(directory), ['phone.json']);
    fs.fsyncSync = originalSync;
    const retried = (await store.prepare('phone', upgrade, 'Fixture')).record;
    assert.equal(retried.connectionId, original.connectionId);
    assert.deepEqual(retried.keys, original.keys);
    assert.deepEqual(retried.fileKey, original.fileKey);
    assert.equal(retried.config.requestProtocol, 2);
    assert.equal(retried.config.minimumRecipientGeneration, 0);
  } finally {
    fs.fsyncSync = originalSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
