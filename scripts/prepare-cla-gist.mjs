#!/usr/bin/env node
// Prepare a reviewable payload only. Publishing and service authorization are separate.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const output = process.argv[2];
if (!output || process.argv.length !== 3) {
  console.error('Usage: node scripts/prepare-cla-gist.mjs <new-output.json>');
  process.exit(1);
}
const agreement = readFileSync(new URL('../CLA.md', import.meta.url), 'utf8');
const metadata = readFileSync(new URL('../.github/cla/metadata.json', import.meta.url), 'utf8');
JSON.parse(metadata);
const payload = {
  description: 'NotiBuddy Contributor Assignment Agreement — Yourbit, LLC — Harmony CAA 1.0',
  public: true,
  files: {
    'CLA.md': { content: agreement },
    metadata: { content: metadata },
  },
};
writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Prepared ${output}; nothing was published.`);
console.log(`Agreement SHA-256: ${createHash('sha256').update(agreement).digest('hex')}`);
