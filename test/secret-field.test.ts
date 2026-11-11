import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotiBuddyClient } from '../src/client.js';
import { PendingStore } from '../src/pending-store.js';
import { ASK_TOOL_SCHEMA } from '../src/mcp.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';
import type { NotiBuddyConfig } from '../src/types.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-secret-'));
const originalFetch = globalThis.fetch;
try {
  const description = JSON.stringify(ASK_TOOL_SCHEMA);
  assert.ok(description.includes('older phones show unknown field types as plain text'));
  assert.ok(description.includes('"secret"'));

  const phoneEnc = await generateReplyKeyPair(); const phoneSig = await generateSenderSigningKeyPair();
  const sender = await generateSenderSigningKeyPair();
  const config: NotiBuddyConfig = { relay: 'https://relay.test', token: 'nb_snd_test', device: {
    id: await deriveDeviceId(phoneEnc.publicKeyB64u, phoneSig.publicKeyB64u), encPub: phoneEnc.publicKeyB64u, sigPub: phoneSig.publicKeyB64u,
  }, senderKeyId: sender.senderKeyId, senderLabel: 'test' };
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ requestId: 'r', seq: 1 }, { status: 202 }); }
    return new Response(null, { status: 204 });
  };
  const client = new NotiBuddyClient(config, sender.privateKey, new PendingStore(config, directory));
  await client.ask({ title: 'Login', fields: [{ id: 'token', type: 'secret', label: 'Token' }], waitSeconds: 0 });
  assert.equal(posts, 1, 'a secret field passes schema validation');
  await assert.rejects(client.ask({ title: 'Bad', fields: [{ id: 'x', type: 'nope' as any, label: 'x' }], waitSeconds: 0 }));
  console.log('secret-field tests passed');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(directory, { recursive: true, force: true });
}
