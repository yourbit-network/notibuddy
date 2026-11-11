import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DestinationStore } from '../src/config.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';
import { createMcpServer } from '../src/mcp.js';
import { UpdateNotifier, updateNotice } from '../src/update-notice.js';
import { CLIENT_VERSION, type ReleaseLookup } from '../src/update-check.js';
import { ClientUpgradeRequiredError, relayJSONOnce, RelayHTTPError } from '../src/client-http.js';
import { FileInbox } from '../src/files.js';

const DAY = 24 * 60 * 60 * 1000;
const NEWER = '99.0.0';
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nb-update-notice-'));
const savedOptOut = process.env.NOTIBUDDY_NO_UPDATE_CHECK;
delete process.env.NOTIBUDDY_NO_UPDATE_CHECK;
const optOut = async (run: () => Promise<void>) => {
  process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1';
  try { await run(); } finally { delete process.env.NOTIBUDDY_NO_UPDATE_CHECK; }
};
function fixture(latest: ReleaseLookup = { ok: true, latest: NEWER }) {
  const home = tempHome();
  let clock = 1_700_000_000_000, calls = 0, result: ReleaseLookup = latest;
  const notifier = new UpdateNotifier(home, () => clock, async () => { calls++; return result; });
  return { home, notifier, advance: (ms: number) => { clock += ms; }, calls: () => calls, set: (r: ReleaseLookup) => { result = r; },
    cache: () => JSON.parse(fs.readFileSync(path.join(home, 'update-check.json'), 'utf8')), now: () => clock };
}

test('the notice text is exact', () => {
  assert.equal(updateNotice('0.2.10', '0.3.0'),
    'NotiBuddy 0.3.0 is available (this is 0.2.10). Update with: npm install -g notibuddy@0.3.0 — or, if you run it through npx or an MCP configuration, change notibuddy@0.2.10 to notibuddy@0.3.0.');
});

test('a newer release notifies once a day', async () => {
  const f = fixture();
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), updateNotice(CLIENT_VERSION, NEWER));
  assert.equal(f.calls(), 1);
  const stored = f.cache();
  assert.deepEqual(Object.keys(stored).sort(), ['checkedAt', 'latest', 'notifiedAt', 'v']);
  assert.equal(stored.latest, NEWER);
  assert.equal((fs.statSync(path.join(f.home, 'update-check.json')).mode & 0o777), 0o600);
  assert.deepEqual(fs.readdirSync(f.home), ['update-check.json']);
  f.advance(DAY - 1000);
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), undefined);
  assert.equal(f.calls(), 1);
  f.advance(2000);
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), updateNotice(CLIENT_VERSION, NEWER));
  assert.equal(f.calls(), 2);
});

test('a cached check under a day old notifies without a lookup', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'update-check.json'), JSON.stringify({ v: 1, checkedAt: f.now() - 1000, latest: NEWER, notifiedAt: null }));
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), updateNotice(CLIENT_VERSION, NEWER));
  assert.equal(f.calls(), 0);
  assert.equal(f.cache().notifiedAt, f.now());
});

test('NOTIBUDDY_NO_UPDATE_CHECK=1 does nothing', () => optOut(async () => {
  const f = fixture();
  fs.rmSync(f.home, { recursive: true });
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), undefined);
  assert.equal(f.calls(), 0);
  assert.equal(fs.existsSync(f.home), false);
}));

test('an offline lookup does not update checkedAt', async () => {
  const f = fixture({ ok: false });
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), undefined);
  assert.equal(fs.existsSync(path.join(f.home, 'update-check.json')), false);
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), undefined);
  assert.equal(f.calls(), 2);
  f.set({ ok: true, latest: NEWER });
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), updateNotice(CLIENT_VERSION, NEWER));
});

test('the same or an older release updates checkedAt and never notifies', async () => {
  for (const latest of [CLIENT_VERSION, '0.0.1']) {
    const f = fixture({ ok: true, latest });
    assert.equal(await f.notifier.cliNotice(Date.now() + 1000), undefined);
    assert.equal(f.cache().checkedAt, f.now());
    assert.equal(f.cache().notifiedAt, null);
    assert.equal(await f.notifier.cliNotice(Date.now() + 1000), undefined);
    assert.equal(f.calls(), 1);
  }
});

test('a malformed cache is treated as empty', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'update-check.json'), '{not json');
  assert.equal(await f.notifier.cliNotice(Date.now() + 1000), updateNotice(CLIENT_VERSION, NEWER));
  assert.equal(f.calls(), 1);
  fs.writeFileSync(path.join(f.home, 'update-check.json'), JSON.stringify({ v: 1, checkedAt: 'x', latest: 5, notifiedAt: {} }));
  assert.equal(await fixture().notifier.cliNotice(Date.now() + 1000), updateNotice(CLIENT_VERSION, NEWER));
  assert.equal(await new UpdateNotifier(f.home, Date.now, async () => { throw new Error('boom'); }).cliNotice(Date.now() + 1000), undefined);
});

test('the CLI prints the notice on stderr only and never waits past the caps', async () => {
  const root = tempHome();
  const stub = path.join(root, 'registry.mjs');
  fs.writeFileSync(stub, `
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (String(url) !== 'https://registry.npmjs.org/notibuddy/latest') return original(url, options);
      if (process.env.REGISTRY_MODE === 'hang') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
      return Promise.resolve(Response.json({ version: '${NEWER}' }));
    };
  `);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (mode: string, optedOut = false) => new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NOTIBUDDY_HOME: path.join(root, 'home-' + mode + optedOut), REGISTRY_MODE: mode };
    delete env.NOTIBUDDY_NO_UPDATE_CHECK;
    if (optedOut) env.NOTIBUDDY_NO_UPDATE_CHECK = '1';
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', pathToFileURL(stub).href, cli, 'status'], { env, cwd: root, timeout: 20_000 });
    let stdout = '', stderr = '';
    child.stdout!.on('data', c => { stdout += c; }); child.stderr!.on('data', c => { stderr += c; });
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
  try {
    const baseline = await run('ok', true);
    assert.equal(baseline.code, 0); assert.equal(baseline.stderr, '');
    const noticed = await run('ok');
    assert.equal(noticed.code, 0);
    assert.equal(noticed.stdout, baseline.stdout);
    assert.equal(noticed.stderr, updateNotice(CLIENT_VERSION, NEWER) + '\n');
    const hung = await run('hang');
    assert.equal(hung.code, 0);
    assert.equal(hung.stdout, baseline.stdout);
    assert.equal(hung.stderr, '');
    assert.ok(hung.ms < 1500 + 4000, `hung lookup delayed the command by ${hung.ms} ms`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

async function mcpSession(lookup: () => Promise<ReleaseLookup>) {
  const home = tempHome();
  const store = new DestinationStore(home);
  const enc = await generateReplyKeyPair(), sig = await generateSenderSigningKeyPair();
  await store.prepare('phone', { v: 1, relay: 'https://relay.test', token: 'nb_snd_fixture_update', pairSecret: Buffer.alloc(32).toString('base64url'),
    device: { id: await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u), encPub: enc.publicKeyB64u, sigPub: sig.publicKeyB64u, name: 'Phone' } }, 'Mac');
  const server = await createMcpServer({ to: 'phone' }, store, lookup);
  const client = new Client({ name: 'fixture', version: '1' }, { capabilities: {} });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  await new Promise(resolve => setTimeout(resolve, 20));
  return { client, done: async () => { await client.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}
const texts = (result: any) => (result.content as { text: string }[]).map(c => c.text);

test('an MCP session shows the notice in the first tool result only', async () => {
  const s = await mcpSession(async () => ({ ok: true, latest: NEWER }));
  try {
    const first = await s.client.callTool({ name: 'notibuddy_list_destinations', arguments: {} });
    assert.equal(texts(first).length, 2);
    assert.equal(texts(first)[1], updateNotice(CLIENT_VERSION, NEWER));
    const second = await s.client.callTool({ name: 'notibuddy_nope', arguments: {} });
    assert.equal(second.isError, true);
    assert.equal(texts(second).length, 1);
  } finally { await s.done(); }
});

test('an MCP error result carries the notice too, and a pending or failed lookup adds nothing', async () => {
  const errored = await mcpSession(async () => ({ ok: true, latest: NEWER }));
  try {
    const result = await errored.client.callTool({ name: 'notibuddy_nope', arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(texts(result).slice(1), [updateNotice(CLIENT_VERSION, NEWER)]);
  } finally { await errored.done(); }
  for (const lookup of [() => new Promise<ReleaseLookup>(() => {}), async () => ({ ok: false }) as ReleaseLookup]) {
    const s = await mcpSession(lookup);
    try { assert.equal(texts(await s.client.callTool({ name: 'notibuddy_list_destinations', arguments: {} })).length, 1); } finally { await s.done(); }
  }
});

test('an MCP session with NOTIBUDDY_NO_UPDATE_CHECK=1 never shows the notice', () => optOut(async () => {
  let calls = 0;
  const s = await mcpSession(async () => { calls++; return { ok: true, latest: NEWER }; });
  try {
    assert.equal(texts(await s.client.callTool({ name: 'notibuddy_list_destinations', arguments: {} })).length, 1);
    assert.equal(calls, 0);
  } finally { await s.done(); }
}));

const upgradeMessage = (minimum?: string) => `The NotiBuddy relay no longer supports this client (${CLIENT_VERSION}${minimum ? `; the minimum is ${minimum}` : ''}). Update with: npm install -g notibuddy@latest — or change notibuddy@${CLIENT_VERSION} to notibuddy@latest in your npx command or MCP configuration.`;

test('relay 426 CLIENT_UPGRADE_REQUIRED throws the exact upgrade error', async () => {
  const original = globalThis.fetch;
  const config = { relay: 'https://relay.test', token: 'nb_snd_x', senderKeyId: 'snd_' + 'a'.repeat(24) } as any;
  try {
    for (const [body, minimum] of [[{ error: 'old', code: 'CLIENT_UPGRADE_REQUIRED', minimumVersion: '0.3.0' }, '0.3.0'],
      [{ error: 'old', code: 'CLIENT_UPGRADE_REQUIRED' }, undefined], [{ error: 'old', code: 'CLIENT_UPGRADE_REQUIRED', minimumVersion: '3; rm -rf' }, undefined]] as const) {
      globalThis.fetch = async () => Response.json(body, { status: 426 });
      await assert.rejects(relayJSONOnce(config, '/v1/ping'), (e: any) => e instanceof ClientUpgradeRequiredError && e.message === upgradeMessage(minimum));
    }
    globalThis.fetch = async () => Response.json({ error: 'x', code: 'OTHER_CODE' }, { status: 426 });
    await assert.rejects(relayJSONOnce(config, '/v1/ping'), (e: any) => e instanceof RelayHTTPError && e.status === 426 && e.code === 'OTHER_CODE');
    globalThis.fetch = async () => Response.json({ code: 'CLIENT_UPGRADE_REQUIRED' }, { status: 400 });
    await assert.rejects(relayJSONOnce(config, '/v1/ping'), (e: any) => e instanceof RelayHTTPError && e.status === 400);
  } finally { globalThis.fetch = original; }
});

test('the file inbox maps the same 426 to the same error', async () => {
  const original = globalThis.fetch, root = tempHome();
  try {
    const store = new DestinationStore(root);
    const enc = await generateReplyKeyPair(), sig = await generateSenderSigningKeyPair();
    const { record, signingKey } = await store.prepare('phone', { v: 1, relay: 'https://relay.test', token: 'nb_snd_' + randomUUID(), pairSecret: Buffer.alloc(32).toString('base64url'),
      device: { id: await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u), encPub: enc.publicKeyB64u, sigPub: sig.publicKeyB64u } }, 'Mac');
    const inbox = new FileInbox(record, signingKey, root);
    globalThis.fetch = async () => Response.json({ error: 'old', code: 'CLIENT_UPGRADE_REQUIRED', minimumVersion: '0.3.0' }, { status: 426 });
    await assert.rejects(inbox.list(), (e: any) => e instanceof ClientUpgradeRequiredError && e.message === upgradeMessage('0.3.0'));
    globalThis.fetch = async () => Response.json({ error: 'teapot', code: 'OTHER' }, { status: 426 });
    await assert.rejects(inbox.list(), (e: any) => !(e instanceof ClientUpgradeRequiredError) && e.message === 'teapot');
  } finally { globalThis.fetch = original; fs.rmSync(root, { recursive: true, force: true }); }
});

if (savedOptOut !== undefined) process.env.NOTIBUDDY_NO_UPDATE_CHECK = savedOptOut;

test('a lookup cancelled after the grace period records nothing, so the next command still shows the notice', async () => {
  const home = tempHome(), controller = new AbortController();
  let calls = 0;
  // A slow registry answer that arrives only after the CLI has given up waiting.
  const late = async (o: { signal?: AbortSignal }): Promise<ReleaseLookup> => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 50));
    return o.signal?.aborted ? { ok: false } : { ok: true, latest: NEWER };
  };
  const first = new UpdateNotifier(home, () => 1_700_000_000_000, late).cliNotice(Date.now() + 1000, controller.signal);
  controller.abort();
  assert.equal(await first, undefined);
  assert.equal(fs.existsSync(path.join(home, 'update-check.json')), false);
  // Even a lookup that ignores the signal and answers ok must not mark the notice shown once cancelled.
  const stubborn = new AbortController();
  const ignoring = async (): Promise<ReleaseLookup> => { calls++; await new Promise(r => setTimeout(r, 20)); return { ok: true, latest: NEWER }; };
  const second = new UpdateNotifier(home, () => 1_700_000_000_000, ignoring).cliNotice(Date.now() + 1000, stubborn.signal);
  stubborn.abort();
  assert.equal(await second, undefined);
  assert.equal(fs.existsSync(path.join(home, 'update-check.json')), false);
  const next = await new UpdateNotifier(home, () => 1_700_000_000_000, late).cliNotice(Date.now() + 1000);
  assert.equal(next, updateNotice(CLIENT_VERSION, NEWER));
  assert.equal(calls, 3);
});
