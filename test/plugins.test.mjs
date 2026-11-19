import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

test('generated plugin manifests match plugin-src with zero drift and pass lint', () => {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts/build-plugins.mjs'), '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('Claude hooks shim exits 0 silently when nb is missing from PATH', { skip: process.platform === 'win32' }, () => {
  const shim = path.join(root, 'plugins/claude-code/notibuddy-hooks/scripts/nb-hook');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-empty-path-'));
  try {
    // Only test missing-nb behavior by shadowing PATH to /usr/bin:/bin (if nb happens to be in /opt/homebrew/bin,
    // verify the script still exits 0 silently against an unpaired NOTIBUDDY_HOME!).
    const unpairedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-shim-home-'));
    try {
      const t0 = performance.now();
      const res = spawnSync('/bin/sh', [shim, 'claude', 'PermissionRequest', '--client', 'claude-code'], {
        input: JSON.stringify({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'touch test.txt' },
        }),
        encoding: 'utf8',
        env: {
          PATH: `${emptyDir}:/usr/bin:/bin`,
          HOME: emptyDir,
          NOTIBUDDY_HOME: unpairedHome,
          NOTIBUDDY_NO_UPDATE_CHECK: '1',
        },
        timeout: 5_000,
      });
      const elapsed = performance.now() - t0;
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, '', 'Claude passthrough must emit empty stdout');
      assert.ok(elapsed < 1_000, `Shim took too long when skipped: ${Math.round(elapsed)}ms`);
    } finally {
      fs.rmSync(unpairedHome, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('Claude hooks shim delegates to installed nb binary on PATH and preserves silent passthrough when unpaired', { skip: process.platform === 'win32' }, () => {
  const shim = path.join(root, 'plugins/claude-code/notibuddy-hooks/scripts/nb-hook');
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-fake-bin-'));
  const unpairedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-shim-unpaired-'));
  try {
    const nbPath = path.join(binDir, 'nb');
    const cliDist = path.join(root, 'dist/cli.js');
    fs.writeFileSync(nbPath, `#!/bin/sh\nexec "${process.execPath}" "${cliDist}" "$@"\n`, { mode: 0o755 });
    const res = spawnSync('/bin/sh', [shim, 'claude', 'PermissionRequest', '--client', 'claude-code'], {
      input: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/nonexistent' },
      }),
      encoding: 'utf8',
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: unpairedHome,
        NOTIBUDDY_HOME: unpairedHome,
        NOTIBUDDY_NO_UPDATE_CHECK: '1',
      },
      timeout: 5_000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(unpairedHome, { recursive: true, force: true });
  }
});
