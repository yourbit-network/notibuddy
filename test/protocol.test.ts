import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  deriveDeviceId,
  deriveSenderKeyId,
  computePairingMac,
  generateReplyKeyPair,
  generateSenderSigningKeyPair,
  importEcdsaPublicKey,
  ecdsaSign,
  ecdsaVerify,
  hpkeSeal,
  hpkeOpen,
} from '../src/crypto.js';
import {
  sealRequest,
  sealReply,
  openReply,
  openError,
  parsePairingBundle,
} from '../src/protocol.js';
import {
  AskPayload,
  AnswerPayload,
  ErrorEnvelope,
} from '../src/types.js';

async function runTests() {
  console.log('🧪 Starting NotiBuddy Protocol v1 Test Suite...\n');

  // 1. Key generation & derivation
  console.log('1️⃣ Testing Device & Sender ID derivation...');
  const devKa = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const devSign = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

  const dePubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', devKa.publicKey));
  const dsPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', devSign.publicKey));

  const encPubB64u = Buffer.from(dePubBytes).toString('base64url');
  const sigPubB64u = Buffer.from(dsPubBytes).toString('base64url');

  const deviceId = await deriveDeviceId(encPubB64u, sigPubB64u);
  assert.ok(deviceId.startsWith('dev_'), 'Device ID must start with dev_');
  assert.equal(deviceId.length, 28, 'Device ID length must be 4 + 24 = 28');
  console.log(`   ✅ Derived deviceId: ${deviceId}`);

  const senderKp = await generateSenderSigningKeyPair();
  assert.ok(senderKp.senderKeyId.startsWith('snd_'), 'Sender ID must start with snd_');
  assert.equal(senderKp.senderKeyId.length, 28, 'Sender ID length must be 4 + 24 = 28');
  console.log(`   ✅ Derived senderKeyId: ${senderKp.senderKeyId}`);

  // 2. Pairing MAC & Bundle validation
  console.log('\n2️⃣ Testing Pairing Bundle parsing and MAC verification...');
  const pairSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const bundleObj = {
    v: 1,
    relay: 'https://relay.notibuddy.test',
    token: 'nb_snd_live_testtoken123',
    device: {
      id: deviceId,
      encPub: encPubB64u,
      sigPub: sigPubB64u,
      name: "Test iPhone",
    },
    pairSecret,
  };

  const bundleB64u = Buffer.from(JSON.stringify(bundleObj)).toString('base64url');
  const bundleStr = `nbpair1.${bundleB64u}`;

  const parsed = await parsePairingBundle(bundleStr);
  assert.equal(parsed.device.id, deviceId);
  assert.equal(parsed.pairSecret, pairSecret);

  const mac = await computePairingMac(
    pairSecret,
    deviceId,
    senderKp.senderKeyId,
    senderKp.publicKeyB64u,
    'agent@macbook'
  );
  assert.ok(mac.length > 30, 'MAC must be non-empty base64url string');
  console.log('   ✅ Pairing bundle validated and HMAC-SHA256 computed.');

  // 3. Request sealing and HPKE encryption
  console.log('\n3️⃣ Testing Request Envelope sealing (Sender -> Device)...');
  const replyKp = await generateReplyKeyPair();
  const askPayload: AskPayload = {
    type: 'ask',
    replyPub: replyKp.publicKeyB64u,
    title: 'Deploy to Production?',
    message: 'Claude Code requests authorization to deploy v1.0.0.',
    options: ['Approve', 'Deny'],
    requiresAuth: true,
  };

  const reqEnvelope = await sealRequest({
    requestId: 'req_0192837465',
    deviceId,
    senderKeyId: senderKp.senderKeyId,
    senderSigningPrivateKey: senderKp.privateKey,
    deviceEncryptionPublicKey: encPubB64u,
    primitive: 'approval',
    payload: askPayload,
    timeoutSeconds: 300,
  });

  assert.equal(reqEnvelope.v, 1);
  assert.equal(reqEnvelope.kind, 'request');
  assert.equal(reqEnvelope.requestId, 'req_0192837465');
  assert.ok(reqEnvelope.enc.length > 50, 'enc must be present');
  assert.ok(reqEnvelope.ct.length > 50, 'ct must be present');
  assert.ok(reqEnvelope.sig.length > 50, 'sig must be present');

  // Verify sender signature on device side
  const header = `nb1|request|${reqEnvelope.requestId}|${deviceId}|${senderKp.senderKeyId}|approval|${reqEnvelope.createdAt}|${reqEnvelope.expiresAt}`;
  const headerBytes = new TextEncoder().encode(header);
  const encBytes = Buffer.from(reqEnvelope.enc, 'base64url');
  const ctBytes = Buffer.from(reqEnvelope.ct, 'base64url');

  const signBuffer = new Uint8Array(headerBytes.length + 1 + encBytes.length + ctBytes.length);
  signBuffer.set(headerBytes, 0);
  signBuffer[headerBytes.length] = 0x00;
  signBuffer.set(encBytes, headerBytes.length + 1);
  signBuffer.set(ctBytes, headerBytes.length + 1 + encBytes.length);

  const sigValid = await ecdsaVerify(senderKp.publicKeyB64u, signBuffer, reqEnvelope.sig);
  assert.ok(sigValid, 'Sender signature on request must verify');

  // Device opens HPKE
  const decryptedReqJson = await hpkeOpen(
    devKa.privateKey,
    reqEnvelope.enc,
    'notibuddy/v1/request',
    header,
    reqEnvelope.ct
  );
  const decryptedReq = JSON.parse(decryptedReqJson) as AskPayload;
  assert.equal(decryptedReq.title, askPayload.title);
  assert.equal(decryptedReq.replyPub, replyKp.publicKeyB64u);
  console.log('   ✅ Request envelope sealed and decrypted successfully with valid signature.');

  // 4. Reply sealing and opening (Device -> Sender)
  console.log('\n4️⃣ Testing Reply Envelope sealing (Device -> Sender)...');
  const answer: AnswerPayload = {
    action: 'Approve',
    authenticated: true,
  };

  const replyEnvelope = await sealReply({
    requestId: reqEnvelope.requestId,
    deviceId,
    deviceSigningPrivateKey: devSign.privateKey,
    replyPublicKey: replyKp.publicKeyB64u,
    answer,
  });

  assert.equal(replyEnvelope.v, 1);
  assert.equal(replyEnvelope.kind, 'reply');

  // Sender opens reply
  const openedAnswer = await openReply({
    envelope: replyEnvelope,
    replyPrivateKey: replyKp.privateKey,
    expectedDeviceId: deviceId,
    deviceSigningPublicKey: sigPubB64u,
  });

  assert.equal(openedAnswer.action, 'Approve');
  assert.equal(openedAnswer.authenticated, true);
  console.log('   ✅ Reply envelope verified with hardware signature and decrypted successfully.');

  // 5. Tamper resistance
  console.log('\n5️⃣ Testing Tamper Resistance (rejecting forged/modified envelopes)...');
  const tamperedReply = { ...replyEnvelope, ct: replyEnvelope.ct.slice(0, -4) + 'AAAA' };
  await assert.rejects(
    async () => {
      await openReply({
        envelope: tamperedReply,
        replyPrivateKey: replyKp.privateKey,
        expectedDeviceId: deviceId,
        deviceSigningPublicKey: sigPubB64u,
      });
    },
    /Device signature verification failed/,
    'Tampered ciphertext must fail signature verification'
  );

  const fakeSigReply = { ...replyEnvelope, sig: Buffer.from(new Uint8Array(64)).toString('base64url') };
  await assert.rejects(
    async () => {
      await openReply({
        envelope: fakeSigReply,
        replyPrivateKey: replyKp.privateKey,
        expectedDeviceId: deviceId,
        deviceSigningPublicKey: sigPubB64u,
      });
    },
    /Device signature verification failed/,
    'Forged signature must be rejected'
  );
  console.log('   ✅ Tampered and forged envelopes safely rejected.');

  // 6. Error envelope
  console.log('\n6️⃣ Testing Error Envelope...');
  const errorHeader = `nb1|error|${reqEnvelope.requestId}|${deviceId}|${Math.floor(Date.now() / 1000)}|bad_signature`;
  const errHeaderBytes = new TextEncoder().encode(errorHeader);
  const errSignBuffer = new Uint8Array(errHeaderBytes.length + 1);
  errSignBuffer.set(errHeaderBytes, 0);
  errSignBuffer[errHeaderBytes.length] = 0x00;

  const errSig = await ecdsaSign(devSign.privateKey, errSignBuffer);
  const errorEnv: ErrorEnvelope = {
    v: 1,
    kind: 'error',
    requestId: reqEnvelope.requestId,
    deviceId,
    createdAt: Math.floor(Date.now() / 1000),
    code: 'bad_signature',
    sig: errSig,
  };

  const errCode = await openError({
    envelope: errorEnv,
    expectedDeviceId: deviceId,
    deviceSigningPublicKey: sigPubB64u,
  });
  assert.equal(errCode, 'bad_signature');
  console.log('   ✅ Error envelope verified successfully.');

  // Regenerate the checked-in interoperability fixture only on explicit request.
  if (process.env.NOTIBUDDY_WRITE_TEST_VECTORS === '1') {
  // 7. Write test-vectors/v1.json
  console.log('\n7️⃣ Generating test-vectors/v1.json...');
  const vectorsDir = path.join(process.cwd(), 'test-vectors');
  if (!fs.existsSync(vectorsDir)) {
    fs.mkdirSync(vectorsDir, { recursive: true });
  }

  const vectors = {
    version: 1,
    description: 'NotiBuddy Protocol v1 Test Vectors (TypeScript reference implementation)',
    keys: {
      device: {
        id: deviceId,
        encryptionPublicKey: encPubB64u,
        encryptionPrivateKeyForTesting: (await crypto.subtle.exportKey('jwk', devKa.privateKey)).d,
        signingPublicKey: sigPubB64u,
      },
      sender: {
        id: senderKp.senderKeyId,
        signingPublicKey: senderKp.publicKeyB64u,
      },
      reply: {
        publicKey: replyKp.publicKeyB64u,
      },
    },
    pairing: {
      pairSecret,
      bundle: bundleStr,
      mac,
    },
    requestEnvelope: reqEnvelope,
    replyEnvelope,
  };

  fs.writeFileSync(
    path.join(vectorsDir, 'v1.json'),
    JSON.stringify(vectors, null, 2) + '\n'
  );
  console.log('   ✅ Written test-vectors/v1.json.');

  }

  console.log('\n🎉 ALL PROTOCOL V1 TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
