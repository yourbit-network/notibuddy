import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge, waitForDecision } from '../src/approval.js';
import type { AskResult } from '../src/client.js';
import { DestinationStore } from '../src/config.js';
import {
  deriveDeviceId,
  generateReplyKeyPair,
  generateSenderSigningKeyPair,
  hpkeOpen,
  importSenderPrivateKey,
} from '../src/crypto.js';
import { buildRequestHeader, sealReply } from '../src/protocol.js';
import type { AnswerPayload, PairingBundle, RequestEnvelope } from '../src/types.js';

process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1';

// 1. Table-driven judge() unit tests across status x action x authenticated.
{
  const cases: Array<{ name: string; res: AskResult; spec: { approveAction: string; requiresAuth: boolean }; expected: string; reason?: string }> = [
    {
      name: 'approved without auth required',
      res: { status: 'resolved', requestId: 'req_1', answer: { action: 'Approve', authenticated: false } },
      spec: { approveAction: 'Approve', requiresAuth: false },
      expected: 'approved',
    },
    {
      name: 'approved with auth required and authenticated=true',
      res: { status: 'resolved', requestId: 'req_2', answer: { action: 'Approve', authenticated: true } },
      spec: { approveAction: 'Approve', requiresAuth: true },
      expected: 'approved',
    },
    {
      name: 'rejected when auth required but authenticated=false',
      res: { status: 'resolved', requestId: 'req_3', answer: { action: 'Approve', authenticated: false } },
      spec: { approveAction: 'Approve', requiresAuth: true },
      expected: 'rejected',
      reason: 'unauthenticated',
    },
    {
      name: 'rejected when user picks Reject',
      res: { status: 'resolved', requestId: 'req_4', answer: { action: 'Reject', authenticated: false } },
      spec: { approveAction: 'Approve', requiresAuth: false },
      expected: 'rejected',
      reason: 'declined',
    },
    {
      name: 'diff rejects UI label Apply (must be lowercase approve)',
      res: { status: 'resolved', requestId: 'req_5', answer: { action: 'Apply', authenticated: true } },
      spec: { approveAction: 'approve', requiresAuth: false },
      expected: 'rejected',
      reason: 'declined',
    },
    {
      name: 'diff approves lowercase approve',
      res: { status: 'resolved', requestId: 'req_6', answer: { action: 'approve', authenticated: true } },
      spec: { approveAction: 'approve', requiresAuth: true },
      expected: 'approved',
    },
    {
      name: 'expired maps to expired',
      res: { status: 'expired', requestId: 'req_7' },
      spec: { approveAction: 'Approve', requiresAuth: false },
      expected: 'expired',
    },
    {
      name: 'not_found maps to error',
      res: { status: 'not_found', requestId: 'req_8' },
      spec: { approveAction: 'Approve', requiresAuth: false },
      expected: 'error',
    },
    {
      name: '402 quota error maps to error',
      res: { status: 'error', requestId: 'req_9', errorCode: 'DAILY_LIMIT_EXCEEDED', message: 'Quota used' },
      spec: { approveAction: 'Approve', requiresAuth: false },
      expected: 'error',
    },
  ];

  for (const c of cases) {
    const out = judge(c.res, c.spec);
    assert.equal(out.outcome, c.expected, c.name);
    if (c.reason && out.outcome === 'rejected') {
      assert.equal(out.reason, c.reason, c.name);
    }
  }
}

// 2. Multi-window waitForDecision() asserts strictly ONE creation call + backoff on RETRY_REQUIRED.
{
  let fakeNow = 1_000_000;
  const sleeps: number[] = [];
  const calls: Array<{ resumeId?: string; title?: string; waitSeconds?: number }> = [];

  const mockClient = {
    async ask(input: any): Promise<AskResult> {
      calls.push({ resumeId: input.resumeId, title: input.title, waitSeconds: input.waitSeconds });
      if (calls.length === 1) {
        return { status: 'pending', requestId: 'req_multi', errorCode: 'RETRY_REQUIRED' };
      }
      if (calls.length === 2) {
        return { status: 'pending', requestId: 'req_multi', errorCode: 'RETRY_REQUIRED' };
      }
      if (calls.length === 3) {
        fakeNow += 5_000;
        return { status: 'pending', requestId: 'req_multi' };
      }
      return { status: 'resolved', requestId: 'req_multi', answer: { action: 'Approve', authenticated: true } };
    },
  };

  const out = await waitForDecision(
    mockClient,
    { title: 'Deploy?', options: ['Approve', 'Reject'], declineOption: 'Reject', timeoutSeconds: 60 },
    { approveAction: 'Approve', requiresAuth: true },
    {
      localGraceSeconds: 0,
      windowSeconds: 5,
      now: () => fakeNow,
      sleep: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
    },
  );

  assert.equal(out.outcome, 'approved');
  assert.equal(calls.filter((c) => c.title !== undefined).length, 1, 'Exactly one initial dispatch');
  assert.deepEqual(
    calls.slice(1).map((c) => c.resumeId),
    ['req_multi', 'req_multi', 'req_multi'],
  );
  assert.deepEqual(sleeps, [1_000, 2_000], 'Exponential backoff on fast RETRY_REQUIRED without sleeping after normal wait');
}

// 3. End-to-end CLI subprocess tests for `nb gate` against a real local E2EE HTTP mock relay.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gate-cli-'));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let server: http.Server | undefined;

try {
  const deviceEnc = await generateReplyKeyPair();
  const deviceSig = await generateSenderSigningKeyPair();
  const deviceSigKey = await importSenderPrivateKey(deviceSig.privateKeyJwk);
  const deviceId = await deriveDeviceId(deviceEnc.publicKeyB64u, deviceSig.publicKeyB64u);

  let mode: 'approve_auth' | 'approve_no_auth' | 'reject' | 'diff_approve' | 'diff_apply_label' | 'expired' | 'quota' | 'pending_then_approve' = 'approve_auth';
  let postCount = 0;
  let pollCount = 0;
  const savedRequests = new Map<string, { envelope: RequestEnvelope; payload: any }>();

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'POST' && url.pathname === '/v1/requests') {
      postCount += 1;
      if (mode === 'quota') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Free relay limit reached', code: 'DAILY_LIMIT_EXCEEDED' }));
        return;
      }
      const envelope = JSON.parse(body) as RequestEnvelope;
      const plaintext = await hpkeOpen(
        deviceEnc.privateKey,
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
      );
      savedRequests.set(envelope.requestId, { envelope, payload: JSON.parse(plaintext) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requestId: envelope.requestId, seq: postCount }));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/replies/')) {
      pollCount += 1;
      const requestId = decodeURIComponent(url.pathname.slice('/v1/replies/'.length));
      const saved = savedRequests.get(requestId);
      if (!saved) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      if (mode === 'expired') {
        res.writeHead(410);
        res.end('{}');
        return;
      }
      if (mode === 'pending_then_approve' && pollCount < 2) {
        res.writeHead(204);
        res.end();
        return;
      }

      let answer: AnswerPayload;
      if (mode === 'approve_auth' || mode === 'pending_then_approve') {
        answer = { action: 'Approve', authenticated: true };
      } else if (mode === 'approve_no_auth') {
        answer = { action: 'Approve', authenticated: false };
      } else if (mode === 'reject') {
        answer = { action: 'Reject', authenticated: false };
      } else if (mode === 'diff_approve') {
        answer = { action: 'approve', authenticated: true };
      } else {
        answer = { action: 'Apply', authenticated: true };
      }

      const reply = await sealReply({
        requestId,
        deviceId,
        deviceSigningPrivateKey: deviceSigKey,
        replyPublicKey: saved.payload.replyPub,
        answer,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...reply, seq: pollCount }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };

  const store = new DestinationStore(root);
  const bundle: PairingBundle = {
    v: 1,
    relay: `http://127.0.0.1:${port}`,
    token: 'nb_snd_gate_test',
    pairSecret: Buffer.alloc(32).toString('base64url'),
    device: { id: deviceId, encPub: deviceEnc.publicKeyB64u, sigPub: deviceSig.publicKeyB64u, name: 'Test iPhone' },
  };
  await store.prepare('ci', bundle, 'GitHub Actions');

  const runCli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, [cli, ...args], {
        env: { ...process.env, NOTIBUDDY_HOME: root, NOTIBUDDY_NO_UPDATE_CHECK: '1' },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (c) => { stdout += c.toString(); });
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  // Approved with Face ID -> exit 0.
  mode = 'approve_auth';
  const okRes = await runCli(['gate', 'Deploy prod?', '--to', 'ci', '--requires-auth', '--timeout', '30']);
  assert.equal(okRes.status, 0, okRes.stderr);
  const okJson = JSON.parse(okRes.stdout);
  assert.equal(okJson.outcome, 'approved');
  assert.equal(okJson.authenticated, true);
  assert.equal(okJson.to, 'ci');

  // Approved WITHOUT auth when --requires-auth set -> exit 2!
  mode = 'approve_no_auth';
  const noAuthRes = await runCli(['gate', 'Deploy prod?', '--to', 'ci', '--requires-auth', '--timeout', '30']);
  assert.equal(noAuthRes.status, 2);
  assert.equal(JSON.parse(noAuthRes.stdout).outcome, 'rejected');
  assert.equal(JSON.parse(noAuthRes.stdout).reason, 'unauthenticated');

  // Rejected -> exit 2!
  mode = 'reject';
  const rejRes = await runCli(['gate', 'Deploy prod?', '--to', 'ci', '--timeout', '30']);
  assert.equal(rejRes.status, 2);
  assert.equal(JSON.parse(rejRes.stdout).outcome, 'rejected');

  // Regression: `nb notify` STILL exits 0 on Reject!
  const notifyRej = await runCli(['notify', 'Deploy prod?', '--to', 'ci', '--options', 'Approve,Reject', '--wait', '10']);
  assert.equal(notifyRej.status, 0, 'nb notify backward-compat exit 0 on Reject must stay intact');
  assert.equal(JSON.parse(notifyRej.stdout).answer.action, 'Reject');

  // Diff tests: lowercase `approve` exits 0; UI label `Apply` MUST exit 2!
  const diffPath = path.join(root, 'plan.json');
  fs.writeFileSync(diffPath, JSON.stringify({ filename: 'plan.tf', original: 'a\n', modified: 'b\n' }));
  mode = 'diff_approve';
  const diffOk = await runCli(['gate', 'Apply plan?', '--to', 'ci', '--diff', diffPath, '--requires-auth', '--timeout', '30']);
  assert.equal(diffOk.status, 0, diffOk.stderr);
  assert.equal(JSON.parse(diffOk.stdout).action, 'approve');

  mode = 'diff_apply_label';
  const diffBadLabel = await runCli(['gate', 'Apply plan?', '--to', 'ci', '--diff', diffPath, '--timeout', '30']);
  assert.equal(diffBadLabel.status, 2, 'Diff must reject UI label Apply and require lowercase approve');

  // Expired (410) -> exit 3!
  mode = 'expired';
  const expRes = await runCli(['gate', 'Deploy?', '--to', 'ci', '--timeout', '30']);
  assert.equal(expRes.status, 3);
  assert.equal(JSON.parse(expRes.stdout).outcome, 'expired');

  // Quota (402) -> exit 1!
  mode = 'quota';
  const quotaRes = await runCli(['gate', 'Deploy?', '--to', 'ci', '--timeout', '30']);
  assert.equal(quotaRes.status, 1);
  assert.equal(JSON.parse(quotaRes.stdout).errorCode, 'DAILY_LIMIT_EXCEEDED');

  // SIGTERM -> exit 143!
  mode = 'pending_then_approve';
  pollCount = -100; // stay pending until killed
  const child = spawn(process.execPath, [cli, 'gate', 'Hold?', '--to', 'ci', '--timeout', '30'], {
    env: { ...process.env, NOTIBUDDY_HOME: root, NOTIBUDDY_NO_UPDATE_CHECK: '1' },
  });
  await new Promise((r) => setTimeout(r, 400));
  child.kill('SIGTERM');
  const sigCode = await new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  assert.equal(sigCode, 143);

  console.log('Gate & approval tests passed.');
} finally {
  server?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
