import assert from 'node:assert/strict';
import { generateSenderSigningKeyPair } from '../src/crypto.js';
import { signSenderRegistration } from '../src/sender-registration.js';

const sender=await generateSenderSigningKeyPair();
const body=await signSenderRegistration({senderKeyId:sender.senderKeyId,senderPub:sender.publicKeyB64u,label:'Agent | test',mac:Buffer.alloc(32).toString('base64url')},'nb_snd_account',sender.privateKey);
// Check the wire contract with WebCrypto without importing the private relay.
const publicKey=await crypto.subtle.importKey('raw',Buffer.from(sender.publicKeyB64u,'base64url'),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
const verify=(realm:string, signedBody=body)=>crypto.subtle.verify(
  {name:'ECDSA',hash:'SHA-256'},publicKey,Buffer.from(body.sig,'base64url'),
  new TextEncoder().encode(JSON.stringify(['nb1','sender-registration',realm,signedBody.senderKeyId,
    signedBody.senderPub,signedBody.label,signedBody.mac,signedBody.createdAt,signedBody.nonce])));
assert.equal(await verify('account'),true);
assert.equal(await verify('other'),false);
assert.equal(await verify('account',{...body,mac:'B'.repeat(43)}),false);
assert.equal(await verify('account',{...body,label:'changed'}),false);
console.log('Sender registration signature contract passed.');
