import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotiBuddyClient } from '../src/client.js';
import { PendingStore } from '../src/pending-store.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair, hpkeOpen } from '../src/crypto.js';
import { buildRequestHeader, sealReply } from '../src/protocol.js';
import type { RequestEnvelope, ReplyEnvelope, NotiBuddyConfig } from '../src/types.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'notibuddy-client-tests-'));
const originalFetch=globalThis.fetch;
try {
  const phoneEnc=await generateReplyKeyPair();const phoneSig=await generateSenderSigningKeyPair();
  const sender=await generateSenderSigningKeyPair();
  const config:NotiBuddyConfig={relay:'https://relay.test',token:'nb_snd_test',device:{
    id:await deriveDeviceId(phoneEnc.publicKeyB64u,phoneSig.publicKeyB64u),encPub:phoneEnc.publicKeyB64u,sigPub:phoneSig.publicKeyB64u,
  },senderKeyId:sender.senderKeyId,senderLabel:'test'};
  const bodies:RequestEnvelope[]=[];const answers=new Map<string,(ReplyEnvelope&{seq:number})[]>();
  const terminal=new Map<string,number>();let gets=0;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(init?.method==='POST') {
      const body=JSON.parse(init.body as string) as RequestEnvelope;bodies.push(body);
      assert.ok(!String(init.body).includes('Secret approval'));
      return Response.json({requestId:body.requestId,seq:bodies.length},{status:202});
    }
    gets++;const id=url.pathname.split('/').pop()!;
    if(terminal.has(id)) return new Response(null,{status:terminal.get(id)!});
    const reply=answers.get(id)?.find(r=>r.seq>Number(url.searchParams.get('afterSeq')??0));
    return reply?Response.json(reply):new Response(null,{status:204});
  };
  const client=()=>new NotiBuddyClient(config,sender.privateKey,new PendingStore(config,directory));
  const open=async(envelope:RequestEnvelope)=>JSON.parse(await hpkeOpen(phoneEnc.privateKey,envelope.enc,'notibuddy/v1/request',buildRequestHeader(envelope.requestId,envelope.deviceId,envelope.senderKeyId,envelope.primitive,envelope.createdAt,envelope.expiresAt),envelope.ct));
  const reply=async(envelope:RequestEnvelope,action:string,seq=1)=>{
    const payload=await open(envelope);
    const signed=await sealReply({requestId:envelope.requestId,deviceId:config.device.id,deviceSigningPrivateKey:phoneSig.privateKey,replyPublicKey:payload.replyPub,answer:{action,values:{text:'form text',input:'form input'}}});
    answers.set(envelope.requestId,[...(answers.get(envelope.requestId)??[]),{...signed,seq}]);
  };
  const pending=await client().ask({title:'Secret approval',requiresAuth:true,sensitive:true,waitSeconds:0, presentation:{shortTitle:'Private decision',summary:'Review the production migration'}});
  assert.equal(pending.status,'pending');assert.equal(gets,1,'wait=0 makes one request, not a busy loop');
  assert.equal((await open(bodies[0])).requiresAuth,true);
  assert.equal((await open(bodies[0])).sensitive,true);
  assert.deepEqual((await open(bodies[0])).presentation,{shortTitle:'Private decision',summary:'Review the production migration'});
  assert.ok(!JSON.stringify(bodies[0]).includes('production migration'), 'Presentation remains encrypted on the wire');
  const sentBeforeInvalid=bodies.length;
  await assert.rejects(client().ask({title:'Invalid summary',waitSeconds:0,presentation:{summary:'x'.repeat(101)}}));
  await assert.rejects(client().ask({title:'Invalid title',waitSeconds:0,presentation:{shortTitle:'Line one\nLine two'}}));
  assert.equal(bodies.length,sentBeforeInvalid,'Invalid display hints are rejected before dispatch');
  await reply(bodies[0],'approve');
  const resumed=await client().ask({resumeId:pending.requestId,waitSeconds:0});
  assert.equal(resumed.status,'resolved');assert.equal(resumed.answer?.action,'approve');
  assert.deepEqual(resumed.answer?.values,{text:'form text',input:'form input'});
  assert.ok(!JSON.stringify(resumed).includes('privateKey'));

  const protectedPending=await client().ask({title:'Another',waitSeconds:0});
  await reply(bodies[1],'approve');const authentic=answers.get(protectedPending.requestId)![0];
  answers.set(protectedPending.requestId,[{...authentic,sig:'A'.repeat(86)}]);
  await assert.rejects(client().ask({resumeId:protectedPending.requestId,waitSeconds:0}),/signature verification failed/);
  answers.set(protectedPending.requestId,[authentic]);
  assert.equal((await client().ask({resumeId:protectedPending.requestId,waitSeconds:0})).status,'resolved','authentication failures must preserve reply keys');

  for(const [http,status] of [[404,'not_found'],[410,'expired']] as const) {
    const pending=await client().ask({title:'Expires',waitSeconds:0});terminal.set(pending.requestId,http);
    assert.equal((await client().ask({resumeId:pending.requestId,waitSeconds:0})).status,status);
  }
  await client().activity({activityId:'timer',action:'start',title:'Timer',timerMinutes:20,sensitive:true,presentation:{shortTitle:'Test timer',summary:'Initial stage'}});
  const start=bodies.at(-1)!;const startPayload=await open(start);
  await client().activity({activityId:'timer',action:'update',status:'Still running'});
  const update=bodies.at(-1)!;const updatePayload=await open(update);
  assert.equal(startPayload.presentation.summary,'Initial stage');
  assert.equal(updatePayload.presentation,undefined,'A new status must not retain an obsolete summary');
  assert.notEqual(start.requestId,update.requestId);assert.equal(startPayload.activityId,updatePayload.activityId);
  assert.equal(updatePayload.primitive,'timer');assert.equal(updatePayload.timerEndsAt,startPayload.timerEndsAt);
  assert.equal(updatePayload.sensitive,true,'Sensitive activities remain private across updates');
  assert.equal(updatePayload.revision,2);assert.equal(updatePayload.title,'Timer');
  await reply(update,'pause',100);await reply(update,'resume',101);await reply(update,'cancel',102);
  const controls=await client().activity({activityId:'timer',action:'poll'});
  assert.deepEqual(controls.controls.map(c=>c.action),['pause','resume','cancel']);
  assert.deepEqual((await client().activity({activityId:'timer',action:'poll'})).controls,[]);
  await client().activity({activityId:'timer',action:'end'});
  const endPayload=await open(bodies.at(-1)!);assert.equal(endPayload.activityId,startPayload.activityId);assert.equal(endPayload.action,'end');

  await assert.rejects(client().ask({title:'Invalid',waitSeconds:NaN}));
  for(const entry of fs.readdirSync(path.join(directory,'pending'),{recursive:true})) {
    const file=path.join(directory,'pending',String(entry));
    // Windows uses ACLs; Unix permission bits do not describe its access controls.
    if(fs.statSync(file).isFile() && process.platform !== 'win32') assert.equal(fs.statSync(file).mode&0o777,0o600);
  }
  console.log('Client regressions passed: encryption, restart/resume, terminal polling, key retention, activity continuity/controls, auth propagation, private storage.');
} finally {
  globalThis.fetch=originalFetch;
  fs.rmSync(directory,{recursive:true,force:true});
}
