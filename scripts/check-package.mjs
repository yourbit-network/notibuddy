// Build before running. The retained archive is the one the release publishes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateContents } from './package-contents.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.build/release');
const temporary = mkdtempSync(path.join(tmpdir(), 'notibuddy-package-'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}
function npm(args, options) {
  assert.ok(process.env.npm_execpath, 'Run this through npm run pack:check.');
  return run(process.execPath, [process.env.npm_execpath, ...args], options);
}
try {
  mkdirSync(output, { recursive: true });
  // Never leave a previous successful manifest after a failed validation.
  rmSync(path.join(output, 'pack.json'), { force: true });
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'notibuddy');
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', output]))[0];
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  assert.equal(packed.filename, `notibuddy-${manifest.version}.tgz`);
  const archive = path.join(output, packed.filename);
  const sources = run('git', ['ls-files', '-z', 'src']).split('\0').filter(file => file.endsWith('.ts'));
  const expected = validateContents(packed, sources, readFileSync(archive));
  const entries = run('tar', ['-tzf', archive]).trim().split(/\r?\n/);
  assert.deepEqual(entries.sort(), expected.map(file => `package/${file}`).sort(), 'Archive paths differ from metadata.');
  const types = run('tar', ['-tvzf', archive]).trim().split(/\r?\n/);
  assert.ok(types.every(line => line.startsWith('-')), 'Only regular files may be published.');
  run('tar', ['-xzf', archive, '-C', temporary]);
  if (process.argv.includes('--scan')) {
    const ignore = path.join(temporary, 'empty-ignore');
    writeFileSync(ignore, '');
    run(process.env.GITLEAKS_BIN || 'gitleaks', [
      'dir', '.', '--config', path.join(root, '.gitleaks.toml'),
      '--gitleaks-ignore-path', ignore, '--ignore-gitleaks-allow', '--redact=100', '--no-banner',
    ], { cwd: path.join(temporary, 'package'), stdio: 'inherit' });
  }
  const consumer = path.join(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const userConfig = path.join(temporary, 'empty.npmrc');
  writeFileSync(userConfig, '');
  const env = { ...process.env, NOTIBUDDY_HOME: path.join(temporary, 'profile'),
    npm_config_userconfig: userConfig, npm_config_registry: 'https://registry.npmjs.org' };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: consumer, env });
  const installed = path.join(consumer, 'node_modules/notibuddy');
  const cli = path.join(installed, 'dist/cli.js');
  assert.match(run(process.execPath, [cli, '--help'], { cwd: consumer, env }), /NotiBuddy CLI/);
  assert.match(run(process.execPath, [cli, 'status'], { cwd: consumer, env }), /No named destinations paired/);
  run(process.execPath, ['--input-type=module', '-e', "await import('notibuddy')"], { cwd: consumer, env });
  const mcp = spawnSync(process.execPath, [path.join(installed, 'dist/mcp-entry.js')], {
    cwd: consumer, env, input: '', encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(mcp.status, 1, 'Unpaired MCP startup must fail without hanging.');
  assert.match(mcp.stderr, /Select a destination explicitly/, 'MCP entry point must load and explain the missing pairing.');
  // Exercise the installed CLI's actual pairing output with temporary keys and
  // an intercepted fixture relay. No phone or live service is contacted.
  const { generateReplyKeyPair, generateSenderSigningKeyPair, deriveDeviceId, toB64u } =
    await import(pathToFileURL(path.join(installed, 'dist/crypto.js')).href);
  const deviceEncryption = await generateReplyKeyPair();
  const deviceSigning = await generateSenderSigningKeyPair();
  const bundle = {
    v: 1, relay: 'https://pairing.fixture.invalid', token: 'nb_snd_package_fixture',
    pairSecret: toB64u(new Uint8Array(32)),
    device: { id: await deriveDeviceId(deviceEncryption.publicKeyB64u, deviceSigning.publicKeyB64u),
      encPub: deviceEncryption.publicKeyB64u, sigPub: deviceSigning.publicKeyB64u, name: 'Package fixture' },
  };
  const fixtureFetch = path.join(temporary, 'fixture-fetch.mjs');
  writeFileSync(fixtureFetch, `
    import assert from 'node:assert/strict';
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://pairing.fixture.invalid/v1/senders');
      assert.equal(options.method, 'POST');
      calls++;
      return Response.json({ status: 'pending_approval' });
    };
    process.on('exit', () => assert.equal(calls, 1, 'Expected one intercepted registration'));
  `);
  const pairing = run(process.execPath, ['--import', pathToFileURL(fixtureFetch).href, cli, 'pair',
    'nbpair1.' + Buffer.from(JSON.stringify(bundle)).toString('base64url'),
    '--to', 'package-check', '--label', 'Package fixture'], { cwd: consumer, env });
  assert.match(pairing, /Phone approval required/);
  const marker = 'MCP configuration:\n';
  const markerAt = pairing.indexOf(marker);
  assert.ok(markerAt >= 0, 'Pairing must print its MCP configuration.');
  assert.deepEqual(JSON.parse(pairing.slice(markerAt + marker.length)), {
    mcpServers: { notibuddy: { command: 'npx',
      args: ['-y', `notibuddy@^${manifest.version}`, 'mcp', '--to', 'package-check'] } },
  }, 'Generated MCP configuration must require the tested package version and explicit destination.');
  // Write the manifest only after every check has passed.
  writeFileSync(path.join(output, 'pack.json'), JSON.stringify([packed], null, 2) + '\n');
  console.log(`Verified ${packed.filename}: ${packed.files.length} allowed files, clean installation, CLI/MCP entry points and pairing configuration${process.argv.includes('--scan') ? ', secret scan' : ''}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
