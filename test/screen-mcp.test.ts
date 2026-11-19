import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import { groupDeliveryHeader, groupDeliveryInput, groupResponseHeader, groupResponseInput, type GroupRequest, type GroupResponse } from '../src/group-wire.js';
import { createMcpServer } from '../src/mcp.js';
import { PendingStore } from '../src/pending-store.js';
import { canonJson, type ScreenCanonValue } from '../src/screen-canon.js';
import {
  SCREEN_CATALOG_BY_SLUG,
  buildScreenTaSigningInput,
  type ScreenSignedTemplateRecord,
  type ScreenTaPublicKey,
} from '../src/screen-catalog.js';
import { repairedTemplateOutputPath, writeRepairedTemplateFile } from '../src/screen-file.js';
import {
  MAX_PUBLIC_TEMPLATE_BYTES,
  fetchPublicTemplateRecord,
  verifyScreenSettlement,
} from '../src/screen-client.js';
import { validateScreenRequestBindings } from '../src/screen-record.js';
import { SKELETONIZER_VERSION, skeletonizeScreenTemplate } from '../src/screen-skeletonizer.js';
import { SCREEN_REFRESH_AFTER_MS, ScreenTemplateStore, relayOriginOf } from '../src/screen-store.js';
import type { ScreenSkeleton, ScreenTemplateId } from '../src/screen-types.js';
import {
  buildScreenRenderedAnswer,
  buildScreenUnavailableAnswer,
  computeScreenContextDigest,
  computeTemplateId,
} from '../src/screen-wire.js';
import type { PairingBundle } from '../src/types.js';

process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1';

// Public signed record created offline with the pre-provisioned `ta-attest-v2` key (no private key in repo).
const PREPROVISIONED_ATTEST_V2_RECORD: ScreenSignedTemplateRecord = JSON.parse(
  '{"kid":"ta-attest-v2","sig":"WP5g9teZKHlK8WU_2Nv_HkEXYYdlOw6YHomxMWFCmwkN-YZdL8GM0tkU8dtPSQh2s4znfdCj5hFaNQ5h3swRRA","skeleton":{"actions":[{"id":"a0","label":{"maxBytes":128,"maxGraphemes":32,"slot":"s2"},"requireBio":false,"role":"primary"}],"root":{"children":[{"kind":"text","style":"body","text":{"maxBytes":512,"maxGraphemes":128,"slot":"s1"}}],"header":{"maxBytes":256,"maxGraphemes":64,"slot":"s0"},"kind":"card"},"v":1},"templateId":"tpl_77bc1d9d1f9b3511d98ed6e80bb2abef41cd8ac700484783ccb2a074c315b264","v":1}'
);

async function makeEphemeralTa(kid = 'ta-attest-v1') {
  const kp = await generateSenderSigningKeyPair();
  const pubEntry: ScreenTaPublicKey = {
    kid,
    purpose: 'attestation',
    status: 'active',
    algorithm: 'ES256',
    publicKeyB64u: kp.publicKeyB64u,
  };
  const signSkeleton = async (skeleton: ScreenSkeleton): Promise<ScreenSignedTemplateRecord> => {
    const templateId = await computeTemplateId(skeleton);
    const sig = await ecdsaSign(kp.privateKey, buildScreenTaSigningInput(kid, templateId));
    return { v: 1, kid, templateId, skeleton, sig };
  };
  return { pubEntry, signSkeleton };
}

async function openGroupDeliveryPlaintext(
  request: GroupRequest,
  devicePrivKey: CryptoKey,
  senderPubKey: string
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
    delivery.ct
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
  const responseId = 'rsp_' + randomUUID().replaceAll('-', '').slice(0, 24);
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
    params.plaintext
  );
  draft.enc = sealed.enc;
  draft.ct = sealed.ct;
  draft.sig = await ecdsaSign(params.responderSigKey, groupResponseInput(draft));
  return draft;
}

function runCliProcess(
  args: string[],
  env: Record<string, string>
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliPath, ...args], {
      env: { ...process.env, ...env, NOTIBUDDY_NO_UPDATE_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-screen-mcp-'));
  const originalFetch = globalThis.fetch;
  const httpServers: ReturnType<typeof createServer>[] = [];
  const mcpClients: Client[] = [];

  try {
    const phoneEnc = await generateReplyKeyPair();
    const phoneSig = await generateSenderSigningKeyPair();
    const deviceId = await deriveDeviceId(phoneEnc.publicKeyB64u, phoneSig.publicKeyB64u);
    const device = { id: deviceId, encPub: phoneEnc.publicKeyB64u, sigPub: phoneSig.publicKeyB64u, name: 'Test iPhone' };

    const recipientsPayload = {
      v: 2,
      deviceId,
      generation: 1,
      primary: { deviceId, encPub: phoneEnc.publicKeyB64u, sigPub: phoneSig.publicKeyB64u },
      companions: [],
    };

    const profileRoot = path.join(root, 'profile');
    const store = new DestinationStore(profileRoot);
    const relayA = 'https://relay-a.fixture.invalid';
    const relayB = 'https://relay-b.fixture.invalid';
    const token = 'nb_snd_' + randomUUID().replaceAll('-', '');
    const bundleV2: PairingBundle = {
      v: 1,
      relay: relayA,
      token,
      pairSecret: Buffer.alloc(32).toString('base64url'),
      device,
      requestProtocol: 2,
    };
    const pairedA = await store.prepare('phone-v2', bundleV2, 'Screen Test Mac');
    const pairedB = await store.prepare('phone-v2-b', { ...bundleV2, relay: relayB }, 'Screen Test Mac B');
    const pairedV1 = await store.prepare(
      'phone-v1',
      { ...bundleV2, requestProtocol: 1 },
      'Legacy V1 Mac'
    );

    const ta = await makeEphemeralTa('ta-attest-v1');
    const resolveTa = (kid: string) => (kid === 'ta-attest-v1' ? ta.pubEntry : undefined);

    let fakeNow = Date.parse('2026-11-01T00:00:00Z');
    const nowFn = () => fakeNow;

    const makeClient = (paired = pairedA, useDefaultPinnedKeys = false) =>
      new NotiBuddyClient(
        paired.record.config,
        paired.signingKey,
        new PendingStore(paired.record.config, store.root),
        'Screen-Agent',
        undefined,
        { enabled: false },
        useDefaultPinnedKeys ? { now: nowFn } : { now: nowFn, resolveTaPublicKey: resolveTa }
      );

    const actionChecklistScreen = {
      templateId: 'action_checklist',
      labels: {
        s0: 'Pre-Release Verification',
        s1: 'Release v1.2.0',
        s2: 'Confirm all checks before cutting release.',
        s3: 'Checks',
        s4: 'Required Steps',
        s6: 'Confirm production freeze',
        s7: 'Proceed',
        s8: 'Cancel',
      },
      data: {
        s5: ['CI green', 'Changelog updated'],
      },
    };
    const kpiStatusScreen = {
      templateId: 'kpi_status_card',
      labels: {
        s0: 'Service Health',
        s1: 'Production API',
        s2: 'Healthy',
        s4: 'All regions nominal.',
        s5: 'Details',
        s7: 'Acknowledge',
        s8: 'Snooze',
      },
      data: {
        s3: [{ label: 'Errors', value: 0 }],
        s6: [{ key: 'Region', value: 'us-east-1' }],
      },
    };

    // -------------------------------------------------------------------------
    // 1. Protocol v1 destination fails fast with 0 HTTP calls
    // -------------------------------------------------------------------------
    {
      let httpCalls = 0;
      globalThis.fetch = async () => {
        httpCalls += 1;
        return new Response(null, { status: 500 });
      };
      await assert.rejects(
        makeClient(pairedV1).ask({
          title: 'Legacy',
          screen: kpiStatusScreen,
          waitSeconds: 0,
        }),
        /Protocol v2/
      );
      assert.equal(httpCalls, 0, 'v1 rejection must perform 0 HTTP calls');
    }

    // -------------------------------------------------------------------------
    // 2. Catalog template (slug + tpl_ ID): 0 GET, 0 PUT, 0 POST /v2/templates;
    //    rendered answer verification + restart resume_id + D46 no plaintext on disk
    // -------------------------------------------------------------------------
    {
      const catalogEntry = SCREEN_CATALOG_BY_SLUG.action_checklist;
      const calls: string[] = [];
      const postedRequests: GroupRequest[] = [];
      const replies = new Map<string, GroupResponse>();

      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url.pathname}`);
        if (method === 'GET' && url.pathname === '/v2/recipients') {
          return Response.json(recipientsPayload);
        }
        if (method === 'POST' && url.pathname === '/v2/requests') {
          const req = JSON.parse(String(init?.body)) as GroupRequest;
          postedRequests.push(req);
          return Response.json({ requestId: req.requestId, seq: postedRequests.length }, { status: 202 });
        }
        if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) {
          const reqId = url.pathname.slice('/v2/replies/'.length);
          const rep = replies.get(reqId);
          return rep ? Response.json({ seq: 1, envelope: rep }) : new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected call: ${method} ${url.pathname}`);
      };

      // Send via catalog slug with waitSeconds=0 (returns pending), then resume via a brand-new client instance.
      const pendingRes = await makeClient(pairedA, true).ask({
        title: 'Release Checklist',
        requiresAuth: true,
        screen: actionChecklistScreen,
        waitSeconds: 0,
      });
      assert.equal(pendingRes.status, 'pending');
      assert.equal(pendingRes.templateId, catalogEntry.templateId);
      assert.equal(postedRequests.length, 1);
      assert.equal(postedRequests[0]!.primitive, 'screen');
      assert.equal(postedRequests[0]!.sessionId, postedRequests[0]!.requestId);
      assert.equal(postedRequests[0]!.revision, 1);
      assert.ok(!calls.some((c) => c.includes('/templates')), 'Catalog IDs must never GET/PUT/POST templates');

      // Verify zero plaintext labels/data/title leaked into PendingStore on disk.
      const pendingDir = path.join(store.root, 'pending');
      const allPendingContents = fs
        .readdirSync(pendingDir, { recursive: true })
        .filter((f) => String(f).endsWith('.json'))
        .map((f) => fs.readFileSync(path.join(pendingDir, String(f)), 'utf8'))
        .join('\n');
      assert.ok(!allPendingContents.includes('Pre-Release Verification'), 'PendingStore must not store plaintext labels');
      assert.ok(!allPendingContents.includes('Changelog updated'), 'PendingStore must not store plaintext data');

      // Decrypt request as primary phone and produce a verified rendered answer.
      const opened = await openGroupDeliveryPlaintext(
        postedRequests[0]!,
        phoneEnc.privateKey,
        pairedA.record.keys.publicKeyB64u
      );
      assert.equal(opened.parsed.templateId, catalogEntry.templateId);
      assert.equal(opened.parsed.title, 'Release Checklist');
      const ctxDigest = await computeScreenContextDigest(
        postedRequests[0]!.requestId,
        new TextEncoder().encode(opened.raw)
      );
      const renderedAnswer = await buildScreenRenderedAnswer(
        ctxDigest,
        'a0',
        { c0: [true, true], f0: true },
        true
      );
      replies.set(
        postedRequests[0]!.requestId,
        await sealGroupReplyPlaintext({
          request: postedRequests[0]!,
          replyPub: opened.parsed.replyPub,
          responderDeviceId: deviceId,
          responderSigKey: phoneSig.privateKey,
          plaintext: JSON.stringify(renderedAnswer),
        })
      );

      // Resume from fresh client instance (cold restart simulation).
      const resumed = await makeClient(pairedA, true).ask({
        resumeId: pendingRes.requestId,
        waitSeconds: 0,
      });
      assert.equal(resumed.status, 'resolved');
      assert.deepEqual(resumed.answer, renderedAnswer);

      // Even 40 days later, catalog tpl_ ID makes 0 template GET/PUT calls.
      fakeNow += 40 * 24 * 60 * 60 * 1000;
      calls.length = 0;
      const byId = await makeClient(pairedA, true).ask({
        title: 'Catalog By ID',
        screen: {
          ...actionChecklistScreen,
          templateId: catalogEntry.templateId,
        },
        waitSeconds: 0,
      });
      assert.equal(byId.status, 'pending');
      assert.ok(!calls.some((c) => c.includes('/templates')), 'Catalog tpl_ ID must never GET/PUT after 40 days');
    }

    // -------------------------------------------------------------------------
    // 3. Bare templateId resolution order:
    //    - Missing locally + GET 404 -> definitive TEMPLATE_EXPIRED with 0 POST /v2/requests
    //    - Missing locally + GET 200 (real pre-provisioned ta-attest-v2 record, NO auth header)
    //      -> caches without lastRefreshedAt -> awaits 1 PUT before POST /v2/requests
    //    - Subsequent send on Day 5 -> 0 GET, 0 PUT
    //    - Day 16 -> awaits 1 PUT BEFORE POST /v2/requests (verified ordering!)
    // -------------------------------------------------------------------------
    {
      const missingId: ScreenTemplateId = `tpl_${'a'.repeat(64)}`;
      const calls: string[] = [];
      let postRequestCount = 0;

      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url.pathname}`);
        if (method === 'GET' && url.pathname === `/templates/${missingId}`) {
          const headers = new Headers(init?.headers);
          assert.equal(headers.get('authorization'), null, 'Public GET /templates/:id must send no Authorization header');
          assert.equal(headers.get('x-sender-signature'), null, 'Public GET /templates/:id must send no X-Sender-Signature');
          return Response.json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' }, { status: 404 });
        }
        if (method === 'POST' && url.pathname === '/v2/requests') {
          postRequestCount += 1;
        }
        throw new Error(`Unexpected call: ${method} ${url.pathname}`);
      };

      const expired = await makeClient(pairedA, true).ask({
        title: 'Expired bare ID',
        screen: { templateId: missingId, labels: {}, data: {} },
        waitSeconds: 0,
      });
      assert.equal(expired.status, 'error');
      assert.equal(expired.errorCode, 'TEMPLATE_EXPIRED');
      assert.equal(postRequestCount, 0, 'TEMPLATE_EXPIRED must send 0 POST /v2/requests');
      assert.deepEqual(calls, [`GET /templates/${missingId}`]);

      // Now test the REAL pre-provisioned `ta-attest-v2` signed record with default pinned public keys!
      const v2Id = PREPROVISIONED_ATTEST_V2_RECORD.templateId;
      const orderedEvents: string[] = [];
      let putCompleted = false;

      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        orderedEvents.push(`start:${method} ${url.pathname}`);
        if (method === 'GET' && url.pathname === `/templates/${v2Id}`) {
          const headers = new Headers(init?.headers);
          assert.equal(headers.get('authorization'), null, 'GET /templates/:id must be unauthenticated');
          assert.equal(headers.get('x-sender-key-id'), null);
          orderedEvents.push(`end:${method} ${url.pathname}`);
          return new Response(canonJson(PREPROVISIONED_ATTEST_V2_RECORD as unknown as ScreenCanonValue), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (method === 'PUT' && url.pathname === `/v2/templates/${v2Id}`) {
          const headers = new Headers(init?.headers);
          assert.ok(headers.get('authorization')?.startsWith('Bearer '), 'PUT must be sender-authenticated');
          assert.ok(headers.get('x-sender-signature'), 'PUT must be sender-signed');
          await new Promise((r) => setTimeout(r, 15));
          putCompleted = true;
          orderedEvents.push(`end:${method} ${url.pathname}`);
          return Response.json({ status: 'fresh' });
        }
        if (method === 'GET' && url.pathname === '/v2/recipients') {
          assert.equal(putCompleted, true, 'PUT refresh must complete before sealing/dispatch');
          return Response.json(recipientsPayload);
        }
        if (method === 'POST' && url.pathname === '/v2/requests') {
          assert.equal(putCompleted, true, 'PUT refresh must be awaited before POST /v2/requests');
          const req = JSON.parse(String(init?.body)) as GroupRequest;
          orderedEvents.push(`end:${method} ${url.pathname}`);
          return Response.json({ requestId: req.requestId, seq: 1 }, { status: 202 });
        }
        if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected call: ${method} ${url.pathname}`);
      };

      const firstV2 = await makeClient(pairedA, true).ask({
        title: 'Pinned ta-attest-v2 record',
        screen: {
          templateId: v2Id,
          labels: { s0: 'Notice', s1: 'Signed with reserved ta-attest-v2 key', s2: 'Acknowledge' },
          data: {},
        },
        waitSeconds: 0,
      });
      assert.equal(firstV2.status, 'pending');
      const endPutIdx = orderedEvents.indexOf(`end:PUT /v2/templates/${v2Id}`);
      const startPostIdx = orderedEvents.indexOf('start:POST /v2/requests');
      assert.ok(endPutIdx > 0 && startPostIdx > endPutIdx, 'PUT must complete strictly before POST /v2/requests');

      // Inspect persisted cache entry shape & mode 0600.
      const screenStore = new ScreenTemplateStore(store.root);
      const cacheFile = screenStore.recordPath(relayOriginOf(relayA), v2Id);
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600, 'Cache entry must be mode 0600');
      }
      const persisted = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      assert.equal(persisted.templateId, v2Id);
      assert.equal(persisted.record.kid, 'ta-attest-v2');
      assert.equal(persisted.lastRefreshedAt, fakeNow);

      // Day 5 (< 15 days): 0 GET, 0 PUT!
      fakeNow += 5 * 24 * 60 * 60 * 1000;
      orderedEvents.length = 0;
      const day5 = await makeClient(pairedA, true).ask({
        title: 'Day 5 send',
        screen: { templateId: v2Id, labels: { s0: 'Day 5', s1: 'Cached fresh', s2: 'OK' }, data: {} },
        waitSeconds: 0,
      });
      assert.equal(day5.status, 'pending');
      assert.ok(!orderedEvents.some((e) => e.includes('/templates')), 'Day 5 must make 0 GET and 0 PUT calls');

      // Day 16 (11 more days -> 16 days since lastRefreshedAt >= 15d): 1 awaited PUT BEFORE POST /v2/requests!
      fakeNow += 11 * 24 * 60 * 60 * 1000;
      orderedEvents.length = 0;
      putCompleted = false;
      const day16 = await makeClient(pairedA, true).ask({
        title: 'Day 16 send',
        screen: { templateId: v2Id, labels: { s0: 'Day 16', s1: 'Needs refresh', s2: 'OK' }, data: {} },
        waitSeconds: 0,
      });
      assert.equal(day16.status, 'pending');
      assert.equal(
        orderedEvents.filter((e) => e === `start:PUT /v2/templates/${v2Id}`).length,
        1,
        'Day 16 must execute exactly 1 PUT'
      );
      assert.ok(
        orderedEvents.indexOf(`end:PUT /v2/templates/${v2Id}`) < orderedEvents.indexOf('start:POST /v2/requests'),
        'Day 16 PUT must finish before POST /v2/requests'
      );
      assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).lastRefreshedAt, fakeNow);

      // Failed PUT (503) + GET confirms 200 valid record -> non-fatal, does NOT update lastRefreshedAt.
      const prevRefreshedAt = fakeNow;
      fakeNow += SCREEN_REFRESH_AFTER_MS;
      orderedEvents.length = 0;
      let getConfirmed = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        orderedEvents.push(`${method} ${url.pathname}`);
        if (method === 'PUT' && url.pathname === `/v2/templates/${v2Id}`) {
          return new Response(JSON.stringify({ error: 'temporary' }), { status: 503 });
        }
        if (method === 'GET' && url.pathname === `/templates/${v2Id}`) {
          getConfirmed = true;
          return new Response(canonJson(PREPROVISIONED_ATTEST_V2_RECORD as unknown as ScreenCanonValue), { status: 200 });
        }
        if (method === 'GET' && url.pathname === '/v2/recipients') return Response.json(recipientsPayload);
        if (method === 'POST' && url.pathname === '/v2/requests') {
          const req = JSON.parse(String(init?.body)) as GroupRequest;
          return Response.json({ requestId: req.requestId, seq: 1 }, { status: 202 });
        }
        if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) return new Response(null, { status: 204 });
        throw new Error(`Unexpected: ${method} ${url.pathname}`);
      };
      const nonFatalPut = await makeClient(pairedA, true).ask({
        title: 'PUT fails but GET confirms',
        screen: { templateId: v2Id, labels: { s0: 'OK', s1: 'Still on R2', s2: 'Done' }, data: {} },
        waitSeconds: 0,
      });
      assert.equal(nonFatalPut.status, 'pending');
      assert.equal(getConfirmed, true);
      assert.equal(
        JSON.parse(fs.readFileSync(cacheFile, 'utf8')).lastRefreshedAt,
        prevRefreshedAt,
        'Non-fatal PUT failure must not advance lastRefreshedAt'
      );

      // Failed PUT (422 TEMPLATE_KEY_RETIRED) + GET 404 -> definitive TEMPLATE_KEY_RETIRED, 0 POST /v2/requests!
      let postAfterRetired = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (method === 'PUT' && url.pathname === `/v2/templates/${v2Id}`) {
          return Response.json({ error: 'Retired', code: 'TEMPLATE_KEY_RETIRED' }, { status: 422 });
        }
        if (method === 'GET' && url.pathname === `/templates/${v2Id}`) {
          return Response.json({ error: 'Not found', code: 'TEMPLATE_NOT_FOUND' }, { status: 404 });
        }
        if (method === 'POST' && url.pathname === '/v2/requests') {
          postAfterRetired += 1;
        }
        throw new Error(`Unexpected: ${method} ${url.pathname}`);
      };
      const retired = await makeClient(pairedA, true).ask({
        title: 'Retired key',
        screen: { templateId: v2Id, labels: { s0: 'A', s1: 'B', s2: 'C' }, data: {} },
        waitSeconds: 0,
      });
      assert.equal(retired.status, 'error');
      assert.equal(retired.errorCode, 'TEMPLATE_KEY_RETIRED');
      assert.equal(postAfterRetired, 0);

      // Failed PUT (503) + GET 404 -> definitive TEMPLATE_EXPIRED with 0 POST /v2/requests!
      let postAfterPut503 = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (method === 'PUT' && url.pathname === `/v2/templates/${v2Id}`) {
          return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
        }
        if (method === 'GET' && url.pathname === `/templates/${v2Id}`) {
          return Response.json({ error: 'Not found', code: 'TEMPLATE_NOT_FOUND' }, { status: 404 });
        }
        if (method === 'POST' && url.pathname === '/v2/requests') {
          postAfterPut503 += 1;
        }
        throw new Error(`Unexpected: ${method} ${url.pathname}`);
      };
      const put503Get404 = await makeClient(pairedA, true).ask({
        title: 'PUT 503 + GET 404',
        screen: { templateId: v2Id, labels: { s0: 'A', s1: 'B', s2: 'C' }, data: {} },
        waitSeconds: 0,
      });
      assert.equal(put503Get404.status, 'error');
      assert.equal(put503Get404.errorCode, 'TEMPLATE_EXPIRED');
      assert.equal(postAfterPut503, 0);

      // Tampered on-disk cache record must be ignored (treated as miss -> GET 200 tampered -> TEMPLATE_INVALID, 0 POST /v2/requests).
      const tamperedEntry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      tamperedEntry.record.sig = 'A'.repeat(86);
      fs.writeFileSync(cacheFile, JSON.stringify(tamperedEntry));
      let postAfterTamperedGet = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.pathname === `/templates/${v2Id}`) {
          return Response.json({ ...PREPROVISIONED_ATTEST_V2_RECORD, sig: 'B'.repeat(86) });
        }
        if (method === 'POST' && url.pathname === '/v2/requests') {
          postAfterTamperedGet += 1;
        }
        throw new Error(`Unexpected call after tampered GET: ${method} ${url.pathname}`);
      };
      const tamperedGetRes = await makeClient(pairedA, true).ask({
        title: 'Tampered GET rejected',
        screen: { templateId: v2Id, labels: { s0: 'A', s1: 'B', s2: 'C' }, data: {} },
        waitSeconds: 0,
      });
      assert.equal(tamperedGetRes.status, 'error');
      assert.equal(tamperedGetRes.errorCode, 'TEMPLATE_INVALID');
      assert.equal(postAfterTamperedGet, 0);

      // Tampered on-disk cache + GET 404 -> TEMPLATE_EXPIRED.
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if ((init?.method ?? 'GET') === 'GET' && url.pathname === `/templates/${v2Id}`) {
          return Response.json({ error: 'Not found' }, { status: 404 });
        }
        throw new Error(`Unexpected call after tampered cache: ${init?.method ?? 'GET'} ${url.pathname}`);
      };
      const tamperedRes = await makeClient(pairedA, true).ask({
        title: 'Tampered cache rejected',
        screen: { templateId: v2Id, labels: { s0: 'A', s1: 'B', s2: 'C' }, data: {} },
        waitSeconds: 0,
      });
      assert.equal(tamperedRes.status, 'error');
      assert.equal(tamperedRes.errorCode, 'TEMPLATE_EXPIRED');
    }

    // -------------------------------------------------------------------------
    // 4. Inline ad-hoc template:
    //    - Local skeletonizer strips literals (0 literals sent to POST /v2/templates)
    //    - Inline memo hit makes 0 POST /v2/templates and 0 registry calls while < 15d
    //    - Auto-repair returns suggestedTemplate + re-hydrated changes; resubmitting converges
    //    - Strict mode 422 repair_suggested & unrepairable 422 invalid_template & 429
    // -------------------------------------------------------------------------
    {
      const nestedInlineTemplate = {
        root: {
          kind: 'card',
          header: { maxGraphemes: 40, maxBytes: 160, value: 'Outer Secret Header' },
          children: [
            {
              kind: 'card',
              header: 'Inner Secret Section',
              children: [
                {
                  kind: 'checklist',
                  id: 'preflight',
                  items: ['Secret backup verified', 'Secret window confirmed'],
                },
                {
                  kind: 'formField',
                  id: 'ticket',
                  fieldType: 'text',
                  label: 'Change Ticket',
                  required: true,
                },
              ],
            },
          ],
        },
        actions: [
          {
            id: 'deploy',
            label: 'Deploy Now',
            role: 'primary',
            requireBio: true,
            enabledWhen: [
              { op: 'allChecked', checklist: 'preflight' },
              { op: 'isNotEmpty', field: 'ticket' },
            ],
          },
          {
            id: 'abort',
            label: 'Cancel',
            role: 'decline',
            requireBio: false,
          },
        ],
      };

      // Build the contract-fixture repaired skeleton (inner card unwrapped to heading + divider, outer header bound snapped 40 -> 64).
      const origSkel = (await skeletonizeScreenTemplate(nestedInlineTemplate)).skeleton;
      const repairedSkeleton: ScreenSkeleton = {
        v: 1,
        root: {
          kind: 'card',
          header: { slot: 's0', maxGraphemes: 64, maxBytes: 256 },
          children: [
            { kind: 'heading', level: 2, text: { slot: 's1', maxGraphemes: 64, maxBytes: 256 } },
            { kind: 'divider' },
            {
              kind: 'checklist',
              id: 'c0',
              items: { slot: 's2', minItems: 1, maxItems: 4, maxBytes: 512 },
            },
            {
              kind: 'formField',
              id: 'f0',
              fieldType: 'text',
              label: { slot: 's3', maxGraphemes: 64, maxBytes: 256 },
              required: true,
            },
          ],
        },
        actions: origSkel.actions,
      };
      const repairedRecord = await ta.signSkeleton(repairedSkeleton);
      const serverChanges = [
        { code: 'BOUND_SNAPPED', message: 'Slot bound rounded up to standard tier.', at: 's0' },
        { code: 'NESTED_CARD_UNWRAPPED', message: 'Inner card unwrapped into heading and divider.', at: 's1' },
      ];

      let postTemplateCalls = 0;
      let registryCalls = 0;
      let lastPostTemplateBody = '';
      const dispatched: GroupRequest[] = [];

      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (method === 'POST' && url.pathname === '/v2/templates') {
          postTemplateCalls += 1;
          lastPostTemplateBody = String(init?.body);
          const parsedBody = JSON.parse(lastPostTemplateBody);
          if (parsedBody.mode === 'strict') {
            return Response.json(
              {
                status: 'repair_suggested',
                repaired: false,
                skeleton: repairedSkeleton,
                changes: serverChanges,
              },
              { status: 422 }
            );
          }
          return Response.json({
            status: 'certified',
            repaired: true,
            templateId: repairedRecord.templateId,
            skeleton: repairedSkeleton,
            record: repairedRecord,
            changes: serverChanges,
          });
        }
        if (url.pathname.startsWith('/templates/') || url.pathname.startsWith('/v2/templates/')) {
          registryCalls += 1;
          return Response.json({ status: 'fresh' });
        }
        if (method === 'GET' && url.pathname === '/v2/recipients') return Response.json(recipientsPayload);
        if (method === 'POST' && url.pathname === '/v2/requests') {
          const req = JSON.parse(String(init?.body)) as GroupRequest;
          dispatched.push(req);
          return Response.json({ requestId: req.requestId, seq: dispatched.length }, { status: 202 });
        }
        if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) return new Response(null, { status: 204 });
        throw new Error(`Unexpected: ${method} ${url.pathname}`);
      };

      // Strict mode rejects auto-repair with 0 POST /v2/requests and returns re-hydrated changes + suggestedTemplate.
      const strictRes = await makeClient(pairedA).ask({
        title: 'Strict inline',
        screen: { template: nestedInlineTemplate, mode: 'strict' },
        waitSeconds: 0,
      });
      assert.equal(strictRes.status, 'error');
      assert.equal(strictRes.errorCode, 'REPAIR_SUGGESTED');
      assert.equal(dispatched.length, 0);
      assert.equal(strictRes.changes?.length, 2);
      assert.equal(strictRes.changes?.[0]?.ordinal, 's0');
      assert.equal(strictRes.changes?.[0]?.at, 'root.header');
      assert.ok(strictRes.suggestedTemplate, 'Strict repair_suggested must include suggestedTemplate');
      // Assert zero inline plaintext literals left the machine in POST /v2/templates!
      assert.ok(!lastPostTemplateBody.includes('Outer Secret Header'));
      assert.ok(!lastPostTemplateBody.includes('Inner Secret Section'));
      assert.ok(!lastPostTemplateBody.includes('Secret backup verified'));
      assert.ok(!lastPostTemplateBody.includes('Deploy Now'));

      // Auto mode certifies + caches + returns suggestedTemplate + re-hydrated changes.
      postTemplateCalls = 0;
      const autoRes = await makeClient(pairedA).ask({
        title: 'Auto inline',
        screen: { template: nestedInlineTemplate },
        waitSeconds: 0,
      });
      assert.equal(autoRes.status, 'pending');
      assert.equal(postTemplateCalls, 1);
      assert.equal(registryCalls, 0);
      assert.equal(autoRes.templateId, repairedRecord.templateId);
      assert.equal(autoRes.repaired, true);
      assert.equal(autoRes.changes?.[0]?.at, 'root.header');
      assert.equal(autoRes.changes?.[0]?.ordinal, 's0');
      assert.ok(autoRes.suggestedTemplate);

      // Verify inline memo persisted at mode 0600 keyed by (relayOrigin, SKELETONIZER_VERSION, inputSkeletonHash).
      const skelInfo = await skeletonizeScreenTemplate(nestedInlineTemplate);
      const memoFile = new ScreenTemplateStore(store.root).memoPath(
        relayOriginOf(relayA),
        SKELETONIZER_VERSION,
        skelInfo.inputSkeletonHash
      );
      assert.ok(fs.existsSync(memoFile), 'Inline memo file must exist');
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(memoFile).mode & 0o777, 0o600, 'Inline memo must be mode 0600');
      }

      // Second send with same structure (different inline text!) while lastRefreshedAt < 15d ->
      // 0 POST /v2/templates calls and 0 registry calls!
      fakeNow += 3 * 24 * 60 * 60 * 1000;
      const variantInline = structuredClone(nestedInlineTemplate);
      variantInline.root.header.value = 'Different Runtime Header';
      postTemplateCalls = 0;
      registryCalls = 0;
      const cachedHit = await makeClient(pairedA).ask({
        title: 'Cached inline hit',
        screen: { template: variantInline },
        waitSeconds: 0,
      });
      assert.equal(cachedHit.status, 'pending');
      assert.equal(postTemplateCalls, 0, 'Local inline memo hit must make 0 POST /v2/templates calls');
      assert.equal(registryCalls, 0, 'Fresh cache (<15d) must make 0 registry GET/PUT calls');
      assert.equal(cachedHit.templateId, repairedRecord.templateId);
      assert.equal(cachedHit.repaired, true);

      // Resubmitting `suggestedTemplate` converges with repaired=undefined/false and 0 POST /v2/templates calls!
      const converged = await makeClient(pairedA).ask({
        title: 'Converged template',
        screen: { template: autoRes.suggestedTemplate! },
        waitSeconds: 0,
      });
      assert.equal(converged.status, 'pending');
      assert.equal(postTemplateCalls, 0, 'Adopted suggestedTemplate hits clean memo with 0 POST calls');
      assert.equal(converged.templateId, repairedRecord.templateId);
      assert.equal(converged.repaired, undefined);

      // Different relay origin misses memo and calls POST /v2/templates for relayB.
      postTemplateCalls = 0;
      const relayBRes = await makeClient(pairedB).ask({
        title: 'Other relay origin',
        screen: { template: nestedInlineTemplate },
        waitSeconds: 0,
      });
      assert.equal(relayBRes.status, 'pending');
      assert.equal(postTemplateCalls, 1, 'Different relayOrigin must not reuse relayA inline memo');

      // Multi-hint unrepairable 422 and 429 rate-limit contract fixtures.
      const unrepairableInline = {
        root: { kind: 'card', header: 'Bad', children: [{ kind: 'text', text: 'Too many actions' }] },
        actions: [
          { id: 'go', label: 'Go', role: 'primary', requireBio: false },
          { id: 'd1', label: 'No 1', role: 'decline', requireBio: true },
          { id: 'd2', label: 'No 2', role: 'decline', requireBio: false },
        ],
      };
      let dispatchedBeforeUnrepairable = dispatched.length;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'POST' && url.pathname === '/v2/templates') {
          return Response.json(
            {
              status: 'invalid_template',
              fixes: [
                { code: 'MULTIPLE_DECLINE_ACTIONS', message: 'Keep at most one decline action.', at: 'a2' },
                { code: 'DECLINE_REQUIRE_BIO_INVALID', message: 'Set requireBio: false on decline.', at: 'a1' },
              ],
            },
            { status: 422 }
          );
        }
        throw new Error(`Unexpected: ${init?.method} ${url.pathname}`);
      };
      const invalidRes = await makeClient(pairedA).ask({
        title: 'Unrepairable',
        screen: { template: unrepairableInline },
        waitSeconds: 0,
      });
      assert.equal(invalidRes.status, 'error');
      assert.equal(invalidRes.errorCode, 'INVALID_TEMPLATE');
      assert.equal(invalidRes.fixes?.length, 2);
      assert.equal(invalidRes.fixes?.[0]?.at, 'd2');
      assert.equal(invalidRes.fixes?.[0]?.ordinal, 'a2');
      assert.equal(invalidRes.fixes?.[1]?.at, 'd1');
      assert.equal(dispatched.length, dispatchedBeforeUnrepairable);

      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'POST' && url.pathname === '/v2/templates') {
          return new Response(JSON.stringify({ error: 'Too many attempts' }), {
            status: 429,
            headers: { 'Retry-After': '42', 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected: ${init?.method} ${url.pathname}`);
      };
      const rateLimited = await makeClient(pairedA).ask({
        title: 'Rate limited',
        screen: { template: unrepairableInline },
        waitSeconds: 0,
      });
      assert.equal(rateLimited.status, 'error');
      assert.equal(rateLimited.errorCode, 'RATE_LIMITED');
      assert.match(rateLimited.message ?? '', /42s/);
    }

    // -------------------------------------------------------------------------
    // 5. Settlement verification:
    //    - Unavailable reply -> TEMPLATE_UNAVAILABLE_ON_DEVICE + clears pending record
    //    - Malformed replies (bad digest, bad form, failed predicate, missing auth,
    //      extra text, cross-variant, invalid JSON) -> SETTLEMENT_UNVERIFIED + clears pending
    // -------------------------------------------------------------------------
    {
      const sendAndDeliverReply = async (
        buildReplyPlaintext: (req: GroupRequest, rawPlaintext: string, parsedPlaintext: any) => Promise<string>
      ) => {
        let capturedReq: GroupRequest | undefined;
        let replyEnv: GroupResponse | undefined;
        globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          const method = init?.method ?? 'GET';
          if (method === 'GET' && url.pathname === '/v2/recipients') return Response.json(recipientsPayload);
          if (method === 'POST' && url.pathname === '/v2/requests') {
            capturedReq = JSON.parse(String(init?.body)) as GroupRequest;
            const opened = await openGroupDeliveryPlaintext(
              capturedReq,
              phoneEnc.privateKey,
              pairedA.record.keys.publicKeyB64u
            );
            const replyPlaintext = await buildReplyPlaintext(capturedReq, opened.raw, opened.parsed);
            replyEnv = await sealGroupReplyPlaintext({
              request: capturedReq,
              replyPub: opened.parsed.replyPub,
              responderDeviceId: deviceId,
              responderSigKey: phoneSig.privateKey,
              plaintext: replyPlaintext,
            });
            return Response.json({ requestId: capturedReq.requestId, seq: 1 }, { status: 202 });
          }
          if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) {
            return Response.json({ seq: 1, envelope: replyEnv });
          }
          throw new Error(`Unexpected: ${method} ${url.pathname}`);
        };
        const res = await makeClient(pairedA, true).ask({
          title: 'Settlement Check',
          requiresAuth: true,
          screen: actionChecklistScreen,
          waitSeconds: 0,
        });
        const pendingStore = new PendingStore(pairedA.record.config, store.root);
        assert.equal(
          pendingStore.read('reply:' + res.requestId),
          undefined,
          `Pending record must be cleared after terminal result (${res.status}/${res.errorCode ?? 'ok'})`
        );
        return res;
      };

      // Unavailable dismiss reply -> TEMPLATE_UNAVAILABLE_ON_DEVICE
      const unavailableRes = await sendAndDeliverReply(async () =>
        JSON.stringify(buildScreenUnavailableAnswer())
      );
      assert.equal(unavailableRes.status, 'error');
      assert.equal(unavailableRes.errorCode, 'TEMPLATE_UNAVAILABLE_ON_DEVICE');

      // Wrong renderDigest -> SETTLEMENT_UNVERIFIED
      const badDigest = await sendAndDeliverReply(async () =>
        JSON.stringify({
          action: 'a0',
          values: { form: { c0: [true, true], f0: true }, render: { v: 1, digest: '0'.repeat(64) } },
          authenticated: true,
        })
      );
      assert.equal(badDigest.status, 'error');
      assert.equal(badDigest.errorCode, 'SETTLEMENT_UNVERIFIED');

      // Unsatisfied allChecked predicate (even with valid renderDigest!) -> SETTLEMENT_UNVERIFIED
      const badPredicate = await sendAndDeliverReply(async (req, raw) => {
        const ctx = await computeScreenContextDigest(req.requestId, new TextEncoder().encode(raw));
        return JSON.stringify(
          await buildScreenRenderedAnswer(ctx, 'a0', { c0: [true, false], f0: true }, true)
        );
      });
      assert.equal(badPredicate.status, 'error');
      assert.equal(badPredicate.errorCode, 'SETTLEMENT_UNVERIFIED');

      // Missing authenticated: true when requiresAuth is set -> SETTLEMENT_UNVERIFIED
      const missingAuth = await sendAndDeliverReply(async (req, raw) => {
        const ctx = await computeScreenContextDigest(req.requestId, new TextEncoder().encode(raw));
        return JSON.stringify(
          await buildScreenRenderedAnswer(ctx, 'a0', { c0: [true, true], f0: true }, false)
        );
      });
      assert.equal(missingAuth.status, 'error');
      assert.equal(missingAuth.errorCode, 'SETTLEMENT_UNVERIFIED');

      // Decline action (a1) succeeds even without auth and unchecked items!
      const declineOk = await sendAndDeliverReply(async (req, raw) => {
        const ctx = await computeScreenContextDigest(req.requestId, new TextEncoder().encode(raw));
        return JSON.stringify(
          await buildScreenRenderedAnswer(ctx, 'a1', { c0: [false, false], f0: false }, false)
        );
      });
      assert.equal(declineOk.status, 'resolved');
      assert.equal(declineOk.answer?.action, 'a1');

      // Cross-variant (dismiss with form) -> SETTLEMENT_UNVERIFIED
      const crossVariant = await sendAndDeliverReply(async () =>
        JSON.stringify({
          action: 'dismiss',
          values: { form: { c0: [true, true], f0: true }, render: { v: 1, unavailable: true } },
        })
      );
      assert.equal(crossVariant.status, 'error');
      assert.equal(crossVariant.errorCode, 'SETTLEMENT_UNVERIFIED');

      // Extra top-level text -> SETTLEMENT_UNVERIFIED
      const extraText = await sendAndDeliverReply(async (req, raw) => {
        const ctx = await computeScreenContextDigest(req.requestId, new TextEncoder().encode(raw));
        const valid = await buildScreenRenderedAnswer(ctx, 'a0', { c0: [true, true], f0: true }, true);
        return JSON.stringify({ ...valid, text: 'smuggled' });
      });
      assert.equal(extraText.status, 'error');
      assert.equal(extraText.errorCode, 'SETTLEMENT_UNVERIFIED');

      // Malformed JSON -> SETTLEMENT_UNVERIFIED
      const invalidJson = await sendAndDeliverReply(async () => '{not-json');
      assert.equal(invalidJson.status, 'error');
      assert.equal(invalidJson.errorCode, 'SETTLEMENT_UNVERIFIED');
    }

    // -------------------------------------------------------------------------
    // 6. MCP tool (`notibuddy_notify.screen`): exclusivity & catalog call
    // -------------------------------------------------------------------------
    {
      let posted = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.pathname === '/v2/recipients') return Response.json(recipientsPayload);
        if (method === 'POST' && url.pathname === '/v2/requests') {
          posted += 1;
          const req = JSON.parse(String(init?.body)) as GroupRequest;
          return Response.json({ requestId: req.requestId, seq: posted }, { status: 202 });
        }
        if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) return new Response(null, { status: 204 });
        throw new Error(`Unexpected MCP call: ${method} ${url.pathname}`);
      };

      const mcpServer = await createMcpServer({ to: 'phone-v2' }, store);
      const mcp = new Client({ name: 'screen-test', version: '1' }, { capabilities: {} });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(right);
      await mcp.connect(left);
      mcpClients.push(mcp);

      const tools = (await mcp.listTools()).tools;
      const notifyTool = tools.find((t) => t.name === 'notibuddy_notify')!;
      assert.ok((notifyTool.inputSchema.properties as any)?.screen, 'notibuddy_notify must expose screen property');

      const okRes = await mcp.callTool({
        name: 'notibuddy_notify',
        arguments: {
          title: 'MCP Screen',
          screen: kpiStatusScreen,
          wait_seconds: 0,
        },
      });
      assert.notEqual(okRes.isError, true);
      const parsedOk = JSON.parse((okRes.content as any)[0].text);
      assert.equal(parsedOk.status, 'pending');
      assert.equal(parsedOk.templateId, SCREEN_CATALOG_BY_SLUG.kpi_status_card.templateId);

      // Exclusivity checks: screen cannot combine with options/fields/diff/message/resume_id.
      const beforeInvalid = posted;
      for (const badArgs of [
        { title: 'X', screen: { templateId: 'kpi_status_card', labels: {}, data: {} }, options: ['Yes'] },
        { title: 'X', screen: { templateId: 'kpi_status_card', labels: {}, data: {} }, message: 'hello' },
        { title: 'X', screen: { templateId: 'kpi_status_card', labels: {}, data: {} }, input_placeholder: 'type' },
        { resume_id: 'req_123', screen: { templateId: 'kpi_status_card', labels: {}, data: {} } },
      ]) {
        const res = await mcp.callTool({ name: 'notibuddy_notify', arguments: { ...badArgs, wait_seconds: 0 } });
        assert.equal(res.isError, true, `Expected exclusivity error for ${JSON.stringify(badArgs)}`);
      }
      assert.equal(posted, beforeInvalid, 'Invalid exclusive combinations must make 0 HTTP calls');
    }

    // -------------------------------------------------------------------------
    // 7. CLI: `nb notify --screen <file>` and `nb screen register <file> [--strict]`
    //    (writes `<stem>.repaired.json` including signed `record` without mutating input!)
    // -------------------------------------------------------------------------
    {
      globalThis.fetch = originalFetch;

      // Use real pre-provisioned `ta-attest-v2` record so CLI verifies under default pinned keys!
      const cliInputTemplate = {
        root: {
          kind: 'card',
          header: { maxGraphemes: 48, maxBytes: 192, value: 'CLI Repair Input' },
          children: [{ kind: 'text', style: 'body', text: 'CLI body' }],
        },
        actions: [{ id: 'ack', label: 'Ack', role: 'primary', requireBio: false }],
      };
      const cliCleanSkeleton = PREPROVISIONED_ATTEST_V2_RECORD.skeleton;

      let registerRequests = 0;
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const rawBody = Buffer.concat(chunks).toString('utf8');
          const url = new URL(req.url!, 'http://127.0.0.1');

          if (req.method === 'POST' && url.pathname === '/v2/templates') {
            registerRequests += 1;
            const body = JSON.parse(rawBody);
            const inputCanonical = canonJson(body.skeleton as ScreenCanonValue);
            const cleanCanonical = canonJson(cliCleanSkeleton as unknown as ScreenCanonValue);
            const needsRepair = inputCanonical !== cleanCanonical;

            if (needsRepair && body.mode === 'strict') {
              res.writeHead(422, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  status: 'repair_suggested',
                  repaired: false,
                  skeleton: cliCleanSkeleton,
                  changes: [{ code: 'BOUND_SNAPPED', message: 'Snapped header bound.', at: 's0' }],
                })
              );
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 'certified',
                repaired: needsRepair,
                templateId: PREPROVISIONED_ATTEST_V2_RECORD.templateId,
                skeleton: cliCleanSkeleton,
                record: PREPROVISIONED_ATTEST_V2_RECORD,
                changes: needsRepair
                  ? [{ code: 'BOUND_SNAPPED', message: 'Snapped header bound.', at: 's0' }]
                  : [],
              })
            );
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v2/recipients') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(recipientsPayload));
            return;
          }
          if (req.method === 'POST' && url.pathname === '/v2/requests') {
            const envReq = JSON.parse(rawBody) as GroupRequest;
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ requestId: envReq.requestId, seq: 1 }));
            return;
          }
          if (req.method === 'GET' && url.pathname.startsWith('/v2/replies/')) {
            res.writeHead(204);
            res.end();
            return;
          }
          res.writeHead(404);
          res.end();
        })();
      });
      httpServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      assert.ok(addr && typeof addr !== 'string');
      const localRelay = `http://127.0.0.1:${addr.port}`;

      const cliHome = path.join(root, 'cli-home');
      const cliStore = new DestinationStore(cliHome);
      await cliStore.prepare('local-v2', { ...bundleV2, relay: localRelay }, 'CLI Screen Mac');

      const inputFile = path.join(root, 'deploy-screen.json');
      const originalBytes = JSON.stringify(cliInputTemplate, null, 2) + '\n';
      fs.writeFileSync(inputFile, originalBytes);
      const repairedOut = repairedTemplateOutputPath(inputFile);
      assert.equal(path.basename(repairedOut), 'deploy-screen.repaired.json');

      // (a) `nb screen register <file> --strict` on repairable file: exits 1, no .repaired.json, input untouched.
      const strictRun = await runCliProcess(['screen', 'register', inputFile, '--strict', '--to', 'local-v2'], {
        NOTIBUDDY_HOME: cliHome,
      });
      assert.equal(strictRun.status, 1, `Expected strict exit 1, got stderr: ${strictRun.stderr}`);
      const strictOut = JSON.parse(strictRun.stdout);
      assert.equal(strictOut.status, 'repair_suggested');
      assert.equal(strictOut.changes[0].at, 'root.header');
      assert.equal(strictOut.changes[0].ordinal, 's0');
      assert.equal(fs.existsSync(repairedOut), false, '--strict must not write .repaired.json');
      assert.equal(fs.readFileSync(inputFile, 'utf8'), originalBytes, 'Input file must never be mutated');

      // (b) `nb screen register <file>` (auto): exits 0, writes <stem>.repaired.json (mode 0600) with signed record, input untouched!
      const autoRun = await runCliProcess(['screen', 'register', inputFile, '--to', 'local-v2'], {
        NOTIBUDDY_HOME: cliHome,
      });
      assert.equal(autoRun.status, 0, `Expected auto exit 0, got stderr: ${autoRun.stderr}`);
      const autoOut = JSON.parse(autoRun.stdout);
      assert.equal(autoOut.status, 'certified');
      assert.equal(autoOut.repaired, true);
      assert.equal(autoOut.repairedPath, repairedOut);
      assert.equal(autoOut.record.templateId, PREPROVISIONED_ATTEST_V2_RECORD.templateId);
      assert.equal(fs.readFileSync(inputFile, 'utf8'), originalBytes, 'Input file must remain byte-identical');
      assert.ok(fs.existsSync(repairedOut), 'Expected <stem>.repaired.json to be written');
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(repairedOut).mode & 0o777, 0o600, '<stem>.repaired.json must be mode 0600');
      }
      const repairedFileJson = JSON.parse(fs.readFileSync(repairedOut, 'utf8'));
      assert.equal(repairedFileJson.templateId, PREPROVISIONED_ATTEST_V2_RECORD.templateId);
      assert.equal(repairedFileJson.record.kid, 'ta-attest-v2');
      assert.equal(repairedFileJson.record.sig, PREPROVISIONED_ATTEST_V2_RECORD.sig);
      assert.ok(repairedFileJson.suggestedTemplate);

      // (c) `nb screen register <clean-file> --strict` passes with exit 0!
      const cleanFile = path.join(root, 'clean-screen.json');
      fs.writeFileSync(cleanFile, JSON.stringify(cliCleanSkeleton, null, 2));
      const cleanRun = await runCliProcess(['screen', 'register', cleanFile, '--strict', '--to', 'local-v2'], {
        NOTIBUDDY_HOME: cliHome,
      });
      assert.equal(cleanRun.status, 0, `Expected clean --strict exit 0, got stderr: ${cleanRun.stderr}`);
      const cleanOut = JSON.parse(cleanRun.stdout);
      assert.equal(cleanOut.status, 'certified');
      assert.equal(cleanOut.repaired, false);
      assert.equal(cleanOut.record.templateId, PREPROVISIONED_ATTEST_V2_RECORD.templateId);
      assert.ok(registerRequests >= 3);

      // (d) `nb notify "CLI Screen" --screen <file> --wait 0` works and rejects conflicting flags!
      const screenSpecFile = path.join(root, 'notify-screen.json');
      fs.writeFileSync(
        screenSpecFile,
        JSON.stringify({
          templateId: PREPROVISIONED_ATTEST_V2_RECORD.templateId,
          labels: { s0: 'CLI Title', s1: 'Cached from register', s2: 'OK' },
          data: {},
        })
      );
      const notifyRun = await runCliProcess(
        ['notify', 'CLI Screen', '--screen', screenSpecFile, '--wait', '0', '--to', 'local-v2'],
        { NOTIBUDDY_HOME: cliHome }
      );
      assert.equal(notifyRun.status, 0, `Expected CLI notify --screen exit 0, got stderr: ${notifyRun.stderr}`);
      const notifyOut = JSON.parse(notifyRun.stdout);
      assert.equal(notifyOut.status, 'pending');
      assert.equal(notifyOut.templateId, PREPROVISIONED_ATTEST_V2_RECORD.templateId);

      const conflictRun = await runCliProcess(
        ['notify', 'Bad', '--screen', screenSpecFile, '--options', 'Yes,No', '--to', 'local-v2'],
        { NOTIBUDDY_HOME: cliHome }
      );
      assert.equal(conflictRun.status, 1);
      assert.match(conflictRun.stderr, /--screen cannot be combined/);
    }

    // -------------------------------------------------------------------------
    // 8. Regression checks: explicit slot mismatch, reserved "dismiss" action id,
    //    optional card.header, symlink fail-closed, inline key-rotation re-attestation,
    //    and formField maxGraphemes settlement enforcement
    // -------------------------------------------------------------------------
    {
      // P1-1: Explicit slot mismatch across text, data, and diff slots fails closed.
      await assert.rejects(
        skeletonizeScreenTemplate(
          {
            v: 1,
            root: {
              kind: 'alert',
              severity: 'warning',
              title: { slot: 's1', maxGraphemes: 64, maxBytes: 256 },
              body: { slot: 's0', maxGraphemes: 64, maxBytes: 256 },
            },
            actions: [{ id: 'a0', label: { slot: 's2', maxGraphemes: 32, maxBytes: 128 }, role: 'primary', requireBio: false }],
          },
          { s0: 'Harmless', s1: 'Dangerous', s2: 'OK' }
        ),
        /expected "s0", got "s1"/
      );
      await assert.rejects(
        skeletonizeScreenTemplate(
          {
            v: 1,
            root: {
              kind: 'checklist',
              id: 'c0',
              items: { slot: 's9', minItems: 1, maxItems: 4, maxBytes: 512 },
            },
            actions: [{ id: 'a0', label: 'OK', role: 'primary', requireBio: false }],
          },
          undefined,
          { s0: ['A'] }
        ),
        /expected "s0", got "s9"/
      );
      await assert.rejects(
        skeletonizeScreenTemplate({
          v: 1,
          root: {
            kind: 'diffViewer',
            diff: { slot: 's5', maxBytes: 4096, maxLines: 64 },
          },
          actions: [{ id: 'a0', label: 'OK', role: 'primary', requireBio: false }],
        }),
        /expected "s0", got "s5"/
      );
      // P1-1: Reserved host-owned "dismiss" action id is rejected.
      await assert.rejects(
        skeletonizeScreenTemplate({
          root: { kind: 'text', text: 'Hello' },
          actions: [{ id: 'dismiss', label: 'Close', role: 'decline', requireBio: false }],
        }),
        /reserved/i
      );

      // P1-2: card.header is optional (omitted or "" succeeds; whitespace-only "   " fails).
      const v2Skel = PREPROVISIONED_ATTEST_V2_RECORD.skeleton;
      validateScreenRequestBindings(v2Skel, {
        labels: { s1: 'Body text', s2: 'Confirm' }, // s0 (card.header) omitted
        data: {},
      });
      validateScreenRequestBindings(v2Skel, {
        labels: { s0: '', s1: 'Body text', s2: 'Confirm' }, // s0 empty string allowed
        data: {},
      });
      assert.throws(
        () =>
          validateScreenRequestBindings(v2Skel, {
            labels: { s0: '   ', s1: 'Body text', s2: 'Confirm' },
            data: {},
          }),
        /whitespace only/
      );

      // P1-3: Symlink fail-closed on ScreenTemplateStore (leaf + parent directories) and writeRepairedTemplateFile.
      if (process.platform !== 'win32') {
        const symRoot = path.join(root, 'symlink-home');
        const extDir = path.join(root, 'external-dir');
        fs.mkdirSync(extDir, { recursive: true, mode: 0o755 });
        const extTarget = path.join(extDir, 'outside.json');
        fs.writeFileSync(
          extTarget,
          JSON.stringify({
            templateId: PREPROVISIONED_ATTEST_V2_RECORD.templateId,
            record: PREPROVISIONED_ATTEST_V2_RECORD,
            lastRefreshedAt: fakeNow,
          }),
          { mode: 0o644 }
        );

        const symStore = new ScreenTemplateStore(symRoot);
        const recPath = symStore.recordPath(relayOriginOf(relayA), PREPROVISIONED_ATTEST_V2_RECORD.templateId);
        fs.mkdirSync(path.dirname(recPath), { recursive: true, mode: 0o700 });
        fs.symlinkSync(extTarget, recPath);

        // Leaf symlink read returns undefined and must NOT fchmod external target.
        assert.equal(
          await symStore.readRecord(relayOriginOf(relayA), PREPROVISIONED_ATTEST_V2_RECORD.templateId),
          undefined
        );
        assert.equal(fs.statSync(extTarget).mode & 0o777, 0o644, 'Read path must not chmod symlink target');
        // Leaf symlink write throws without modifying external target.
        await assert.rejects(
          symStore.writeRecord(relayOriginOf(relayA), {
            templateId: PREPROVISIONED_ATTEST_V2_RECORD.templateId,
            record: PREPROVISIONED_ATTEST_V2_RECORD,
            lastRefreshedAt: fakeNow,
          }),
          /symlink/i
        );

        // Parent directory symlink (`screens/memo` -> extDir) fails closed on both read and write without chmodding extDir.
        const memoLink = path.join(symRoot, 'screens', 'memo');
        fs.symlinkSync(extDir, memoLink);
        const hashHex = 'b'.repeat(64);
        assert.equal(symStore.readInlineMemo(relayOriginOf(relayA), SKELETONIZER_VERSION, hashHex), undefined);
        assert.throws(
          () =>
            symStore.writeInlineMemo({
              relayOrigin: relayOriginOf(relayA),
              skeletonizerVersion: SKELETONIZER_VERSION,
              inputSkeletonHash: hashHex,
              templateId: PREPROVISIONED_ATTEST_V2_RECORD.templateId,
              repaired: false,
            }),
          /symlink/i
        );
        assert.equal(fs.statSync(extDir).mode & 0o777, 0o755, 'Parent dir symlink must not be chmodded');

        // writeRepairedTemplateFile rejects symlinked target and inputPath symlink colliding with target.
        const fileDir = path.join(root, 'repaired-symlink-test');
        fs.mkdirSync(fileDir, { recursive: true });
        const realInput = path.join(fileDir, 'orig.json');
        fs.writeFileSync(realInput, '{"v":1}\n');
        const targetLink = repairedTemplateOutputPath(realInput);
        fs.symlinkSync(extTarget, targetLink);
        const dummyRepaired = {
          templateId: PREPROVISIONED_ATTEST_V2_RECORD.templateId,
          repaired: true as const,
          skeleton: PREPROVISIONED_ATTEST_V2_RECORD.skeleton,
          suggestedTemplate: PREPROVISIONED_ATTEST_V2_RECORD.skeleton as unknown as Record<string, unknown>,
          changes: [],
          record: PREPROVISIONED_ATTEST_V2_RECORD,
        };
        assert.throws(() => writeRepairedTemplateFile(realInput, dummyRepaired), /symlink/i);

        // Input symlink pointing to `<stem>.repaired.json` must be rejected without clobbering.
        const collidingRepaired = path.join(fileDir, 'alias.repaired.json');
        fs.writeFileSync(collidingRepaired, '{"keep":true}\n');
        const inputAlias = path.join(fileDir, 'alias.json');
        fs.symlinkSync(collidingRepaired, inputAlias);
        assert.throws(() => writeRepairedTemplateFile(inputAlias, dummyRepaired), /overwrite input/i);
        assert.equal(fs.readFileSync(collidingRepaired, 'utf8'), '{"keep":true}\n');
      }

      // P2-1: Inline memo hit after TA key rotation (PUT -> 422 TEMPLATE_KEY_RETIRED, GET -> 404)
      // falls through to POST /v2/templates under active key and updates local cache/memo.
      {
        const rotHome = path.join(root, 'key-rotation-home');
        const rotDestStore = new DestinationStore(rotHome);
        const rotPaired = await rotDestStore.prepare('rot-v2', bundleV2, 'Rot Mac');
        const rotTaV1 = await makeEphemeralTa('ta-attest-v1');
        const rotTaV2 = await makeEphemeralTa('ta-attest-v2');
        const resolveBoth = (kid: string) =>
          kid === 'ta-attest-v1' ? rotTaV1.pubEntry : kid === 'ta-attest-v2' ? rotTaV2.pubEntry : undefined;

        const inlineForRot = {
          root: { kind: 'card', header: 'Rotate Me', children: [{ kind: 'text', text: 'Body' }] },
          actions: [{ id: 'ok', label: 'OK', role: 'primary', requireBio: false }],
        };
        const skelRot = (await skeletonizeScreenTemplate(inlineForRot)).skeleton;
        const recV1 = await rotTaV1.signSkeleton(skelRot);
        const recV2 = await rotTaV2.signSkeleton(skelRot);

        let rotNow = Date.parse('2026-11-01T00:00:00Z');
        const rotClient = () =>
          new NotiBuddyClient(
            rotPaired.record.config,
            rotPaired.signingKey,
            new PendingStore(rotPaired.record.config, rotDestStore.root),
            'Rot-Agent',
            undefined,
            { enabled: false },
            { now: () => rotNow, resolveTaPublicKey: resolveBoth }
          );

        let activeKey: 'v1' | 'v2' = 'v1';
        let postTemplateHits = 0;
        let putTemplateHits = 0;
        let postReqHits = 0;
        globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          const method = init?.method ?? 'GET';
          if (method === 'POST' && url.pathname === '/v2/templates') {
            postTemplateHits += 1;
            const rec = activeKey === 'v1' ? recV1 : recV2;
            return Response.json({
              status: 'certified',
              repaired: false,
              templateId: rec.templateId,
              skeleton: rec.skeleton,
              record: rec,
              changes: [],
            });
          }
          if (method === 'PUT' && url.pathname === `/v2/templates/${recV1.templateId}`) {
            putTemplateHits += 1;
            const body = JSON.parse(String(init?.body));
            if (activeKey === 'v2' && body.kid === 'ta-attest-v1') {
              return Response.json({ error: 'Retired', code: 'TEMPLATE_KEY_RETIRED' }, { status: 422 });
            }
            return Response.json({ status: 'refreshed' });
          }
          if (method === 'GET' && url.pathname === `/templates/${recV1.templateId}`) {
            return Response.json({ error: 'Not found', code: 'TEMPLATE_NOT_FOUND' }, { status: 404 });
          }
          if (method === 'GET' && url.pathname === '/v2/recipients') return Response.json(recipientsPayload);
          if (method === 'POST' && url.pathname === '/v2/requests') {
            postReqHits += 1;
            const req = JSON.parse(String(init?.body)) as GroupRequest;
            return Response.json({ requestId: req.requestId, seq: postReqHits }, { status: 202 });
          }
          if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) return new Response(null, { status: 204 });
          throw new Error(`Unexpected rotation call: ${method} ${url.pathname}`);
        };

        // Initial send registers under ta-attest-v1.
        const firstRot = await rotClient().ask({
          title: 'Initial v1',
          screen: { template: inlineForRot },
          waitSeconds: 0,
        });
        assert.equal(firstRot.status, 'pending');
        assert.equal(postTemplateHits, 1);

        // Rotate server to ta-attest-v2 and advance clock 35 days so PUT runs and gets 422 TEMPLATE_KEY_RETIRED + GET 404.
        activeKey = 'v2';
        rotNow += 35 * 24 * 60 * 60 * 1000;
        const secondRot = await rotClient().ask({
          title: 'Re-attested under v2',
          screen: { template: inlineForRot },
          waitSeconds: 0,
        });
        assert.equal(secondRot.status, 'pending');
        assert.equal(putTemplateHits, 1, 'Stale cache must attempt PUT first');
        assert.equal(postTemplateHits, 2, 'Retired key on inline memo must fall through to POST /v2/templates');
        assert.equal(postReqHits, 2);

        // Local cache must now hold the active ta-attest-v2 record (subsequent send makes 0 POST/PUT).
        const rotScreenStore = new ScreenTemplateStore(rotDestStore.root, resolveBoth);
        const updatedCache = await rotScreenStore.readRecord(relayOriginOf(relayA), recV2.templateId);
        assert.equal(updatedCache?.record.kid, 'ta-attest-v2');
      }

      // P2-2: Settlement enforces field.maxGraphemes on text-like formFields and returns normalized ScreenAnswer.
      {
        const boundedFieldSkel: ScreenSkeleton = {
          v: 1,
          root: {
            kind: 'card',
            children: [
              {
                kind: 'formField',
                id: 'f0',
                fieldType: 'text',
                label: { slot: 's0', maxGraphemes: 32, maxBytes: 128 },
                maxGraphemes: 4,
                maxBytes: 64,
              },
            ],
          },
          actions: [
            { id: 'a0', label: { slot: 's1', maxGraphemes: 32, maxBytes: 128 }, role: 'primary', requireBio: false },
          ],
        };
        const ctx = 'c'.repeat(64);
        const pendingCtx = {
          templateId: await computeTemplateId(boundedFieldSkel),
          contextDigest: ctx,
          skeleton: boundedFieldSkel,
          checklistCounts: {},
          pickerOptionCounts: {},
        };

        // 5 ASCII graphemes (5 bytes <= maxBytes 64, but > maxGraphemes 4) -> SETTLEMENT_UNVERIFIED.
        const tooManyGraphemes = await buildScreenRenderedAnswer(ctx, 'a0', { f0: '12345' });
        const rejected = await verifyScreenSettlement(pendingCtx, tooManyGraphemes);
        assert.equal(rejected.status, 'error');
        assert.equal(rejected.errorCode, 'SETTLEMENT_UNVERIFIED');

        // 4 multi-byte emoji graphemes (16 bytes <= 64, 4 graphemes <= 4) -> resolved with normalized answer.
        const exactGraphemes = await buildScreenRenderedAnswer(ctx, 'a0', { f0: '🚀🔥✅🎉' });
        const accepted = await verifyScreenSettlement(pendingCtx, exactGraphemes);
        assert.equal(accepted.status, 'resolved');
        assert.deepEqual(accepted.answer, exactGraphemes);
      }

      // P1: Public GET cap parity (98,304 bytes) + inline memo self-heal on non-auth 4xx PUT + 404 GET.
      {
        assert.equal(MAX_PUBLIC_TEMPLATE_BYTES, 98_304);
        const capTa = await makeEphemeralTa('ta-attest-v1');
        const capResolve = (kid: string) => (kid === 'ta-attest-v1' ? capTa.pubEntry : undefined);
        const capInline = {
          root: { kind: 'card', header: 'Cap Check', children: [{ kind: 'text', text: 'Body' }] },
          actions: [{ id: 'ok', label: 'OK', role: 'primary', requireBio: false }],
        };
        const capSkel = (await skeletonizeScreenTemplate(capInline)).skeleton;
        const capRec = await capTa.signSkeleton(capSkel);
        const rawRec = JSON.stringify(capRec);
        const withinCap = rawRec + ' '.repeat(70_000 - Buffer.byteLength(rawRec));
        const exactCap = rawRec + ' '.repeat(MAX_PUBLIC_TEMPLATE_BYTES - Buffer.byteLength(rawRec));
        const overCap = exactCap + ' ';
        assert.ok(Buffer.byteLength(withinCap) > 65_536);
        assert.equal(Buffer.byteLength(exactCap), 98_304);
        assert.equal(Buffer.byteLength(overCap), 98_305);

        let servedBody = withinCap;
        globalThis.fetch = async () =>
          new Response(servedBody, { status: 200, headers: { 'Content-Type': 'application/json' } });

        const ok70k = await fetchPublicTemplateRecord(relayA, capRec.templateId, {}, { resolveTaPublicKey: capResolve });
        assert.equal(ok70k.status, 200);

        servedBody = exactCap;
        const ok96k = await fetchPublicTemplateRecord(relayA, capRec.templateId, {}, { resolveTaPublicKey: capResolve });
        assert.equal(ok96k.status, 200);

        servedBody = overCap;
        await assert.rejects(
          () => fetchPublicTemplateRecord(relayA, capRec.templateId, {}, { resolveTaPublicKey: capResolve }),
          /exceeds maximum byte size/i
        );

        // Inline memo self-heal matrix:
        // - Non-auth 4xx on PUT (413 / 422 TEMPLATE_INVALID) + 404 on GET -> falls through to POST /v2/templates.
        // - Auth 4xx on PUT (401 / 403) + 404 on GET -> does NOT fall through to POST /v2/templates.
        // - Non-auth 4xx on PUT + non-404 on GET (500) -> does NOT fall through to POST /v2/templates.
        for (const scenario of [
          { name: '413-404', putStatus: 413, putCode: undefined, getStatus: 404, expectReattest: true },
          { name: '422-invalid-404', putStatus: 422, putCode: 'TEMPLATE_INVALID', getStatus: 404, expectReattest: true },
          { name: '401-404', putStatus: 401, putCode: undefined, getStatus: 404, expectReattest: false },
          { name: '403-404', putStatus: 403, putCode: 'DESTINATION_FORBIDDEN', getStatus: 404, expectReattest: false },
          { name: '422-500', putStatus: 422, putCode: 'TEMPLATE_INVALID', getStatus: 500, expectReattest: false },
        ]) {
          const healHome = path.join(root, `self-heal-${scenario.name}`);
          const healDestStore = new DestinationStore(healHome);
          const healPaired = await healDestStore.prepare(`heal-${scenario.name}`, bundleV2, 'Heal Mac');
          let healNow = Date.parse('2026-11-01T00:00:00Z');
          const healClient = () =>
            new NotiBuddyClient(
              healPaired.record.config,
              healPaired.signingKey,
              new PendingStore(healPaired.record.config, healDestStore.root),
              'Heal-Agent',
              undefined,
              { enabled: false },
              { now: () => healNow, resolveTaPublicKey: capResolve }
            );

          let postTemplates = 0;
          let putTemplates = 0;
          let postReqs = 0;
          globalThis.fetch = async (input, init) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            if (method === 'POST' && url.pathname === '/v2/templates') {
              postTemplates += 1;
              return Response.json({
                status: 'certified',
                repaired: false,
                templateId: capRec.templateId,
                skeleton: capRec.skeleton,
                record: capRec,
                changes: [],
              });
            }
            if (method === 'PUT' && url.pathname === `/v2/templates/${capRec.templateId}`) {
              putTemplates += 1;
              return Response.json(
                scenario.putCode ? { error: 'Rejected', code: scenario.putCode } : { error: 'Rejected' },
                { status: scenario.putStatus }
              );
            }
            if (method === 'GET' && url.pathname === `/templates/${capRec.templateId}`) {
              return Response.json({ error: 'Check' }, { status: scenario.getStatus });
            }
            if (method === 'GET' && url.pathname === '/v2/recipients') return Response.json(recipientsPayload);
            if (method === 'POST' && url.pathname === '/v2/requests') {
              postReqs += 1;
              const req = JSON.parse(String(init?.body)) as GroupRequest;
              return Response.json({ requestId: req.requestId, seq: postReqs }, { status: 202 });
            }
            if (method === 'GET' && url.pathname.startsWith('/v2/replies/')) return new Response(null, { status: 204 });
            throw new Error(`Unexpected self-heal call (${scenario.name}): ${method} ${url.pathname}`);
          };

          const first = await healClient().ask({ title: 'Seed', screen: { template: capInline }, waitSeconds: 0 });
          assert.equal(first.status, 'pending', scenario.name);
          assert.equal(postTemplates, 1, scenario.name);

          healNow += 35 * 24 * 60 * 60 * 1000;
          const second = await healClient().ask({ title: 'Second', screen: { template: capInline }, waitSeconds: 0 });
          assert.equal(putTemplates, 1, scenario.name);
          if (scenario.expectReattest) {
            assert.equal(second.status, 'pending', `${scenario.name} must self-heal via re-attestation`);
            assert.equal(postTemplates, 2, `${scenario.name} must call POST /v2/templates`);
            assert.equal(postReqs, 2, scenario.name);
          } else {
            assert.equal(second.status, 'error', `${scenario.name} must not re-attest`);
            assert.equal(postTemplates, 1, `${scenario.name} must not call POST /v2/templates`);
            assert.equal(postReqs, 1, scenario.name);
          }
        }
      }
    }

    console.log('screen-mcp.test.ts: all MCP/CLI screen, cache, refresh-on-send, contract fixture, and settlement tests passed');
  } finally {
    globalThis.fetch = originalFetch;
    for (const c of mcpClients) await c.close().catch(() => {});
    for (const s of httpServers) s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
