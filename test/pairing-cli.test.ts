import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createECDH, createHash } from 'node:crypto';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';

test('actual CLI reports automatic, manual, pending and already-linked outcomes without retaining the code', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-pairing-cli-'));
  try {
    const enc = await generateReplyKeyPair(), sig = await generateSenderSigningKeyPair(), key = createECDH('prime256v1');
    // A valid short scalar makes leading-zero export coverage deterministic.
    key.setPrivateKey(Buffer.from([1]));
    const device = { id: await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u), encPub: enc.publicKeyB64u, sigPub: sig.publicKeyB64u, name: 'Synthetic phone' };
    const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
    const scalar = key.getPrivateKey(), privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString('base64url');
    const token = 'nb_snd_cli_pairing_fixture', now = Date.now();
    const bundle = { v: 1, relay: 'https://pairing.fixture.invalid', token, device, pairSecret: Buffer.alloc(32).toString('base64url'),
      requestProtocol: 2, minimumRecipientGeneration: 0, firstUse: { privateKey, invitation: {
        v: 1, id: 'pin_' + digest(key.getPublicKey()).slice(0, 32), accountId: digest(token.slice(7)).slice(0, 32),
        deviceId: device.id, devicePub: device.sigPub, relay: 'https://pairing.fixture.invalid', publicKey: key.getPublicKey().toString('base64url'),
        createdAt: now, expiresAt: now + 600_000,
      } } };
    const fixture = path.join(root, 'relay.mjs');
    fs.writeFileSync(fixture, `
      import assert from 'node:assert/strict';
      let first, calls = 0;
      // Windows forcibly terminates child processes for kill('SIGTERM'). Use
      // IPC there to exercise the CLI's real shutdown handler; POSIX uses the
      // operating-system signal. Do not keep an otherwise-finished CLI alive.
      if (process.platform === 'win32') {
        process.on('message', message => { if (message === 'interrupt') process.emit('SIGTERM'); });
        process.channel?.unref();
      }
      globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'https://pairing.fixture.invalid/v1/senders');
        assert.equal(options.method, 'POST');
        const wire = String(options.body), body = JSON.parse(wire);
        first ??= wire; assert.equal(wire, first);
        assert(!Object.hasOwn(body, 'firstUse')); assert(!Object.hasOwn(body, 'privateKey'));
        calls++;
        const mode = process.env.PAIRING_FIXTURE_MODE;
        const status = mode === 'automatic' ? calls === 1 ? 'pending_automatic' : 'registered'
          : mode === 'waiting' || mode === 'interrupt' ? 'pending_automatic' : mode;
        return Response.json({ status, senderKeyId: body.senderKeyId,
          ...(status === 'pending_automatic' ? { expiresAt: Number(process.env.PAIRING_FIXTURE_EXPIRY) } : {}) });
      };
      process.on('exit', () => assert.equal(calls, process.env.PAIRING_FIXTURE_MODE === 'automatic' ? 2 : 1));
    `);
    const encoded = 'nbpair1.' + Buffer.from(JSON.stringify(bundle)).toString('base64url');
    const run = (mode: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', pathToFileURL(fixture).href,
        fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'pair', encoded, '--to', 'phone', '--label', 'CLI fixture',
        '--wait', mode === 'waiting' ? '0' : '3'], {
        env: { ...process.env, NOTIBUDDY_HOME: path.join(root, 'profile'), PAIRING_FIXTURE_MODE: mode, PAIRING_FIXTURE_EXPIRY: String(bundle.firstUse.invitation.expiresAt) },
        cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 15_000,
      });
      let stdout = '', stderr = '';
      child.stdout!.on('data', chunk => {
        stdout += chunk;
        if (mode === 'interrupt' && stdout.includes('First-use code claimed')) {
          if (process.platform === 'win32') child.send('interrupt'); else child.kill('SIGTERM');
        }
      });
      child.stderr!.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
    });
    let saved: Buffer | undefined;
    for (const mode of ['pending_approval', 'automatic', 'registered', 'waiting', 'interrupt']) {
      const result = await run(mode);
      assert.equal(result.code, mode === 'interrupt' ? 143 : 0, result.stderr);
      assert(!result.stdout.includes(privateKey)); assert(!result.stderr.includes(privateKey));
      assert(!result.stdout.includes(encoded)); assert(!result.stderr.includes(encoded));
      if (mode === 'registered' || mode === 'automatic') { assert.match(result.stdout, /Pairing confirmed/); assert.doesNotMatch(result.stdout, /then approve the connection/); }
      if (mode === 'pending_approval') assert.match(result.stdout, /Phone approval required/);
      if (mode === 'waiting') { assert.match(result.stdout, /Connection is not confirmed yet/); assert.doesNotMatch(result.stdout, /Pairing confirmed/); }
      const bytes = fs.readFileSync(path.join(root, 'profile/destinations/phone.json'));
      assert(!bytes.toString().includes(privateKey)); assert(!bytes.toString().includes('firstUse'));
      if (saved) assert.deepEqual(bytes, saved); saved = bytes;
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
