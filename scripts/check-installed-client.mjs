#!/usr/bin/env node
// Exact public registry artifact + existing encrypted CLI/MCP/file smoke.
// The profile, cache and npm configuration are always disposable and explicit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {fixture} from './fixtures/installed-client-smoke.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function releaseExpectation(record) {
  const version = record?.publicRelease?.version;
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(record?.archive?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(record?.archive?.integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert(Number.isSafeInteger(record.archive.files) && record.archive.files > 0);
  return {version, sha256: record.archive.sha256, integrity: record.archive.integrity,
    files: record.archive.files, tarball: `https://registry.npmjs.org/notibuddy/-/notibuddy-${version}.tgz`};
}

export function isolatedEnvironment({platform = process.platform, source = process.env, temporary, cache, profile, user, global, node = process.execPath}) {
  // The SDK merges selected parent variables even with explicit env. Undefined
  // entries remove its user-profile defaults from the spawned MCP process.
  const env = Object.fromEntries(['HOME','LOGNAME','SHELL','TERM','USER','APPDATA','HOMEDRIVE','HOMEPATH',
    'LOCALAPPDATA','USERNAME','USERPROFILE','PROGRAMFILES','PROCESSOR_ARCHITECTURE'].map(key => [key, undefined]));
  const paths = [platform === 'win32' ? path.win32.dirname(node) : path.dirname(node)];
  if (platform === 'win32') {
    const root = Object.entries(source).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
    assert(root && path.win32.isAbsolute(root), 'Windows requires an absolute SystemRoot');
    env.SystemRoot = root;
    paths.push(path.win32.join(root, 'System32'));
  } else paths.push('/usr/bin', '/bin');
  return {...env, PATH: paths.join(platform === 'win32' ? ';' : ':'), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    NOTIBUDDY_HOME: profile, npm_config_userconfig: user, npm_config_globalconfig: global,
    npm_config_cache: cache, npm_config_registry: 'https://registry.npmjs.org', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false'};
}

export function npmCLI(explicit, node = process.execPath) {
  const bin = path.dirname(node);
  const candidates = explicit ? [explicit] : [path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const real = fs.realpathSync(candidate), manifest = path.resolve(path.dirname(real), '../package.json');
    assert.equal(path.basename(real), 'npm-cli.js');
    assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).name, 'npm');
    return real;
  }
  throw new Error('Cannot find npm CLI; supply --npm-cli with its absolute npm-cli.js path');
}

export function verifyInstalledLock(lock, installed, expectation) {
  const entry = lock?.packages?.['node_modules/notibuddy'];
  assert(entry && !entry.link, 'Require the exact installed package lock entry');
  assert.equal(entry.version, expectation.version);
  assert.equal(entry.resolved, expectation.tarball);
  assert.equal(entry.integrity, expectation.integrity);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'notibuddy'); assert.equal(manifest.version, expectation.version);
  for (const dependency of Object.values(lock.packages)) {
    if (dependency.resolved) { const url = new URL(dependency.resolved); assert.equal(url.origin, 'https://registry.npmjs.org');
      assert(!url.username && !url.password && !url.search && !url.hash, 'Require unauthenticated public package URLs'); }
  }
}

export async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--release','--output','--expected-platform','--npm-cli'].includes(args[i]) && args[i + 1], 'Use --release FILE --output DIRECTORY --expected-platform PLATFORM [--npm-cli FILE]');
    assert(!(args[i] in options), 'Duplicate option'); options[args[i]] = args[i + 1];
  }
  assert(options['--release'] && options['--output'] && options['--expected-platform']);
  const output = path.resolve(options['--output']); fs.mkdirSync(output, {recursive: true});
  const receipt = path.join(output, 'receipt.json'); assert(!fs.existsSync(receipt), 'Use a new output directory');
  const result = {startedAt: new Date().toISOString(), completed: false, platform: process.platform, architecture: process.arch,
    node: process.version, osRelease: os.release(), commands: [], limits: ['Synthetic v1 HTTP phone fixture; no real relay, native UI, Apple service or APNs.',
      'No signal/crash matrix or v2/invitation coverage in this lane.', 'Windows ACLs are not inferred from POSIX permission bits.',
      'Registry integrity is checked independently; npm verifies installation against the exact locked archive integrity. Installed file hashes are retained.',
      'Fixture fetch restrictions are not an OS firewall or packet capture.']};
  let temporary, stage = 'preflight';
  const childExec = promisify(execFile);
  async function run(label, command, argv, extra = {}) {
    const start = Date.now();
    try {
      const out = await childExec(command, argv, {cwd: temporary, timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...extra});
      result.commands.push({label, exitCode: 0, elapsedMs: Date.now() - start, stdoutSHA256: sha(out.stdout), stderrSHA256: sha(out.stderr)}); return out;
    } catch (error) {
      result.commands.push({label, exitCode: error.code, signal: error.signal, elapsedMs: Date.now() - start, stdoutSHA256: sha(error.stdout || ''), stderrSHA256: sha(error.stderr || '')});
      if (extra.expectedFailure === error.code) return {stdout: error.stdout, stderr: error.stderr};
      throw new Error(label + ' failed');
    }
  }
  try {
    assert.equal(process.platform, options['--expected-platform'], 'Platform does not match requested acceptance lane');
    const releaseBytes = fs.readFileSync(path.resolve(options['--release']));
    const expected = releaseExpectation(JSON.parse(releaseBytes)); result.expected = expected; result.releaseReceiptSHA256 = sha(releaseBytes);
    const npm = npmCLI(options['--npm-cli']); result.npmExecutableSHA256 = sha(fs.readFileSync(npm));
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy installed '));
    const consumer = path.join(temporary, 'consumer'), cache = path.join(temporary, 'fresh cache'), profile = path.join(temporary, 'fresh profile');
    fs.mkdirSync(consumer, {mode: 0o700});
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({name:'installed-public-client-check',private:true,dependencies:{notibuddy:expected.version}}));
    const user = path.join(temporary, 'empty-user.npmrc'), global = path.join(temporary, 'empty-global.npmrc');
    fs.writeFileSync(user, ''); fs.writeFileSync(global, '');
    const env = isolatedEnvironment({temporary, cache, profile, user, global});
    stage = 'registry';
    const metadataURL = `https://registry.npmjs.org/notibuddy/${expected.version}`;
    const metadataResponse = await fetch(metadataURL, {redirect:'error',headers:{},signal:AbortSignal.timeout(20000)});
    assert.equal(metadataResponse.status, 200); const metadata = await metadataResponse.json();
    assert.equal(metadata.name, 'notibuddy'); assert.equal(metadata.version, expected.version);
    assert.equal(metadata.dist.integrity, expected.integrity); assert.equal(metadata.dist.tarball, expected.tarball);
    const archive = await fetch(expected.tarball, {redirect:'error',headers:{},signal:AbortSignal.timeout(20000)});
    assert.equal(archive.status, 200); const bytes = Buffer.from(await archive.arrayBuffer());
    assert.equal(sha(bytes), expected.sha256); assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), expected.integrity);
    result.registry = {exact:metadataURL,tarball:expected.tarball,archiveSHA256:sha(bytes),archiveIntegrity:expected.integrity};
    stage = 'install';
    result.npm = (await run('npm-version', process.execPath, [npm,'--version'], {env})).stdout.trim();
    await run('fresh-registry-install', process.execPath, [npm,'install','--ignore-scripts','--no-audit','--no-fund'], {cwd:consumer,env});
    const installed = path.join(consumer, 'node_modules/notibuddy'), lockBytes = fs.readFileSync(path.join(consumer,'package-lock.json'));
    const lock = JSON.parse(lockBytes); verifyInstalledLock(lock, installed, expected); result.lockSHA256 = sha(lockBytes);
    result.dependencies = Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key).map(([key,value]) => [key,{version:value.version,integrity:value.integrity,resolved:value.resolved}]));
    const files = [];
    function walk(directory) { for (const entry of fs.readdirSync(directory,{withFileTypes:true})) { const file = path.join(directory,entry.name);
      if (entry.isDirectory()) walk(file); else { assert(entry.isFile()); files.push([path.relative(installed,file).split(path.sep).join('/'),sha(fs.readFileSync(file))]); } } }
    walk(installed); assert.equal(files.length, expected.files); result.installedFiles = files.sort((a,b) => a[0].localeCompare(b[0],'en'));
    const cli = path.join(installed,'dist/cli.js');
    assert.match((await run('installed-help',process.execPath,[cli,'--help'],{env})).stdout,/default 10800, max 10800/);
    assert.match((await run('fresh-status',process.execPath,[cli,'status'],{env})).stdout,/No named destinations paired/);
    const missing = await run('unpaired-mcp',process.execPath,[path.join(installed,'dist/mcp-entry.js')],{env,expectedFailure:1});
    assert.match(missing.stderr,/Select a destination explicitly/);
    stage = 'synthetic-cli-mcp-file'; result.synthetic = await fixture({installed,temporary,env,run,version:expected.version}); result.completed = true;
  } catch (error) {
    // Do not serialize assertion operands, request bodies or synthetic private keys.
    result.failure = {stage,kind:error.name};
  } finally {
    if (temporary) {
      try { fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100}); result.temporaryCacheProfilesKeysAndPlaintextRemoved = !fs.existsSync(temporary); }
      catch { result.temporaryCacheProfilesKeysAndPlaintextRemoved = false; result.completed = false; result.failure = {stage:'cleanup',kind:'CleanupFailed'}; }
    } else result.noTemporaryLaneCreated = true;
    result.finishedAt = new Date().toISOString(); fs.writeFileSync(receipt,JSON.stringify(result,null,2)+'\n');
  }
  console.log(JSON.stringify({completed:result.completed,receipt,cleanup:result.temporaryCacheProfilesKeysAndPlaintextRemoved ?? result.noTemporaryLaneCreated}));
  return result.completed ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
