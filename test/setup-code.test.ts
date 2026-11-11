import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SETUP_CODE_BYTES, SETUP_CODE_PROMPT, readSetupCode, type SetupCodeInput } from '../src/setup-code.js';
process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1'; // tests never contact the npm registry

function fakeTerminal() {
  const input = new PassThrough() as PassThrough & SetupCodeInput & { raw: boolean[] };
  input.isTTY = true; input.raw = [];
  input.setRawMode = (mode: boolean) => { input.raw.push(mode); return input; };
  const output = new PassThrough(); let written = ''; output.on('data', chunk => { written += chunk; });
  return { input, output, written: () => written };
}

test('a TTY prompts on the output stream, reads one line without echo and restores the terminal', async () => {
  const { input, output, written } = fakeTerminal();
  const pending = readSetupCode(input, output);
  input.write('nbpair1.abc'); input.write('def\r');
  assert.equal(await pending, 'nbpair1.abcdef');
  assert.deepEqual(input.raw, [true, false]);
  assert.equal(written(), SETUP_CODE_PROMPT + '\n');
  assert(!written().includes('nbpair1'), 'the typed code is never echoed');
});

test('TTY input honours backspace and trims, and Ctrl-C restores the terminal and aborts', async () => {
  const first = fakeTerminal(); const pending = readSetupCode(first.input, first.output);
  first.input.write('  xyz\u007f\u007f ok \n'); assert.equal(await pending, 'x ok');
  const second = fakeTerminal(); const interrupted = readSetupCode(second.input, second.output);
  const previousExit = process.exitCode;
  second.input.write('abc\u0003');
  await assert.rejects(interrupted, /Interrupted/);
  process.exitCode = previousExit;
  assert.deepEqual(second.input.raw, [true, false]);
});

test('TTY input rejects an empty or oversized code', async () => {
  const empty = fakeTerminal(); const none = readSetupCode(empty.input, empty.output);
  empty.input.write('\r'); await assert.rejects(none, /No setup code received/);
  const big = fakeTerminal(); const huge = readSetupCode(big.input, big.output);
  big.input.write('a'.repeat(MAX_SETUP_CODE_BYTES + 1)); await assert.rejects(huge, /longer than 64 KiB/);
  assert.deepEqual(big.input.raw, [true, false]);
});

test('piped input is read whole, trimmed, size-limited, and prompts nothing', async () => {
  const output = new PassThrough(); let written = ''; output.on('data', chunk => { written += chunk; });
  const piped = new PassThrough(); piped.end('  nbpair1.piped\n');
  assert.equal(await readSetupCode(piped, output), 'nbpair1.piped'); assert.equal(written, '');
  const blank = new PassThrough(); blank.end('  \n');
  await assert.rejects(readSetupCode(blank, output), /No setup code received/);
  const large = new PassThrough(); large.end('a'.repeat(MAX_SETUP_CODE_BYTES + 1));
  await assert.rejects(readSetupCode(large, output), /longer than 64 KiB/);
});

// The CLI parses the bundle after obtaining it, so a malformed code reaches the same
// stage for stdin and argv. The argv path must also warn about shell history.
function runCli(args: string[], stdin?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-setup-code-'));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], {
      env: { ...process.env, NOTIBUDDY_HOME: path.join(root, 'profile') }, cwd: root, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject);
    child.once('exit', code => { fs.rmSync(root, { recursive: true, force: true }); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin ?? '');
  });
}

test('nb pair reads the setup code from stdin and does not warn', async () => {
  const result = await runCli(['pair', '--to', 'phone'], 'not-a-real-setup-code\n');
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /shell history/);
  assert.doesNotMatch(result.stderr, /No setup code received/);
  assert.match(result.stderr, /setup|bundle|pairing/i); // parser rejected the piped text
});

test('nb pair with no code on stdin explains what to do', async () => {
  const result = await runCli(['pair', '--to', 'phone'], '');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No setup code received/);
});

test('nb pair accepts a command-line code but warns about shell history', async () => {
  const result = await runCli(['pair', 'not-a-real-setup-code', '--to', 'phone']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Warning: a setup code on the command line can be saved in shell history\. Run `nb pair --to phone` and paste it when asked instead\./);
  assert.doesNotMatch(result.stderr, /No setup code received/);
});
