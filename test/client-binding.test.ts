import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DestinationStore } from '../src/config.js';
import {
  deleteClientBinding,
  listClientBindings,
  resolveClientDestination,
  writeClientBinding,
} from '../src/client-binding.js';
import { createMcpServer, MCP_INSTRUCTIONS } from '../src/mcp.js';
import { createDestinationRouter } from '../src/routing.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair, hpkeOpen } from '../src/crypto.js';
import { buildRequestHeader } from '../src/protocol.js';
import type { PairingBundle, RequestEnvelope } from '../src/types.js';

process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-client-binding-'));
const originalFetch = globalThis.fetch;
const openClients: Client[] = [];

try {
  const store = new DestinationStore(root);
  const makePhone = async (name: string) => {
    const enc = await generateReplyKeyPair();
    const sig = await generateSenderSigningKeyPair();
    const bundle: PairingBundle = {
      v: 1,
      relay: 'https://relay.test',
      token: 'nb_snd_fixture_' + name,
      pairSecret: Buffer.alloc(32).toString('base64url'),
      device: {
        id: await deriveDeviceId(enc.publicKeyB64u, sig.publicKeyB64u),
        encPub: enc.publicKeyB64u,
        sigPub: sig.publicKeyB64u,
        name,
      },
    };
    return { bundle, enc, sig };
  };

  let fetches = 0;
  const requests: RequestEnvelope[] = [];
  globalThis.fetch = async (_input, init) => {
    fetches += 1;
    if (init?.method === 'POST') {
      const req = JSON.parse(String(init.body)) as RequestEnvelope;
      requests.push(req);
      return Response.json({ requestId: req.requestId, seq: requests.length }, { status: 202 });
    }
    return new Response(null, { status: 204 });
  };

  const connectClient = async (clientId: string) => {
    const server = await createMcpServer({ client: clientId }, store);
    const client = new Client({ name: 'test-host', version: '1.0' }, { capabilities: {} });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
    openClients.push(client);
    return client;
  };

  // Bare `createDestinationRouter({})` stays strict.
  await assert.rejects(createDestinationRouter({}, store), /Select a destination explicitly/);

  // 1. State: 0 destinations -> starts cleanly, constant 4 tools, no `to` param, instructions set, zero network on call.
  const mcpA = await connectClient('claude-code');
  assert.equal(mcpA.getInstructions(), MCP_INSTRUCTIONS);
  const tools0 = (await mcpA.listTools()).tools;
  assert.deepEqual(
    tools0.map((t) => t.name),
    ['notibuddy_notify', 'notibuddy_activity', 'notibuddy_files', 'notibuddy_list_destinations'],
  );
  assert.equal('to' in (tools0[0].inputSchema.properties ?? {}), false);
  assert.match(tools0[0].description ?? '', /Fail closed/);

  const unpairedCall = await mcpA.callTool({ name: 'notibuddy_notify', arguments: { title: 'Hello' } });
  assert.equal(unpairedCall.isError, true);
  assert.match((unpairedCall.content as any)[0].text, /No NotiBuddy phone is paired/);
  assert.equal(fetches, 0, 'Unpaired call must never hit network');

  const list0 = JSON.parse((await mcpA.callTool({ name: 'notibuddy_list_destinations', arguments: {} })).content[0].text);
  assert.equal(list0.status, 'unpaired');
  assert.deepEqual(list0.destinations, []);

  // 2. State: 0 -> 1 destination paired mid-session -> binds once without restart!
  const personal = await makePhone('Personal');
  const pRec = await store.prepare('personal', personal.bundle, 'My Mac');
  const firstSend = await mcpA.callTool({ name: 'notibuddy_notify', arguments: { title: 'Paired!' } });
  assert.notEqual(firstSend.isError, true);
  const firstBody = JSON.parse((firstSend.content as any)[0].text);
  assert.equal(firstBody.to, 'personal');
  assert.equal(firstBody.connectionId, pRec.record.connectionId);
  assert.equal(requests.length, 1);
  // Default sender label comes from --client id ("Claude Code"), not hostname!
  const decrypted = JSON.parse(
    await hpkeOpen(
      personal.enc.privateKey,
      requests[0].enc,
      'notibuddy/v1/request',
      buildRequestHeader(
        requests[0].requestId,
        requests[0].deviceId,
        requests[0].senderKeyId,
        requests[0].primitive,
        requests[0].createdAt,
        requests[0].expiresAt,
      ),
      requests[0].ct,
    ),
  );
  assert.equal(decrypted.source.label, 'Claude Code');

  // 3. State: unbound single-dest fallback + 2nd destination paired mid-session -> refuses!
  const work = await makePhone('Work');
  const wRec = await store.prepare('work', work.bundle, 'My Mac');
  const fetchesBeforeAmbiguous = fetches;
  const ambiguousCall = await mcpA.callTool({ name: 'notibuddy_notify', arguments: { title: 'Ambiguous' } });
  assert.equal(ambiguousCall.isError, true);
  assert.match((ambiguousCall.content as any)[0].text, /nb bind --client claude-code --to/);
  assert.equal(fetches, fetchesBeforeAmbiguous, 'Ambiguous state must refuse before network');

  // 4. Binding back to the SAME destination resumes without restart!
  writeClientBinding('claude-code', 'personal', pRec.record.connectionId, root);
  const resumedSend = await mcpA.callTool({ name: 'notibuddy_notify', arguments: { title: 'Bound same' } });
  assert.notEqual(resumedSend.isError, true);
  assert.equal(requests.length, 2);

  // 5. Explicit binding active + unrelated 3rd destination (`ci`) added mid-session -> keeps working!
  const ci = await makePhone('CI');
  await store.prepare('ci', ci.bundle, 'GitHub Actions');
  const stillWorks = await mcpA.callTool({ name: 'notibuddy_notify', arguments: { title: 'Still pinned' } });
  assert.notEqual(stillWorks.isError, true);
  assert.equal(requests.length, 3);

  // 6. Explicit binding changed to DIFFERENT destination (`work`) mid-session -> refuses until restart!
  writeClientBinding('claude-code', 'work', wRec.record.connectionId, root);
  const fetchesBeforeRetarget = fetches;
  const retargeted = await mcpA.callTool({ name: 'notibuddy_notify', arguments: { title: 'Should refuse' } });
  assert.equal(retargeted.isError, true);
  assert.match((retargeted.content as any)[0].text, /binding changed mid-session; restart/);
  assert.equal(fetches, fetchesBeforeRetarget);

  // 7. Fresh session picks up the explicit binding to `work`!
  const mcpB = await connectClient('claude-code');
  const workSend = await mcpB.callTool({ name: 'notibuddy_notify', arguments: { title: 'To work' } });
  assert.notEqual(workSend.isError, true);
  assert.equal(JSON.parse((workSend.content as any)[0].text).to, 'work');

  // 8. `DestinationStore.rename` updates bindings so pinned client keeps matching same connectionId!
  store.rename('work', 'work-phone');
  const resolvedRenamed = resolveClientDestination('claude-code', root);
  assert.equal(resolvedRenamed.ok, true);
  if (resolvedRenamed.ok) {
    assert.equal(resolvedRenamed.destination, 'work-phone');
    assert.equal(resolvedRenamed.connectionId, wRec.record.connectionId);
  }
  const afterRename = await mcpB.callTool({ name: 'notibuddy_notify', arguments: { title: 'After rename' } });
  assert.notEqual(afterRename.isError, true);
  assert.equal(JSON.parse((afterRename.content as any)[0].text).to, 'work-phone');

  // 9. Unpairing bound destination makes binding stale -> refuses (never follows new phone re-paired under same name)!
  store.forget('work-phone');
  const stale = resolveClientDestination('claude-code', root);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'stale_binding');
  const stalePhone = await makePhone('Replacement');
  await store.prepare('work-phone', stalePhone.bundle, 'Replacement Mac');
  const stillStale = resolveClientDestination('claude-code', root);
  assert.equal(stillStale.ok, false, 'Re-pairing a new phone under the same alias must NOT satisfy old connectionId');
  if (!stillStale.ok) assert.equal(stillStale.code, 'stale_binding');

  // 10. CLI `nb bind`, `nb unbind`, `nb unpair` orphan note, and `nb status --to` boundClients!
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const runCli = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NOTIBUDDY_HOME: root, NOTIBUDDY_NO_UPDATE_CHECK: '1' },
    });

  const bindRes = runCli(['bind', '--client', 'claude-code', '--client', 'cursor', '--to', 'personal']);
  assert.equal(bindRes.status, 0, bindRes.stderr);
  const bindJson = JSON.parse(bindRes.stdout);
  assert.equal(bindJson.destination, 'personal');
  assert.equal(bindJson.bindings.length, 2);
  assert.deepEqual(listClientBindings(root).map((b) => b.client), ['claude-code', 'cursor']);

  const listBind = runCli(['bind']);
  assert.equal(listBind.status, 0);
  assert.equal(JSON.parse(listBind.stdout).length, 2);

  const statusPersonal = runCli(['status', '--to', 'personal']);
  assert.equal(statusPersonal.status, 0);
  assert.deepEqual(JSON.parse(statusPersonal.stdout).boundClients, ['claude-code', 'cursor']);

  const unbindRes = runCli(['unbind', '--client', 'cursor']);
  assert.equal(unbindRes.status, 0);
  assert.deepEqual(JSON.parse(unbindRes.stdout), { unbound: ['cursor'], notFound: [] });

  const unpairRes = runCli(['unpair', '--to', 'personal']);
  assert.equal(unpairRes.status, 0);
  assert.match(unpairRes.stdout, /Orphaned client bindings: claude-code/);
  assert.equal(deleteClientBinding('claude-code', root), true);

  console.log('Client binding & MCP --client tests passed.');
} finally {
  globalThis.fetch = originalFetch;
  for (const c of openClients) await c.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
