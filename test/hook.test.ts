import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeClientBinding } from '../src/client-binding.js';
import { DestinationStore } from '../src/config.js';
import {
  deriveDeviceId,
  generateReplyKeyPair,
  generateSenderSigningKeyPair,
  hpkeOpen,
  importSenderPrivateKey,
} from '../src/crypto.js';
import {
  parseClaudePermissionRequest,
  passthroughStdoutFor,
  renderClaudePermission,
} from '../src/hook-agents.js';
import {
  escapeUntrustedVisible,
  formatClaudePermission,
  MAX_HOOK_DIFF_BYTES,
  MAX_HOOK_MESSAGE_BYTES,
} from '../src/hook-display.js';
import {
  checkHookLedger,
  recordHookDispatchSuccess,
  recordHookQuotaExceeded,
  reserveHookDispatch,
} from '../src/hook-ledger.js';
import { runHook } from '../src/hook.js';
import { buildRequestHeader, sealReply } from '../src/protocol.js';
import type { AnswerPayload, PairingBundle, RequestEnvelope } from '../src/types.js';

process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1';

// Real captured Claude Code PermissionRequest fixtures (from Phase 0 probes).
const REAL_BASH_FIXTURE = JSON.stringify({
  session_id: '931f80e1-b4ca-4cce-ae7b-498254ccb0d7',
  cwd: '/workspace/app',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: {
    command: 'touch probe-marker.txt && rm -f probe-marker.txt',
    description: 'MODEL_PROSE_MUST_NOT_APPEAR',
  },
});

const REAL_EDIT_FIXTURE = JSON.stringify({
  session_id: 'ed2b54e3-d8a3-4a29-8d9c-00ca507d209f',
  cwd: '/workspace/app',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Edit',
  tool_input: {
    file_path: '/workspace/app/src/config.ts',
    old_string: 'const retries = 2;\n',
    new_string: 'const retries = 3;\n',
    replace_all: false,
  },
});

// 1. Display security invariants & Trojan Source escaping.
{
  const parsedBash = parseClaudePermissionRequest(REAL_BASH_FIXTURE);
  assert.equal(parsedBash.ok, true);
  if (parsedBash.ok) {
    const formatted = formatClaudePermission(parsedBash.input);
    assert.equal(formatted.ok, true);
    if (formatted.ok) {
      assert.equal(formatted.prompt.kind, 'approval');
      assert.equal(formatted.prompt.title, 'Approve Bash command?');
      assert.ok(formatted.prompt.message.includes('touch probe-marker.txt && rm -f probe-marker.txt'));
      assert.ok(!formatted.prompt.message.includes('MODEL_PROSE_MUST_NOT_APPEAR'), 'Must omit model-written description');
    }
  }

  // Visible bidi / CR / control / lone-surrogate escaping without normalization.
  const spoofed = 'safe\u202Eevil\r\u0007\u200B\uD800';
  const escaped = escapeUntrustedVisible(spoofed);
  assert.ok(escaped.includes('\\u{202E}'), 'Bidi override must be visibly escaped');
  assert.ok(escaped.includes('\\r'), 'Carriage return must be visibly escaped');
  assert.ok(escaped.includes('\\u{0007}'), 'BEL control char must be visibly escaped');
  assert.ok(escaped.includes('\\u{200B}'), 'Zero-width space must be visibly escaped');
  assert.ok(escaped.includes('\\u{D800}'), 'Lone surrogate must be visibly escaped');

  // Attacker-controlled MCP tool name NEVER enters title.
  const mcpFormatted = formatClaudePermission({
    hookEventName: 'PermissionRequest',
    toolName: 'mcp__evil__Approve_Now_Free_Money',
    toolInput: { arg: 'value' },
  });
  assert.equal(mcpFormatted.ok, true);
  if (mcpFormatted.ok) {
    assert.equal(mcpFormatted.prompt.title, 'Approve tool request?');
  }

  // Never truncate and approve: oversized Bash or Edit MUST passthrough.
  const bigBash = formatClaudePermission({
    hookEventName: 'PermissionRequest',
    toolName: 'Bash',
    toolInput: { command: 'x'.repeat(MAX_HOOK_MESSAGE_BYTES + 10) },
  });
  assert.equal(bigBash.ok, false);

  const bigEdit = formatClaudePermission({
    hookEventName: 'PermissionRequest',
    toolName: 'Edit',
    toolInput: {
      file_path: 'a.ts',
      old_string: 'a'.repeat(MAX_HOOK_DIFF_BYTES),
      new_string: 'b'.repeat(100),
    },
  });
  assert.equal(bigEdit.ok, false);

  // Real Edit fixture produces native diff prompt.
  const parsedEdit = parseClaudePermissionRequest(REAL_EDIT_FIXTURE);
  assert.equal(parsedEdit.ok, true);
  if (parsedEdit.ok) {
    const formatted = formatClaudePermission(parsedEdit.input);
    assert.equal(formatted.ok, true);
    if (formatted.ok && formatted.prompt.kind === 'diff') {
      assert.equal(formatted.prompt.title, 'Approve file edit?');
      assert.equal(formatted.prompt.diff.language, 'typescript');
      assert.equal(formatted.prompt.diff.original, 'const retries = 2;\n');
      assert.equal(formatted.prompt.diff.modified, 'const retries = 3;\n');
    } else {
      assert.fail('Expected native diff prompt for small Edit');
    }
  }
}

// 2. Argv-only passthrough bytes & forbidden output fields property check.
{
  assert.equal(passthroughStdoutFor('claude', 'PermissionRequest'), '');
  assert.equal(passthroughStdoutFor('antigravity', 'PreToolUse'), '{}\n');
  assert.equal(passthroughStdoutFor('antigravity', 'Stop'), '{"decision":""}\n');
  assert.equal(passthroughStdoutFor('unknown-host', 'Whatever'), '{}\n');

  for (const verdict of [
    { kind: 'allow' as const },
    { kind: 'deny' as const, reason: 'Rejected on NotiBuddy device' },
    { kind: 'passthrough' as const, cause: 'timeout' },
  ]) {
    const rendered = renderClaudePermission(verdict);
    assert.equal(rendered.exitCode, 0);
    assert.ok(!rendered.stdout.includes('updatedInput'));
    assert.ok(!rendered.stdout.includes('updatedPermissions'));
    assert.ok(!rendered.stdout.includes('interrupt'));
  }
}

// 3. Ledger: hourly cap + stepped 402 quota breaker (15m -> 30m -> 60m) + reset on success.
const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-hook-ledger-'));
try {
  const t0 = 1_700_000_000_000;
  assert.equal(checkHookLedger('claude-code', 2, t0, ledgerRoot).allowed, true);
  assert.equal(reserveHookDispatch('claude-code', 2, t0, ledgerRoot).allowed, true);
  assert.equal(reserveHookDispatch('claude-code', 2, t0 + 1_000, ledgerRoot).allowed, true);
  const third = reserveHookDispatch('claude-code', 2, t0 + 2_000, ledgerRoot);
  assert.equal(third.allowed, false);
  if (!third.allowed) assert.equal(third.cause, 'hourly_budget_exceeded');

  // Stepped 402 breaker: 15m -> 30m -> 60m -> 60m.
  const u1 = recordHookQuotaExceeded('quota-key', t0, ledgerRoot);
  assert.equal(u1 - t0, 15 * 60_000);
  const blocked = checkHookLedger('quota-key', 30, t0 + 60_000, ledgerRoot);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.cause, 'quota_breaker_open');

  const u2 = recordHookQuotaExceeded('quota-key', u1, ledgerRoot);
  assert.equal(u2 - u1, 30 * 60_000);
  const u3 = recordHookQuotaExceeded('quota-key', u2, ledgerRoot);
  assert.equal(u3 - u2, 60 * 60_000);
  const u4 = recordHookQuotaExceeded('quota-key', u3, ledgerRoot);
  assert.equal(u4 - u3, 60 * 60_000);

  // Any successful dispatch resets the breaker.
  recordHookDispatchSuccess('quota-key', ledgerRoot);
  assert.equal(checkHookLedger('quota-key', 30, u4 - 1_000, ledgerRoot).allowed, true);
} finally {
  fs.rmSync(ledgerRoot, { recursive: true, force: true });
}

// 4. Engine unit tests: defaults (Face ID OFF, sensitive ON), grace abort, debug redaction, property test.
const engRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-hook-engine-'));
try {
  const store = new DestinationStore(engRoot);
  const enc = await generateReplyKeyPair();
  const sig = await generateSenderSigningKeyPair();
  const devId = await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u);
  const bundle: PairingBundle = {
    v: 1,
    relay: 'https://relay.test',
    token: 'nb_snd_hook_eng',
    pairSecret: Buffer.alloc(32).toString('base64url'),
    device: { id: devId, encPub: enc.publicKeyB64u, sigPub: sig.publicKeyB64u, name: 'iPhone' },
  };
  await store.prepare('personal', bundle, 'My Mac');

  // Default: Face ID OFF (`requiresAuth: false`), sensitive ON (`sensitive: true`), sender = "Claude Code".
  let capturedDispatch: any;
  let stdout = '';
  const allowRes = await runHook(['claude', 'PermissionRequest', '--client', 'claude-code', '--grace', '0'], {
    root: engRoot,
    readStdin: async () => ({ ok: true, text: REAL_BASH_FIXTURE }),
    writeStdout: (s) => { stdout += s; },
    dispatch: async (params) => {
      capturedDispatch = params;
      return { outcome: 'approved', requestId: 'req_ok', action: 'Approve', authenticated: false };
    },
  });
  assert.equal(allowRes.exitCode, 0);
  assert.equal(capturedDispatch.requiresAuth, false, 'Face ID must default OFF per owner decision');
  assert.equal(capturedDispatch.askInput.sensitive, true, 'Hidden previews must default ON');
  assert.equal(capturedDispatch.sender, 'Claude Code');
  assert.equal(JSON.parse(stdout).hookSpecificOutput.decision.behavior, 'allow');

  // Opt-in `--requires-auth` + `--show-preview`.
  await runHook(['claude', 'PermissionRequest', '--client', 'claude-code', '--grace', '0', '--requires-auth', '--show-preview'], {
    root: engRoot,
    readStdin: async () => ({ ok: true, text: REAL_BASH_FIXTURE }),
    writeStdout: () => {},
    dispatch: async (params) => {
      capturedDispatch = params;
      return { outcome: 'rejected', requestId: 'req_rej', reason: 'declined', action: 'Reject', authenticated: false };
    },
  });
  assert.equal(capturedDispatch.requiresAuth, true);
  assert.equal(capturedDispatch.askInput.sensitive, false);

  // Grace period abort (simulating user answering locally in terminal) -> ZERO dispatches!
  let dispatchCalls = 0;
  const ac = new AbortController();
  const gracePromise = runHook(['claude', 'PermissionRequest', '--client', 'claude-code', '--grace', '10'], {
    root: engRoot,
    signal: ac.signal,
    readStdin: async () => ({ ok: true, text: REAL_BASH_FIXTURE }),
    writeStdout: () => {},
    dispatch: async () => {
      dispatchCalls += 1;
      return { outcome: 'approved', requestId: 'req_never', action: 'Approve', authenticated: false };
    },
  });
  setTimeout(() => ac.abort(), 30);
  const aborted = await gracePromise;
  assert.equal(aborted.stdout, '');
  assert.equal(dispatchCalls, 0, 'Aborting during grace period must never dispatch');

  // Debug stderr & events.jsonl NEVER leak tool_input / secret commands!
  let stderr = '';
  const secretFixture = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'SUPER_SECRET_TOKEN_XYZ_999' },
  });
  await runHook(['claude', 'PermissionRequest', '--client', 'claude-code', '--to', 'personal'], {
    root: engRoot,
    debug: true,
    readStdin: async () => ({ ok: true, text: secretFixture }),
    writeStdout: () => {},
    writeStderr: (s) => { stderr += s; },
  });
  assert.match(stderr, /conflicting_client_and_to/);
  assert.ok(!stderr.includes('SUPER_SECRET_TOKEN_XYZ_999'));
  const logText = fs.readFileSync(path.join(engRoot, 'hooks', 'events.jsonl'), 'utf8');
  assert.ok(!logText.includes('SUPER_SECRET_TOKEN_XYZ_999'), 'Metadata log must never contain tool_input');

  // Property test: no non-approved outcome or malformed input EVER emits `allow`!
  const adversarialOutcomes: Array<any> = [
    { outcome: 'rejected', requestId: 'r1', reason: 'declined', action: 'Reject', authenticated: false },
    { outcome: 'rejected', requestId: 'r2', reason: 'unauthenticated', action: 'Approve', authenticated: false },
    { outcome: 'rejected', requestId: 'r3', reason: 'unexpected_action', action: 'allow', authenticated: true },
    { outcome: 'expired', requestId: 'r4' },
    { outcome: 'error', requestId: 'r5', errorCode: 'DAILY_LIMIT_EXCEEDED', message: 'limit' },
    { outcome: 'error', errorCode: 'NETWORK', message: 'offline' },
  ];
  for (const outcome of adversarialOutcomes) {
    let outStr = '';
    const r = await runHook(['claude', 'PermissionRequest', '--to', 'personal', '--grace', '0', '--max-per-hour', '0'], {
      root: engRoot,
      readStdin: async () => ({ ok: true, text: REAL_BASH_FIXTURE }),
      writeStdout: (s) => { outStr += s; },
      dispatch: async () => outcome,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(!outStr.includes('"allow"'), `Must never allow for outcome ${JSON.stringify(outcome)}`);
  }
} finally {
  fs.rmSync(engRoot, { recursive: true, force: true });
}

// 5. Real subprocess E2EE test of `dist/cli.js hook claude PermissionRequest` against mock relay.
const e2eRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-hook-e2e-'));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let server: http.Server | undefined;
try {
  const deviceEnc = await generateReplyKeyPair();
  const deviceSig = await generateSenderSigningKeyPair();
  const deviceSigKey = await importSenderPrivateKey(deviceSig.privateKeyJwk);
  const deviceId = await deriveDeviceId(deviceEnc.publicKeyB64u, deviceSig.publicKeyB64u);

  let mode: 'allow' | 'deny' | 'quota' = 'allow';
  const savedRequests = new Map<string, any>();

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'POST' && url.pathname === '/v1/requests') {
      if (mode === 'quota') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Free request allowance used', code: 'DAILY_LIMIT_EXCEEDED' }));
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
      savedRequests.set(envelope.requestId, JSON.parse(plaintext));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requestId: envelope.requestId, seq: 1 }));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/replies/')) {
      const requestId = decodeURIComponent(url.pathname.slice('/v1/replies/'.length));
      const payload = savedRequests.get(requestId);
      const answer: AnswerPayload =
        mode === 'allow'
          ? { action: payload.filename ? 'approve' : 'Approve', authenticated: false }
          : { action: payload.filename ? 'reject' : 'Reject', authenticated: false };
      const reply = await sealReply({
        requestId,
        deviceId,
        deviceSigningPrivateKey: deviceSigKey,
        replyPublicKey: payload.replyPub,
        answer,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...reply, seq: 1 }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const store = new DestinationStore(e2eRoot);
  const bundle: PairingBundle = {
    v: 1,
    relay: `http://127.0.0.1:${port}`,
    token: 'nb_snd_hook_e2e',
    pairSecret: Buffer.alloc(32).toString('base64url'),
    device: { id: deviceId, encPub: deviceEnc.publicKeyB64u, sigPub: deviceSig.publicKeyB64u, name: 'Test iPhone' },
  };
  const rec = await store.prepare('personal', bundle, 'My Mac');
  writeClientBinding('claude-code', 'personal', rec.record.connectionId, e2eRoot);

  const runSub = (args: string[], stdinText: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, [cli, ...args], {
        env: { ...process.env, NOTIBUDDY_HOME: e2eRoot, NOTIBUDDY_NO_UPDATE_CHECK: '1' },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (c) => { stdout += c.toString(); });
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
      proc.stdin.end(stdinText);
    });

  // E2EE Bash allow.
  mode = 'allow';
  const rAllow = await runSub(['hook', 'claude', 'PermissionRequest', '--client', 'claude-code', '--grace', '0', '--timeout', '15'], REAL_BASH_FIXTURE);
  assert.equal(rAllow.status, 0, rAllow.stderr);
  assert.equal(JSON.parse(rAllow.stdout).hookSpecificOutput.decision.behavior, 'allow');

  // E2EE Edit diff allow!
  const rEditAllow = await runSub(['hook', 'claude', 'PermissionRequest', '--client', 'claude-code', '--grace', '0', '--timeout', '15'], REAL_EDIT_FIXTURE);
  assert.equal(rEditAllow.status, 0, rEditAllow.stderr);
  assert.equal(JSON.parse(rEditAllow.stdout).hookSpecificOutput.decision.behavior, 'allow');

  // E2EE Bash deny.
  mode = 'deny';
  const rDeny = await runSub(['hook', 'claude', 'PermissionRequest', '--client', 'claude-code', '--grace', '0', '--timeout', '15'], REAL_BASH_FIXTURE);
  assert.equal(rDeny.status, 0);
  const denyJson = JSON.parse(rDeny.stdout);
  assert.equal(denyJson.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(denyJson.hookSpecificOutput.decision.message, /Rejected/);

  // E2EE 402 quota -> silent passthrough (exit 0, empty stdout) AND trips quota breaker!
  mode = 'quota';
  const rQuota = await runSub(['hook', 'claude', 'PermissionRequest', '--client', 'claude-code', '--grace', '0', '--timeout', '15'], REAL_BASH_FIXTURE);
  assert.equal(rQuota.status, 0);
  assert.equal(rQuota.stdout, '');
  assert.equal(checkHookLedger('claude-code', 30, Date.now(), e2eRoot).allowed, false);

  // SIGTERM during grace in real subprocess -> exit 0, empty stdout!
  const child = spawn(
    process.execPath,
    [cli, 'hook', 'claude', 'PermissionRequest', '--to', 'personal', '--grace', '10'],
    { env: { ...process.env, NOTIBUDDY_HOME: e2eRoot, NOTIBUDDY_NO_UPDATE_CHECK: '1' } },
  );
  child.stdin.end(REAL_BASH_FIXTURE);
  let childOut = '';
  child.stdout.on('data', (c) => { childOut += c.toString(); });
  await new Promise((r) => setTimeout(r, 200));
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  assert.equal(code, 0);
  assert.equal(childOut, '');

  console.log('Hook engine, display, ledger, and E2EE subprocess tests passed.');
} finally {
  server?.close();
  fs.rmSync(e2eRoot, { recursive: true, force: true });
}
