#!/usr/bin/env node
// Actual Windows console Ctrl+C against the exact published CLI.
// Synthetic loopback phone/Watch; no user profile or production service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {releaseExpectation, isolatedEnvironment, npmCLI, verifyInstalledLock} from './check-installed-client.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const [releaseFile, outputDirectory, platform] = process.argv.slice(2);
assert.equal(process.argv.length, 5, 'Usage: node scripts/check-windows-console.mjs RELEASE_JSON OUTPUT_DIRECTORY win32');
assert(platform === 'win32' && process.platform === platform, 'Requires an actual Windows host');
const output = path.resolve(outputDirectory);
fs.mkdirSync(output, {recursive: true});
const receipt = path.join(output, 'receipt.json');
assert(!fs.existsSync(receipt), 'Use a new output directory');
const result = {startedAt: new Date().toISOString(), completed: false, platform, architecture: process.arch,
  osRelease: os.release(), node: process.version, cases: [], commands: [],
  limits: ['Synthetic v1 phone and v2 phone/Watch over loopback; no Apple device, hosted relay or APNs.',
    'Generates Windows CTRL_C_EVENT in an isolated child console; does not emulate a keypress or terminal shutdown.',
    'No forced termination, pending-write interruption or power-loss durability claim in this lane.',
    'Resume uses the request ID printed by the interrupted CLI.',
    'Fetch interception is not an OS firewall or packet capture.']};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy signal acceptance '));
let server, active, executionEnv, stage = 'install';
const children = new Set();
async function command(label, executable, args, env, cwd = temporary) {
  const out = await execute(executable, args, {env, cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024});
  result.commands.push({label, stdoutSHA256: hash(out.stdout), stderrSHA256: hash(out.stderr)});
  return out;
}
function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(label)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
try {
  const releaseBytes = fs.readFileSync(path.resolve(releaseFile));
  const expected = releaseExpectation(JSON.parse(releaseBytes));
  result.releaseReceiptSHA256 = hash(releaseBytes); result.expected = expected;
  const archiveResponse = await fetch(expected.tarball, {redirect: 'error', signal: AbortSignal.timeout(20000)});
  assert.equal(archiveResponse.status, 200);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  assert.equal(hash(archive), expected.sha256);
  assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), expected.integrity);
  const consumer = path.join(temporary, 'consumer'), profile = path.join(temporary, 'profile');
  fs.mkdirSync(consumer, {mode: 0o700});
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({name: 'signal-acceptance', private: true,
    dependencies: {notibuddy: expected.version}}));
  const user = path.join(temporary, 'empty-user.npmrc'), global = path.join(temporary, 'empty-global.npmrc');
  fs.writeFileSync(user, ''); fs.writeFileSync(global, '');
  const env = isolatedEnvironment({temporary, profile, cache: path.join(temporary, 'cache'), user, global});
  executionEnv = env;
  const npm = npmCLI();
  result.npm = (await command('npm-version', process.execPath, [npm, '--version'], env)).stdout.trim();
  await command('fresh-registry-install', process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], env, consumer);
  const installed = path.join(consumer, 'node_modules/notibuddy');
  const lockBytes = fs.readFileSync(path.join(consumer, 'package-lock.json'));
  verifyInstalledLock(JSON.parse(lockBytes), installed, expected); result.lockSHA256 = hash(lockBytes);
  result.installedFiles = [];
  function inventory(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inventory(file);
      else { assert(entry.isFile()); result.installedFiles.push({path: path.relative(installed, file), sha256: hash(fs.readFileSync(file))}); }
    }
  }
  inventory(installed); assert.equal(result.installedFiles.length, expected.files);
  const api = await import(pathToFileURL(path.join(installed, 'dist/index.js')).href);
  const group = await import(pathToFileURL(path.join(installed, 'dist/group-wire.js')).href);
  const {companionGrantInput} = await import(pathToFileURL(path.join(installed, 'dist/companion-grant.js')).href);
  const {PendingStore} = await import(pathToFileURL(path.join(installed, 'dist/pending-store.js')).href);
  const enc = await api.generateReplyKeyPair(), sig = await api.generateSenderSigningKeyPair();
  const device = {id: await api.deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u), encPub: enc.publicKeyB64u,
    sigPub: sig.publicKeyB64u, name: 'Signal fixture'};
  const watchEnc = await api.generateReplyKeyPair(), watchSig = await api.generateSenderSigningKeyPair();
  const watch = {deviceId: await api.deriveDeviceId(watchEnc.publicKeyB64u, watchSig.publicKeyB64u),
    encPub: watchEnc.publicKeyB64u, sigPub: watchSig.publicKeyB64u};
  const token = 'nb_snd_signal_fixture';
  const grant = {v: 1, accountId: hash(token.slice(7)).slice(0, 32), parentDeviceId: device.id, ...watch,
    credentialHash: hash('synthetic-watch-credential'), capabilities: ['approval', 'text_input', 'timer_control'],
    generation: 2, nonce: Buffer.alloc(32, 1).toString('base64url'), expiresAt: 1};
  const roster = {v: 2, deviceId: device.id, generation: 2,
    primary: {deviceId: device.id, encPub: device.encPub, sigPub: device.sigPub}, companions: [{grant,
      parentSignature: await api.ecdsaSign(sig.privateKey, companionGrantInput(grant, 'parent')),
      childSignature: await api.ecdsaSign(watchSig.privateKey, companionGrantInput(grant, 'child'))}]};
  const registrations = new Map();
  let relayFailure;
  server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const wire = Buffer.concat(chunks).toString(), body = wire ? JSON.parse(wire) : undefined;
      const url = new URL(request.url, 'http://127.0.0.1');
      const json = (status, value) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(value)); };
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      if (request.method === 'POST' && url.pathname === '/v1/senders') {
        registrations.set(body.senderKeyId, body); json(200, {status: 'registered', senderKeyId: body.senderKeyId}); return;
      }
      assert(active);
      if (active.protocol === 2 && request.method === 'GET') {
        const sender = registrations.get(request.headers['x-sender-key-id']); assert(sender);
        const input = `nb1|http|GET|${url.pathname}${url.search}|${request.headers['x-sender-timestamp']}|${request.headers['x-sender-nonce']}|${hash(wire)}`;
        assert(await api.ecdsaVerify(sender.senderPub, Buffer.from(input), request.headers['x-sender-signature']));
        active.signedLookups++;
      }
      if (request.method === 'GET' && url.pathname === '/v2/recipients') {
        assert.equal(active.protocol, 2); assert.equal(url.searchParams.get('deviceId'), device.id);
        assert.equal(active.phase === 'resume', false, 'Resume must use the original saved membership');
        active.discovery++; json(200, roster); return;
      }
      if (request.method === 'POST' && url.pathname === `/v${active.protocol}/requests`) {
        assert.equal(body.v, active.protocol); assert.equal(body.deviceId, device.id);
        const registration = registrations.get(body.senderKeyId); assert(registration);
        if (body.v === 1) {
          const header = api.buildRequestHeader(body.requestId, body.deviceId, body.senderKeyId, body.primitive, body.createdAt, body.expiresAt);
          assert(await api.ecdsaVerify(registration.senderPub, Buffer.concat([Buffer.from(header), Buffer.from([0]),
            Buffer.from(body.enc, 'base64url'), Buffer.from(body.ct, 'base64url')]), body.sig));
        } else {
          assert(group.validGroupRequest(body)); assert.equal(body.deliveries.length, 2);
          for (const delivery of body.deliveries) assert(await api.ecdsaVerify(registration.senderPub,
            group.groupDeliveryInput(body, delivery), delivery.sig));
        }
        active.posts++;
        if (active.wire) assert.equal(wire, active.wire, 'Retry changed signed bytes');
        else { active.wire = wire; active.envelope = body; }
        if (active.phase === 'dispatch') { active.ready(); return; }
        json(202, {requestId: body.requestId, seq: 1}); return;
      }
      assert.equal(request.method, 'GET');
      assert.equal(url.pathname, `/v${active.protocol}/replies/` + active.envelope.requestId);
      active.gets++;
      if (active.phase === 'reply-body') {
        response.writeHead(200, {'content-type': 'application/json'}); response.write('{'); active.ready(); return;
      }
      assert.equal(active.phase, 'resume'); json(200, active.reply);
    } catch (error) {
      relayFailure = error.name;
      if (!response.headersSent) response.writeHead(500);
      response.end(); active?.ready();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = 'http://127.0.0.1:' + server.address().port;
  const guard = path.join(temporary, 'loopback-only.mjs'), audit = path.join(temporary, 'fetch-audit.jsonl');
  // Record before dispatch rather than relying on a child exit handler.
  fs.writeFileSync(guard, `import {appendFileSync} from 'node:fs';const original=fetch;
globalThis.fetch=(url,options)=>{const blocked=Number(new URL(String(url)).origin!==${JSON.stringify(relay)});
appendFileSync(${JSON.stringify(audit)},JSON.stringify({calls:1-blocked,blocked})+'\\n');
if(blocked)throw Error('Non-loopback fetch');return original(url,options);};`, {mode: 0o600});
  const cli = path.join(installed, 'dist/cli.js');
  const cliArgs = args => ['--import', pathToFileURL(guard).href, cli, ...args];
  const destinations = new Map();
  for (const protocol of [1, 2]) {
    const name = 'phone-v' + protocol;
    const bundle = 'nbpair1.' + Buffer.from(JSON.stringify({v: 1, relay, token, device,
      pairSecret: Buffer.alloc(32).toString('base64url'), requestProtocol: protocol,
      ...(protocol === 2 ? {minimumRecipientGeneration: 2} : {})})).toString('base64url');
    assert.match((await command('pair-v' + protocol, process.execPath,
      cliArgs(['pair', bundle, '--to', name, '--wait', '0']), env)).stdout, /Pairing confirmed/);
    destinations.set(protocol, new api.DestinationStore(profile).read(name));
  }
  stage = 'signals';
  const cases = [1, 2].flatMap(protocol => ['dispatch', 'reply-body'].map(phase => ({protocol, phase})));
  for (const {protocol, phase} of cases) {
    stage = 'v' + protocol + '-' + phase + '-CTRL_C_EVENT';
    const destination = destinations.get(protocol), saved = new PendingStore(destination.config, profile);
    const name = 'phone-v' + protocol;
    let ready;
    const reached = new Promise(resolve => { ready = resolve; });
    active = {protocol, phase, ready, posts: 0, gets: 0, discovery: 0, signedLookups: 0};
    const args = cliArgs(['ask', 'Synthetic signal recovery', '--to', name, '--wait', '55']);
    const controlReceipt = path.join(temporary, stage + '-console.json');
    const controlTrigger = path.join(temporary, stage + '-interrupt');
    const launchConfig = path.join(temporary, stage + '-launch.json');
    fs.writeFileSync(launchConfig, JSON.stringify({node: process.execPath, args, cwd: temporary,
      trigger: controlTrigger, receipt: controlReceipt}));
    const powershell = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(new URL('./fixtures/windows-console-interrupt.ps1', import.meta.url)),
      '-ConfigPath', launchConfig],
      {cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false});
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const ended = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, terminationSignal) => {
        result.helperExit = {code, signal: terminationSignal, stdoutSHA256: hash(stdout), stderrSHA256: hash(stderr)};
        if (fs.existsSync(controlReceipt)) {
          try {
            const probe = JSON.parse(fs.readFileSync(controlReceipt, 'utf8').replace(/^\uFEFF/, ''));
            if (probe.failure) result.helperFailure = probe.failure;
          } catch {
            result.helperFailure = {stage: 'receipt', kind: 'InvalidProbeReceipt'};
          }
        }
        children.delete(child); resolve({code, signal: terminationSignal});
      });
    });
    await bounded(Promise.race([reached, ended.then(() => { throw Error('CLI exited before interruption point'); })]),
      20000, 'CLI did not reach interruption point');
    assert(!relayFailure); assert(active.envelope);
    const id = active.envelope.requestId;
    const before = saved.read('reply:' + id);
    assert(before?.privateKeyJwk);
    assert.equal(before.expiresAt - active.envelope.createdAt, 10800);
    const stoppedAt = Date.now();
    fs.writeFileSync(controlTrigger, 'interrupt');
    const helperExit = await bounded(ended, 5000, 'Console event did not stop the CLI promptly');
    assert.equal(helperExit.code, 0); assert.equal(helperExit.signal, null);
    assert.equal(stdout, ''); assert.equal(stderr, '');
    const observation = JSON.parse(fs.readFileSync(controlReceipt, 'utf8').replace(/^\uFEFF/, ''));
    const consoleEvent = observation.consoleEvent;
    assert.deepEqual(consoleEvent, {event: 'CTRL_C_EVENT', isolatedConsoleProcesses: 2, targetPresent: true, sent: true});
    const exit = {code: observation.exitCode, signal: null};
    const elapsedMs = Date.now() - stoppedAt;
    assert.equal(exit.code, 130);
    stdout = observation.stdout; stderr = observation.stderr;
    assert.equal(stdout, '');
    assert(stderr.includes("resume_id='" + id + "'"));
    assert(!stderr.includes(destination.config.token)); assert(!stderr.includes(before.privateKeyJwk.d));
    const after = saved.read('reply:' + id);
    assert(after?.privateKeyJwk);
    const original = before;
    assert.deepEqual(after.privateKeyJwk, original.privateKeyJwk); assert.deepEqual(after.envelope, original.envelope);
    assert.equal(after.expiresAt, original.expiresAt);
    assert.equal(after.expiresAt - active.envelope.createdAt, 10800);
    const lockFiles = fs.readdirSync(saved.directory).filter(p => p.endsWith('.operation.lock'));
    assert.equal(lockFiles.length, 0);
    if (protocol === 1) {
      const payload = JSON.parse(await api.hpkeOpen(enc.privateKey, active.envelope.enc, 'notibuddy/v1/request',
        api.buildRequestHeader(id, device.id, active.envelope.senderKeyId, active.envelope.primitive, active.envelope.createdAt, active.envelope.expiresAt), active.envelope.ct));
      assert.equal(payload.title, 'Synthetic signal recovery');
      active.reply = {...await api.sealReply({requestId: id, deviceId: device.id, deviceSigningPrivateKey: sig.privateKey,
        replyPublicKey: payload.replyPub, answer: {action: 'approve'}}), seq: 1};
    } else {
      assert.deepEqual(after.recipients, original.recipients); assert.deepEqual(after.recipients, roster);
      let payload;
      for (const [actor, key] of [[device.id, enc.privateKey], [watch.deviceId, watchEnc.privateKey]]) {
        const delivery = active.envelope.deliveries.find(d => d.deviceId === actor); assert(delivery);
        const opened = JSON.parse(await api.hpkeOpen(key, delivery.enc, 'notibuddy/v2/request',
          group.groupDeliveryHeader(active.envelope, actor), delivery.ct));
        assert.equal(opened.title, 'Synthetic signal recovery');
        if (payload) assert.deepEqual(opened, payload); payload = opened;
      }
      const answer = JSON.stringify({action: 'approve'});
      const reply = {v: 2, kind: 'reply', requestId: id, parentDeviceId: device.id, deviceId: watch.deviceId,
        generation: 2, responseId: 'reply_' + randomUUID(), createdAt: Math.floor(Date.now() / 1000), enc: '', ct: '', sig: '',
        receipts: [{deviceId: device.id, enc: '', ct: ''}]};
      const header = group.groupResponseHeader(reply);
      Object.assign(reply, await api.hpkeSeal(payload.replyPub, 'notibuddy/v2/reply', header + '|sender', answer));
      Object.assign(reply.receipts[0], await api.hpkeSeal(device.encPub, 'notibuddy/v2/receipt', header + '|receipt|' + device.id, answer));
      reply.sig = await api.ecdsaSign(watchSig.privateKey, group.groupResponseInput(reply));
      assert(group.validGroupResponse(reply));
      active.reply = {seq: 1, envelope: reply};
    }
    active.phase = 'resume';
    const resumed = JSON.parse((await command('resume-' + stage, process.execPath,
      cliArgs(['ask', '--resume', id, '--to', name, '--wait', '0']), env)).stdout);
    assert.equal(resumed.status, 'resolved'); assert.equal(resumed.answer.action, 'approve');
    assert.equal(resumed.requestId, id); assert.equal(saved.read('reply:' + id), undefined);
    assert.equal(active.posts, phase === 'dispatch' ? 2 : 1); assert(!relayFailure);
    assert.equal(active.discovery, protocol === 2 ? 1 : 0);
    assert.equal(active.signedLookups, protocol === 2 ? active.gets + 1 : 0);
    const residue = fs.readdirSync(profile, {recursive: true}).filter(p => /\.(tmp|lock)([\\/]|$)/.test(String(p)));
    assert.deepEqual(residue, []);
    result.cases.push({protocol, phase, consoleEvent, exitCode: exit.code, terminationSignal: exit.signal, elapsedMs,
      resumeIdReported: true, operationLockReleased: true,
      sameKeyAndEnvelopeRetained: true, unchangedThreeHourExpiry: true, verifiedReplyResolved: true,
      responder: protocol === 2 ? 'watch' : 'phone', recipientDiscoveries: active.discovery,
      originalRecipientSnapshotRetained: protocol === 2, signedLookups: active.signedLookups,
      dispatches: active.posts, replyLookups: active.gets, temporaryAndLockResidue: 0});
  }
  const fetches = fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(fetches.every(x => x.blocked === 0));
  result.loopbackFetches = fetches.reduce((n, x) => n + x.calls, 0); result.nonLoopbackFetchAttempts = 0;
  result.completed = true;
} catch (error) {
  result.failure = {stage, kind: error.name,
    sourceLine: Number(error.stack?.match(/check-windows-console\.mjs:(\d+):/)?.[1]) || undefined};
} finally {
  try {
    await Promise.all([...children].map(async child => {
      const closed = new Promise(resolve => child.once('close', resolve));
      // Windows kill() only terminates the PowerShell helper. Clean up its
      // owned CLI subtree too if the harness fails before normal completion.
      try {
        await execute(path.join(executionEnv.SystemRoot, 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], {env: executionEnv, timeout: 5000});
      } catch {
        // The helper may already have exited during the cleanup race.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await bounded(closed, 5000, 'Test helper did not stop during cleanup');
    }));
  } catch {
    result.completed = false; result.failure = {stage: 'cleanup', kind: 'ProcessCleanupFailed'};
  }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try {
    fs.rmSync(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    result.temporaryProfilesKeysAndCacheRemoved = !fs.existsSync(temporary);
  } catch {
    result.temporaryProfilesKeysAndCacheRemoved = false;
    result.completed = false; result.failure = {stage: 'cleanup', kind: 'TemporaryCleanupFailed'};
  }
  result.finishedAt = new Date().toISOString(); fs.writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({completed: result.completed, cases: result.cases.length, receipt}));
process.exitCode = result.completed ? 0 : 1;
