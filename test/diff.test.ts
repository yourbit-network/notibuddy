import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NotiBuddyClient } from '../src/client.js';
import { DestinationStore } from '../src/config.js';
import { PendingStore } from '../src/pending-store.js';
import { createMcpServer } from '../src/mcp.js';
import { parseDiff, MAX_DIFF_TEXT_BYTES, MAX_DIFF_LINES } from '../src/diff.js';
import { readDiffFile, MAX_DIFF_FILE_BYTES } from '../src/diff-file.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair, hpkeOpen, ecdsaVerify } from '../src/crypto.js';
import { buildRequestHeader, sealReply } from '../src/protocol.js';
import type { RequestEnvelope, ReplyEnvelope, DiffInput, PairingBundle } from '../src/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-diff-'));
const originalFetch = globalThis.fetch;
const clients: Client[] = [];
const server = createServer();
const diff: DiffInput = { filename: 'src/review-秘密.ts', language: 'typescript', original: 'return "before-秘密";\n', modified: 'return "after-秘密";\n' };
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
let checks = 0;
try {
  assert.deepEqual(parseDiff(diff), diff);
  assert.equal(parseDiff({ ...diff, original: '' }).original, '');
  assert.equal(parseDiff({ ...diff, modified: '' }).modified, '');
  const boundary = { ...diff, original: 'é'.repeat(MAX_DIFF_TEXT_BYTES / 2), modified: '' };
  assert.equal(Buffer.byteLength(parseDiff(boundary).original), MAX_DIFF_TEXT_BYTES);
  assert.equal(parseDiff({ ...diff, original: '\n'.repeat(MAX_DIFF_LINES - 2), modified: '' }).original.length, MAX_DIFF_LINES - 2);
  for (const invalid of [null, {}, { ...diff, original: 42 }, { ...diff, modified: undefined },
    { ...diff, filename: ' ' }, { ...diff, filename: 'hidden\nname' }, { ...diff, language: 'x'.repeat(41) },
    { ...diff, filename: 'é'.repeat(257) }, { ...boundary, modified: 'x' }, { ...diff, original: '\ud800' },
    { ...diff, modified: '\udc00' }, { ...diff, original: '\n'.repeat(MAX_DIFF_LINES - 1), modified: '' },
    { ...diff, private_source_marker: 'must not leak' }]) {
    assert.throws(() => parseDiff(invalid), error => error instanceof Error && error.message.startsWith('Invalid diff:') &&
      !error.message.includes(diff.filename) && !error.message.includes('private_source_marker'));
  }
  checks++;

  const inputFile = path.join(root, 'changes.json');
  fs.writeFileSync(inputFile, JSON.stringify(diff));
  assert.deepEqual(readDiffFile(inputFile), diff);
  for (const bytes of [Buffer.from('{"private_source_marker" invalid}'), Buffer.from([0xff, 0xfe]), Buffer.alloc(MAX_DIFF_FILE_BYTES + 1), Buffer.from('{"filename":"secret"}')]) {
    const invalid = path.join(root, 'invalid.json'); fs.writeFileSync(invalid, bytes);
    assert.throws(() => readDiffFile(invalid), /Diff file must be readable UTF-8 JSON/);
  }
  assert.throws(() => readDiffFile(root), /Diff file must be readable/);
  assert.throws(() => readDiffFile(path.join(root, 'missing')), /Diff file must be readable/);
  if (process.platform !== 'win32') {
    const fifo = path.join(root, 'pipe');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    assert.throws(() => readDiffFile(fifo), /Diff file must be readable/);
  }
  checks++;

  const enc = await generateReplyKeyPair(), phoneSig = await generateSenderSigningKeyPair();
  const device = { id: await deriveDeviceId(enc.publicKeyB64u, phoneSig.publicKeyB64u), encPub: enc.publicKeyB64u, sigPub: phoneSig.publicKeyB64u };
  const store = new DestinationStore(path.join(root, 'profile'));
  const bundle: PairingBundle = { v: 1, relay: 'https://relay.test', token: 'nb_snd_' + randomUUID().replaceAll('-', ''),
    pairSecret: Buffer.alloc(32).toString('base64url'), device };
  const paired = await store.prepare('review', bundle, 'Synthetic review');
  const pending = () => new PendingStore(paired.record.config, store.root);
  const client = () => new NotiBuddyClient(paired.record.config, paired.signingKey, pending(), 'Diff reviewer');
  const requests: RequestEnvelope[] = [];
  const replies = new Map<string, ReplyEnvelope>();
  let loseAcknowledgement = false, calls = 0;
  const open = async (request: RequestEnvelope) => {
    const header = buildRequestHeader(request.requestId, request.deviceId, request.senderKeyId, request.primitive, request.createdAt, request.expiresAt);
    assert(await ecdsaVerify(paired.record.keys.publicKeyB64u, Buffer.concat([Buffer.from(header), Buffer.from([0]), Buffer.from(request.enc, 'base64url'), Buffer.from(request.ct, 'base64url')]), request.sig));
    return JSON.parse(await hpkeOpen(enc.privateKey, request.enc, 'notibuddy/v1/request', header, request.ct));
  };
  const reply = async (request: RequestEnvelope, action = 'approve') => {
    const payload = await open(request);
    replies.set(request.requestId, await sealReply({ requestId: request.requestId, deviceId: device.id,
      deviceSigningPrivateKey: phoneSig.privateKey, replyPublicKey: payload.replyPub, answer: { action, authenticated: true } }));
  };
  globalThis.fetch = async (input, init) => {
    calls++;
    if (init?.method === 'POST') {
      const request = JSON.parse(String(init.body)); requests.push(request);
      assert(!String(init.body).includes(diff.original)); assert(!String(init.body).includes(diff.filename));
      return loseAcknowledgement ? new Response(null, { status: 503 }) : Response.json({ requestId: request.requestId, seq: requests.length }, { status: 202 });
    }
    const id = new URL(String(input)).pathname.split('/').pop()!;
    return replies.has(id) ? Response.json({ ...replies.get(id), seq: 1 }) : new Response(null, { status: 204 });
  };
  const first = await client().ask({ title: 'Review source', diff, sensitive: true, requiresAuth: true, waitSeconds: 0 });
  assert.equal(first.status, 'pending'); assert.equal(requests[0].primitive, 'diff');
  const payload = await open(requests[0]);
  for (const [key, value] of Object.entries(diff)) assert.equal(payload[key], value);
  assert.equal(payload.type, 'ask'); assert.equal(payload.sensitive, true); assert.equal(payload.requiresAuth, true);
  assert.deepEqual(payload.source, { label: 'Diff reviewer' }); assert.equal(payload.diff, undefined, 'Wire fields match the native flat DiffPayload');
  assert.equal(pending().read<any>('reply:' + first.requestId).payload, undefined, 'Acknowledged dispatch removes retained source');
  await reply(requests[0]);
  assert.equal((await client().ask({ resumeId: first.requestId, waitSeconds: 0 })).answer?.action, 'approve');
  assert.equal(requests.length, 1, 'Resume does not create a duplicate request'); checks++;

  const beforeInvalid = calls;
  for (const input of [{ ...diff, original: null }, { ...boundary, modified: 'x' }]) {
    await assert.rejects(client().ask({ title: 'Invalid', diff: input as any, waitSeconds: 0 }));
  }
  for (const extra of [{ options: ['Yes'] }, { inputPlaceholder: '' }, { fields: [{ id: 'x', type: 'text' as const, label: 'x' }] }, { resumeId: 'req_fixture' }]) {
    await assert.rejects(client().ask({ title: 'Conflicting', diff, ...extra, waitSeconds: 0 }), /new diff request cannot include/);
  }
  // Escaping can exceed the encrypted-envelope limit even below the source-text cap.
  await assert.rejects(client().ask({ title: 'Too much escaped text', diff: { ...diff, original: '\0'.repeat(MAX_DIFF_TEXT_BYTES), modified: '' }, waitSeconds: 0 }));
  assert.equal(calls, beforeInvalid, 'Invalid diffs never reach HTTP');
  assert.equal((await client().ask({ title: 'Exact byte limit', diff: boundary, waitSeconds: 0 })).status, 'pending');
  assert.equal(Buffer.byteLength((await open(requests.at(-1)!)).original), MAX_DIFF_TEXT_BYTES); checks++;

  loseAcknowledgement = true;
  const interrupted = await client().ask({ title: 'Retry same diff', diff, waitSeconds: 0 });
  const interruptedWire = requests.at(-1)!;
  assert.equal(interrupted.status, 'pending');
  assert.equal(pending().read<any>('reply:' + interrupted.requestId).payload.original, diff.original);
  loseAcknowledgement = false;
  await reply(interruptedWire, 'reject');
  assert.equal((await client().ask({ resumeId: interrupted.requestId, waitSeconds: 0 })).answer?.action, 'reject');
  assert.deepEqual(requests.at(-1), interruptedWire, 'Lost acknowledgement retries the identical envelope'); checks++;

  const mcpServer = await createMcpServer({ allowTo: ['review'], sender: 'MCP reviewer' }, store);
  const mcp = new Client({ name: 'diff-fixture', version: '1' }, { capabilities: {} });
  const [left, right] = InMemoryTransport.createLinkedPair(); await mcpServer.connect(right); await mcp.connect(left); clients.push(mcp);
  const schema = (await mcp.listTools()).tools.find(tool => tool.name === 'notibuddy_ask')!.inputSchema;
  assert(schema.properties?.diff); assert(schema.required?.includes('to'));
  const result = await mcp.callTool({ name: 'notibuddy_ask', arguments: { to: 'review', title: 'MCP diff', diff, sensitive: true, requires_auth: true, wait_seconds: 0 } });
  assert(!result.isError); const mcpPending = JSON.parse((result.content as any)[0].text);
  assert.equal(mcpPending.status, 'pending'); assert.equal((await open(requests.at(-1)!)).original, diff.original);
  await reply(requests.at(-1)!);
  const resumed = await mcp.callTool({ name: 'notibuddy_ask', arguments: { to: 'review', resume_id: mcpPending.requestId, wait_seconds: 0 } });
  assert.equal(JSON.parse((resumed.content as any)[0].text).answer.action, 'approve');
  const beforeMcpInvalid = calls;
  for (const args of [{ title: 'Missing destination', diff }, { to: 'review', title: 'Conflicting', diff, fields: [{ id: 'x', type: 'text', label: 'x' }] },
    { to: 'review', title: 'Invalid source', diff: { ...diff, original: 5 } }]) {
    assert.equal((await mcp.callTool({ name: 'notibuddy_ask', arguments: { ...args, wait_seconds: 0 } })).isError, true);
  }
  assert.equal(calls, beforeMcpInvalid); checks++;

  globalThis.fetch = originalFetch;
  let serverFailure: unknown;
  server.on('request', (request, response) => { void (async () => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = JSON.parse(Buffer.concat(chunks).toString()) as RequestEnvelope;
      const content = await open(envelope); assert.equal(envelope.primitive, 'diff'); assert.equal(content.modified, diff.modified);
      assert.equal(content.requiresAuth, true); assert.equal(content.sensitive, true);
      await reply(envelope); response.writeHead(202, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ requestId: envelope.requestId, seq: 1 }));
    } else {
      const id = new URL(request.url!, 'http://localhost').pathname.split('/').pop()!;
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ...replies.get(id), seq: 1 }));
    }
  })().catch(error => { serverFailure = error; response.writeHead(500); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  // Preserve the same synthetic sender key by changing only this fixture's saved relay.
  const recordFile = path.join(store.root, 'destinations', 'review.json');
  const localRecord = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  localRecord.config.relay = `http://127.0.0.1:${address.port}`; fs.writeFileSync(recordFile, JSON.stringify(localRecord), { mode: 0o600 });
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { env: { ...process.env, NOTIBUDDY_HOME: store.root }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  const cliResult = await run(['ask', 'CLI diff', '--to', 'review', '--diff', inputFile, '--requires-auth', '--sensitive', '--wait', '2']);
  if (serverFailure) throw serverFailure;
  assert.equal(cliResult.code, 0, cliResult.stderr); assert.equal(JSON.parse(cliResult.stdout).answer.action, 'approve');
  assert(!cliResult.stdout.includes(diff.original)); checks++;
  const conflict = await run(['ask', 'Conflict', '--to', 'review', '--diff', path.join(root, 'missing'), '--options', 'Yes']);
  assert.equal(conflict.code, 1); assert.match(conflict.stderr, /cannot be combined/);
  const invalidCli = await run(['ask', 'Bad source', '--to', 'review', '--diff', path.join(root, 'invalid.json')]);
  assert.equal(invalidCli.code, 1); assert(!invalidCli.stderr.includes('secret')); checks++;
  console.log(`${checks} diff validation, encryption, resume, MCP and CLI checks passed`);
} finally {
  globalThis.fetch = originalFetch;
  for (const client of clients) await client.close();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
