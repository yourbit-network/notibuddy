import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NotiBuddyClient, type AskParams } from '../src/client.js';
import { DestinationStore } from '../src/config.js';
import { PendingStore, type PendingReply } from '../src/pending-store.js';
import { ASK_TOOL_SCHEMA, createMcpServer } from '../src/mcp.js';
import { sealRequest } from '../src/protocol.js';
import { sealGroupRequest, verifyRecipients } from '../src/groups.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';
import type { RequestEnvelope, NotiBuddyConfig, AskPayload, ActivityPayload, PrimitiveType } from '../src/types.js';
import type { GroupRequest } from '../src/group-wire.js';

type Wire = RequestEnvelope | GroupRequest;
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-timeout-'));
  const encryption = await generateReplyKeyPair(), signing = await generateSenderSigningKeyPair(), sender = await generateSenderSigningKeyPair();
  const device = { id: await deriveDeviceId(encryption.publicKeyB64u, signing.publicKeyB64u), encPub: encryption.publicKeyB64u, sigPub: signing.publicKeyB64u };
  const config: NotiBuddyConfig = { relay: 'https://relay.test', token: 'nb_snd_' + randomUUID(), device,
    senderKeyId: sender.senderKeyId, senderPub: sender.publicKeyB64u, senderLabel: 'Synthetic timeout fixture' };
  const manifest = { v: 2, deviceId: device.id, generation: 1, primary: { deviceId: device.id, encPub: device.encPub, sigPub: device.sigPub }, companions: [] };
  const store = new PendingStore(config, root), requests: Wire[] = [];
  const client = (version: 1 | 2 = 1) => new NotiBuddyClient({ ...config, requestProtocol: version }, sender.privateKey, store);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).includes('/recipients')) return Response.json(manifest);
    if (init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as Wire; requests.push(request);
      return Response.json({ requestId: request.requestId, seq: requests.length }, { status: 202 });
    }
    return new Response(null, { status: 204 });
  };
  return { root, config, manifest, sender, encryption, store, requests, client, fetch, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const ordinary: AskParams[] = [{ title: 'Approval' }, { title: 'Protected approval', requiresAuth: true },
  { title: 'Text', inputPlaceholder: 'Reply' }, { title: 'Form', fields: [{ id: 'name', type: 'text', label: 'Name' }] },
  { title: 'Diff', diff: { filename: 'review.txt', original: 'before', modified: 'after' } }];

test('both request protocols default every ordinary ask to three hours and retain one-hour activities', async () => {
  const f = await fixture(), original = globalThis.fetch;
  try {
    globalThis.fetch = f.fetch;
    for (const version of [1, 2] as const) {
      for (const input of ordinary) {
        assert.equal((await f.client(version).ask({ ...input, waitSeconds: 0 })).status, 'pending');
        const request = f.requests.at(-1)!; assert.equal(request.v, version);
        assert.equal(request.expiresAt - request.createdAt, 10800);
      }
      await f.client(version).activity({ activityId: 'timer_' + version, action: 'start', timerMinutes: 20 });
      assert.equal(f.requests.at(-1)!.expiresAt - f.requests.at(-1)!.createdAt, 3600);
    }
    for (const timeoutSeconds of [1, 3600, 10800]) {
      await f.client().ask({ title: 'Explicit', timeoutSeconds, waitSeconds: 0 });
      assert.equal(f.requests.at(-1)!.expiresAt - f.requests.at(-1)!.createdAt, timeoutSeconds);
    }
    const before = f.requests.length;
    for (const timeoutSeconds of [0, -1, 1.5, 10801, NaN, Infinity]) await assert.rejects(f.client().ask({ title: 'Invalid', timeoutSeconds, waitSeconds: 0 }));
    await assert.rejects(f.client().ask({ title: 'Invalid wait', waitSeconds: 56 }));
    assert.equal(f.requests.length, before);
  } finally { globalThis.fetch = original; f.close(); }
});

test('low-level v1/v2 sealers enforce ordinary/activity bounds while retaining activity defaults', async () => {
  const f = await fixture();
  try {
    const recipients = await verifyRecipients(f.manifest, f.config);
    const seal = (version: 1 | 2, primitive: PrimitiveType, timeoutSeconds?: number) => {
      const payload: AskPayload | ActivityPayload = primitive.startsWith('activity_')
        ? { type: 'activity', title: 'Activity', action: 'start', activityId: 'activity', revision: 1, primitive: 'timer', replyPub: f.encryption.publicKeyB64u }
        : { type: 'ask', title: 'Synthetic', replyPub: f.encryption.publicKeyB64u };
      return version === 1
        ? sealRequest({ requestId: 'request', deviceId: f.config.device.id, senderKeyId: f.sender.senderKeyId,
          senderSigningPrivateKey: f.sender.privateKey, deviceEncryptionPublicKey: f.config.device.encPub, primitive, payload, timeoutSeconds })
        : sealGroupRequest({ requestId: 'request', senderKeyId: f.sender.senderKeyId, signingKey: f.sender.privateKey,
          recipients, primitive, payload, timeoutSeconds });
    };
    for (const version of [1, 2] as const) {
      for (const primitive of ['approval', 'text_input', 'form', 'diff'] as const) {
        for (const timeout of [undefined, 1, 3601, 10800]) {
          const request = await seal(version, primitive, timeout);
          assert.equal(request.expiresAt - request.createdAt, timeout ?? 10800);
        }
        for (const invalid of [0, -1, 1.5, 10801, NaN, Infinity]) await assert.rejects(seal(version, primitive, invalid), /between 1 and 10800/);
      }
      for (const primitive of ['activity_start', 'activity_update', 'activity_end'] as const) {
        const request = await seal(version, primitive); assert.equal(request.expiresAt - request.createdAt, 300);
        const boundary = await seal(version, primitive, 3600); assert.equal(boundary.expiresAt - boundary.createdAt, 3600);
        await assert.rejects(seal(version, primitive, 3601), /between 1 and 3600/);
      }
    }
  } finally { f.close(); }
});

test('resume and ambiguous retry never extend the original signed expiry or replace saved ciphertext', async () => {
  const f = await fixture(), original = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  try {
    for (const version of [1, 2] as const) {
      let fail = true;
      globalThis.fetch = async (input, init) => {
        const result = await f.fetch(input, init);
        if (init?.method === 'POST' && fail) { fail = false; throw Error('Lost acknowledgement'); }
        return result;
      };
      const pending = await f.client(version).ask({ title: 'Same request', timeoutSeconds: 120, waitSeconds: 0 });
      const wire = structuredClone(f.requests.at(-1)!);
      const saved = f.store.read<PendingReply>('reply:' + pending.requestId)!;
      now += 30_000;
      const resumed = await f.client(version).ask({ resumeId: pending.requestId, timeoutSeconds: 10800, waitSeconds: 0 });
      assert.equal(resumed.requestId, pending.requestId); assert.equal(resumed.status, 'pending');
      assert.deepEqual(f.requests.at(-1), wire);
      const after = f.store.read<PendingReply>('reply:' + pending.requestId)!;
      assert.equal(after.expiresAt, saved.expiresAt); assert.deepEqual(after.privateKeyJwk, saved.privateKeyJwk);
      now += 100_000;
      const count = f.requests.length;
      await f.client(version).ask({ resumeId: pending.requestId, timeoutSeconds: 10800, waitSeconds: 0 });
      assert.equal(f.requests.length, count, 'Expired saved requests are never reissued with a fresh lifetime');
      assert.equal(f.store.read<PendingReply>('reply:' + pending.requestId)!.expiresAt, saved.expiresAt);
    }
  } finally { globalThis.fetch = original; Date.now = originalNow; f.close(); }
});

test('MCP exposes independent timeout/wait bounds and forwards the selected request lifetime', async () => {
  const f = await fixture(), original = globalThis.fetch;
  const store = new DestinationStore(path.join(f.root, 'mcp'));
  const paired = await store.prepare('test', { v: 1, relay: f.config.relay, token: f.config.token,
    device: f.config.device, pairSecret: Buffer.alloc(32).toString('base64url') }, 'Synthetic');
  const client = new Client({ name: 'timeout-fixture', version: '1' }, { capabilities: {} });
  const server = await createMcpServer({ to: 'test' }, store);
  try {
    globalThis.fetch = f.fetch;
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
    const schema = (await client.listTools()).tools.find(tool => tool.name === 'notibuddy_ask')!.inputSchema;
    assert.deepEqual(schema.properties?.timeout_seconds, ASK_TOOL_SCHEMA.inputSchema.properties.timeout_seconds);
    assert.equal(ASK_TOOL_SCHEMA.inputSchema.properties.timeout_seconds.maximum, 10800);
    assert.equal(ASK_TOOL_SCHEMA.inputSchema.properties.wait_seconds.maximum, 55);
    for (const timeout_seconds of [undefined, 1800, 10800]) {
      const result = await client.callTool({ name: 'notibuddy_ask', arguments: { title: 'MCP request', wait_seconds: 0,
        ...(timeout_seconds === undefined ? {} : { timeout_seconds }) } });
      assert(!result.isError); assert.equal(f.requests.at(-1)!.expiresAt - f.requests.at(-1)!.createdAt, timeout_seconds ?? 10800);
    }
    const before = f.requests.length;
    for (const args of [{ timeout_seconds: 10801 }, { timeout_seconds: 1.5 }, { wait_seconds: 56 }]) {
      assert.equal((await client.callTool({ name: 'notibuddy_ask', arguments: { title: 'Invalid', wait_seconds: 0, ...args } })).isError, true);
    }
    assert.equal(f.requests.length, before); assert(paired.record.keys.senderKeyId);
  } finally { await client.close(); await server.close(); globalThis.fetch = original; f.close(); }
});

test('CLI --timeout controls signed lifetime while --wait stays a short operation budget', async () => {
  const f = await fixture(), store = new DestinationStore(path.join(f.root, 'cli'));
  const server = createServer(); let failure: unknown;
  server.on('request', (request, response) => { void (async () => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString()) as Wire; f.requests.push(wire);
      response.writeHead(202, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ requestId: wire.requestId, seq: f.requests.length }));
    } else { response.writeHead(204); response.end(); }
  })().catch(error => { failure = error; response.writeHead(500); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    await store.prepare('test', { v: 1, relay: f.config.relay, token: f.config.token, device: f.config.device,
      pairSecret: Buffer.alloc(32).toString('base64url') }, 'Synthetic');
    const recordPath = path.join(store.root, 'destinations', 'test.json'), record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.config.relay = `http://127.0.0.1:${address.port}`; fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
        env: { ...process.env, NOTIBUDDY_HOME: store.root }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
      let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
      child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
    });
    for (const timeout of [undefined, '1800', '10800']) {
      const result = await run(['ask', 'CLI request', '--to', 'test', '--wait', '0', ...(timeout ? ['--timeout', timeout] : [])]);
      assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'pending');
      assert.equal(f.requests.at(-1)!.expiresAt - f.requests.at(-1)!.createdAt, timeout ? Number(timeout) : 10800);
    }
    const before = f.requests.length;
    for (const args of [['--timeout', '10801'], ['--timeout', '1.5'], ['--timeout', '0'], ['--wait', '56']]) {
      const result = await run(['ask', 'Invalid', '--to', 'test', ...args]); assert.equal(result.code, 1);
    }
    assert.equal(f.requests.length, before); if (failure) throw failure;
    const help = await run(['help']); assert.match(help.stdout, /--timeout/); assert.match(help.stdout, /10800/); assert.match(help.stdout, /does not change expiry/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});
