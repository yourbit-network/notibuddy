import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
function git(args, optional = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0 && !optional) throw new Error('Cannot configure hooks in this Git repository.');
  return result.status === 0 ? result.stdout.trim() : '';
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

try {
  if (git(['rev-parse', '--show-toplevel']) !== root) {
    throw new Error('Install this hook in the standalone public repository, not the private monorepo mirror.');
  }
  const located = process.env.GITLEAKS_BIN || spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout?.trim();
  if (!located) throw new Error('Install Gitleaks first (on macOS: brew install gitleaks).');
  const scanner = path.resolve(located);
  accessSync(scanner, constants.X_OK);
  const version = spawnSync(scanner, ['version'], { encoding: 'utf8' });
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.stdout?.trim() || '')?.slice(1).map(Number);
  const minimum = [8, 30, 1];
  const firstDifference = parts?.findIndex((n, index) => n !== minimum[index]);
  if (version.status !== 0 || !parts || (firstDifference !== -1 && parts[firstDifference] < minimum[firstDifference])) {
    throw new Error('Gitleaks 8.30.1 or newer is required.');
  }

  const common = path.resolve(root, git(['rev-parse', '--git-common-dir']));
  const managed = path.join(common, 'notibuddy-hooks');
  const current = path.resolve(root, git(['rev-parse', '--git-path', 'hooks']));
  const previous = current === managed
    ? git(['config', '--local', '--get', 'notibuddy.previousHooksPath'])
    : current;
  if (previous === managed) throw new Error('Refusing a recursive hooks configuration.');
  if (existsSync(managed) && current !== managed && !existsSync(path.join(managed, '.notibuddy-managed'))) {
    throw new Error('The managed hooks directory already exists and is not owned by this installer.');
  }
  mkdirSync(managed, { recursive: true });
  const prologue = `#!/bin/sh\nset -eu\nexport PATH=${quote(path.dirname(process.execPath))}:"$PATH"\n`;
  // Forward existing hooks by their original absolute path. Symlinking them would
  // break hooks that locate supporting files relative to their own script path.
  if (existsSync(previous)) {
    for (const name of readdirSync(previous)) {
      const original = path.join(previous, name);
      if (name === 'pre-push' || !statSync(original).isFile() || !(statSync(original).mode & 0o111)) continue;
      writeFileSync(path.join(managed, name), prologue + `if [ -x ${quote(original)} ]; then exec ${quote(original)} "$@"; fi\n`, { mode: 0o755 });
    }
  }
  const previousPush = path.join(previous, 'pre-push');
  const hook = prologue + `input=$(mktemp "\${TMPDIR:-/tmp}/notibuddy-pre-push.XXXXXX")
trap 'rm -f "$input"' EXIT
cat > "$input"
${quote(path.join(root, '.githooks/pre-push'))} "$@" < "$input"
if [ -x ${quote(previousPush)} ]; then
  ${quote(previousPush)} "$@" < "$input"
fi
`;
  writeFileSync(path.join(managed, 'pre-push'), hook, { mode: 0o755 });
  writeFileSync(path.join(managed, '.notibuddy-managed'), 'Managed by scripts/install-hooks.mjs\n');
  git(['config', '--local', 'notibuddy.gitleaksPath', scanner]);
  git(['config', '--local', 'notibuddy.previousHooksPath', previous]);
  git(['config', '--local', 'core.hooksPath', managed]);
  console.log('Pre-push secret scanning enabled for this checkout; existing hooks preserved.');
} catch (error) {
  console.error(`Hook setup failed: ${error.message}`);
  process.exitCode = 1;
}
