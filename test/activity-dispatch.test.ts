import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotiBuddyClient } from '../src/client.js';
import { PendingStore, type ActivitySession } from '../src/pending-store.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';
import type { RequestEnvelope } from '../src/types.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'notibuddy-dispatch-test-'));
const originalFetch=globalThis.fetch;
try {
  const enc=await generateReplyKeyPair(),sig=await generateSenderSigningKeyPair(),sender=await generateSenderSigningKeyPair();
  const config={relay:'https://relay.test',token:'nb_snd_test',device:{id:await deriveDeviceId(enc.publicKeyB64u,sig.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:sig.publicKeyB64u},senderKeyId:sender.senderKeyId,senderLabel:'test'};
  const store=new PendingStore(config,directory);const client=new NotiBuddyClient(config,sender.privateKey,store);
  let http=402,networkFailure=false,last:RequestEnvelope;
  globalThis.fetch=async(_input,init)=>{
    if(init?.method!=='POST') return new Response(null,{status:204});
    last=JSON.parse(init.body as string);
    if(networkFailure) throw new TypeError('Connection lost');
    return Response.json({requestId:last.requestId,seq:1},{status:http});
  };
  await assert.rejects(client.activity({activityId:'task',action:'start',title:'Original'}),/402/);
  assert.equal(store.read('activity:task'),undefined);assert.equal(store.read('reply:'+last!.requestId),undefined);
  http=202;await client.activity({activityId:'task',action:'start',title:'Original'});
  const original=store.read<ActivitySession>('activity:task');
  for(const action of ['update','end'] as const) {
    http=402;await assert.rejects(client.activity({activityId:'task',action,title:'Rejected'}),/402/);
    assert.deepEqual(store.read('activity:task'),original);
    assert.equal(store.read('reply:'+last!.requestId),undefined);
    assert.equal((await client.activity({activityId:'task',action:'poll'})).status,'active');
  }
  http=202;await client.activity({activityId:'task',action:'end'});
  assert.equal((await client.activity({activityId:'task',action:'poll'})).status,'ended');
  for(const status of [409,500]) {
    http=status;const activityId='ambiguous-'+status;
    await assert.rejects(client.activity({activityId,action:'start',title:'Unknown'}));
    assert.ok(store.read('activity:'+activityId));assert.ok(store.read('reply:'+last!.requestId));
  }
  http=202;await client.activity({activityId:'expiry',action:'start',title:'Expires'});
  const expired=store.read<ActivitySession>('activity:expiry')!;
  expired.expiresAt=Math.floor(Date.now()/1000)-1;
  const expiredStableId=expired.payload.activityId;
  store.write('activity:expiry',expired,Date.now()+600000);
  assert.equal((await client.activity({activityId:'expiry',action:'poll'})).status,'expired');
  for(const action of ['update','end'] as const) await assert.rejects(client.activity({activityId:'expiry',action}),/Activity expired/);
  await client.activity({activityId:'expiry',action:'start',title:'Fresh'});
  assert.notEqual(store.read<ActivitySession>('activity:expiry')!.payload.activityId,expiredStableId);
  networkFailure=true;
  await assert.rejects(client.activity({activityId:'lost-ack',action:'start',title:'Unknown'}));
  assert.ok(store.read('activity:lost-ack'));assert.ok(store.read('reply:'+last!.requestId));
  console.log('Activity dispatch rejection and ambiguous-acceptance recovery checks passed.');
} finally {globalThis.fetch=originalFetch;fs.rmSync(directory,{recursive:true,force:true});}
