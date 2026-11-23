import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NotiBuddyClient } from '../src/client.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair, hpkeOpen } from '../src/crypto.js';
import { PendingStore } from '../src/pending-store.js';
import { buildRequestHeader, sealReply } from '../src/protocol.js';
import { RESYNC_INTERVAL_MS, SenderStream } from '../src/sender-stream.js';
import type { NotiBuddyConfig, ReplyEnvelope, RequestEnvelope } from '../src/types.js';

function acceptWebSocketUpgrade(req: any, socket: any) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

const HAS_GLOBAL_WS = typeof (globalThis as any).WebSocket === 'function';

test(
  'NotiBuddyClient uses /v2/sender/ws stream to wake ask() immediately without 1s polling and reuses socket when keepAlive=true',
  { skip: HAS_GLOBAL_WS ? false : 'global WebSocket requires Node 21+' },
  async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-stream-test-'));
  const phoneEnc = await generateReplyKeyPair();
  const phoneSig = await generateSenderSigningKeyPair();
  const sender = await generateSenderSigningKeyPair();
  const answers = new Map<string, ReplyEnvelope & { seq: number }>();
  const sockets: any[] = [];
  let wsUpgrades = 0;
  let getCount = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/v1/requests') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const env = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestEnvelope;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requestId: env.requestId, seq: 1 }));

      const opened = JSON.parse(
        await hpkeOpen(
          phoneEnc.privateKey,
          env.enc,
          'notibuddy/v1/request',
          buildRequestHeader(env.requestId, env.deviceId, env.senderKeyId, env.primitive, env.createdAt, env.expiresAt),
          env.ct,
        ),
      );
      const reply = await sealReply({
        requestId: env.requestId,
        deviceId: await deriveDeviceId(phoneEnc.publicKeyB64u, phoneSig.publicKeyB64u),
        deviceSigningPrivateKey: phoneSig.privateKey,
        replyPublicKey: opened.replyPub,
        answer: { action: 'Approve' },
      });
      setTimeout(() => {
        answers.set(env.requestId, { ...reply, seq: 2 });
        for (const s of sockets) {
          s.write(encodeWsTextFrame(JSON.stringify({ type: 'reply.available', requestId: env.requestId, seq: 2 })));
        }
      }, 60).unref();
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/replies/')) {
      getCount++;
      const id = url.pathname.split('/').pop()!;
      const ans = answers.get(id);
      if (!ans) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ans));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    if (req.url === '/v2/sender/ws') {
      assert.equal(req.headers['x-sender-key-id'], sender.senderKeyId);
      assert.ok(typeof req.headers['x-sender-signature'] === 'string');
      wsUpgrades++;
      acceptWebSocketUpgrade(req, socket);
      sockets.push(socket);
      socket.write(encodeWsTextFrame(JSON.stringify({ type: 'ready', senderKeyId: sender.senderKeyId })));
      socket.on('data', (chunk: Buffer) => {
        if (chunk.length > 0 && (chunk[0] & 0x0f) === 0x08) {
          socket.end(Buffer.from([0x88, 0x00]));
        }
      });
      socket.on('close', () => {
        const idx = sockets.indexOf(socket);
        if (idx >= 0) sockets.splice(idx, 1);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  try {
    const config: NotiBuddyConfig = {
      relay: `http://127.0.0.1:${port}`,
      token: 'nb_snd_test',
      device: {
        id: await deriveDeviceId(phoneEnc.publicKeyB64u, phoneSig.publicKeyB64u),
        encPub: phoneEnc.publicKeyB64u,
        sigPub: phoneSig.publicKeyB64u,
      },
      senderKeyId: sender.senderKeyId,
      senderLabel: 'StreamTest',
    };

    const mcpClient = new NotiBuddyClient(config, sender.privateKey, new PendingStore(config, dir), undefined, undefined, {
      keepAlive: true,
    }, undefined, { activityUpdateDebounceMs: 0, dispatchPaceMs: 0 });

    const r1 = await mcpClient.ask({ title: 'First', options: ['Approve', 'Deny'], waitSeconds: 10 });
    assert.equal(r1.status, 'resolved');
    assert.equal(r1.answer?.action, 'Approve');
    assert.equal(wsUpgrades, 1);
    assert.equal(getCount, 2);

    const r2 = await mcpClient.ask({ title: 'Second', options: ['Approve', 'Deny'], waitSeconds: 10 });
    assert.equal(r2.status, 'resolved');
    assert.equal(wsUpgrades, 1, 'keepAlive=true reuses single persistent WebSocket');
    assert.equal(getCount, 4);
    mcpClient.close();

    // Non-keepAlive (CLI mode) closes the WebSocket after ask() resolves.
    const cliClient = new NotiBuddyClient(config, sender.privateKey, new PendingStore(config, dir));
    const r3 = await cliClient.ask({ title: 'Third', options: ['Approve', 'Deny'], waitSeconds: 10 });
    assert.equal(r3.status, 'resolved');
    assert.equal(wsUpgrades, 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sockets.length, 0);
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NotiBuddyClient falls back to adaptive polling when WebSocket upgrade is rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notibuddy-stream-fallback-'));
  const phoneEnc = await generateReplyKeyPair();
  const phoneSig = await generateSenderSigningKeyPair();
  const sender = await generateSenderSigningKeyPair();
  const answers = new Map<string, ReplyEnvelope & { seq: number }>();
  let getCount = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/v1/requests') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const env = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestEnvelope;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requestId: env.requestId, seq: 1 }));

      const opened = JSON.parse(
        await hpkeOpen(
          phoneEnc.privateKey,
          env.enc,
          'notibuddy/v1/request',
          buildRequestHeader(env.requestId, env.deviceId, env.senderKeyId, env.primitive, env.createdAt, env.expiresAt),
          env.ct,
        ),
      );
      const reply = await sealReply({
        requestId: env.requestId,
        deviceId: await deriveDeviceId(phoneEnc.publicKeyB64u, phoneSig.publicKeyB64u),
        deviceSigningPrivateKey: phoneSig.privateKey,
        replyPublicKey: opened.replyPub,
        answer: { action: 'Deny' },
      });
      setTimeout(() => {
        answers.set(env.requestId, { ...reply, seq: 2 });
      }, 200).unref();
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/replies/')) {
      getCount++;
      const id = url.pathname.split('/').pop()!;
      const ans = answers.get(id);
      if (!ans) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ans));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  try {
    const config: NotiBuddyConfig = {
      relay: `http://127.0.0.1:${port}`,
      token: 'nb_snd_test',
      device: {
        id: await deriveDeviceId(phoneEnc.publicKeyB64u, phoneSig.publicKeyB64u),
        encPub: phoneEnc.publicKeyB64u,
        sigPub: phoneSig.publicKeyB64u,
      },
      senderKeyId: sender.senderKeyId,
      senderLabel: 'FallbackTest',
    };
    const client = new NotiBuddyClient(config, sender.privateKey, new PendingStore(config, dir));
    const result = await client.ask({ title: 'Fallback', options: ['Approve', 'Deny'], waitSeconds: 5 });
    assert.equal(result.status, 'resolved');
    assert.equal(result.answer?.action, 'Deny');
    assert.equal(getCount, 2);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'SenderStream defaults connected safety resync to 90s while preserving custom resyncMs overrides and immediate disconnect resync',
  { skip: HAS_GLOBAL_WS ? false : 'global WebSocket requires Node 21+' },
  async () => {
    assert.equal(RESYNC_INTERVAL_MS, 90_000);

    const phoneEnc = await generateReplyKeyPair();
    const phoneSig = await generateSenderSigningKeyPair();
    const sender = await generateSenderSigningKeyPair();
    const sockets: any[] = [];
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on('upgrade', (req, socket) => {
      if (req.url === '/v2/sender/ws') {
        acceptWebSocketUpgrade(req, socket);
        sockets.push(socket);
        socket.write(encodeWsTextFrame(JSON.stringify({ type: 'ready', senderKeyId: sender.senderKeyId })));
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    try {
      const config: NotiBuddyConfig = {
        relay: `http://127.0.0.1:${port}`,
        token: 'nb_snd_test',
        device: {
          id: await deriveDeviceId(phoneEnc.publicKeyB64u, phoneSig.publicKeyB64u),
          encPub: phoneEnc.publicKeyB64u,
          sigPub: phoneSig.publicKeyB64u,
        },
        senderKeyId: sender.senderKeyId,
        senderLabel: 'ResyncTest',
      };
      const stream = new SenderStream(config, sender.privateKey, true);
      try {
        const resyncOutcome = await stream.waitForReply('req_resync', Date.now() + 5_000, {}, 40);
        assert.equal(resyncOutcome, 'resync');
        assert.equal(stream.isConnected, true);

        // Closing the server socket wakes the waiter immediately with 'fallback' so ask() resyncs on reconnect.
        const disconnectWait = stream.waitForReply('req_disconnect', Date.now() + 5_000);
        setTimeout(() => {
          for (const s of sockets) s.destroy();
        }, 30).unref();
        const disconnectOutcome = await disconnectWait;
        assert.equal(disconnectOutcome, 'fallback');
      } finally {
        stream.close();
      }
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  },
);
