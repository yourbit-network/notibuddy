import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NOTIBUDDY_NO_UPDATE_CHECK='1';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { DestinationStore } from '../src/config.js';
import { relayJSON, RelayHTTPError, httpSigningInput, httpSigningAccount } from '../src/client-http.js';
import { accountIdOf, bindCredentials, CredentialRecoveryError } from '../src/credential-recovery.js';
import { FileInbox } from '../src/files.js';
import { PendingStore } from '../src/pending-store.js';
import { RecipientStore } from '../src/recipient-store.js';
import { parsePairingBundle } from '../src/protocol.js';
import { validateFirstUse } from '../src/pairing-invitation.js';
import { deriveDeviceId, ecdsaSign, ecdsaVerify, generateReplyKeyPair, generateSenderSigningKeyPair, hpkeSealBytes, sha256, toB64u, toHex } from '../src/crypto.js';
import type { NotiBuddyConfig } from '../src/types.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const oldToken='nb_snd_'+randomUUID();
const epochTokenOf=(accountId:string,secret:Uint8Array)=>`nb_snd_${accountId}.${toB64u(secret)}`;
type Call={path:string;method:string;authorization:string;headers:Headers};
interface Fake {
  calls:Call[];credentialCalls:()=>Call[];other:()=>Call[];
  /** What the relay currently accepts. */ accepted:string;
  credentials:(call:Call)=>Response|Promise<Response>;
  forced?:()=>Response|undefined;
}

async function fixture(run:(f:any)=>Promise<void>,token=oldToken) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nb-credential-rotation-')),original=globalThis.fetch;
  try {
    const enc=await generateReplyKeyPair(),phone=await generateSenderSigningKeyPair();
    const device={id:await deriveDeviceId(enc.publicKeyB64u,phone.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:phone.publicKeyB64u};
    const bundle={v:1 as const,relay:'https://relay.test',token,pairSecret:Buffer.alloc(32).toString('base64url'),device};
    const store=new DestinationStore(root);
    const opened=await store.prepare('phone',bundle,'Sender');
    const secrets=new Map<number,Uint8Array>();
    const secretFor=(epoch:number)=>{if(!secrets.has(epoch))secrets.set(epoch,randomBytes(32));return secrets.get(epoch)!;};
    /** The phone's sealed record for `epoch`; options corrupt one binding at a time. */
    const record=async(epoch:number,cfg:NotiBuddyConfig,o:{signer?:CryptoKey;hashOf?:string;aadEpoch?:number;deviceId?:string}={})=>{
      const secret=secretFor(epoch),accountId=accountIdOf(cfg.token),senderKeyId=cfg.senderKeyId;
      const aad=`nb2|sender-credentials|${accountId}|${device.id}|${senderKeyId}|${o.aadEpoch ?? epoch}`;
      const sealed=await hpkeSealBytes(opened.record.keys.publicKeyB64u,'notibuddy/v2/sender-credentials',aad,secret);
      const epochHash=o.hashOf ?? toHex(await sha256(secret));
      const joined=Buffer.concat([Buffer.from(sealed.enc,'base64url'),Buffer.from(sealed.ct)]);
      const input=new TextEncoder().encode(`nb2|sender-credentials|${accountId}|${device.id}|${senderKeyId}|${epoch}|${epochHash}|${hash(joined)}`);
      const sig=await ecdsaSign(o.signer ?? phone.privateKey,input);
      return {v:1,epoch,deviceId:o.deviceId ?? device.id,record:{enc:sealed.enc,ct:toB64u(sealed.ct),sig}};
    };
    const tokenFor=(epoch:number,cfg:NotiBuddyConfig)=>epochTokenOf(accountIdOf(cfg.token),secretFor(epoch));
    const calls:Call[]=[];
    const fake:Fake={calls,credentialCalls:()=>calls.filter(c=>c.path==='/v1/sender/credentials'),other:()=>calls.filter(c=>c.path!=='/v1/sender/credentials'),
      accepted:'',credentials:()=>Response.json({code:'SENDER_NOT_FOUND'},{status:404})};
    globalThis.fetch=async(url,init)=>{
      const headers=new Headers(init?.headers),call={path:new URL(String(url)).pathname,method:init?.method ?? 'GET',authorization:headers.get('Authorization') ?? '',headers};
      calls.push(call);
      if(call.path==='/v1/sender/credentials')return fake.credentials(call);
      const forced=fake.forced?.();if(forced)return forced;
      if(call.authorization!==`Bearer ${fake.accepted}`)return Response.json({code:'CREDENTIAL_ROTATED'},{status:409});
      return call.path==='/v1/files'?Response.json({files:[]}):Response.json({ok:true});
    };
    const bind=async()=>{
      const {record:r,signingKey}=await store.open('phone'),config=structuredClone(r.config);
      bindCredentials(config,{store,name:'phone',signingKey});return config;
    };
    const file=path.join(root,'destinations','phone.json');
    await run({root,store,phone,device,opened,record,tokenFor,fake,calls,bind,file,
      post:(config:NotiBuddyConfig)=>relayJSON(config,'/v1/ping',{method:'POST',body:'{}'}),
      stored:()=>store.read('phone').config});
  } finally {globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
}
const respond=(f:any,epoch:number,cfg:NotiBuddyConfig,o?:any)=>async()=>Response.json(await f.record(epoch,cfg,o));

test('409 then a valid epoch-1 record: one fetch, retry with the epoch token, persisted before use, signed by nb2|http',()=>fixture(async f=>{
  const config=await f.bind();
  f.fake.accepted=f.tokenFor(1,config);f.fake.credentials=respond(f,1,config);
  assert.deepEqual((await f.post(config)).body,{ok:true});
  assert.equal(f.fake.credentialCalls().length,1);
  assert.equal(f.fake.other().length,2);
  assert.equal(f.fake.other()[1].authorization,`Bearer ${f.fake.accepted}`);
  assert.equal(f.stored().token,f.fake.accepted);assert.equal(f.stored().credentialEpoch,1);assert.equal(f.stored().pairingToken,oldToken);
  assert.equal(config.token,f.fake.accepted);assert.equal(config.credentialEpoch,1);assert.equal(config.pairingToken,oldToken);
  const call=f.fake.credentialCalls()[0],h=call.headers;
  assert.equal(call.authorization,`Bearer ${oldToken}`);
  const input=httpSigningInput(oldToken,'GET','/sender/credentials',h.get('X-Sender-Timestamp'),h.get('X-Sender-Nonce'),hash(''));
  assert.ok(new TextDecoder().decode(input).startsWith(`nb2|http|${accountIdOf(oldToken)}|GET|`));
  assert.ok(await ecdsaVerify(f.opened.record.keys.publicKeyB64u,input,h.get('X-Sender-Signature')));
  // The epoch token now names its embedded account in later signatures.
  assert.equal(httpSigningAccount(f.fake.accepted),accountIdOf(oldToken));
}));

for(const [label,corrupt] of [
  ['a bad signature',(f:any)=>({signer:f.otherSigner})],
  ['a signature over a different epochHash',()=>({hashOf:'0'.repeat(64)})],
  ['the wrong aad',()=>({aadEpoch:7})],
  ['the wrong deviceId',()=>({deviceId:'dev_'+'0'.repeat(24)})],
] as const) test(`${label} is a CredentialRecoveryError: store byte-identical, no retry`,()=>fixture(async f=>{
  f.otherSigner=(await generateSenderSigningKeyPair()).privateKey;
  const config=await f.bind(),before=fs.readFileSync(f.file);
  f.fake.credentials=respond(f,1,config,corrupt(f));
  await assert.rejects(f.post(config),(e:any)=>e instanceof CredentialRecoveryError && e.message===
    "This computer's NotiBuddy credentials were rotated on the phone and could not be refreshed. Pair again: in NotiBuddy on the phone add this computer, then run: nb pair --to phone");
  assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.fake.other().length,1);assert.equal(config.token,oldToken);
}));

test('a legacy stored token with the relay at epoch 3 recovers in one fetch',()=>fixture(async f=>{
  const config=await f.bind();
  f.fake.accepted=f.tokenFor(3,config);f.fake.credentials=respond(f,3,config);
  await f.post(config);
  assert.equal(f.fake.credentialCalls().length,1);assert.equal(f.stored().credentialEpoch,3);assert.equal(f.stored().token,f.fake.accepted);
}));

for(const epoch of [2,1]) test(`stored epoch 2 rejects a record at epoch ${epoch}`,()=>fixture(async f=>{
  const first=await f.bind();
  await f.store.rotateCredentials('phone',{senderKeyId:first.senderKeyId,token:f.tokenFor(2,first),epoch:2});
  const config=await f.bind(),before=fs.readFileSync(f.file);
  assert.equal(config.credentialEpoch,2);
  f.fake.credentials=respond(f,epoch,config);
  await assert.rejects(f.post(config),CredentialRecoveryError);
  assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.fake.other().length,1);
}));

test('the store write never lowers or repeats an epoch and refuses another sender key',()=>fixture(async f=>{
  const config=await f.bind(),next=(epoch:number,token:string)=>({senderKeyId:config.senderKeyId,token,epoch});
  await f.store.rotateCredentials('phone',next(2,f.tokenFor(2,config)));
  const stored=fs.readFileSync(f.file);
  assert.equal((await f.store.rotateCredentials('phone',next(1,f.tokenFor(1,config)))).config.credentialEpoch,2);
  assert.equal((await f.store.rotateCredentials('phone',next(2,f.tokenFor(1,config)))).config.token,f.tokenFor(2,config));
  assert.deepEqual(fs.readFileSync(f.file),stored);
  await assert.rejects(f.store.rotateCredentials('phone',{...next(3,f.tokenFor(3,config)),senderKeyId:'snd_'+'0'.repeat(24)}));
}));

test('two bound configs from one store hit 409 together: both succeed, one write, one token',()=>fixture(async f=>{
  const a=await f.bind(),b=await f.bind();
  f.fake.accepted=f.tokenFor(1,a);f.fake.credentials=respond(f,1,a);
  const target=path.join(f.root,'destinations','phone.json'),originalRename=fs.renameSync;let writes=0;
  fs.renameSync=((from:any,to:any)=>{if(String(to)===target)writes++;return originalRename(from,to);}) as typeof fs.renameSync;
  try{await Promise.all([f.post(a),f.post(b)]);}finally{fs.renameSync=originalRename;}
  assert.equal(writes,1);assert.equal(a.token,f.fake.accepted);assert.equal(b.token,f.fake.accepted);
  assert.equal(f.stored().token,f.fake.accepted);
}));

test('concurrent recovery on one config performs one credentials fetch',()=>fixture(async f=>{
  const config=await f.bind();
  f.fake.accepted=f.tokenFor(1,config);f.fake.credentials=respond(f,1,config);
  await Promise.all([f.post(config),f.post(config),f.post(config)]);
  assert.equal(f.fake.credentialCalls().length,1);
}));

test('a second config adopts the stored higher epoch: from the store reread, and from a 404',()=>fixture(async f=>{
  const a=await f.bind(),b=await f.bind(),c=await f.bind();
  f.fake.accepted=f.tokenFor(1,a);f.fake.credentials=respond(f,1,a);
  await f.post(a);
  const fetches=f.fake.credentialCalls().length;
  await f.post(b);
  assert.equal(f.fake.credentialCalls().length,fetches,'adopted from the store without a fetch');
  assert.equal(b.token,f.fake.accepted);
  // c read the store before a rotated it, then the relay answers 404 because a already replaced the record.
  const stale=await f.bind();
  await f.store.rotateCredentials('phone',{senderKeyId:stale.senderKeyId,token:f.tokenFor(2,stale),epoch:2});
  f.fake.accepted=f.tokenFor(2,stale);
  const fresh=structuredClone(c);bindCredentials(fresh,{store:f.store,name:'phone',signingKey:(await f.store.open('phone')).signingKey});
  fresh.token=oldToken;delete fresh.credentialEpoch;
  f.fake.credentials=async()=>Response.json({code:'SENDER_NOT_FOUND'},{status:404});
  await f.post(fresh);
  assert.equal(fresh.token,f.fake.accepted);assert.equal(fresh.credentialEpoch,2);
}));

test('a 404 with no higher stored epoch is a CredentialRecoveryError',()=>fixture(async f=>{
  const config=await f.bind();
  await assert.rejects(f.post(config),CredentialRecoveryError);
}));

test('a destination re-paired under another sender key is neither adopted nor opened',()=>fixture(async f=>{
  const config=await f.bind();
  // Simulate a re-pair: the stored record now names a different sender key, at a higher epoch.
  const other=JSON.parse(fs.readFileSync(f.file,'utf8'));
  other.config.senderKeyId=other.keys.senderKeyId='snd_'+'0'.repeat(24);other.config.credentialEpoch=5;
  fs.writeFileSync(f.file,JSON.stringify(other,null,2)+'\n');
  const before=fs.readFileSync(f.file);
  await assert.rejects(f.post(config),CredentialRecoveryError);
  assert.equal(f.fake.credentialCalls().length,0);
  assert.notEqual(config.credentialEpoch,5);
  assert.deepEqual(fs.readFileSync(f.file),before);
}));

test('a 401 on the credentials fetch is a CredentialRecoveryError',()=>fixture(async f=>{
  const config=await f.bind(),before=fs.readFileSync(f.file);
  f.fake.credentials=()=>Response.json({code:'SENDER_REVOKED'},{status:401});
  await assert.rejects(f.post(config),CredentialRecoveryError);
  assert.deepEqual(fs.readFileSync(f.file),before);
}));

test('a second 409 propagates after exactly two request attempts',()=>fixture(async f=>{
  const config=await f.bind();
  f.fake.accepted='never';f.fake.credentials=respond(f,1,config);
  await assert.rejects(f.post(config),(e:any)=>e instanceof RelayHTTPError && e.status===409 && e.code==='CREDENTIAL_ROTATED');
  assert.equal(f.fake.other().length,2);assert.equal(f.fake.credentialCalls().length,1);
}));

test('a network failure on the credentials fetch propagates, changes nothing and a later call recovers',()=>fixture(async f=>{
  const config=await f.bind(),before=fs.readFileSync(f.file);
  f.fake.accepted=f.tokenFor(1,config);
  f.fake.credentials=()=>{throw new TypeError('offline');};
  await assert.rejects(f.post(config),(e:any)=>e instanceof TypeError && e.message==='offline');
  assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(config.token,oldToken);
  f.fake.credentials=respond(f,1,config);
  assert.deepEqual((await f.post(config)).body,{ok:true});assert.equal(f.stored().credentialEpoch,1);
}));

test('other 409 codes, a 500, an unbound config and the credentials route itself never recover',()=>fixture(async f=>{
  const config=await f.bind();
  f.fake.forced=()=>Response.json({code:'REQUEST_ID_CONFLICT'},{status:409});
  await assert.rejects(f.post(config),(e:any)=>e.status===409 && e.code==='REQUEST_ID_CONFLICT');
  f.fake.forced=()=>Response.json({code:'BOOM'},{status:500});
  await assert.rejects(f.post(config),(e:any)=>e.status===500);
  f.fake.forced=undefined;
  const {record}=await f.store.open('phone'),unbound=structuredClone(record.config);
  await assert.rejects(relayJSON(unbound,'/v1/ping',{method:'POST',body:'{}'}),(e:any)=>e instanceof RelayHTTPError && e.code==='CREDENTIAL_ROTATED');
  f.fake.credentials=()=>Response.json({code:'CREDENTIAL_ROTATED'},{status:409});
  await assert.rejects(relayJSON(config,'/v1/sender/credentials',{},{},(await f.store.open('phone')).signingKey),(e:any)=>e.code==='CREDENTIAL_ROTATED');
  assert.equal(f.fake.credentialCalls().length,1,'only the explicit call to the credentials route');
}));

test('storage scopes are unchanged after a rotation',()=>fixture(async f=>{
  const config=await f.bind(),before={pending:(new PendingStore(config,f.root) as any).directory,recipients:(new RecipientStore(config,f.root) as any).file,
    inbox:new FileInbox(f.opened.record,f.opened.signingKey,f.root).directory};
  f.fake.accepted=f.tokenFor(1,config);f.fake.credentials=respond(f,1,config);
  await f.post(config);
  const reopened=(await f.store.open('phone')).record;
  for(const c of [config,reopened.config])assert.equal((new PendingStore(c,f.root) as any).directory,before.pending);
  for(const c of [config,reopened.config])assert.equal((new RecipientStore(c,f.root) as any).file,before.recipients);
  assert.equal(new FileInbox(reopened,f.opened.signingKey,f.root).directory,before.inbox);
  // A re-pair with the original bundle token still matches the rotated destination.
  const again=await f.store.prepare('phone',{v:1,relay:'https://relay.test',token:oldToken,pairSecret:Buffer.alloc(32).toString('base64url'),device:f.device},'Sender');
  assert.equal(again.record.config.credentialEpoch,1);
}));

test('FileInbox recovers from a 409 and retries once; an unbound inbox does not',()=>fixture(async f=>{
  const {record,signingKey}=await f.store.open('phone'),inbox=new FileInbox(record,signingKey,f.root,{store:f.store,name:'phone'});
  f.fake.accepted=f.tokenFor(1,record.config);f.fake.credentials=respond(f,1,record.config);
  assert.deepEqual(await inbox.list(),[]);
  assert.equal(f.fake.credentialCalls().length,1);assert.equal(f.fake.calls.filter((c:Call)=>c.path==='/v1/files').length,2);
  assert.equal(f.stored().credentialEpoch,1);
  const plain=(await f.store.open('phone')).record;plain.config.token=oldToken;
  await assert.rejects(new FileInbox(plain,signingKey,f.root).list());
  assert.equal(f.fake.credentialCalls().length,1);
}));

test('accountIdOf: epoch tokens carry their account, legacy tokens hash their secret',()=>{
  const account='0123456789abcdef0123456789abcdef',epoch=`nb_snd_${account}.${'A'.repeat(43)}`;
  assert.equal(accountIdOf(epoch),account);assert.equal(httpSigningAccount(epoch),account);
  assert.equal(accountIdOf('nb_snd_abc'),'ba7816bf8f01cfea414140de5dae2223');
  assert.equal(httpSigningAccount('nb_snd_abc'),'ba7816bf8f01cfea414140de5dae2223');
  assert.equal(accountIdOf(`nb_snd_${account}.${'A'.repeat(42)}`),hash(`${account}.${'A'.repeat(42)}`).slice(0,32));
});

test('pairing accepts an epoch token: bundle, first-use account binding, malformed shape',async()=>{
  const account='0123456789abcdef0123456789abcdef',token=`nb_snd_${account}.${toB64u(randomBytes(32))}`;
  const enc=await generateReplyKeyPair(),sig=await generateSenderSigningKeyPair(),now=Date.now(),key=createECDH('prime256v1');key.generateKeys();
  const scalar=key.getPrivateKey(),device={id:await deriveDeviceId(enc.publicKeyB64u,sig.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:sig.publicKeyB64u};
  const firstUse=(accountId:string)=>({privateKey:Buffer.concat([Buffer.alloc(32-scalar.length),scalar]).toString('base64url'),invitation:{
    v:1,id:'pin_'+hash(key.getPublicKey()).slice(0,32),accountId,deviceId:device.id,devicePub:device.sigPub,relay:'https://relay.example.test',
    publicKey:key.getPublicKey().toString('base64url'),createdAt:now,expiresAt:now+600_000}});
  const bundle=(t:string,accountId=account)=>({v:1,relay:'https://relay.example.test',token:t,pairSecret:Buffer.alloc(32).toString('base64url'),device,requestProtocol:2,minimumRecipientGeneration:0,firstUse:firstUse(accountId)});
  const encode=(v:unknown)=>'nbpair1.'+Buffer.from(JSON.stringify(v)).toString('base64url');
  assert.equal((await parsePairingBundle(encode(bundle(token)))).token,token);
  assert.deepEqual(validateFirstUse(firstUse(account),{relay:'https://relay.example.test',token,device},now).invitation.accountId,account);
  assert.throws(()=>validateFirstUse(firstUse(hash(token.slice(7)).slice(0,32)),{relay:'https://relay.example.test',token,device},now));
  for(const bad of [`nb_snd_${account}.${'A'.repeat(42)}`,`nb_snd_${account.toUpperCase()}.${'A'.repeat(43)}`,`nb_snd_${account}.${'A'.repeat(43)}.x`])
    await assert.rejects(parsePairingBundle(encode(bundle(bad))));
});
