#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const srcRoot = path.join(root, 'plugin-src');
const modeWrite = process.argv.includes('--write');
const modeCheck = process.argv.includes('--check') || !modeWrite;

function readUtf8Lf(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const meta = JSON.parse(readUtf8Lf(path.join(srcRoot, 'meta.json')));
const { hosts } = JSON.parse(readUtf8Lf(path.join(srcRoot, 'hosts.json')));
const ruleText = readUtf8Lf(path.join(srcRoot, 'rule.md')).trim();
const hookShimTemplate = readUtf8Lf(path.join(srcRoot, 'hooks/nb-hook.sh.tmpl'));
const iconBytes = fs.readFileSync(path.join(srcRoot, 'icon.png'));
const logoSvg = readUtf8Lf(path.join(srcRoot, 'logo.svg'));

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Budget & policy checks on canonical source.
assert.ok(wordCount(ruleText) <= 80, `plugin-src/rule.md exceeds 80 words (${wordCount(ruleText)})`);
assert.match(meta.minCli, /^\d+\.\d+\.\d+$/, `plugin-src/meta.json minCli must be an exact version pin (got ${meta.minCli})`);
assert.ok(iconBytes.length <= 128 * 1024, `plugin-src/icon.png exceeds 128 KiB (${iconBytes.length} bytes)`);

function readTree(dir, base = dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Symlink forbidden in plugin sources: ${full}`);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      for (const [k, v] of readTree(full, base)) out.set(k, v);
    } else {
      out.set(rel, { content: readUtf8Lf(full), mode: fs.statSync(full).mode & 0o777 });
    }
  }
  return out;
}

const sharedSkills = readTree(path.join(srcRoot, 'skills'));
const hookSkill = readTree(path.join(srcRoot, 'hooks/skill'));

// Map<repoRelativePath, { content: string | Buffer; executable?: boolean }>
const generated = new Map();

function put(relPath, content, executable = false) {
  const normalized = relPath.split(path.sep).join('/');
  assert.ok(!generated.has(normalized), `Duplicate generated file: ${normalized}`);
  generated.set(normalized, { content: content.endsWith('\n') ? content : content + '\n', executable });
}

function putBinary(relPath, buffer) {
  const normalized = relPath.split(path.sep).join('/');
  assert.ok(!generated.has(normalized), `Duplicate generated file: ${normalized}`);
  generated.set(normalized, { content: buffer, executable: false });
}

function mcpConfigFor(clientId) {
  return JSON.stringify(
    {
      mcpServers: {
        notibuddy: {
          command: 'npx',
          args: ['-y', `notibuddy@${meta.minCli}`, 'mcp', '--client', clientId],
        },
      },
    },
    null,
    2,
  );
}

function remoteMcpConfig() {
  return JSON.stringify(
    {
      mcpServers: {
        notibuddy: {
          type: 'http',
          url: 'https://mcp.notibuddy.app/mcp',
        },
      },
    },
    null,
    2,
  );
}

function coreManifestFor(host) {
  if (host.id === 'antigravity') {
    return JSON.stringify(
      {
        name: meta.core.name,
        version: meta.pluginVersion,
        description: meta.core.description,
        logo: 'assets/icon.png',
        author: meta.author,
        homepage: host.homepage,
        repository: { type: 'git', url: meta.repository },
      },
      null,
      2,
    );
  }
  if (host.id === 'codex') {
    return JSON.stringify(
      {
        name: meta.core.name,
        version: meta.pluginVersion,
        description: meta.core.description,
        skills: './skills/',
        mcpServers: './.mcp.json',
        extensions: {
          'com.openai': {
            category: 'Productivity',
          },
        },
      },
      null,
      2,
    );
  }
  if (host.id === 'cursor') {
    return JSON.stringify(
      {
        name: meta.core.name,
        displayName: meta.core.displayName,
        version: meta.pluginVersion,
        description: meta.core.description,
        logo: 'assets/logo.svg',
        author: meta.author,
        homepage: host.homepage,
        repository: meta.repository,
        license: meta.license,
      },
      null,
      2,
    );
  }
  // Claude Code manifest (validated against `claude plugin validate --strict --profile directory`).
  return JSON.stringify(
    {
      name: meta.core.name,
      displayName: meta.core.displayName,
      version: meta.pluginVersion,
      description: meta.core.description,
      icon: './.claude-plugin/icon.png',
      author: meta.author,
      homepage: host.homepage,
      repository: meta.repository,
      documentationUrl: meta.documentationUrl,
      supportUrl: meta.supportUrl,
      privacyPolicyUrl: meta.privacyPolicyUrl,
      termsOfServiceUrl: meta.termsOfServiceUrl,
      license: meta.license,
      keywords: ['notifications', 'approvals', 'mcp', 'iphone', 'apple-watch', 'encrypted'],
    },
    null,
    2,
  );
}

function claudeDirectoryManifestFor(host) {
  return JSON.stringify(
    {
      name: meta.core.name,
      displayName: meta.core.displayName,
      version: meta.pluginVersion,
      description:
        'Dynamic native iOS custom screen builder, Face ID approval gates, Live Activities, and iPhone-to-Claude file sharing across your paired iPhone, iPad, and Apple Watch.',
      icon: './.claude-plugin/icon.png',
      author: meta.author,
      homepage: host.homepage,
      repository: meta.repository,
      documentationUrl: meta.documentationUrl,
      supportUrl: meta.supportUrl,
      privacyPolicyUrl: meta.privacyPolicyUrl,
      termsOfServiceUrl: meta.termsOfServiceUrl,
      license: meta.license,
      keywords: ['notifications', 'approvals', 'mcp', 'iphone', 'apple-watch', 'live-activities'],
    },
    null,
    2,
  );
}

function hooksManifestFor(host) {
  return JSON.stringify(
    {
      name: meta.hooks.name,
      displayName: meta.hooks.displayName,
      version: meta.pluginVersion,
      description: meta.hooks.description,
      icon: './.claude-plugin/icon.png',
      author: meta.author,
      homepage: host.homepage,
      repository: meta.repository,
      documentationUrl: meta.documentationUrl,
      supportUrl: meta.supportUrl,
      privacyPolicyUrl: meta.privacyPolicyUrl,
      termsOfServiceUrl: meta.termsOfServiceUrl,
      license: meta.license,
      keywords: ['hooks', 'permissions', 'notifications', 'approvals', 'iphone', 'apple-watch'],
    },
    null,
    2,
  );
}

function coreReadme(host) {
  const installSection =
    host.id === 'claude-code'
      ? `\n## Install\n\n\`\`\`\n/plugin install ${meta.core.name} --marketplace yourbit-network/notibuddy\n\`\`\`\n`
      : host.id === 'codex'
        ? `\n## Install\n\n\`\`\`bash\ncodex plugin marketplace add yourbit-network/notibuddy\ncodex plugin add ${meta.core.name}@notibuddy\n\`\`\`\n`
        : '';
  return `# NotiBuddy for ${host.displayName}

${meta.core.description}
${installSection}
## Quick Start

1. Install the **NotiBuddy** app on iPhone or iPad ([App Store](https://apps.apple.com/app/id6823749991)).
2. Open **NotiBuddy → Connect → Add → Create setup code → Share Setup**, then run in your own terminal:
   \`\`\`bash
   pbpaste | npx -y notibuddy@${meta.minCli} pair --to personal
   \`\`\`
3. If you pair more than one phone or CI destination, bind ${host.displayName} explicitly:
   \`\`\`bash
   nb bind --client ${host.clientId} --to personal
   \`\`\`

Full setup guide: ${host.homepage}
`;
}

function claudeDirectoryReadme(host) {
  return `# NotiBuddy

Turn your iPhone, iPad, and Apple Watch into a two-way native control surface for Claude—with a dynamic custom screen builder, biometric approval gates, Lock Screen Live Activities, and iPhone-to-Claude file sharing.

Unlike built-in notifications that only ping you to return to a chat thread, NotiBuddy lets Claude compose bespoke native iOS screens on the fly from 12 UI blocks (inline code diffs, KPI strips, key-value lists, alerts, checklists, toggles, pickers, steppers, and structured forms) with optional dry-run validation, or launch 8 ready-made developer presets across Claude, MCP-compatible IDEs, CI/CD pipelines, and local CLI scripts.

## Quick Start

1. Install the **NotiBuddy** companion app on iPhone or iPad ([App Store](https://apps.apple.com/app/id6823749991)).
2. Connect the bundled **NotiBuddy** remote MCP server (\`https://mcp.notibuddy.app/mcp\`) via the plugin's **Connectors** tab (or on first use in Claude Code) and complete OAuth pairing using a setup code (\`nbpair1...\`) from **NotiBuddy → Connect → Add a connection → Create setup code → Share Setup**.
3. Ask Claude to send a deployment gate or custom native screen, track a long-running task with a Live Activity, or inspect files shared from your iPhone.
4. *(Optional — local terminal workflows)* Claude Code users who want local-only encryption keys or opt-in terminal permission hooks can also install the local \`notibuddy\` CLI/MCP server and hooks plugin — see ${host.homepage}.

## Data & Privacy

- **Remote connection:** Connects over HTTPS using OAuth 2.1 with PKCE (\`S256\`) to \`https://mcp.notibuddy.app/mcp\`, which encrypts payloads between the hosted connector and your paired Apple device via \`https://notibuddy.app\`.
- **Data exchanged:** Sends only the notification titles, messages, native screen layouts/slots, Live Activity updates, and file-transfer requests initiated during your conversation, and returns your device's replies or explicitly requested shared files (via short-lived browser download links at \`https://mcp.notibuddy.app/f/...\` with the decryption key kept in the URL \`#fragment\`, or bounded UTF-8 text reads up to 128 KiB).
- **Guardrails:** Intentionally blocks \`type: "secret"\` / \`fieldType: "secret"\` form fields on the hosted connector and supports hiding lock-screen previews (\`sensitive: true\`).
- **Revocation:** Disconnecting in Claude revokes the OAuth grant (\`POST /oauth/revoke\`), purging stored per-connection keys and withdrawing the sender registration from your device.
- **Links:** [Privacy Policy](${meta.privacyPolicyUrl}) · [Terms of Service](${meta.termsOfServiceUrl}) · [Support](${meta.supportUrl}) · [Setup Guide](${meta.documentationUrl})
`;
}

function hooksReadme(host) {
  const installSection =
    host.id === 'claude-code'
      ? `\n## Install\n\n\`\`\`\n/plugin install ${meta.hooks.name} --marketplace yourbit-network/notibuddy\n\`\`\`\n`
      : '';
  return `# NotiBuddy Hooks for ${host.displayName}

${meta.hooks.description}
${installSection}
## Prerequisites

Install the local \`nb\` CLI (hooks never call \`npx\`):

\`\`\`bash
brew install yourbit-network/tap/notibuddy
# or: npm install -g notibuddy
\`\`\`

Then pair your iPhone in Terminal (and run \`nb bind --client ${host.clientId} --to <alias>\` if you have more than one destination).

Full setup guide: ${host.homepage}
`;
}

function cursorMdcRule(text) {
  return `---
description: NotiBuddy fail-closed approval, privacy, and untrusted file safety rules
alwaysApply: true
---

${text}
`;
}

const claudeMarketplacePlugins = [];
const codexMarketplacePlugins = [];

for (const host of hosts) {
  const coreDir = `plugins/${host.id}/${meta.core.name}`;
  put(`${coreDir}/${host.manifestPath}`, coreManifestFor(host));
  put(`${coreDir}/${host.mcpFile}`, mcpConfigFor(host.clientId));
  put(`${coreDir}/README.md`, coreReadme(host));
  putBinary(`${coreDir}/${host.id === 'claude-code' ? '.claude-plugin/icon.png' : 'assets/icon.png'}`, iconBytes);
  if (host.id === 'cursor') {
    put(`${coreDir}/assets/logo.svg`, logoSvg);
  }

  if (host.ruleFile) {
    const ruleContent = host.ruleFile.endsWith('.mdc') ? cursorMdcRule(ruleText) : `# NotiBuddy Safety Rules\n\n${ruleText}\n`;
    put(`${coreDir}/${host.ruleFile}`, ruleContent);
  }

  for (const [rel, file] of sharedSkills) {
    put(`${coreDir}/skills/${rel}`, file.content);
  }

  if (host.id === 'claude-code') {
    claudeMarketplacePlugins.push({
      name: meta.core.name,
      source: `./${coreDir}`,
      description: meta.core.description,
      version: meta.pluginVersion,
      author: meta.author,
      homepage: host.homepage,
      repository: meta.repository,
      license: meta.license,
    });

    // Hosted remote MCP + skills bundle for Anthropic's Software Directory (`claude.ai/directory`),
    // avoiding local code execution while pairing cleanly with https://mcp.notibuddy.app/mcp.
    const directoryDir = `plugins/${host.id}/${meta.core.name}-directory`;
    put(`${directoryDir}/${host.manifestPath}`, claudeDirectoryManifestFor(host));
    put(`${directoryDir}/${host.mcpFile}`, remoteMcpConfig());
    put(`${directoryDir}/README.md`, claudeDirectoryReadme(host));
    putBinary(`${directoryDir}/.claude-plugin/icon.png`, iconBytes);
    for (const [rel, file] of sharedSkills) {
      put(`${directoryDir}/skills/${rel}`, file.content);
    }
    for (const [rel, file] of hookSkill) {
      put(`${directoryDir}/skills/notibuddy-hooks/${rel}`, file.content);
    }
  }
  if (host.id === 'codex') {
    codexMarketplacePlugins.push({
      name: meta.core.name,
      source: {
        source: 'local',
        path: `./${coreDir}`,
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Productivity',
    });
  }

  if (host.hooks?.enabled) {
    const hooksDir = `plugins/${host.id}/${meta.hooks.name}`;
    put(`${hooksDir}/${host.manifestPath}`, hooksManifestFor(host));
    put(`${hooksDir}/README.md`, hooksReadme(host));
    putBinary(`${hooksDir}/${host.id === 'claude-code' ? '.claude-plugin/icon.png' : 'assets/icon.png'}`, iconBytes);

    const shim = hookShimTemplate.replace('__PASSTHROUGH__', host.hooks.passthroughStdout);
    put(`${hooksDir}/scripts/nb-hook`, shim, true);

    if (host.id === 'claude-code') {
      const hooksJson = JSON.stringify(
        {
          hooks: {
            [host.hooks.hookEvent]: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `${host.hooks.commandPrefix} ${host.hooks.hookAgent} ${host.hooks.hookEvent} --client ${host.clientId} --timeout ${host.hooks.timeoutSeconds}`,
                    timeout: host.hooks.harnessTimeoutSeconds,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      );
      put(`${hooksDir}/${host.hooks.hooksPath}`, hooksJson);
      claudeMarketplacePlugins.push({
        name: meta.hooks.name,
        source: `./${hooksDir}`,
        description: meta.hooks.description,
        version: meta.pluginVersion,
        author: meta.author,
        homepage: host.homepage,
        repository: meta.repository,
        license: meta.license,
      });
    }

    for (const [rel, file] of hookSkill) {
      put(`${hooksDir}/skills/notibuddy-hooks/${rel}`, file.content);
    }
  }
}

put(
  '.claude-plugin/marketplace.json',
  JSON.stringify(
    {
      name: 'notibuddy',
      owner: meta.author,
      metadata: {
        description: 'Official NotiBuddy plugins for Claude Code.',
      },
      plugins: claudeMarketplacePlugins,
    },
    null,
    2,
  ),
);

put(
  '.agents/plugins/marketplace.json',
  JSON.stringify(
    {
      name: 'notibuddy',
      interface: {
        displayName: 'NotiBuddy',
      },
      plugins: codexMarketplacePlugins,
    },
    null,
    2,
  ),
);

// Static lint checks across all generated files.
for (const [rel, { content }] of generated) {
  assert.ok(!rel.includes('/bin/'), `Top-level bin/ forbidden in plugins: ${rel}`);
  if (Buffer.isBuffer(content)) continue;
  assert.ok(!/(?:\/Users\/|\/home\/(?!linuxbrew)|C:\\\\)/.test(content), `Absolute host path leaked in ${rel}`);
  if (rel.startsWith('plugins/') && rel.endsWith('.json')) {
    assert.ok(!/"--to"|"--allow-to"/.test(content), `Hardcoded --to/--allow-to forbidden in ${rel}`);
  }
  if (rel.includes('/notibuddy-directory/')) {
    assert.ok(!rel.includes('/hooks/') && !rel.endsWith('.sh'), `Directory bundle must not run local hooks or scripts: ${rel}`);
    if (rel.endsWith('.mcp.json')) {
      const parsed = JSON.parse(content);
      const entry = parsed?.mcpServers?.notibuddy;
      assert.equal(entry?.type, 'http', `Directory .mcp.json must use remote http transport in ${rel}`);
      assert.equal(entry?.url, 'https://mcp.notibuddy.app/mcp', `Unexpected remote MCP URL in ${rel}`);
      assert.equal(entry?.command, undefined, `Directory .mcp.json must not declare local command in ${rel}`);
      assert.equal(entry?.args, undefined, `Directory .mcp.json must not declare local args in ${rel}`);
      continue;
    }
  }
  if (rel.includes('/notibuddy-hooks/') && (rel.endsWith('hooks.json') || rel.endsWith('scripts/nb-hook'))) {
    assert.ok(!/\bnpx\b/.test(content), `npx is forbidden in hook execution files: ${rel}`);
  }
  if (rel.endsWith('mcp_config.json') || rel.endsWith('.mcp.json') || rel.endsWith('/mcp.json')) {
    const parsed = JSON.parse(content);
    const entry = parsed?.mcpServers?.notibuddy;
    assert.equal(entry?.command, 'npx', `Unexpected MCP command in ${rel}`);
    assert.equal(entry?.args?.[0], '-y', `Unexpected MCP arg[0] in ${rel}`);
    assert.equal(entry?.args?.[1], `notibuddy@${meta.minCli}`, `Unexpected MCP arg[1] in ${rel}`);
    assert.equal(entry?.args?.[2], 'mcp', `Unexpected MCP arg[2] in ${rel}`);
    assert.equal(entry?.args?.[3], '--client', `MCP config must use --client in ${rel}`);
    assert.match(entry?.args?.[4] ?? '', /^[a-z][a-z0-9_-]{0,47}$/, `Invalid --client id in ${rel}`);
    assert.equal(entry?.args?.length, 5, `Unexpected extra MCP args in ${rel}`);
  }
}

const managedRoots = ['plugins', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];

function existingManagedFiles() {
  const existing = new Set();
  for (const target of managedRoots) {
    const abs = path.join(root, target);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.lstatSync(abs);
    assert.ok(!stat.isSymbolicLink(), `Symlink forbidden in generated tree: ${target}`);
    if (stat.isFile()) {
      existing.add(target);
    } else {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          assert.ok(!entry.isSymbolicLink(), `Symlink forbidden in generated tree: ${full}`);
          if (entry.isDirectory()) walk(full);
          else existing.add(path.relative(root, full).split(path.sep).join('/'));
        }
      };
      walk(abs);
    }
  }
  return existing;
}

if (modeWrite) {
  const existing = existingManagedFiles();
  for (const stale of existing) {
    if (!generated.has(stale)) fs.rmSync(path.join(root, stale), { force: true });
  }
  for (const [rel, { content, executable }] of generated) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (Buffer.isBuffer(content)) fs.writeFileSync(abs, content);
    else fs.writeFileSync(abs, content, 'utf8');
    if (executable) fs.chmodSync(abs, 0o755);
  }
  console.log(`Generated ${generated.size} plugin manifest files from plugin-src/.`);
} else if (modeCheck) {
  const existing = existingManagedFiles();
  const diffs = [];
  for (const [rel, { content, executable }] of generated) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      diffs.push(`missing: ${rel}`);
      continue;
    }
    if (Buffer.isBuffer(content)) {
      const actual = fs.readFileSync(abs);
      if (!actual.equals(content)) diffs.push(`binary drift: ${rel}`);
    } else {
      const actual = readUtf8Lf(abs);
      if (actual !== content) diffs.push(`content drift: ${rel}`);
    }
    if (executable && process.platform !== 'win32') {
      const mode = fs.statSync(abs).mode & 0o111;
      if (mode === 0) diffs.push(`missing +x mode: ${rel}`);
    }
  }
  for (const extra of existing) {
    if (!generated.has(extra)) diffs.push(`unexpected file: ${extra}`);
  }
  if (diffs.length > 0) {
    console.error('Plugin manifest drift detected:\n  ' + diffs.join('\n  ') + '\nRun: npm run plugins:build');
    process.exit(1);
  }
  console.log(`Verified ${generated.size} generated plugin manifest files (0 drift, all lint checks passed).`);
}
