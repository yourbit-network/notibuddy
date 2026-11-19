import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NotiBuddyClient } from '../src/client.js';
import { DestinationStore } from '../src/config.js';
import {
  deriveDeviceId,
  ecdsaSign,
  ecdsaVerify,
  generateReplyKeyPair,
  generateSenderSigningKeyPair,
  hpkeOpen,
  hpkeSeal,
} from '../src/crypto.js';
import {
  groupDeliveryHeader,
  groupDeliveryInput,
  groupResponseHeader,
  groupResponseInput,
  type GroupRequest,
  type GroupResponse,
} from '../src/group-wire.js';
import { createMcpServer } from '../src/mcp.js';
import { PendingStore } from '../src/pending-store.js';
import { canonJson, type ScreenCanonValue } from '../src/screen-canon.js';
import {
  SCREEN_CATALOG_BY_SLUG,
  buildScreenTaSigningInput,
  type ScreenSignedTemplateRecord,
  type ScreenTaPublicKey,
} from '../src/screen-catalog.js';
import { verifySignedTemplateRecord } from '../src/screen-record.js';
import { ScreenTemplateStore, relayOriginOf } from '../src/screen-store.js';
import type { ScreenSkeleton, ScreenTemplateId } from '../src/screen-types.js';
import {
  buildScreenRenderedAnswer,
  buildScreenUnavailableAnswer,
  computeScreenContextDigest,
  computeTemplateId,
} from '../src/screen-wire.js';
import type { PairingBundle } from '../src/types.js';

process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 15 * DAY_MS;
const RETENTION_MS = 30 * DAY_MS;

function acceptWebSocketUpgrade(req: IncomingMessage, socket: Duplex): void {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function openGroupDeliveryPlaintext(
  request: GroupRequest,
  devicePrivKey: CryptoKey,
  senderPubKey: string,
): Promise<{ raw: string; parsed: any }> {
  const delivery = request.deliveries.find((d) => d.deviceId === request.deviceId);
  assert.ok(delivery, 'Missing primary delivery');
  const sigOk = await ecdsaVerify(senderPubKey, groupDeliveryInput(request, delivery), delivery.sig);
  assert.equal(sigOk, true, 'GroupRequest delivery signature must verify');
  const raw = await hpkeOpen(
    devicePrivKey,
    delivery.enc,
    'notibuddy/v2/request',
    groupDeliveryHeader(request, delivery.deviceId),
    delivery.ct,
  );
  return { raw, parsed: JSON.parse(raw) };
}

async function sealGroupReplyPlaintext(params: {
  request: GroupRequest;
  replyPub: string;
  responderDeviceId: string;
  responderSigKey: CryptoKey;
  plaintext: string;
}): Promise<GroupResponse> {
  const responseId = 'rsp_' + crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  const createdAt = params.request.createdAt + 1;
  const draft: GroupResponse = {
    v: 2,
    kind: 'reply',
    requestId: params.request.requestId,
    parentDeviceId: params.request.deviceId,
    deviceId: params.responderDeviceId,
    generation: params.request.generation,
    responseId,
    createdAt,
    enc: '',
    ct: '',
    receipts: [],
    sig: '',
  };
  const sealed = await hpkeSeal(
    params.replyPub,
    'notibuddy/v2/reply',
    groupResponseHeader(draft) + '|sender',
    params.plaintext,
  );
  draft.enc = sealed.enc;
  draft.ct = sealed.ct;
  draft.sig = await ecdsaSign(params.responderSigKey, groupResponseInput(draft));
  return draft;
}

function makeInteractiveInlineTemplate(): Record<string, unknown> {
  return {
    v: 1,
    root: {
      kind: 'card',
      header: 'Release Approval',
      children: [
        {
          kind: 'checklist',
          id: 'c0',
          title: 'Pre-flight checks',
          items: ['Unit tests green', 'Schema verified'],
        },
        {
          kind: 'formField',
          id: 'f0',
          fieldType: 'text',
          label: 'Change ticket',
          required: true,
          maxGraphemes: 64,
          maxBytes: 256,
        },
        {
          kind: 'diffViewer',
          diff: {
            filename: 'src/release.ts',
            language: 'typescript',
            original: 'return old();\n',
            modified: 'return next();\n',
          },
        },
      ],
    },
    actions: [
      {
        id: 'a0',
        label: 'Approve Release',
        role: 'primary',
        requireBio: true,
        enabledWhen: [
          { op: 'allChecked', checklist: 'c0' },
          { op: 'isNotEmpty', field: 'f0' },
        ],
      },
      {
        id: 'a1',
        label: 'Decline',
        role: 'decline',
        requireBio: false,
      },
    ],
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-screen-e2e-'));
  const mcpClients: Client[] = [];
  const sockets = new Set<Duplex>();

  let fakeNowMs = Date.UTC(2026, 10, 1, 12, 0, 0);

  const phoneEnc = await generateReplyKeyPair();
  const phoneSig = await generateSenderSigningKeyPair();
  const deviceId = await deriveDeviceId(phoneEnc.publicKeyB64u, phoneSig.publicKeyB64u);
  const device = {
    id: deviceId,
    encPub: phoneEnc.publicKeyB64u,
    sigPub: phoneSig.publicKeyB64u,
    name: 'E2E Test iPhone',
  };

  // Ephemeral attestation keypair
  const taKp = await generateSenderSigningKeyPair();
  const taKid = 'ta-attest-v1';
  const taPub: ScreenTaPublicKey = {
    kid: taKid,
    purpose: 'attestation',
    status: 'active',
    algorithm: 'ES256',
    publicKeyB64u: taKp.publicKeyB64u,
  };
  const resolveTa = (kid: string) => (kid === taKid ? taPub : undefined);
  let allowRestoreKids = new Set<string>([taKid]);

  const signSkeleton = async (skeleton: ScreenSkeleton): Promise<ScreenSignedTemplateRecord> => {
    const templateId = await computeTemplateId(skeleton);
    const sig = await ecdsaSign(taKp.privateKey, buildScreenTaSigningInput(taKid, templateId));
    return { v: 1, kid: taKid, templateId, skeleton, sig };
  };

  // Simulated R2 storage with fake-clock 30-day retention & exact write counter
  const r2Store = new Map<string, { body: string; uploadedMs: number }>();
  let r2PutCount = 0;
  let postRequestCount = 0;
  let wsUpgrades = 0;
  const eventLog: string[] = [];

  const getLiveR2 = (templateId: string) => {
    const entry = r2Store.get(templateId);
    if (!entry) return undefined;
    if (fakeNowMs - entry.uploadedMs >= RETENTION_MS) {
      r2Store.delete(templateId);
      return undefined;
    }
    return entry;
  };

  const replies = new Map<string, { seq: number; envelope: GroupResponse }>();
  let nextSeq = 1;
  let autoDeviceHandler:
    | ((req: GroupRequest, opened: { raw: string; parsed: any }) => Promise<void>)
    | undefined;

  const recipientsPayload = {
    v: 2,
    deviceId,
    generation: 1,
    primary: { deviceId, encPub: phoneEnc.publicKeyB64u, sigPub: phoneSig.publicKeyB64u },
    companions: [],
  };

  let senderKeyId = '';
  let senderPubKey = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    eventLog.push(`${method} ${url.pathname}`);

    try {
      if (method === 'GET' && url.pathname === '/v2/recipients') {
        sendJson(res, 200, recipientsPayload);
        return;
      }

      if (method === 'POST' && url.pathname === '/v2/templates') {
        const body = JSON.parse(await readBody(req)) as {
          skeleton: ScreenSkeleton;
          mode?: 'auto' | 'strict';
        };
        const record = await signSkeleton(body.skeleton);
        const existing = getLiveR2(record.templateId);
        if (!existing || fakeNowMs - existing.uploadedMs >= REFRESH_AFTER_MS) {
          r2PutCount += 1;
          r2Store.set(record.templateId, {
            body: canonJson(record as unknown as ScreenCanonValue),
            uploadedMs: fakeNowMs,
          });
        }
        sendJson(res, 200, {
          status: 'certified',
          repaired: false,
          templateId: record.templateId,
          record,
          changes: [],
        });
        return;
      }

      if (method === 'GET' && url.pathname.startsWith('/templates/')) {
        assert.equal(req.headers.authorization, undefined, 'GET /templates/:id must be unauthenticated');
        assert.equal(req.headers['x-sender-signature'], undefined, 'GET /templates/:id must send no sender signature');
        const templateId = url.pathname.slice('/templates/'.length);
        const entry = getLiveR2(templateId);
        if (!entry) {
          sendJson(res, 404, { error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' }, { 'Cache-Control': 'no-store' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(entry.body);
        return;
      }

      if (method === 'PUT' && url.pathname.startsWith('/v2/templates/')) {
        assert.ok(req.headers.authorization?.startsWith('Bearer '), 'PUT must be sender-authenticated');
        assert.ok(typeof req.headers['x-sender-signature'] === 'string', 'PUT must be sender-signed');
        const templateId = url.pathname.slice('/v2/templates/'.length);
        const parsed = JSON.parse(await readBody(req)) as ScreenSignedTemplateRecord;
        assert.equal(parsed.templateId, templateId);
        if (!allowRestoreKids.has(parsed.kid)) {
          sendJson(res, 422, { error: 'Template signing key retired', code: 'TEMPLATE_KEY_RETIRED' });
          return;
        }
        const existing = getLiveR2(templateId);
        if (existing) {
          const ageMs = fakeNowMs - existing.uploadedMs;
          if (ageMs < REFRESH_AFTER_MS) {
            sendJson(res, 200, { status: 'fresh' });
            return;
          }
          r2PutCount += 1;
          r2Store.set(templateId, {
            body: canonJson(parsed as unknown as ScreenCanonValue),
            uploadedMs: fakeNowMs,
          });
          sendJson(res, 200, { status: 'refreshed' });
          return;
        }
        r2PutCount += 1;
        r2Store.set(templateId, {
          body: canonJson(parsed as unknown as ScreenCanonValue),
          uploadedMs: fakeNowMs,
        });
        sendJson(res, 200, { status: 'restored' });
        return;
      }

      if (method === 'POST' && url.pathname === '/v2/requests') {
        postRequestCount += 1;
        const body = JSON.parse(await readBody(req)) as GroupRequest;
        const seq = nextSeq++;
        if (autoDeviceHandler) {
          const opened = await openGroupDeliveryPlaintext(body, phoneEnc.privateKey, senderPubKey);
          await autoDeviceHandler(body, opened);
        }
        sendJson(res, 202, { requestId: body.requestId, seq });
        return;
      }

      if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) {
        const requestId = url.pathname.slice('/v2/replies/'.length);
        const reply = replies.get(requestId);
        if (!reply) {
          res.writeHead(204);
          res.end();
          return;
        }
        sendJson(res, 200, reply);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.on('upgrade', (req, socket) => {
    if (req.url === '/v2/sender/ws') {
      assert.equal(req.headers['x-sender-key-id'], senderKeyId);
      assert.ok(typeof req.headers['x-sender-signature'] === 'string');
      wsUpgrades += 1;
      acceptWebSocketUpgrade(req, socket);
      sockets.add(socket);
      socket.write(encodeWsTextFrame(JSON.stringify({ type: 'ready', senderKeyId })));
      socket.on('data', (chunk: Buffer) => {
        if (chunk.length > 0 && (chunk[0] & 0x0f) === 0x08) {
          socket.end(Buffer.from([0x88, 0x00]));
        }
      });
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const relayUrl = `http://127.0.0.1:${address.port}`;

  const pushWsReplyAvailable = (requestId: string, seq: number) => {
    const frame = encodeWsTextFrame(JSON.stringify({ type: 'reply.available', requestId, seq }));
    for (const s of sockets) s.write(frame);
  };

  try {
    const profileRoot = path.join(root, 'profile');
    const store = new DestinationStore(profileRoot);
    const token = 'nb_snd_' + crypto.randomUUID().replaceAll('-', '');
    const bundle: PairingBundle = {
      v: 1,
      relay: relayUrl,
      token,
      pairSecret: Buffer.alloc(32).toString('base64url'),
      device,
      requestProtocol: 2,
    };
    const paired = await store.prepare('e2e', bundle, 'E2E Agent');
    senderKeyId = paired.record.config.senderKeyId;
    senderPubKey = paired.record.keys.publicKeyB64u;

    const makeClient = (homeDir = store.root, streamEnabled = true) =>
      new NotiBuddyClient(
        paired.record.config,
        paired.signingKey,
        new PendingStore(paired.record.config, homeDir),
        'E2E-Agent',
        undefined,
        { enabled: streamEnabled, keepAlive: false },
        { now: () => fakeNowMs, resolveTaPublicKey: resolveTa },
      );

    // Connect real MCP server over InMemoryTransport
    const mcpServer = await createMcpServer({ to: 'e2e' }, store);
    const mcpClient = new Client({ name: 'screen-e2e-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    mcpClients.push(mcpClient);

    const callNotify = async (args: Record<string, unknown>) => {
      const result = await mcpClient.callTool({ name: 'notibuddy_notify', arguments: args });
      assert.notEqual(result.isError, true, `Unexpected MCP tool error: ${JSON.stringify(result.content)}`);
      const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text;
      assert.ok(text, 'Expected JSON text content from notibuddy_notify');
      return JSON.parse(text);
    };

    // =========================================================================
    // 1. Full MCP `notibuddy_notify.screen` E2E round-trip via real `/v2/sender/ws`
    //    + `resume_id` verification + wizard `thread.prev` step n+1
    // =========================================================================
    const catalogEntry = SCREEN_CATALOG_BY_SLUG.action_checklist;
    const checklistScreen = {
      templateId: 'action_checklist',
      labels: {
        s0: 'Pre-Release Verification',
        s1: 'Release v2.5.0',
        s2: 'Confirm all checks before cutting release.',
        s3: 'Checks',
        s4: 'Required Steps',
        s6: 'Confirm production freeze',
        s7: 'Proceed',
        s8: 'Cancel',
      },
      data: {
        s5: ['Unit tests green', 'Schema verified'],
      },
    };

    autoDeviceHandler = async (req, opened) => {
      assert.equal(req.primitive, 'screen');
      assert.equal(opened.parsed.templateId, catalogEntry.templateId);

      const contextDigest = await computeScreenContextDigest(
        req.requestId,
        new TextEncoder().encode(opened.raw),
      );
      const answer = await buildScreenRenderedAnswer(
        contextDigest,
        'a0',
        { c0: [true, true], f0: true },
        true,
      );

      const replyEnv = await sealGroupReplyPlaintext({
        request: req,
        replyPub: opened.parsed.replyPub,
        responderDeviceId: deviceId,
        responderSigKey: phoneSig.privateKey,
        plaintext: JSON.stringify(answer),
      });
      const seq = nextSeq++;
      setTimeout(() => {
        replies.set(req.requestId, { seq, envelope: replyEnv });
        pushWsReplyAvailable(req.requestId, seq);
      }, 60).unref();
    };

    const mcpStep1 = await callNotify({
      title: 'Deploy v2.5.0',
      requires_auth: true,
      wait_seconds: 5,
      screen: checklistScreen,
    });
    assert.equal(mcpStep1.status, 'resolved');
    assert.equal(mcpStep1.answer.action, 'a0');
    assert.deepEqual(mcpStep1.answer.values.form, { c0: [true, true], f0: true });
    assert.match(mcpStep1.answer.values.render.digest, /^[0-9a-f]{64}$/);
    assert.ok(wsUpgrades >= 1, 'Expected live /v2/sender/ws connection for immediate wakeup');

    // Wizard Step 2 with thread.prev + offline restart resume_id verification
    let step2OpenedThread: unknown;
    let deferredStep2Reply: (() => Promise<void>) | undefined;
    autoDeviceHandler = async (req, opened) => {
      step2OpenedThread = opened.parsed.thread;
      deferredStep2Reply = async () => {
        const contextDigest = await computeScreenContextDigest(
          req.requestId,
          new TextEncoder().encode(opened.raw),
        );
        const answer = await buildScreenRenderedAnswer(
          contextDigest,
          'a0',
          { c0: [true, true], f0: true },
          true,
        );
        const replyEnv = await sealGroupReplyPlaintext({
          request: req,
          replyPub: opened.parsed.replyPub,
          responderDeviceId: deviceId,
          responderSigKey: phoneSig.privateKey,
          plaintext: JSON.stringify(answer),
        });
        replies.set(req.requestId, { seq: nextSeq++, envelope: replyEnv });
      };
    };

    const step2Pending = await callNotify({
      title: 'Wizard Step 2',
      requires_auth: true,
      wait_seconds: 0,
      screen: {
        ...checklistScreen,
        thread: {
          id: 'thr_e2e_wizard',
          step: 2,
          of: 2,
          prev: {
            requestId: mcpStep1.requestId,
            renderDigest: mcpStep1.answer.values.render.digest,
          },
        },
      },
    });
    assert.equal(step2Pending.status, 'pending');
    assert.deepEqual(step2OpenedThread, {
      id: 'thr_e2e_wizard',
      step: 2,
      of: 2,
      prev: {
        requestId: mcpStep1.requestId,
        renderDigest: mcpStep1.answer.values.render.digest,
      },
    });
    assert.ok(deferredStep2Reply);
    await deferredStep2Reply();

    const step2Resumed = await callNotify({
      resume_id: step2Pending.requestId,
      wait_seconds: 0,
    });
    assert.equal(step2Resumed.status, 'resolved');
    assert.equal(step2Resumed.answer.action, 'a0');
    assert.match(step2Resumed.answer.values.render.digest, /^[0-9a-f]{64}$/);

    // =========================================================================
    // 2. Inline ad-hoc checklist + form + diff round-trip with device hydration
    //    over unauthenticated GET /templates/:id + real /v2/sender/ws wakeup
    // =========================================================================
    const inlineDraft = makeInteractiveInlineTemplate();
    let certifiedTemplateId: ScreenTemplateId = 'tpl_' + '0'.repeat(64) as ScreenTemplateId;
    let certifiedLabels: Record<string, string> = {};
    let certifiedData: Record<string, any> = {};

    autoDeviceHandler = async (req, opened) => {
      const tplId = opened.parsed.templateId as ScreenTemplateId;
      certifiedTemplateId = tplId;
      certifiedLabels = opened.parsed.labels;
      certifiedData = opened.parsed.data;
      // Device hydrates via unauthenticated GET /templates/:id and verifies TA signature + hash
      const tplRes = await fetch(`${relayUrl}/templates/${tplId}`);
      assert.equal(tplRes.status, 200);
      const rawRecord = JSON.parse(await tplRes.text()) as ScreenSignedTemplateRecord;
      const verified = await verifySignedTemplateRecord(rawRecord, {
        expectedTemplateId: tplId,
        expectedPurpose: 'attestation',
        resolveTaPublicKey: resolveTa,
      });
      assert.equal(verified.templateId, tplId);

      const contextDigest = await computeScreenContextDigest(
        req.requestId,
        new TextEncoder().encode(opened.raw),
      );
      const answer = await buildScreenRenderedAnswer(
        contextDigest,
        'a0',
        { c0: [true, true], f0: 'CHG-2048' },
        true,
      );

      const replyEnv = await sealGroupReplyPlaintext({
        request: req,
        replyPub: opened.parsed.replyPub,
        responderDeviceId: deviceId,
        responderSigKey: phoneSig.privateKey,
        plaintext: JSON.stringify(answer),
      });
      const seq = nextSeq++;
      setTimeout(() => {
        replies.set(req.requestId, { seq, envelope: replyEnv });
        pushWsReplyAvailable(req.requestId, seq);
      }, 60).unref();
    };

    const adHocRoundTrip = await makeClient(store.root, true).ask({
      title: 'Inline Checklist + Form + Diff',
      requiresAuth: true,
      waitSeconds: 5,
      screen: { template: inlineDraft as any },
    });
    assert.equal(adHocRoundTrip.status, 'resolved');
    assert.equal(adHocRoundTrip.answer?.action, 'a0');
    assert.deepEqual((adHocRoundTrip.answer?.values as any)?.form, { c0: [true, true], f0: 'CHG-2048' });
    assert.match((adHocRoundTrip.answer?.values as any)?.render?.digest, /^[0-9a-f]{64}$/);

    // =========================================================================
    // 3. All Six Fake-Clock Retention E2E Scenarios
    // =========================================================================
    autoDeviceHandler = undefined;
    const screenStore = new ScreenTemplateStore(store.root);
    const cachePath = screenStore.recordPath(relayOriginOf(relayUrl), certifiedTemplateId);
    assert.ok(fs.existsSync(cachePath), 'Local template record must be persisted after certification');
    const cachedRecord = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      record: ScreenSignedTemplateRecord;
    };

    // Scenario 1: Day 5 PUT no-op (`fresh`, 0 R2 writes)
    fakeNowMs += 5 * DAY_MS;
    const putsBeforeDay5 = r2PutCount;
    eventLog.length = 0;
    const day5Send = await makeClient(store.root, false).ask({
      title: 'Day 5 Send',
      screen: { templateId: certifiedTemplateId, labels: certifiedLabels, data: certifiedData },
      waitSeconds: 0,
    });
    assert.equal(day5Send.status, 'pending');
    assert.equal(r2PutCount - putsBeforeDay5, 0, 'Day 5 must perform 0 R2 writes');
    assert.ok(!eventLog.some((e) => e.startsWith('PUT /v2/templates/')), 'Day 5 cached client skips PUT');

    // Also verify server-side Day 5 PUT directly returns { status: "fresh" } with 0 R2 writes
    const day5DirectPut = await fetch(`${relayUrl}/v2/templates/${certifiedTemplateId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Sender-Signature': 'fixture-sig',
        'Content-Type': 'application/json',
      },
      body: canonJson(cachedRecord.record as unknown as ScreenCanonValue),
    });
    assert.equal(day5DirectPut.status, 200);
    assert.deepEqual(await day5DirectPut.json(), { status: 'fresh' });
    assert.equal(r2PutCount - putsBeforeDay5, 0, 'Server Day 5 PUT must perform 0 R2 writes');

    // Scenario 2: Day 16 PUT refresh (`refreshed`, 1 R2 write, strictly before POST /v2/requests)
    fakeNowMs += 11 * DAY_MS; // Day 16 since Day 0
    const putsBeforeDay16 = r2PutCount;
    eventLog.length = 0;
    const day16Send = await makeClient(store.root, false).ask({
      title: 'Day 16 Refresh',
      screen: { templateId: certifiedTemplateId, labels: certifiedLabels, data: certifiedData },
      waitSeconds: 0,
    });
    assert.equal(day16Send.status, 'pending');
    assert.equal(r2PutCount - putsBeforeDay16, 1, 'Day 16 must perform exactly 1 R2 write');
    const putIdx16 = eventLog.indexOf(`PUT /v2/templates/${certifiedTemplateId}`);
    const postIdx16 = eventLog.indexOf('POST /v2/requests');
    assert.ok(putIdx16 >= 0 && postIdx16 > putIdx16, 'Day 16 PUT must complete before POST /v2/requests');

    // Scenario 3: Day 35 after refresh (R2 expired at 30d) with local record restores & sends (`restored`, 1 R2 write)
    fakeNowMs += 35 * DAY_MS;
    assert.equal(getLiveR2(certifiedTemplateId), undefined, 'R2 entry must be expired at Day 35');
    const putsBeforeDay35 = r2PutCount;
    eventLog.length = 0;
    const day35Restore = await makeClient(store.root, false).ask({
      title: 'Day 35 Restore',
      screen: { templateId: certifiedTemplateId, labels: certifiedLabels, data: certifiedData },
      waitSeconds: 0,
    });
    assert.equal(day35Restore.status, 'pending');
    assert.equal(r2PutCount - putsBeforeDay35, 1, 'Day 35 restore must perform 1 R2 write');
    assert.ok(getLiveR2(certifiedTemplateId), 'R2 entry must be live after Day 35 restore');
    const putIdx35 = eventLog.indexOf(`PUT /v2/templates/${certifiedTemplateId}`);
    const postIdx35 = eventLog.indexOf('POST /v2/requests');
    assert.ok(putIdx35 >= 0 && postIdx35 > putIdx35, 'Day 35 restore PUT must precede POST /v2/requests');

    // Scenario 4: Day 35 bare ID (expired in R2, fresh client with no local record) fails fast with TEMPLATE_EXPIRED & 0 POST /v2/requests
    fakeNowMs += 35 * DAY_MS;
    assert.equal(getLiveR2(certifiedTemplateId), undefined);
    const bareHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-screen-e2e-bare-'));
    try {
      const postsBeforeBare = postRequestCount;
      const bareResult = await makeClient(bareHome, false).ask({
        title: 'Day 35 Bare ID',
        screen: { templateId: certifiedTemplateId, labels: certifiedLabels, data: certifiedData },
        waitSeconds: 0,
      });
      assert.equal(bareResult.status, 'error');
      assert.equal(bareResult.errorCode, 'TEMPLATE_EXPIRED');
      assert.equal(postRequestCount - postsBeforeBare, 0, 'TEMPLATE_EXPIRED must send 0 POST /v2/requests');
    } finally {
      fs.rmSync(bareHome, { recursive: true, force: true });
    }

    // Scenario 5: Retired kid returns 422 TEMPLATE_KEY_RETIRED (0 POST /v2/requests, 0 R2 writes)
    allowRestoreKids = new Set<string>(['ta-attest-v2']);
    const putsBeforeRetired = r2PutCount;
    const postsBeforeRetired = postRequestCount;
    const retiredResult = await makeClient(store.root, false).ask({
      title: 'Retired Key',
      screen: { templateId: certifiedTemplateId, labels: certifiedLabels, data: certifiedData },
      waitSeconds: 0,
    });
    assert.equal(retiredResult.status, 'error');
    assert.equal(retiredResult.errorCode, 'TEMPLATE_KEY_RETIRED');
    assert.equal(r2PutCount - putsBeforeRetired, 0, 'Retired kid must perform 0 R2 writes');
    assert.equal(postRequestCount - postsBeforeRetired, 0, 'Retired kid must send 0 POST /v2/requests');

    // Scenario 6: Device 404 -> host Dismiss -> TEMPLATE_UNAVAILABLE_ON_DEVICE (via /v2/sender/ws)
    allowRestoreKids = new Set<string>([taKid]);
    autoDeviceHandler = async (req, opened) => {
      // Simulate R2 object missing when device tries to hydrate -> 404 -> host Dismiss
      r2Store.delete(opened.parsed.templateId);
      const missRes = await fetch(`${relayUrl}/templates/${opened.parsed.templateId}`);
      assert.equal(missRes.status, 404);
      const dismissEnv = await sealGroupReplyPlaintext({
        request: req,
        replyPub: opened.parsed.replyPub,
        responderDeviceId: deviceId,
        responderSigKey: phoneSig.privateKey,
        plaintext: JSON.stringify(buildScreenUnavailableAnswer()),
      });
      const seq = nextSeq++;
      setTimeout(() => {
        replies.set(req.requestId, { seq, envelope: dismissEnv });
        pushWsReplyAvailable(req.requestId, seq);
      }, 60).unref();
    };

    const unavailableRes = await makeClient(store.root, true).ask({
      title: 'Device 404 Dismiss',
      waitSeconds: 5,
      screen: {
        templateId: certifiedTemplateId,
        labels: certifiedLabels,
        data: certifiedData,
      },
    });
    assert.equal(unavailableRes.status, 'error');
    assert.equal(unavailableRes.errorCode, 'TEMPLATE_UNAVAILABLE_ON_DEVICE');

    console.log('MCP screen E2E round-trip, wizard thread, /v2/sender/ws, resume_id, and 6 fake-clock retention scenarios passed.');
  } finally {
    for (const c of mcpClients) await c.close().catch(() => {});
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
