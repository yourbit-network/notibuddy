import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateReplyKeyPair, generateSenderSigningKeyPair, deriveDeviceId } from '../src/crypto.js';
import type { PairingBundle } from '../src/types.js';
import { DestinationStore } from '../src/config.js';
import { z } from 'zod';
import { askFields, activitySchema } from '../src/client.js';
import { ASK_TOOL_SCHEMA, ACTIVITY_TOOL_SCHEMA, createMcpServer, MCP_VERSION } from '../src/mcp.js';
process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1'; // tests never contact the npm registry

// Zod property (camelCase) -> advertised property (snake_case).
const RENAMES: Record<string, string> = {
  inputPlaceholder: 'input_placeholder', requiresAuth: 'requires_auth', timeoutSeconds: 'timeout_seconds',
  waitSeconds: 'wait_seconds', resumeId: 'resume_id', declineOption: 'decline_option',
  timerMinutes: 'timer_minutes', totalSteps: 'total_steps', activityId: 'id',
};
// Properties present on only one side are skipped: `diff` (zod: unknown) and `to`
// (added per-destination at list time) are advertised only; `shortTitle`/`summary` are shared.
const KEYWORDS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum'] as const;

type Json = Record<string, any>;
function compare(path: string, zodSide: Json, advertised: Json, errors: string[]): void {
  for (const k of KEYWORDS) if (zodSide[k] !== advertised[k]) errors.push(`${path}.${k}: zod=${zodSide[k]} advertised=${advertised[k]}`);
  const zInt = zodSide.type === 'integer', aInt = advertised.type === 'integer';
  if (zInt !== aInt) errors.push(`${path}.integer: zod=${zInt} advertised=${aInt}`);
  if (zodSide.items && advertised.items) compare(`${path}[]`, zodSide.items, advertised.items, errors);
  if (zodSide.properties && advertised.properties) compare_props(path, zodSide.properties, advertised.properties, errors, false);
}
function compare_props(path: string, zp: Json, ap: Json, errors: string[], rename: boolean): void {
  for (const [zk, zv] of Object.entries(zp)) {
    const ak = rename ? RENAMES[zk] ?? zk : zk;
    if (!(ak in ap)) continue;
    compare(`${path}.${ak}`, zv as Json, ap[ak], errors);
  }
}
function check(name: string, schema: z.ZodType, advertised: Json): void {
  const js = z.toJSONSchema(schema, { io: 'input' }) as Json;
  const errors: string[] = [];
  compare_props(name, js.properties, advertised.inputSchema.properties, errors, true);
  assert.deepEqual(errors, [], `${name} advertised bounds drift from zod:\n${errors.join('\n')}`);
}

check('ask', askFields, ASK_TOOL_SCHEMA);
check('activity', activitySchema, ACTIVITY_TOOL_SCHEMA);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
assert.equal(MCP_VERSION, pkg);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-schema-'));
const store = new DestinationStore(home);
const enc = await generateReplyKeyPair(), sig = await generateSenderSigningKeyPair();
const bundle: PairingBundle = { v: 1, relay: 'https://relay.test', token: 'nb_snd_fixture_schema', pairSecret: Buffer.alloc(32).toString('base64url'),
  device: { id: await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u), encPub: enc.publicKeyB64u, sigPub: sig.publicKeyB64u, name: 'Phone' } };
await store.prepare('phone', bundle, 'My Mac');
const server = await createMcpServer({ to: 'phone' }, store);
const client = new Client({ name: 'fixture', version: '1' }, { capabilities: {} });
const [left, right] = InMemoryTransport.createLinkedPair();
await server.connect(right); await client.connect(left);
assert.equal(client.getServerVersion()?.version, pkg);
await client.close();
fs.rmSync(home, { recursive: true, force: true });
console.log('mcp schema bounds: ok');
