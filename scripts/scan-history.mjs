// Reuse the hook's fail-closed scanner in CI, including commit/tag messages.
import { spawnSync } from 'node:child_process';

const ref = process.env.GITHUB_REF?.startsWith('refs/tags/') ? process.env.GITHUB_REF : 'HEAD';
const resolved = spawnSync('git', ['rev-parse', '--verify', ref], { encoding: 'utf8' });
if (resolved.status !== 0) throw new Error('Cannot resolve the revision to scan.');
const oid = resolved.stdout.trim();
const result = spawnSync(process.execPath, ['scripts/scan-push.mjs'], {
  input: `${ref} ${oid} refs/heads/scan ${'0'.repeat(40)}\n`,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
