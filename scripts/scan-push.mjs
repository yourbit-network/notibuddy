import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(args, optional = false) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 && !optional) throw new Error('Cannot inspect the Git objects being pushed.');
  return result.status === 0 ? result.stdout.trim() : '';
}

let temporary;
try {
  const input = readFileSync(0, 'utf8');
  const commits = new Set();
  const metadata = [input];
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[1])) {
      throw new Error('Invalid pre-push ref information.');
    }
    let oid = fields[1];
    if (/^0+$/.test(oid)) continue; // Deletion sends no new objects.
    let type = git(['cat-file', '-t', oid]);
    while (type === 'tag') {
      const tag = git(['cat-file', '-p', oid]);
      metadata.push(tag); // Annotated tag messages can contain credentials too.
      oid = /^object ([a-f0-9]{40}|[a-f0-9]{64})$/m.exec(tag)?.[1];
      if (!oid) throw new Error('Cannot inspect an annotated tag.');
      type = git(['cat-file', '-t', oid]);
    }
    if (type !== 'commit') throw new Error('Only refs pointing to commits can pass the secret scan.');
    commits.add(oid);
  }
  if (commits.size > 0) {
    if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
      throw new Error('Fetch the complete history with git fetch --unshallow before pushing.');
    }
    const root = git(['rev-parse', '--show-toplevel']);
    const scanner = git(['config', '--local', '--get', 'notibuddy.gitleaksPath'], true) || 'gitleaks';
    temporary = mkdtempSync(path.join(tmpdir(), 'notibuddy-push-'));
    const ignoreFile = path.join(temporary, 'empty-ignore');
    writeFileSync(ignoreFile, '', { mode: 0o600 });
    const flags = [
      '--config', path.join(root, '.gitleaks.toml'),
      '--gitleaks-ignore-path', ignoreFile,
      '--ignore-gitleaks-allow', '--redact=100', '--no-banner',
    ];
    function scan(args, content) {
      const result = spawnSync(scanner, [...args, ...flags], {
        cwd: root, input: content, stdio: ['pipe', 'inherit', 'inherit'],
      });
      if (result.error) throw new Error('Gitleaks is unavailable. Install it and rerun node scripts/install-hooks.mjs.');
      if (result.status !== 0) throw new Error('Secret scan failed. Review the redacted findings before pushing.');
    }
    console.error('NotiBuddy: scanning all history reachable from the refs being pushed.');
    // Scan actual pushed objects, including non-HEAD branches and merge changes.
    // Full reachable history also covers new branches, force pushes and deleted secrets.
    scan(['git', root, '--log-opts', `--full-history --root -m ${[...commits].join(' ')}`]);
    metadata.push(git(['log', '--no-patch', '--format=%B', ...commits]));
    scan(['stdin'], metadata.join('\n'));
    console.error('NotiBuddy: pre-push secret scan passed.');
  }
} catch (error) {
  console.error(`NotiBuddy: push blocked. ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
