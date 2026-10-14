import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair, ecdsaSign, ecdsaVerify, hpkeOpen, hpkeSeal, sha256, toHex, toB64u } from '../src/crypto.js';
import { companionGrantInput, type CompanionGrant } from '../src/companion-grant.js';
import { groupDeliveryHeader, groupDeliveryInput, groupResponseHeader, groupResponseInput, type GroupRequest, type GroupResponse } from '../src/group-wire.js';
import { verifyRecipients, sealGroupRequest, openGroupResponse } from '../src/groups.js';
import { RecipientStore } from '../src/recipient-store.js';
import type { NotiBuddyConfig } from '../src/types.js';

async function device() {
  const signing=await generateSenderSigningKeyPair(),encryption=await generateReplyKeyPair();
  return {deviceId:await deriveDeviceId(encryption.publicKeyB64u,signing.publicKeyB64u),encPub:encryption.publicKeyB64u,sigPub:signing.publicKeyB64u,
    signingKey:signing.privateKey,encryptionKey:encryption.privateKey};
}
async function fixture() {
  const primary=await device(),watch=await device(),sender=await generateSenderSigningKeyPair(),reply=await generateReplyKeyPair(),realm=randomUUID();
  const config:NotiBuddyConfig={relay:'https://relay.notibuddy.test',token:'nb_snd_'+realm,
    device:{id:primary.deviceId,encPub:primary.encPub,sigPub:primary.sigPub},senderKeyId:sender.senderKeyId,senderLabel:'Fixture sender'};
  const grant:CompanionGrant={v:1,accountId:toHex(await sha256(new TextEncoder().encode(realm))).slice(0,32),
    parentDeviceId:primary.deviceId,deviceId:watch.deviceId,encPub:watch.encPub,sigPub:watch.sigPub,
    credentialHash:'0'.repeat(64),capabilities:['approval','text_input','timer_control'],generation:2,
    nonce:toB64u(crypto.getRandomValues(new Uint8Array(32))),expiresAt:1};
  const proof={grant,parentSignature:await ecdsaSign(primary.signingKey,companionGrantInput(grant,'parent')),
    childSignature:await ecdsaSign(watch.signingKey,companionGrantInput(grant,'child'))};
  const manifest={v:2,deviceId:primary.deviceId,generation:2,primary:{deviceId:primary.deviceId,encPub:primary.encPub,sigPub:primary.sigPub},companions:[proof]};
  const recipients=await verifyRecipients(manifest,config);
  const payload={type:'ask' as const,title:'Approve release?',replyPub:reply.publicKeyB64u,requiresAuth:true};
  const request=await sealGroupRequest({requestId:'req_'+randomUUID(),senderKeyId:sender.senderKeyId,signingKey:sender.privateKey,recipients,primitive:'approval',payload});
  const response=async(actor=watch,q:GroupRequest=request,answer:unknown={action:'approve',authenticated:true})=>{
    const r:GroupResponse={v:2,kind:q.primitive.startsWith('activity_')?'control':'reply',requestId:q.requestId,parentDeviceId:primary.deviceId,
      deviceId:actor.deviceId,generation:q.generation,responseId:'reply_'+randomUUID(),createdAt:Math.floor(Date.now()/1000),enc:'',ct:'',sig:'',
      receipts:[{deviceId:actor===watch?primary.deviceId:watch.deviceId,enc:'',ct:''}]};
    const header=groupResponseHeader(r),text=JSON.stringify(answer);
    Object.assign(r,await hpkeSeal(reply.publicKeyB64u,'notibuddy/v2/reply',header+'|sender',text));
    Object.assign(r.receipts[0],await hpkeSeal(actor===watch?primary.encPub:watch.encPub,'notibuddy/v2/receipt',header+'|receipt|'+r.receipts[0].deviceId,text));
    r.sig=await ecdsaSign(actor.signingKey,groupResponseInput(r));return r;
  };
  return {primary,watch,sender,reply,config,manifest,recipients,payload,request,response};
}

test('public, relay and Swift agree on canonical v2 signature vectors',async()=>{
  const vector=JSON.parse(fs.readFileSync(new URL('../test-vectors/group-delivery-v2.json',import.meta.url),'utf8'));
  for(let i=0;i<vector.request.deliveries.length;i++) {
    const delivery=vector.request.deliveries[i];
    assert.equal(groupDeliveryHeader(vector.request,delivery.deviceId),vector.deliveryVectors[i].header);
    assert.equal(toB64u(groupDeliveryInput(vector.request,delivery)),vector.deliveryVectors[i].signingInput);
    assert(await ecdsaVerify(vector.senderSigningPublicKey,groupDeliveryInput(vector.request,delivery),delivery.sig));
  }
  assert.equal(toB64u(groupResponseInput(vector.response)),vector.responseSigningInput);
  assert(await ecdsaVerify(vector.responderSigningPublicKey,groupResponseInput(vector.response),vector.response.sig));
});

test('verified enrollment is bound to the pinned parent, account, keys, capabilities and both proofs',async()=>{
  const f=await fixture();assert.equal(f.recipients.recipients.length,2);
  assert(Object.isFrozen(f.recipients.recipients[0].capabilities));
  for(const edit of [
    (m:any)=>{m.primary.sigPub=f.watch.sigPub;},(m:any)=>{m.companions[0].grant.accountId='f'.repeat(32);},
    (m:any)=>{m.companions[0].grant.capabilities=['billing'];},(m:any)=>{m.companions[0].grant.generation=3;},
    (m:any)=>{m.companions[0].childSignature=m.companions[0].parentSignature;},
    (m:any)=>{m.companions[0].grant.encPub=f.primary.encPub;},(m:any)=>{m.extra=true;},
  ]) {const changed=structuredClone(f.manifest);edit(changed);await assert.rejects(verifyRecipients(changed,f.config));}
  // The historical enrollment deadline deliberately does not expire active membership.
  assert.equal(f.manifest.companions[0].grant.expiresAt,1);
});

test('saved generations reject rollback and a different roster at the same generation',async()=>{
  const f=await fixture(),checkpoint={generation:2,fingerprint:f.recipients.fingerprint};
  await assert.rejects(verifyRecipients({...f.manifest,generation:1,companions:[]},f.config,checkpoint));
  await assert.rejects(verifyRecipients({...f.manifest,companions:[]},f.config,checkpoint));
  const unpaired=await verifyRecipients({...f.manifest,generation:3,companions:[]},f.config,checkpoint);
  assert.equal(unpaired.recipients.length,1);assert.equal(unpaired.generation,3);
});

test('both devices decrypt their separate delivery; unrelated keys and another recipient header fail',async()=>{
  const f=await fixture(),other=await device();
  for(const actor of [f.primary,f.watch]) {
    const delivery=f.request.deliveries.find(d=>d.deviceId===actor.deviceId)!;
    const header=groupDeliveryHeader(f.request,actor.deviceId);
    assert(await ecdsaVerify(f.sender.publicKeyB64u,groupDeliveryInput(f.request,delivery),delivery.sig));
    assert.deepEqual(JSON.parse(await hpkeOpen(actor.encryptionKey,delivery.enc,'notibuddy/v2/request',header,delivery.ct)),f.payload);
    await assert.rejects(hpkeOpen(other.encryptionKey,delivery.enc,'notibuddy/v2/request',header,delivery.ct));
    await assert.rejects(hpkeOpen(actor.encryptionKey,delivery.enc,'notibuddy/v2/request',groupDeliveryHeader(f.request,actor===f.primary?f.watch.deviceId:f.primary.deviceId),delivery.ct));
  }
  assert.notEqual(f.request.deliveries[0].enc,f.request.deliveries[1].enc);
  assert.notEqual(f.request.deliveries[0].ct,f.request.deliveries[1].ct);
});

test('sender decrypts an authenticated Watch answer and the phone decrypts its signed receipt',async()=>{
  const f=await fixture(),response=await f.response();
  assert.deepEqual(await openGroupResponse({input:response,request:f.request,recipients:f.recipients,replyKey:f.reply.privateKey}),{action:'approve',authenticated:true});
  const receipt=response.receipts[0];
  assert.deepEqual(JSON.parse(await hpkeOpen(f.primary.encryptionKey,receipt.enc,'notibuddy/v2/receipt',groupResponseHeader(response)+'|receipt|'+f.primary.deviceId,receipt.ct)),{action:'approve',authenticated:true});
  await assert.rejects(hpkeOpen(f.watch.encryptionKey,receipt.enc,'notibuddy/v2/receipt',groupResponseHeader(response)+'|receipt|'+f.primary.deviceId,receipt.ct));
});

test('tampered receipts, another request, wrong actor and invalid answer fields never resolve',async()=>{
  const f=await fixture(),response=await f.response();
  for(const edit of [
    (r:GroupResponse)=>{r.requestId='other';},(r:GroupResponse)=>{r.generation++;},(r:GroupResponse)=>{r.deviceId=f.primary.deviceId;},
    (r:GroupResponse)=>{r.receipts=[];},(r:GroupResponse)=>{r.receipts[0].ct=toB64u(new Uint8Array(32));},
    (r:GroupResponse)=>{r.kind='control';},(r:GroupResponse)=>{r.createdAt=f.request.expiresAt;},
  ]) {const changed=structuredClone(response);edit(changed);await assert.rejects(openGroupResponse({input:changed,request:f.request,recipients:f.recipients,replyKey:f.reply.privateKey}));}
  const malformed=await f.response(f.watch,f.request,{action:32});
  await assert.rejects(openGroupResponse({input:malformed,request:f.request,recipients:f.recipients,replyKey:f.reply.privateKey}));
});

test('a failed atomic checkpoint replacement preserves the earlier trusted generation',async()=>{
  const f=await fixture(),root=fs.mkdtempSync(path.join(os.tmpdir(),'notibuddy-checkpoint-failure-'));
  const rename=fs.renameSync;
  try {
    const store=new RecipientStore(f.config,root);store.remember(f.recipients);
    const next=await verifyRecipients({...f.manifest,generation:3,companions:[]},f.config,store.read());
    fs.renameSync=()=>{throw Error('Injected rename failure');};
    assert.throws(()=>store.remember(next));
    assert.equal(store.read()!.generation,2);
    assert.equal(fs.readdirSync(path.join(root,'recipients')).filter(n=>n.endsWith('.tmp')).length,0);
    fs.renameSync=rename;store.remember(next);assert.equal(store.read()!.generation,3);
  } finally {fs.renameSync=rename;fs.rmSync(root,{recursive:true,force:true});}
});

test('Watch cannot return a terminal reply for a form even with a valid signed encrypted response',async()=>{
  const f=await fixture(),q=await sealGroupRequest({requestId:'form',senderKeyId:f.sender.senderKeyId,signingKey:f.sender.privateKey,
    recipients:f.recipients,primitive:'form',payload:{...f.payload,fields:[{id:'a',type:'text',label:'Name'}]}});
  await assert.rejects(openGroupResponse({input:await f.response(f.watch,q),request:q,recipients:f.recipients,replyKey:f.reply.privateKey}));
  assert.equal((await openGroupResponse({input:await f.response(f.primary,q),request:q,recipients:f.recipients,replyKey:f.reply.privateKey})).action,'approve');
});

test('checkpoint persistence survives aliases and process restarts and fails closed on damaged state',async()=>{
  const f=await fixture(),root=fs.mkdtempSync(path.join(os.tmpdir(),'notibuddy-recipients-'));
  try {
    const store=new RecipientStore(f.config,root);store.remember(f.recipients);
    const reopened=new RecipientStore({...f.config,senderLabel:'another label'},root);
    assert.deepEqual(reopened.read(),{generation:2,fingerprint:f.recipients.fingerprint});
    const next=await verifyRecipients({...f.manifest,generation:3,companions:[]},f.config,reopened.read());
    reopened.remember(next);assert.throws(()=>store.remember(f.recipients));
    const file=path.join(root,'recipients',fs.readdirSync(path.join(root,'recipients')).find(n=>n.endsWith('.json'))!);
    // Windows access is governed by inherited ACLs, not Unix permission bits.
    if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
    fs.writeFileSync(file,'damaged');assert.throws(()=>reopened.read());assert.throws(()=>store.remember(next));assert.equal(fs.readFileSync(file,'utf8'),'damaged');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('size, time and identifier validation fails before creating an oversized or ambiguous request',async()=>{
  const f=await fixture(),params={requestId:'id',senderKeyId:f.sender.senderKeyId,signingKey:f.sender.privateKey,recipients:f.recipients,primitive:'approval' as const,payload:f.payload};
  await assert.rejects(sealGroupRequest({...params,timeoutSeconds:3601}));
  await assert.rejects(sealGroupRequest({...params,requestId:'id\n'}));
  await assert.rejects(sealGroupRequest({...params,payload:{...f.payload,message:'a'.repeat(150000)}}));
});
