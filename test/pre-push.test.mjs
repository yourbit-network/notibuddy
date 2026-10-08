import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const scanner = process.env.GITLEAKS_BIN || spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim();
assert.ok(scanner, 'Install Gitleaks before running hook integration tests.');
const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GITLEAKS_BIN: scanner };
for (const key of Object.keys(environment)) {
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key) || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_') || key === 'GIT_CONFIG_COUNT') delete environment[key];
}
const fakeToken = () => ['nb', 'snd', 'live', randomBytes(24).toString('hex')].join('_');

function repository(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "notibuddy hook's test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const work = path.join(directory, 'work');
  const remote = path.join(directory, 'remote.git');
  mkdirSync(work);
  function run(command, args, options = {}) {
    return spawnSync(command, args, { cwd: work, env: environment, encoding: 'utf8', ...options });
  }
  function git(...args) {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(file, content) {
    const destination = path.join(work, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  function commit(message = 'Fixture commit') {
    git('add', '.');
    return git('commit', '--allow-empty', '-m', message);
  }
  function install() {
    const result = run(process.execPath, ['scripts/install-hooks.mjs']);
    assert.equal(result.status, 0, result.stderr);
  }
  function push(...refs) { return run('git', ['push', 'origin', ...refs]); }
  function blocked(result, credential) {
    assert.notEqual(result.status, 0, 'The push should have been rejected.');
    assert.match(result.stderr, /push blocked/);
    if (credential) assert.ok(!result.stderr.includes(credential), 'Findings must redact credentials.');
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'Hook integration test');
  git('config', 'user.email', 'hook@example.invalid');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  for (const file of ['.githooks/pre-push', '.gitleaks.toml', 'scripts/install-hooks.mjs', 'scripts/scan-push.mjs', 'test-vectors/v1.json', 'test/protocol.test.ts', 'README.md']) {
    const destination = path.join(work, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(source, file), destination);
  }
  chmodSync(path.join(work, '.githooks/pre-push'), 0o755);
  write('package.json', '{"type":"module"}\n');
  commit('Initial fixture');
  return { directory, work, remote, run, git, write, commit, install, push, blocked };
}

test('clean fixtures, annotated tags and existing hooks work after repeated installation', t => {
  const r = repository(t);
  r.write('.git/previous-hooks/post-commit', '#!/bin/sh\nprintf attested > .git/attested\n');
  r.write('.git/previous-hooks/pre-push', '#!/bin/sh\nprintf "%s\\n" "$@" > .git/previous-args\ncat > .git/previous-stdin\n');
  for (const name of ['pre-push', 'post-commit']) chmodSync(path.join(r.work, '.git/previous-hooks', name), 0o755);
  r.git('config', 'core.hooksPath', '.git/previous-hooks');
  r.install();
  r.install();
  r.commit('Clean change');
  assert.equal(readFileSync(path.join(r.work, '.git/attested'), 'utf8'), 'attested');
  r.git('tag', '-a', 'v1.0.0', '-m', 'Release fixture');
  const result = r.push('main', 'refs/tags/v1.0.0');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /pre-push secret scan passed/);
  assert.match(readFileSync(path.join(r.work, '.git/previous-stdin'), 'utf8'), /refs\/heads\/main/);
  assert.match(readFileSync(path.join(r.work, '.git/previous-stdin'), 'utf8'), /refs\/tags\/v1.0.0/);
  assert.equal(readFileSync(path.join(r.work, '.git/previous-args'), 'utf8'), `origin\n${r.remote}\n`);
});

test('a new secret is blocked and findings are redacted', t => {
  const r = repository(t);
  r.install();
  const credential = fakeToken();
  r.write('accidental.env', `TOKEN=${credential}\n`);
  r.commit();
  r.blocked(r.push('main'), credential);
  assert.equal(r.git('ls-remote', 'origin'), '');
});

test('deleting a secret in a later commit does not make a new branch safe', t => {
  const r = repository(t);
  r.install();
  const credential = fakeToken();
  r.write('temporary.txt', credential);
  r.commit();
  r.git('rm', 'temporary.txt');
  r.commit();
  r.blocked(r.push('main'), credential);
});

test('non-HEAD branches are scanned while unrelated local branches are excluded', t => {
  const r = repository(t);
  r.install();
  r.git('switch', '-c', 'topic');
  const credential = fakeToken();
  r.write('accidental.txt', credential);
  r.commit();
  r.git('switch', 'main');
  assert.equal(r.push('main').status, 0);
  r.blocked(r.push('topic'), credential);
});

test('annotated tag and commit messages are scanned', t => {
  const r = repository(t);
  r.install();
  const credential = fakeToken();
  r.git('tag', '-a', 'unsafe-tag', '-m', credential);
  r.blocked(r.push('refs/tags/unsafe-tag'), credential);
  r.commit(credential);
  r.blocked(r.push('main'), credential);
});

test('new credentials inside the fixture file are not exempt', t => {
  const r = repository(t);
  r.install();
  const credential = fakeToken();
  const fixture = JSON.parse(readFileSync(path.join(r.work, 'test-vectors/v1.json')));
  fixture.accidental = credential;
  r.write('test-vectors/v1.json', JSON.stringify(fixture, null, 2));
  r.commit();
  r.blocked(r.push('main'), credential);
});

test('a fresh encoded pairing bundle is blocked', t => {
  const r = repository(t);
  r.install();
  const bundle = 'nbpair1.' + Buffer.from(JSON.stringify({ v: 1, relay: 'https://relay.example.invalid', token: fakeToken(), pairSecret: randomBytes(32).toString('base64url') })).toString('base64url');
  r.write('setup.txt', bundle);
  r.commit();
  r.blocked(r.push('main'), bundle);
});

test('standard GitHub-token detection remains enabled despite inline allow comments', t => {
  const r = repository(t);
  r.install();
  const credential = ['gh', 'p_', randomBytes(18).toString('hex')].join('');
  r.write('accidental.js', `const accessToken = '${credential}'; // gitleaks:allow\n`);
  r.commit();
  r.blocked(r.push('main'), credential);
});

test('private JWK material is rejected', t => {
  const r = repository(t);
  r.install();
  const credential = randomBytes(32).toString('base64url');
  r.write('key.json', JSON.stringify({ kty: 'EC', crv: 'P-256', d: credential }));
  r.commit();
  r.blocked(r.push('main'), credential);
});

test('invalid scanner configuration fails closed', t => {
  const r = repository(t);
  r.install();
  r.write('.gitleaks.toml', 'this is not valid TOML');
  r.commit();
  r.blocked(r.push('main'));
  assert.equal(r.git('ls-remote', 'origin'), '');
});

test('scanner failure blocks a push but deletion-only pushes still work', t => {
  const r = repository(t);
  r.install();
  assert.equal(r.push('main:temporary').status, 0);
  r.git('config', 'notibuddy.gitleaksPath', path.join(r.directory, 'missing-scanner'));
  r.blocked(r.push('main'));
  assert.equal(r.push(':temporary').status, 0);
});

test('the previous pre-push hook can still reject a clean push', t => {
  const r = repository(t);
  r.write('.git/hooks/pre-push', '#!/bin/sh\necho Previous-hook-rejected >&2\nexit 1\n');
  chmodSync(path.join(r.work, '.git/hooks/pre-push'), 0o755);
  r.install();
  const result = r.push('main');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Previous-hook-rejected/);
  assert.equal(r.git('ls-remote', 'origin'), '');
});

test('force pushes and merge-only secrets are checked', t => {
  const r = repository(t);
  r.install();
  assert.equal(r.push('main').status, 0);
  r.git('switch', '-c', 'side');
  r.write('side.txt', 'side\n');
  r.commit();
  r.git('switch', 'main');
  r.write('main.txt', 'main\n');
  r.commit();
  r.git('merge', '--no-commit', 'side');
  const credential = fakeToken();
  r.write('merge.txt', credential);
  r.commit('Merge fixture');
  r.blocked(r.push('--force', 'main'), credential);
});

test('blob tags are refused instead of bypassing history scanning', t => {
  const r = repository(t);
  r.install();
  const oid = r.git('hash-object', '-w', 'README.md');
  r.git('tag', 'blob-tag', oid);
  r.blocked(r.push('refs/tags/blob-tag'));
});
