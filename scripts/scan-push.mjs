import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PUBLIC_ROOT_OID = 'edd899371727959b1a826c179c4829301be5e32d';

export const FORBIDDEN_ROOT_OIDS = new Set([
  'af70ec8419ddba8c27bdf6d9666b8cc65df2d59d',
  '2e76a04a99014fa58e6b67edc7fbdba54d634f79',
  '1305e91cd861b52743a48fcfa46669e5a61fa057',
]);

export const PUBLIC_REMOTE_RE =
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)yourbit-network\/notibuddy(?:\.git)?$/;

const PRIVATE_REPO_TOKEN_RE = /notibuddy(?:-app)\b/i;
const PRIVATE_REPO_REF_RE = /yourbit-network\/notibuddy(?:-app)\b/i;
const PRIVATE_TRACKER_CANDIDATE_RE = /\bnb-([a-z0-9]+)(?:\.[0-9]+)?\b/gi;
const INTERNAL_DIRECTIVE_RE = /^\s*\/\/@\s*[A-Za-z][A-Za-z0-9_-]*\s*:/m;

const LEGACY_TRACKER_EXEMPT_COMMIT_OIDS = new Set([
  'b6bb44fa69166cd50c0da3e6786c3f3914fab6d6',
  '7e21b7c8a4d4b93f5e3a09e9bfc47ee2985a32ea',
]);

const TOKEN_HASH_SALT = 'nb-pub-fence-v1:';

function hashFenceValue(value) {
  return createHash('sha256').update(TOKEN_HASH_SALT + value.toLowerCase()).digest('hex');
}

const PRIVATE_TRACKER_PREFIX_HASHES = new Set([
  '1b22f362b924361282244fec953b4127c2fd548954c324e128c821d483b8bae8',
  '24c213be53b0f31729fb9c45afb9691c0807aa8578829ec122d9604fb6f6f827',
  '3c1d7cff0a0bceab3651b8fe9d5a10f279bef4ddbc0614582e397130f2909b18',
  '6a3658f1f9157d3f6be565b9fc6068dbc9b385db95bf1832a5d14f84abda278b',
  '3b28e03f8dc05a24290dff6787e5bb7f821dad9cd4e842fc9b83918d76053a25',
  'fa0a5d9197c562ff78e26045f1f225143c5768b35414b87a57da6d645ef56ee5',
  'ac9588d990d68f4aa8a734398fa2b9630ca5d7783a79f81e7843d26b4f972e72',
  'b37f33e373f5b2cd28ee5e5e693f2cf5d84fa418df336618e6d984d80944b233',
  '6de3d8b03a9137d1338b2711bf62711a6cbc4b740d16ef8c10f53133233b9b4a',
  '630d28907803dcc999b2ea72a954d4d5caefa7ce3094be594ac104306a46069f',
  'a3e1cd7f7a2199a40d8d76591bbf80700a41e281234302b7098dd87384473c2a',
]);

function hasPrivateTrackerId(text) {
  for (const match of text.matchAll(PRIVATE_TRACKER_CANDIDATE_RE)) {
    if (PRIVATE_TRACKER_PREFIX_HASHES.has(hashFenceValue('trk:' + match[1]))) {
      return true;
    }
  }
  return false;
}

const FORBIDDEN_TOKEN_HASHES = new Set([
  '4a3add5f875255be6f5ca853e8455458fd706c1a4eea678517bd1cc1709a7619',
  'ef6582659aeb0c951cdeeff689b5ebe2949de1639f178a69aaa75d81effa8440',
  'db823c3310c25471c432b355a7f1a5054c430e9397e7abd921dcee9cb00cf17f',
  '196379ebeba4a6b79e7be568066702e29742567f77eb51d9f6405c5348d0a60f',
  'a5065a84cbd917bb316002dd897f2985af6083035989d4286602272f61c74762',
  '4728371611f90d5fd81c1a377707e1d4bd0e07397b8dff253d295854ce1529d2',
  '17517f6d97242527f5f88befeac193902097ea0f940329a51cd3e712a83d1090',
  '712d46a2cd049535b493aa8a6f1f5cb38c22eac7e7325c079eec9381d316f87f',
  '490d6d43487013b9985f0d2391d5049697ca32f92b9a5c448cbcf87d1b045a7c',
  '8dc311769b8caa641423d5b3d97ddecff8ad15cd892fa094be5b499ced2cad69',
  'f005ec236b337d679bfe388ef89ebab12a685926ddf521e90bd28d11a3a39330',
  'df95da9695fa634161e8adbfe5cb999f4d261f3462f82a3fc919ece260b63b35',
  '6a20d5bffa6d57bcc49b20bde6db99538e8d49a0db26ca923464e716869967ba',
  'b6068dd9c928d3274969f116cb177931c596e0102d79dcc6ed7fce4657d69e96',
  '16fed0d4df9c90c202a0101ec9ae9de9b11b07a664e7bf346a6caddfb0bbd2a2',
  '31baf27c6a1f5953fe19fcbcc5bb2741dbeb219ba4e5915de3e86e0df7f188a6',
  '853df13bd838f049401eb09d4516a1b973a4f8d17c07aec9e30d2207a39033d2',
  '6812db0f2b56954eb4c8fb411f3266dbfb15a648e7136a0723c3610367f6f47a',
  '6f9384c7d2864c9f7940550b88be16091a84896e4c0b06e8254f5942f0f9f286',
  'ef103b231bfd2d82eeb8cdc4caa2f16686170baf37ba94c74c401e9ae9645510',
  '637b7cb12ebfe5320a97bc7b07b5cf66a93a51a4b961b3fd6be7975893950359',
  '124bdc6775ae8958a7f1e179f344caa43e38fa49bb52a9e069a75b76a122713d',
  'bdb7030df4597b03a3dea47a8b0fac5a0f3c031354533aa85790881c57b8d0cf',
  '91279d7b0712af2ef48fce1c698754cdd4812595e58d2b02a118a658c2561407',
  '43ea79eb5e51e184f031c3d73be32f6a579a7340657e490a2449f5eec937fb01',
  '0a0c8f15ec62df411a2d21cc3c59743ffd664abb715fc27cc7fbeaec723bab21',
  '9cc8a3b09c2c2543affb98777655693bda93f807bd296f976ad828ac8729f353',
  'b2b9de6e6769cb8f4afbe69fc203baa21eef1335de27983b2e820ae6a15b221a',
  '4bde7491948762cfd437ac952f5b5f7f80ac30c21947cbf6063371d067c38897',
  '46bc5d81118cc5c04739dcfbd9df8ddfeeb7d16276595ba54ab10e2da82af870',
  '822f45344594c300214165f5f642b07a4afb93d032c1e99682a393b40dd9dce7',
  '9e3f5028ae3e9a8d5305ebbb53fd89f5018782a75a71df20d034790d32c8164f',
  '02daeb96156c610d8b6c19605fe2c9a6c518a9fe41836dcbafb18a8db140a058',
  'e12fb177bcbe1c7b190316b914c916be6a09271626ee0a20edc393e95a7c6464',
  '303498f8789702bc4ac9e686b4b7b65cee0845bb1c44a4f1a96a1807b37a44a6',
]);

const DENIED_TOP_LEVEL_DIRS = new Set([
  'apps',
  'services',
  'docs',
  'copy',
  '.appstoreconnect',
  '.wrangler',
  'dist',
  'node_modules',
  '.build',
]);

const DENIED_TOP_LEVEL_DIR_HASHES = new Set([
  '650b261217704151745c20190e29bff9748996de1f84de30314b4e89e772deac',
  '9b5b1052b61a9de1d772ec2c1cc37b70f1ed71741cfdb19f61003d05b7a249bd',
]);

const DENIED_SUFFIXES = [
  '.swift',
  '.p8',
  '.mobileprovision',
];

const DENIED_SUFFIX_HASHES = new Set([
  'fd676030107ff946531a1a0ce942ac9aed4869c7c505f54027044cc67177e347',
  '45bd20e49bfd7ae7b9c1156c66be06c381ea99ec2d0668f7bf0d6f8a89ae3b0f',
  '3e1dd90d83639a07ef2f402902d9333254d102adfb7b01c125df3d748e53425f',
  'cbfdfc697970dbe63e49facf27515ced0e91af400252ec46c7897aaebfdb3b0d',
]);

const DENIED_SEGMENT_PAIR_HASHES = new Set([
  '6e83c1c23dad7ab5ba8f9f936817a68d5300aaaabcd917f086762f512cfbbe48',
]);

const DENIED_FILENAMES = new Set(['wrangler.jsonc', 'wrangler.toml', 'podfile']);

const ALLOWED_ROOT_FILES = new Set([
  '.gitignore',
  '.gitleaks.toml',
  'CHANGELOG.md',
  'CLA.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'PROTOCOL.md',
  'README.md',
  'SECURITY.md',
  'glama.json',
  'package-lock.json',
  'package.json',
  'server.json',
  'tsconfig.json',
]);

const ALLOWED_EXACT_PATHS = new Set([
  '.githooks/pre-push',
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
]);

const ALLOWED_PATH_PATTERNS = [
  /^\.github\/(?:workflows\/[\w.-]+\.ya?ml|ISSUE_TEMPLATE\/[\w.-]+\.(?:ya?ml|md)|cla\/[\w.-]+\.(?:md|json)|PULL_REQUEST_TEMPLATE\.md|dependabot\.ya?ml|CODEOWNERS)$/,
  /^plugin-src\/(?:[\w.-]+\/)*[\w.-]+$/,
  /^plugins\/(?:[\w.-]+\/)*[\w.-]+$/,
  /^src\/(?:[\w-]+\/)*[\w-]+\.ts$/,
  /^test\/(?:[\w-]+\/)*[\w.-]+\.(?:ts|mjs|js|json)$/,
  /^test-vectors\/[\w.-]+\.json$/,
  /^scripts\/(?:[\w-]+\/)*[\w.-]+\.(?:mjs|js|sh|ps1|md|json)$/,
];

const NOTE_PATH_RE = /^(?:[0-9a-f]{2}\/[0-9a-f]{38}|[0-9a-f]{40})$/;

export function isAllowedPublicPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (
    relPath.startsWith('/') ||
    relPath.endsWith('/') ||
    relPath.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(relPath)
  ) {
    return false;
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment === '.git') {
      return false;
    }
  }
  if (
    DENIED_TOP_LEVEL_DIRS.has(segments[0]) ||
    DENIED_TOP_LEVEL_DIR_HASHES.has(hashFenceValue('dir:' + segments[0]))
  ) {
    return false;
  }

  const lower = relPath.toLowerCase();
  for (const suffix of DENIED_SUFFIXES) {
    if (lower.endsWith(suffix)) return false;
  }
  const baseName = segments[segments.length - 1].toLowerCase();
  const baseParts = baseName.split('.');
  for (let i = 1; i < baseParts.length; i += 1) {
    const candidateSuffix = '.' + baseParts.slice(i).join('.');
    if (DENIED_SUFFIX_HASHES.has(hashFenceValue('suf:' + candidateSuffix))) return false;
  }
  for (let i = 0; i + 1 < baseParts.length; i += 1) {
    if (DENIED_SEGMENT_PAIR_HASHES.has(hashFenceValue('seg:' + baseParts[i] + '.' + baseParts[i + 1]))) {
      return false;
    }
  }
  if (
    lower.includes('.xcodeproj/') ||
    lower.endsWith('.xcodeproj') ||
    lower.includes('.xcworkspace/') ||
    lower.endsWith('.xcworkspace')
  ) {
    return false;
  }
  if (DENIED_FILENAMES.has(baseName)) return false;

  if (segments.length === 1) return ALLOWED_ROOT_FILES.has(relPath);
  if (ALLOWED_EXACT_PATHS.has(relPath)) return true;
  return ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(relPath));
}

export function findForbiddenContent(text, { allowLegacyTrackerId = false } = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings = [];
  if (!allowLegacyTrackerId && hasPrivateTrackerId(text)) {
    findings.push('Private issue tracker identifier detected.');
  }
  if (INTERNAL_DIRECTIVE_RE.test(text)) {
    findings.push('Internal directive annotation detected.');
  }
  if (PRIVATE_REPO_REF_RE.test(text)) {
    findings.push('Private repository reference detected.');
  }
  const matches = text.match(/[A-Za-z][A-Za-z0-9_]*/g);
  if (matches) {
    const words = new Set();
    for (const word of matches) {
      words.add(word.toLowerCase());
    }
    for (const word of words) {
      const digest = hashFenceValue(word);
      if (FORBIDDEN_TOKEN_HASHES.has(digest)) {
        findings.push('Internal identifier token detected.');
        break;
      }
    }
  }
  return findings;
}

function git(args, optional = false) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !optional) throw new Error('Cannot inspect the Git objects being pushed.');
  return result.status === 0 ? result.stdout.trim() : '';
}

function isAllowedTmpRemote(remoteUrl, root, realTmp) {
  if (PUBLIC_REMOTE_RE.test(remoteUrl)) return true;
  if (/^(?:https?|ssh|git):\/\//i.test(remoteUrl) || /^git@/i.test(remoteUrl)) return false;
  const candidate = remoteUrl.startsWith('file://')
    ? fileURLToPath(remoteUrl)
    : path.resolve(root, remoteUrl);
  let resolved = candidate;
  try {
    resolved = existsSync(candidate) ? realpathSync(candidate) : path.resolve(candidate);
  } catch {
    return false;
  }
  return resolved === realTmp || resolved.startsWith(realTmp + path.sep);
}

function checkAlternatesAndRemotes(root, realTmp, isTmpFixture, remoteUrl) {
  if (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES || process.env.GIT_OBJECT_DIRECTORY) {
    throw new Error('Git alternate object directories are forbidden.');
  }
  const alternatesPath = path.resolve(root, git(['rev-parse', '--git-path', 'objects/info/alternates']));
  if (existsSync(alternatesPath)) {
    throw new Error('Git objects/info/alternates is forbidden.');
  }

  if (remoteUrl) {
    if (PRIVATE_REPO_TOKEN_RE.test(remoteUrl)) {
      throw new Error('Refusing to push to a private repository target.');
    }
    if (!isTmpFixture) {
      if (!PUBLIC_REMOTE_RE.test(remoteUrl)) {
        throw new Error('Remote URL is not the canonical public repository.');
      }
    } else if (!isAllowedTmpRemote(remoteUrl, root, realTmp)) {
      throw new Error('Remote URL is outside the allowed fixture temp directory.');
    }
  }

  const remotes = git(['remote'], true).split(/\r?\n/).filter(Boolean);
  for (const remote of remotes) {
    const fetchUrls = git(['remote', 'get-url', '--all', remote], true).split(/\r?\n/).filter(Boolean);
    const pushUrls = git(['remote', 'get-url', '--push', '--all', remote], true).split(/\r?\n/).filter(Boolean);
    const urls = new Set([...fetchUrls, ...pushUrls]);
    for (const url of urls) {
      if (PRIVATE_REPO_TOKEN_RE.test(url)) {
        throw new Error(`Configured remote '${remote}' targets a private repository.`);
      }
      if (!isTmpFixture && !PUBLIC_REMOTE_RE.test(url)) {
        throw new Error(`Configured remote '${remote}' is not the canonical public repository.`);
      }
    }
  }
}

function scanReachableBlobs(commits) {
  const revList = git(['-c', 'core.quotepath=false', 'rev-list', '--objects', ...commits]);
  const oidToPath = new Map();
  for (const line of revList.split(/\r?\n/)) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const oid = space === -1 ? line : line.slice(0, space);
    const relPath = space === -1 ? '' : line.slice(space + 1);
    if (!oidToPath.has(oid) || (!oidToPath.get(oid) && relPath)) {
      oidToPath.set(oid, relPath);
    }
  }
  if (oidToPath.size === 0) return;

  const checkResult = spawnSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      input: `${[...oidToPath.keys()].join('\n')}\n`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (checkResult.status !== 0) throw new Error('Cannot inspect Git objects.');

  const blobOids = [];
  for (const line of checkResult.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [oid, type] = line.split(' ');
    if (type !== 'blob') continue;
    const relPath = oidToPath.get(oid) || '';
    if (relPath.toLowerCase().endsWith('.png')) continue;
    blobOids.push(oid);
  }
  if (blobOids.length === 0) return;

  const batchResult = spawnSync('git', ['cat-file', '--batch'], {
    input: `${blobOids.join('\n')}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (batchResult.status !== 0) throw new Error('Cannot read Git blob contents.');

  const buf = batchResult.stdout;
  let offset = 0;
  while (offset < buf.length) {
    const newline = buf.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = buf.subarray(offset, newline).toString('utf8');
    const parts = header.split(' ');
    const oid = parts[0];
    const size = Number(parts[2]);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('Malformed Git object stream.');
    }
    const start = newline + 1;
    const end = start + size;
    const contentBuf = buf.subarray(start, end);
    offset = end + 1;
    if (contentBuf.includes(0)) continue;
    const findings = findForbiddenContent(contentBuf.toString('utf8'));
    if (findings.length > 0) {
      const relPath = oidToPath.get(oid) || oid;
      throw new Error(`Forbidden internal content in ${relPath}: ${findings[0]}`);
    }
  }
}

function runPrePushHook() {
  let temporary;
  try {
    const root = git(['rev-parse', '--show-toplevel']);
    const realRoot = realpathSync(root);
    const realTmp = realpathSync(tmpdir());
    const isTmpFixture = realRoot === realTmp || realRoot.startsWith(realTmp + path.sep);
    const remoteUrl = process.argv[3] || '';

    checkAlternatesAndRemotes(root, realTmp, isTmpFixture, remoteUrl);

    const input = readFileSync(0, 'utf8');
    const codeCommits = new Set();
    const notesCommits = new Set();
    const metadata = [input];
    const tagMessages = [];

    for (const line of input.trim().split('\n').filter(Boolean)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 4 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[1])) {
        throw new Error('Invalid pre-push ref information.');
      }
      const [localRef, localOid, remoteRef] = fields;
      if (/^0+$/.test(localOid)) continue; // Deletion sends no new objects.

      if (localRef === 'refs/notes/enclave-signer' && remoteRef === 'refs/notes/enclave-signer') {
        const type = git(['cat-file', '-t', localOid]);
        if (type !== 'commit') throw new Error('Notes ref must point to a commit.');
        notesCommits.add(localOid);
      } else if (
        (remoteRef.startsWith('refs/heads/') || remoteRef.startsWith('refs/tags/')) &&
        localRef !== 'refs/notes/enclave-signer'
      ) {
        let oid = localOid;
        let type = git(['cat-file', '-t', oid]);
        while (type === 'tag') {
          const tag = git(['cat-file', '-p', oid]);
          metadata.push(tag); // Annotated tag messages can contain credentials too.
          tagMessages.push(tag);
          oid = /^object ([a-f0-9]{40}|[a-f0-9]{64})$/m.exec(tag)?.[1];
          if (!oid) throw new Error('Cannot inspect an annotated tag.');
          type = git(['cat-file', '-t', oid]);
        }
        if (type !== 'commit') throw new Error('Only refs pointing to commits can pass the secret scan.');
        codeCommits.add(oid);
      } else {
        throw new Error('Unsupported target ref namespace.');
      }
    }

    const allCommits = [...codeCommits, ...notesCommits];
    if (allCommits.length > 0) {
      if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
        throw new Error('Fetch the complete history with git fetch --unshallow before pushing.');
      }

      const requireCanonicalRoot =
        !isTmpFixture ||
        PUBLIC_REMOTE_RE.test(remoteUrl) ||
        git(['config', '--local', '--get', 'notibuddy.requireCanonicalRoot'], true) === 'true';

      for (const oid of codeCommits) {
        const roots = git(['rev-list', '--max-parents=0', oid]).split(/\r?\n/).filter(Boolean);
        if (roots.some((r) => FORBIDDEN_ROOT_OIDS.has(r))) {
          throw new Error('Forbidden foreign repository history detected.');
        }
        if (roots.length !== 1) {
          throw new Error('Pushed history must descend from a single root commit.');
        }
        if (requireCanonicalRoot && roots[0] !== PUBLIC_ROOT_OID) {
          throw new Error('Pushed history does not descend from the canonical public root commit.');
        }
      }

      for (const oid of notesCommits) {
        const roots = git(['rev-list', '--max-parents=0', oid]).split(/\r?\n/).filter(Boolean);
        if (roots.some((r) => FORBIDDEN_ROOT_OIDS.has(r))) {
          throw new Error('Forbidden foreign notes history detected.');
        }
      }

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
      scan(['git', root, '--log-opts', `--full-history --root -m ${allCommits.join(' ')}`]);
      const commitMessages = git(['log', '--no-patch', '--format=%B', ...allCommits]);
      metadata.push(commitMessages);
      scan(['stdin'], metadata.join('\n'));

      const rawDiff = git([
        '-c',
        'core.quotepath=false',
        'log',
        '--full-history',
        '--root',
        '-m',
        '--raw',
        '--no-abbrev',
        '--pretty=format:',
        ...allCommits,
      ]);
      for (const line of rawDiff.split(/\r?\n/)) {
        if (!line.startsWith(':')) continue;
        const modeMatch = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*\t(.+)$/.exec(line);
        if (!modeMatch) continue;
        const [, , newMode, pathField] = modeMatch;
        if (newMode !== '000000' && newMode !== '100644' && newMode !== '100755') {
          const entryPath = pathField.split('\t').pop();
          throw new Error(`Forbidden Git entry mode ${newMode} at ${entryPath}.`);
        }
      }

      if (codeCommits.size > 0) {
        const touchedPaths = new Set(
          git(['-c', 'core.quotepath=false', 'log', '--full-history', '--root', '--name-only', '--pretty=format:', ...codeCommits])
            .split(/\r?\n/)
            .filter(Boolean)
        );
        for (const relPath of touchedPaths) {
          if (!isAllowedPublicPath(relPath)) {
            throw new Error(`Path is not allowed in the public repository: ${relPath}`);
          }
        }
      }

      if (notesCommits.size > 0) {
        const touchedNotePaths = new Set(
          git(['-c', 'core.quotepath=false', 'log', '--full-history', '--root', '--name-only', '--pretty=format:', ...notesCommits])
            .split(/\r?\n/)
            .filter(Boolean)
        );
        for (const notePath of touchedNotePaths) {
          if (!NOTE_PATH_RE.test(notePath)) {
            throw new Error(`Notes path is not allowed: ${notePath}`);
          }
        }
      }

      const commitMetaStream = git(['log', '--no-patch', '--format=%H%x1f%B%x00', ...allCommits]);
      for (const record of commitMetaStream.split('\0')) {
        if (!record) continue;
        const sep = record.indexOf('\x1f');
        if (sep === -1) continue;
        const sha = record.slice(0, sep).trim();
        const body = record.slice(sep + 1);
        const commitFindings = findForbiddenContent(body, {
          allowLegacyTrackerId: LEGACY_TRACKER_EXEMPT_COMMIT_OIDS.has(sha),
        });
        if (commitFindings.length > 0) {
          throw new Error(`Forbidden internal content in commit ${sha}: ${commitFindings[0]}`);
        }
      }
      if (tagMessages.length > 0) {
        const tagFindings = findForbiddenContent(tagMessages.join('\n'), {
          allowLegacyTrackerId: false,
        });
        if (tagFindings.length > 0) {
          throw new Error(`Forbidden internal content in tag metadata: ${tagFindings[0]}`);
        }
      }

      scanReachableBlobs(allCommits);

      console.error('NotiBuddy: pre-push secret scan passed.');
    }
  } catch (error) {
    console.error(`NotiBuddy: push blocked. ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  runPrePushHook();
}
