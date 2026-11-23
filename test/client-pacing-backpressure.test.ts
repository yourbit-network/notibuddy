import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_ACTIVITY_UPDATE_DEBOUNCE_MS,
  DEFAULT_DISPATCH_PACE_MS,
  DispatchRejectedError,
  MAX_ACTIVITY_UPDATE_DEBOUNCE_MS,
  MAX_DISPATCH_PACE_MS,
  NotiBuddyClient,
} from '../src/client.js';
import {
  LOAD_SCALE_DECAY_MS,
  LoadScaleTracker,
  parseLoadScaleHeader,
  parseRetryAfterMs,
} from '../src/client-http.js';
import { companionGrantInput, type CompanionGrant } from '../src/companion-grant.js';
import {
  deriveDeviceId,
  ecdsaSign,
  generateReplyKeyPair,
  generateSenderSigningKeyPair,
  hpkeOpen,
  hpkeSeal,
  sha256,
  toB64u,
  toHex,
} from '../src/crypto.js';
import {
  groupDeliveryHeader,
  groupResponseHeader,
  groupResponseInput,
  type GroupRequest,
  type GroupResponse,
} from '../src/group-wire.js';
import { PendingStore } from '../src/pending-store.js';
import { buildRequestHeader } from '../src/protocol.js';
import { DEFAULT_RECIPIENT_CACHE_TTL_MS, RecipientStore } from '../src/recipient-store.js';
import { MAX_RESYNC_INTERVAL_MS, RESYNC_INTERVAL_MS, scaledResyncIntervalMs } from '../src/sender-stream.js';
import type { NotiBuddyConfig, RequestEnvelope } from '../src/types.js';

async function device() {
  const enc = await generateReplyKeyPair();
  const sig = await generateSenderSigningKeyPair();
  return {
    id: await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u),
    enc,
    sig,
  };
}

async function makeFixture(version: 1 | 2 = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-pacing-test-'));
  const phone = await device();
  const watch = await device();
  const sender = await generateSenderSigningKeyPair();
  const config: NotiBuddyConfig = {
    relay: 'https://relay.test',
    token: 'nb_snd_' + crypto.randomUUID(),
    device: {
      id: phone.id,
      encPub: phone.enc.publicKeyB64u,
      sigPub: phone.sig.publicKeyB64u,
    },
    senderKeyId: sender.senderKeyId,
    senderPub: sender.publicKeyB64u,
    senderLabel: 'PacingTest',
    requestProtocol: version,
  };
  const store = new PendingStore(config, root);
  const manifest = async (generation: number, includeWatch = true) => {
    const companions = [];
    if (includeWatch) {
      const grant: CompanionGrant = {
        v: 1,
        accountId: toHex(await sha256(new TextEncoder().encode(config.token.slice(7)))).slice(0, 32),
        parentDeviceId: phone.id,
        deviceId: watch.id,
        encPub: watch.enc.publicKeyB64u,
        sigPub: watch.sig.publicKeyB64u,
        credentialHash: '0'.repeat(64),
        capabilities: ['approval', 'text_input', 'timer_control'],
        generation,
        nonce: toB64u(new Uint8Array(32)),
        expiresAt: 1,
      };
      companions.push({
        grant,
        parentSignature: await ecdsaSign(phone.sig.privateKey, companionGrantInput(grant, 'parent')),
        childSignature: await ecdsaSign(watch.sig.privateKey, companionGrantInput(grant, 'child')),
      });
    }
    return {
      v: 2,
      deviceId: phone.id,
      generation,
      primary: { deviceId: phone.id, encPub: phone.enc.publicKeyB64u, sigPub: phone.sig.publicKeyB64u },
      companions,
    };
  };
  const openV1 = async (envelope: RequestEnvelope) =>
    JSON.parse(
      await hpkeOpen(
        phone.enc.privateKey,
        envelope.enc,
        'notibuddy/v1/request',
        buildRequestHeader(
          envelope.requestId,
          envelope.deviceId,
          envelope.senderKeyId,
          envelope.primitive,
          envelope.createdAt,
          envelope.expiresAt,
        ),
        envelope.ct,
      ),
    );
  const groupControlReply = async (q: GroupRequest, seq = 100) => {
    const delivery = q.deliveries.find((d) => d.deviceId === watch.id)!;
    const payload = JSON.parse(
      await hpkeOpen(
        watch.enc.privateKey,
        delivery.enc,
        'notibuddy/v2/request',
        groupDeliveryHeader(q, watch.id),
        delivery.ct,
      ),
    );
    const r: GroupResponse = {
      v: 2,
      kind: 'control',
      requestId: q.requestId,
      parentDeviceId: phone.id,
      deviceId: watch.id,
      generation: q.generation,
      responseId: crypto.randomUUID(),
      createdAt: Math.floor(Date.now() / 1000),
      enc: '',
      ct: '',
      sig: '',
      receipts: [{ deviceId: phone.id, enc: '', ct: '' }],
    };
    const header = groupResponseHeader(r);
    const text = JSON.stringify({ action: 'pause' });
    Object.assign(r, await hpkeSeal(payload.replyPub, 'notibuddy/v2/reply', header + '|sender', text));
    Object.assign(
      r.receipts[0],
      await hpkeSeal(phone.enc.publicKeyB64u, 'notibuddy/v2/receipt', header + '|receipt|' + phone.id, text),
    );
    r.sig = await ecdsaSign(watch.sig.privateKey, groupResponseInput(r));
    return { seq, envelope: r };
  };
  return { root, phone, watch, sender, config, store, manifest, openV1, groupControlReply };
}

test('LoadScaleTracker clamps strictly to [1, 10], ignores malformed values, and decays back to 1 after 5 minutes', () => {
  assert.equal(parseLoadScaleHeader(null), undefined);
  assert.equal(parseLoadScaleHeader(''), undefined);
  assert.equal(parseLoadScaleHeader('abc'), undefined);
  assert.equal(parseLoadScaleHeader('NaN'), undefined);
  assert.equal(parseLoadScaleHeader('Infinity'), undefined);
  assert.equal(parseLoadScaleHeader('2, 3'), undefined);
  assert.equal(parseLoadScaleHeader('0'), 1);
  assert.equal(parseLoadScaleHeader('-7'), 1);
  assert.equal(parseLoadScaleHeader('1'), 1);
  assert.equal(parseLoadScaleHeader('4'), 4);
  assert.equal(parseLoadScaleHeader('2.5'), 2.5);
  assert.equal(parseLoadScaleHeader('99'), 10);

  const tracker = new LoadScaleTracker();
  assert.equal(tracker.current(1_000), 1);
  assert.equal(tracker.observe('4', 1_000), 4);
  assert.equal(tracker.observe('not-a-number', 2_000), 4);
  assert.equal(tracker.observe('2', 10_000), 4);
  // Still 4 right before 5 minutes elapsed
  assert.equal(tracker.current(1_000 + LOAD_SCALE_DECAY_MS - 1), 4);
  // Decays back to 1 at 5 minutes without a higher/sustained value
  assert.equal(tracker.current(1_000 + LOAD_SCALE_DECAY_MS), 1);
  // Higher value refreshes and extends window
  assert.equal(tracker.observe('3', 500_000), 3);
  assert.equal(tracker.observe('15', 600_000), 10);
  assert.equal(tracker.current(600_000 + LOAD_SCALE_DECAY_MS - 1), 10);
  assert.equal(tracker.current(600_000 + LOAD_SCALE_DECAY_MS), 1);

  assert.equal(scaledResyncIntervalMs(1), RESYNC_INTERVAL_MS);
  assert.equal(scaledResyncIntervalMs(2), 180_000);
  assert.equal(scaledResyncIntervalMs(4), MAX_RESYNC_INTERVAL_MS);
  assert.equal(scaledResyncIntervalMs(10), MAX_RESYNC_INTERVAL_MS);

  assert.equal(parseRetryAfterMs('5', 1_000), 5_000);
  assert.equal(parseRetryAfterMs('0', 1_000), 0);
  assert.equal(parseRetryAfterMs('9999', 1_000), 300_000);
  assert.equal(parseRetryAfterMs('invalid', 1_000), undefined);
});

test('429 is non-definitive, preserves Retry-After and E2EE reply keys, and retries honoring Retry-After', async () => {
  assert.equal(new DispatchRejectedError(429, 'RATE_LIMITED', 'RATE_LIMITED', false, '5').definitive, false);
  assert.equal(new DispatchRejectedError(429, 'RATE_LIMITED', 'RATE_LIMITED', false, '5').retryAfter, '5');
  assert.equal(new DispatchRejectedError(402, 'DAILY_LIMIT_EXCEEDED', 'DAILY_LIMIT_EXCEEDED').definitive, true);

  const f = await makeFixture(1);
  const originalFetch = globalThis.fetch;
  try {
    // Case 1: Persistent 429 with Retry-After exceeding call deadline -> preserves E2EE reply:<id> key!
    let posts = 0;
    const postedIds: string[] = [];
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') {
        posts++;
        const req = JSON.parse(String(init.body));
        postedIds.push(req.requestId);
        return new Response(JSON.stringify({ code: 'RATE_LIMITED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60', 'X-NotiBuddy-Load-Scale': '4' },
        });
      }
      return new Response(null, { status: 204 });
    };
    const client = new NotiBuddyClient(
      f.config,
      f.sender.privateKey,
      f.store,
      undefined,
      undefined,
      { enabled: false },
      undefined,
      { activityUpdateDebounceMs: 0, dispatchPaceMs: 0 },
    );
    const pending = await client.ask({ title: 'Keep key on 429', waitSeconds: 0 });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.errorCode, 'RETRY_REQUIRED');
    assert.equal(posts, 1);
    assert.ok(f.store.read('reply:' + pending.requestId), '429 must NEVER delete saved reply:<id> E2EE key');
    assert.equal(client.loadScale, 4, 'X-NotiBuddy-Load-Scale must be captured on 429 responses too');

    // Case 2: Transient 429 with Retry-After inside deadline -> honors Retry-After and retries exact envelope!
    let attempts = 0;
    const attemptTimes: number[] = [];
    const seenEnvelopes: RequestEnvelope[] = [];
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') {
        attempts++;
        attemptTimes.push(Date.now());
        const req = JSON.parse(String(init.body)) as RequestEnvelope;
        seenEnvelopes.push(req);
        if (attempts === 1) {
          return new Response(JSON.stringify({ code: 'RATE_LIMITED' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '0.05' },
          });
        }
        return Response.json({ requestId: req.requestId, seq: 1 }, { status: 202 });
      }
      return new Response(null, { status: 204, headers: { 'X-NotiBuddy-Load-Scale': '6' } });
    };
    const delivered = await client.notify({ title: 'Retries after 429' });
    assert.equal(delivered.status, 'delivered');
    assert.equal(attempts, 2);
    assert.deepEqual(seenEnvelopes[0], seenEnvelopes[1]);
    assert.ok(attemptTimes[1] - attemptTimes[0] >= 45, 'Must honor Retry-After before retrying');

    // Verify 204 response also captures X-NotiBuddy-Load-Scale!
    await client.ask({ resumeId: pending.requestId, waitSeconds: 0 });
    assert.equal(client.loadScale, 6, 'X-NotiBuddy-Load-Scale must be captured on 204 responses');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('RecipientStore caches verified /v2/recipients payload, verifies rollback on every read, and refreshes on 409 RECIPIENTS_CHANGED', async () => {
  const f = await makeFixture(2);
  const originalFetch = globalThis.fetch;
  try {
    let recipientFetches = 0;
    let gen = 2;
    let rejectNextPost = false;
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/v2/recipients') {
        recipientFetches++;
        return Response.json(await f.manifest(gen), {
          headers: { 'X-NotiBuddy-Load-Scale': '2' },
        });
      }
      if (u.pathname === '/v2/requests') {
        const q = JSON.parse(String(init?.body)) as GroupRequest;
        if (rejectNextPost) {
          rejectNextPost = false;
          gen = 3;
          return Response.json({ code: 'RECIPIENTS_CHANGED' }, { status: 409 });
        }
        return Response.json({ requestId: q.requestId, seq: 1 }, { status: 202 });
      }
      return new Response(null, { status: 204 });
    };

    const client = new NotiBuddyClient(
      f.config,
      f.sender.privateKey,
      f.store,
      undefined,
      undefined,
      { enabled: false },
      undefined,
      { activityUpdateDebounceMs: 0, dispatchPaceMs: 0 },
    );

    await client.notify({ title: 'First' });
    await client.notify({ title: 'Second' });
    await client.notify({ title: 'Third' });
    assert.equal(recipientFetches, 1, 'Cached /v2/recipients avoids repeat GETs within TTL');

    // Tamper the cache file -> verifyRecipients catches tamper, invalidates cache, and fetches fresh!
    const recipientsDir = path.join(f.root, 'recipients');
    const cacheFile = fs.readdirSync(recipientsDir).find((n) => n.endsWith('.cache'))!;
    assert.ok(cacheFile);
    const tampered = JSON.parse(fs.readFileSync(path.join(recipientsDir, cacheFile), 'utf8'));
    tampered.body.generation = 1; // rollback attempt inside cache!
    fs.writeFileSync(path.join(recipientsDir, cacheFile), JSON.stringify(tampered));

    // Fresh client reads tampered disk cache, verifies against checkpoint (gen 2), rejects rollback, re-fetches!
    const client2 = new NotiBuddyClient(
      f.config,
      f.sender.privateKey,
      f.store,
      undefined,
      undefined,
      { enabled: false },
      undefined,
      { activityUpdateDebounceMs: 0, dispatchPaceMs: 0 },
    );
    await client2.notify({ title: 'After tampered cache' });
    assert.equal(recipientFetches, 2, 'Tampered/rolled-back cache entry must be rejected and refetched');

    // 409 RECIPIENTS_CHANGED invalidates cache immediately and re-fetches gen 3!
    rejectNextPost = true;
    await client2.notify({ title: 'Membership rotated' });
    assert.equal(recipientFetches, 3);
    assert.equal(new RecipientStore(f.config, f.root).read()?.generation, 3);

    // Verify loadScale scales soft TTL (1h * loadScale): cache with cachedAt = now - 1.5h is expired at scale 1, fresh at scale 2.
    const rs = new RecipientStore(f.config, f.root);
    const now = Date.now();
    const rawCached = rs.readCached(DEFAULT_RECIPIENT_CACHE_TTL_MS, now);
    assert.ok(rawCached);
    assert.equal(rs.readCached(DEFAULT_RECIPIENT_CACHE_TTL_MS, now + DEFAULT_RECIPIENT_CACHE_TTL_MS + 1), undefined);
    assert.ok(rs.readCached(DEFAULT_RECIPIENT_CACHE_TTL_MS * 2, now + DEFAULT_RECIPIENT_CACHE_TTL_MS + 1));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('default 5s debounce, 3s leading-edge pacer, deadline cap, duplicate notify storm dedupe, and start+end cancellation', async () => {
  const f = await makeFixture(1);
  const originalFetch = globalThis.fetch;
  try {
    // 1. Verify exact defaults on bare NotiBuddyClient constructor
    const defaultClient = new NotiBuddyClient(f.config, f.sender.privateKey, f.store, undefined, undefined, {
      enabled: false,
    });
    assert.equal(defaultClient.effectiveActivityUpdateDebounceMs, DEFAULT_ACTIVITY_UPDATE_DEBOUNCE_MS);
    assert.equal(defaultClient.effectiveActivityUpdateDebounceMs, 5_000);
    assert.equal(defaultClient.effectiveDispatchPaceMs, DEFAULT_DISPATCH_PACE_MS);
    assert.equal(defaultClient.effectiveDispatchPaceMs, 3_000);
    defaultClient.close();

    // 2. Leading-edge pacer (1st call = 0ms delay, back-to-back spaced out with ZERO drops) +
    //    duplicate notify storm dedupe + start+end cancellation before dispatch + loadScale scaling!
    const posted: { at: number; envelope: RequestEnvelope; payload: any }[] = [];
    let currentLoadScaleHeader = '1';
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') {
        const envelope = JSON.parse(String(init.body)) as RequestEnvelope;
        const payload = await f.openV1(envelope);
        posted.push({ at: Date.now(), envelope, payload });
        return Response.json(
          { requestId: envelope.requestId, seq: posted.length },
          { status: 202, headers: { 'X-NotiBuddy-Load-Scale': currentLoadScaleHeader } },
        );
      }
      return new Response(null, { status: 204 });
    };

    const pacedClient = new NotiBuddyClient(
      f.config,
      f.sender.privateKey,
      f.store,
      undefined,
      undefined,
      { enabled: false },
      undefined,
      { activityUpdateDebounceMs: 80, dispatchPaceMs: 120 },
    );

    // 1st notify -> 0ms delay!
    const t0 = Date.now();
    const n1 = await pacedClient.notify({ title: 'Alert A', message: 'Body 1' });
    assert.ok(Date.now() - t0 < 80, 'Leading-edge 1st call must have ~0ms delay');

    // Duplicate storm within pace window -> deduped to same result, ZERO extra POSTs!
    const [dup1, dup2] = await Promise.all([
      pacedClient.notify({ title: 'Alert A', message: 'Body 1' }),
      pacedClient.notify({ title: 'Alert A', message: 'Body 1' }),
    ]);
    assert.equal(dup1.requestId, n1.requestId);
    assert.equal(dup2.requestId, n1.requestId);
    assert.equal(posted.length, 1);

    // Back-to-back DISTINCT notify -> spaced out by dispatchPaceMs, ZERO drops!
    const n2 = await pacedClient.notify({ title: 'Alert B', message: 'Body 2' });
    assert.notEqual(n2.requestId, n1.requestId);
    assert.equal(posted.length, 2);
    assert.ok(posted[1].at - posted[0].at >= 100, 'Second distinct dispatch must be spaced by pace interval');

    // start + end cancellation: immediately queue activity_start while pacer window is hot,
    // then cancel with activity_end before start dispatches -> ZERO POSTs!
    const postsBeforeShortTask = posted.length;
    const startP = pacedClient.activity({ activityId: 'ephemeral', action: 'start', title: 'Flash' });
    // Let start enter the pace wait queue
    await new Promise((r) => setTimeout(r, 15));
    const endRes = await pacedClient.activity({ activityId: 'ephemeral', action: 'end', status: 'Done' });
    const startRes = await startP;
    assert.equal(startRes.status, 'cancelled');
    assert.equal(endRes.status, 'cancelled');
    assert.equal(posted.length, postsBeforeShortTask, 'Cancelled start+end must send ZERO HTTP POSTs');

    // Trailing-edge debounce/coalesce for rapid activity(update) calls + flushPendingActivities()!
    const postsBeforeActivity = posted.length;
    await pacedClient.activity({ activityId: 'build', action: 'start', title: 'Build', step: 1, totalSteps: 10 });
    assert.equal(posted.length, postsBeforeActivity + 1);

    const u2 = await pacedClient.activity({ activityId: 'build', action: 'update', status: 'Step 2', step: 2 });
    const u3 = await pacedClient.activity({ activityId: 'build', action: 'update', status: 'Step 3', step: 3 });
    const u4 = await pacedClient.activity({ activityId: 'build', action: 'update', status: 'Step 4', step: 4 });
    assert.equal(u2.status, 'coalesced');
    assert.equal(u3.status, 'coalesced');
    assert.equal(u4.status, 'coalesced');
    assert.equal(posted.length, postsBeforeActivity + 1, 'Rapid updates must buffer inside debounce window');

    // Explicit flushPendingActivities() dispatches the ONE coalesced update (step 4) immediately!
    await pacedClient.flushPendingActivities();
    assert.equal(posted.length, postsBeforeActivity + 2);
    assert.equal(posted.at(-1)!.payload.step, 4);
    assert.equal(posted.at(-1)!.payload.status, 'Step 4');

    // Rapid updates followed by activity_end: cancels pending update timer and folds latest step into activity_end!
    await pacedClient.activity({ activityId: 'build', action: 'update', status: 'Step 9', step: 9 });
    await pacedClient.activity({ activityId: 'build', action: 'end', status: 'Complete' });
    assert.equal(posted.length, postsBeforeActivity + 3);
    assert.equal(posted.at(-1)!.payload.action, 'end');
    assert.equal(posted.at(-1)!.payload.step, 9);
    assert.equal(posted.at(-1)!.payload.status, 'Complete');

    // Verify X-NotiBuddy-Load-Scale scales debounce & pace caps + deadline headroom cap!
    currentLoadScaleHeader = '10';
    await pacedClient.notify({ title: 'Surge signal' });
    assert.equal(pacedClient.loadScale, 10);
    assert.equal(pacedClient.effectiveActivityUpdateDebounceMs, 800);
    assert.equal(pacedClient.effectiveDispatchPaceMs, 1_200);

    // Tight deadline cap: remainingDeadline = 5_040ms -> maxAllowedWait = max(0, 5_040 - 5_000) = 40ms (NOT 1_200ms!)
    const tTight = Date.now();
    await pacedClient.notify({ title: 'Urgent tight deadline' }, { deadline: Date.now() + 5_040 });
    assert.ok(Date.now() - tTight < 300, 'Pacer delay must respect remainingDeadline - 5_000ms headroom cap');

    // Verify caps on default client at loadScale=10 -> debounce capped at 50s (or 60s max), pace capped at 10s
    const capCheckClient = new NotiBuddyClient(
      f.config,
      f.sender.privateKey,
      f.store,
      undefined,
      undefined,
      { enabled: false },
      undefined,
      { activityUpdateDebounceMs: 10_000, dispatchPaceMs: 3_000 },
    );
    await capCheckClient.notify({ title: 'Trigger loadScale 10' });
    assert.equal(capCheckClient.effectiveActivityUpdateDebounceMs, MAX_ACTIVITY_UPDATE_DEBOUNCE_MS);
    assert.equal(capCheckClient.effectiveDispatchPaceMs, MAX_DISPATCH_PACE_MS);

    pacedClient.close();
    capCheckClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('WS-driven activity updates skip HTTP GET /v2/replies until activity.available arrives, while poll always hits HTTP', async () => {
  if (typeof (globalThis as any).WebSocket !== 'function') return;

  const f = await makeFixture(2);
  const sockets: any[] = [];
  const replies = new Map<string, any>();
  let replyGets = 0;
  let recipientGets = 0;
  let lastRequest: GroupRequest | undefined;
  const manifestGen2 = await f.manifest(2);

  const acceptWs = (req: any, socket: any) => {
    const accept = crypto
      .createHash('sha1')
      .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  };
  const frame = (text: string) => {
    const payload = Buffer.from(text, 'utf8');
    if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    const h = Buffer.alloc(4);
    h[0] = 0x81;
    h[1] = 126;
    h.writeUInt16BE(payload.length, 2);
    return Buffer.concat([h, payload]);
  };

  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://127.0.0.1');
    if (u.pathname === '/v2/recipients') {
      recipientGets++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifestGen2));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v2/requests') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const q = JSON.parse(Buffer.concat(chunks).toString('utf8')) as GroupRequest;
      lastRequest = q;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requestId: q.requestId, seq: 1 }));
      return;
    }
    if (req.method === 'GET' && u.pathname.startsWith('/v2/replies/')) {
      replyGets++;
      const id = u.pathname.split('/').pop()!;
      const afterSeq = Number(u.searchParams.get('afterSeq') ?? 0);
      const r = replies.get(id);
      if (r && r.seq > afterSeq) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    if (req.url === '/v2/sender/ws') {
      acceptWs(req, socket);
      sockets.push(socket);
      socket.write(frame(JSON.stringify({ type: 'ready', senderKeyId: f.sender.senderKeyId })));
      socket.on('close', () => {
        const idx = sockets.indexOf(socket);
        if (idx >= 0) sockets.splice(idx, 1);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  try {
    const wsConfig: NotiBuddyConfig = { ...f.config, relay: `http://127.0.0.1:${port}` };
    const client = new NotiBuddyClient(
      wsConfig,
      f.sender.privateKey,
      new PendingStore(wsConfig, f.root),
      undefined,
      undefined,
      { enabled: true, keepAlive: true },
      undefined,
      { activityUpdateDebounceMs: 0, dispatchPaceMs: 0 },
    );
    try {
      await client.activity({ activityId: 'ws-act', action: 'start', title: 'Pipeline', step: 1, totalSteps: 5 });
      assert.equal(recipientGets, 1);
      assert.equal(sockets.length, 1, 'v2 activity start with keepAlive opens /v2/sender/ws');

      // 3 updates with WS connected and NO activity.available -> ZERO GET /v2/replies/:id!
      await client.activity({ activityId: 'ws-act', action: 'update', step: 2 });
      await client.activity({ activityId: 'ws-act', action: 'update', step: 3 });
      await client.activity({ activityId: 'ws-act', action: 'update', step: 4 });
      assert.equal(replyGets, 0, 'Connected /v2/sender/ws with no buffered announcement skips HTTP reply polling');
      assert.equal(recipientGets, 1, 'Cached /v2/recipients stays at 1 GET');

      // Watch taps Pause -> relay pushes activity.available over /v2/sender/ws!
      const ctrl = await f.groupControlReply(lastRequest!, 55);
      replies.set(lastRequest!.requestId, ctrl);
      for (const s of sockets) {
        s.write(frame(JSON.stringify({ type: 'activity.available', requestId: lastRequest!.requestId, seq: 55 })));
      }
      await new Promise((r) => setTimeout(r, 40));

      const afterSignal = await client.activity({ activityId: 'ws-act', action: 'update', step: 5 });
      assert.deepEqual(afterSignal.controls.map((c) => c.action), ['pause']);
      assert.ok(replyGets > 0 && replyGets <= 3);

      // Explicit action='poll' ALWAYS queries HTTP even when WS is connected with no buffered announcement!
      const getsBeforePoll = replyGets;
      const polled = await client.activity({ activityId: 'ws-act', action: 'poll' });
      assert.equal(polled.status, 'active');
      assert.ok(replyGets > getsBeforePoll, 'Explicit poll must always query HTTP');
      assert.ok(replyGets - getsBeforePoll <= 2, 'pollActivity must cap polled request IDs to <= 2');
    } finally {
      client.close();
    }
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('trailing debounce timer auto-flushes coalesced activity updates and loadScale scales fallback HTTP pollPause (capped at 15s)', async () => {
  const f = await makeFixture(1);
  const originalFetch = globalThis.fetch;
  try {
    const postedPayloads: any[] = [];
    const pollTimestamps: number[] = [];
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') {
        const envelope = JSON.parse(String(init.body)) as RequestEnvelope;
        postedPayloads.push(await f.openV1(envelope));
        return Response.json(
          { requestId: envelope.requestId, seq: postedPayloads.length },
          { status: 202, headers: { 'X-NotiBuddy-Load-Scale': '1' } },
        );
      }
      pollTimestamps.push(Date.now());
      return new Response(null, { status: 204, headers: { 'X-NotiBuddy-Load-Scale': '2' } });
    };

    const client = new NotiBuddyClient(
      f.config,
      f.sender.privateKey,
      f.store,
      undefined,
      undefined,
      { enabled: false },
      undefined,
      { activityUpdateDebounceMs: 60, dispatchPaceMs: 0 },
    );
    try {
      await client.activity({ activityId: 'auto-flush', action: 'start', title: 'Job', step: 1, totalSteps: 5 });
      await client.activity({ activityId: 'auto-flush', action: 'update', step: 2, status: 'Two' });
      await client.activity({ activityId: 'auto-flush', action: 'update', step: 3, status: 'Three' });
      assert.equal(postedPayloads.length, 1, 'Updates stay buffered before trailing timer fires');

      // Wait for trailing-edge timer (~60ms) to fire automatically without calling flushPendingActivities()
      const flushWaitDeadline = Date.now() + 2_000;
      while (postedPayloads.length < 2 && Date.now() < flushWaitDeadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(postedPayloads.length, 2, 'Trailing timer auto-flushes exactly ONE coalesced update');
      assert.equal(postedPayloads[1].step, 3);
      assert.equal(postedPayloads[1].status, 'Three');

      // Verify fallback HTTP pollPause scales by loadScale (2x -> first pause = 2000ms vs 1000ms)
      pollTimestamps.length = 0;
      const askResult = await client.ask({ title: 'Poll scaling', waitSeconds: 2.3 });
      assert.equal(askResult.status, 'pending');
      assert.equal(client.loadScale, 2);
      // At loadScale=2: poll #1 at t=0 (sets loadScale=2), pause=2000ms -> poll #2 at t~2000ms,
      // next pause=min(3000, remaining~300ms) -> deadline! So at most 2 polls in 2.3s (vs 3 polls at loadScale=1).
      assert.equal(pollTimestamps.length, 2);
      assert.ok(pollTimestamps[1] - pollTimestamps[0] >= 1_850, `Expected >=1850ms scaled poll gap, got ${pollTimestamps[1] - pollTimestamps[0]}ms`);
    } finally {
      client.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
