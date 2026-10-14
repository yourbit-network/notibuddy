import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NotiBuddyClient, ResumableRequestError } from '../src/client.js';
import { PendingStore, type PendingReply, type ActivitySession } from '../src/pending-store.js';
import { DestinationStore } from '../src/config.js';
import { parsePairingBundle, buildRequestHeader, buildErrorHeader, sealReply } from '../src/protocol.js';
import { relayJSON, DeadlineError } from '../src/client-http.js';
import { generateReplyKeyPair, generateSenderSigningKeyPair, deriveDeviceId, hpkeOpen, hpkeSeal, ecdsaSign, ecdsaVerify, sha256, toHex, toB64u } from '../src/crypto.js';
import { companionGrantInput, type CompanionGrant } from '../src/companion-grant.js';
import { groupDeliveryHeader, groupResponseHeader, groupResponseInput, type GroupRequest, type GroupResponse } from '../src/group-wire.js';
import type { NotiBuddyConfig, RequestEnvelope } from '../src/types.js';

async function device() {
  const enc=await generateReplyKeyPair(),sig=await generateSenderSigningKeyPair();
  return {id:await deriveDeviceId(enc.publicKeyB64u,sig.publicKeyB64u),enc,sig};
}
async function fixture(run:(f:any)=>Promise<void>) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'notibuddy-client-recovery-')),original=globalThis.fetch;
  try {
    const phone=await device(),sender=await generateSenderSigningKeyPair();
    const config:NotiBuddyConfig={relay:'https://relay.test',token:'nb_snd_'+randomUUID(),device:{id:phone.id,encPub:phone.enc.publicKeyB64u,sigPub:phone.sig.publicKeyB64u},senderKeyId:sender.senderKeyId,senderLabel:'Fixture'};
    const store=new PendingStore(config,root),requests:RequestEnvelope[]=[];
    const client=(override:Partial<NotiBuddyConfig>={})=>new NotiBuddyClient({...config,...override},sender.privateKey,store);
    const payload=(r:RequestEnvelope)=>hpkeOpen(phone.enc.privateKey,r.enc,'notibuddy/v1/request',buildRequestHeader(r.requestId,r.deviceId,r.senderKeyId,r.primitive,r.createdAt,r.expiresAt),r.ct).then(JSON.parse);
    const reply=async(r:RequestEnvelope,seq=100)=>({...await sealReply({requestId:r.requestId,deviceId:phone.id,deviceSigningPrivateKey:phone.sig.privateKey,replyPublicKey:(await payload(r)).replyPub,answer:{action:'pause'}}),seq});
    await run({root,phone,sender,config,store,requests,client,payload,reply});
  }finally{globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
}
const stalled=(signal?:AbortSignal|null)=>new Promise<Response>((_,reject)=>{if(signal?.aborted)reject(signal.reason);else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});

test('lost dispatch acknowledgement resumes the exact request and key after a process restart',()=>fixture(async(f)=>{
  let failed=false;
  globalThis.fetch=async(_url,init)=>{
    if(init?.method==='POST') {
      const r=JSON.parse(String(init.body));f.requests.push(r);
      if(!failed){failed=true;throw new TypeError('Lost acknowledgement');}
      return Response.json({requestId:r.requestId,seq:1},{status:202});
    }
    return Response.json(await f.reply(f.requests[0]));
  };
  const first=await f.client().ask({title:'Retry the same request',waitSeconds:0});
  assert.equal(first.status,'pending');assert.equal(first.errorCode,'RETRY_REQUIRED');
  assert.equal(f.store.read('reply:'+first.requestId).dispatch,'pending');
  const next=await f.client().ask({resumeId:first.requestId,waitSeconds:0});
  assert.equal(next.status,'resolved');assert.deepEqual(f.requests[0],f.requests[1]);
  assert.equal(f.store.read('reply:'+first.requestId),undefined);
}));

test('one end-to-end deadline bounds dispatch and a stalled reply body',()=>fixture(async(f)=>{
  let bodyCancelled=false;
  globalThis.fetch=async(_url,init)=>{
    if(init?.method==='POST') {
      await new Promise(resolve=>setTimeout(resolve,40));
      const r=JSON.parse(String(init.body));f.requests.push(r);return Response.json({requestId:r.requestId,seq:1},{status:202});
    }
    return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){bodyCancelled=true;}}));
  };
  const start=performance.now(),result=await f.client().ask({title:'Bounded',waitSeconds:0.12});
  assert.equal(result.status,'pending');assert.equal(result.errorCode,'WAIT_DEADLINE');
  assert(performance.now()-start<900);assert(bodyCancelled);assert(f.store.read('reply:'+result.requestId));
}));

test('caller cancellation reaches fetch and retains a resumable identity',()=>fixture(async(f)=>{
  const controller=new AbortController();let observed=false;
  globalThis.fetch=async(_url,init)=>{
    if(init?.method==='POST') {
      const r=JSON.parse(String(init.body));f.requests.push(r);return Response.json({requestId:r.requestId,seq:1},{status:202});
    }
    init!.signal!.addEventListener('abort',()=>{observed=true;},{once:true});setTimeout(()=>controller.abort(),10);return stalled(init?.signal);
  };
  await assert.rejects(f.client().ask({title:'Cancelled',waitSeconds:1},{signal:controller.signal}),(e:any)=>e instanceof ResumableRequestError && e.requestId===f.requests[0].requestId);
  assert(observed);assert(f.store.read('reply:'+f.requests[0].requestId));
}));

test('missing sequence or malformed authenticated answers cannot consume a saved key',()=>fixture(async(f)=>{
  globalThis.fetch=async(_url,init)=>{
    if(init?.method==='POST'){const r=JSON.parse(String(init.body));f.requests.push(r);return Response.json({requestId:r.requestId,seq:1},{status:202});}
    const {seq,...invalid}=await f.reply(f.requests[0]);return Response.json(invalid);
  };
  const result=await f.client().ask({title:'No sequence',waitSeconds:0});assert.equal(result.status,'pending');assert(f.store.read('reply:'+result.requestId));
  const q=f.requests[0];
  globalThis.fetch=async()=>Response.json({...await sealReply({requestId:q.requestId,deviceId:f.phone.id,deviceSigningPrivateKey:f.phone.sig.privateKey,
    replyPublicKey:(await f.payload(q)).replyPub,answer:{action:32} as any}),seq:100});
  assert.equal((await f.client().ask({resumeId:result.requestId,waitSeconds:0})).status,'pending');assert(f.store.read('reply:'+result.requestId));
  globalThis.fetch=async()=>Response.json(await f.reply(f.requests[0]));
  assert.equal((await f.client().ask({resumeId:result.requestId,waitSeconds:0})).status,'resolved');
}));

test('a signed reply or error for another request preserves resumable state until the correct response arrives',()=>fixture(async(f)=>{
  for(const kind of ['reply','error']) {
    let current:RequestEnvelope,wrong=true;
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){current=JSON.parse(String(init.body));return Response.json({requestId:current.requestId,seq:1},{status:202});}
      const requestId=wrong?'request_other':current!.requestId;
      if(kind==='reply')return Response.json({...await sealReply({requestId,deviceId:f.phone.id,deviceSigningPrivateKey:f.phone.sig.privateKey,
        replyPublicKey:(await f.payload(current!)).replyPub,answer:{action:'Approve'}}),seq:2});
      const createdAt=Math.floor(Date.now()/1000),code='unsupported';
      const sig=await ecdsaSign(f.phone.sig.privateKey,Buffer.concat([Buffer.from(buildErrorHeader(requestId,f.phone.id,createdAt,code)),Buffer.from([0])]));
      return Response.json({v:1,kind:'error',requestId,deviceId:f.phone.id,createdAt,code,sig,seq:2});
    };
    const first=await f.client().ask({title:'Bound response',waitSeconds:0});
    assert.equal(first.status,'pending');assert.equal(first.errorCode,'RETRY_REQUIRED');assert(f.store.read('reply:'+first.requestId));
    wrong=false;
    const resumed=await f.client().ask({resumeId:first.requestId,waitSeconds:0});
    assert.equal(resumed.status,kind==='reply'?'resolved':'error');assert.equal(f.store.read('reply:'+first.requestId),undefined);
  }
}));

test('signed reply timestamps use the original lifetime and allow delayed collection',()=>fixture(async(f)=>{
  const originalNow=Date.now,base=Math.floor(originalNow()/1000);let now=base,responseTime:number|undefined;
  Date.now=()=>now*1000;
  try {
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){const r=JSON.parse(String(init.body));f.requests.push(r);return Response.json({requestId:r.requestId,seq:1},{status:202});}
      if(responseTime===undefined)return new Response(null,{status:204});
      const fetchTime=now;now=responseTime;
      try{return Response.json(await f.reply(f.requests[0]));}finally{now=fetchTime;}
    };
    const pending=await f.client().ask({title:'Delayed',timeoutSeconds:3600,waitSeconds:0});
    assert.equal(pending.status,'pending');now=base+3400;
    for(const invalid of [base-121,base+3600,now+121]) {
      responseTime=invalid;
      const result=await f.client().ask({resumeId:pending.requestId,waitSeconds:0});
      assert.equal(result.status,'pending');assert(f.store.read('reply:'+pending.requestId));
    }
    now=base+3500;responseTime=base+10;
    assert.equal((await f.client().ask({resumeId:pending.requestId,waitSeconds:0})).status,'resolved');
    assert.equal(f.store.read('reply:'+pending.requestId),undefined);
  }finally{Date.now=originalNow;}
}));

test('slow history is bounded and rotated while the newest controls are checked first',(t)=>fixture(async(f)=>{
  globalThis.fetch=async(_url,init)=>{
    if(init?.method==='POST'){const r=JSON.parse(String(init.body));f.requests.push(r);return Response.json({requestId:r.requestId,seq:f.requests.length},{status:202});}
    return new Response(null,{status:204});
  };
  await f.client().activity({activityId:'fair',action:'start',timerMinutes:10});
  await f.client().activity({activityId:'fair',action:'update'});await f.client().activity({activityId:'fair',action:'update'});
  // Crypto and disk work must not race a 120 ms wall-clock test budget on CI.
  // Advance the actual deadline timer only when the simulated history stalls.
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  let phase=0,aborted=0;
  const checked:string[]=[];
  globalThis.fetch=async(url,init)=>{
    const u=new URL(String(url)),seq=Number(u.searchParams.get('afterSeq'));
    checked.push(u.pathname.split('/').at(-1)!);
    if(u.pathname.endsWith(f.requests[2].requestId))return seq<100?Response.json(await f.reply(f.requests[2],100)):new Response(null,{status:204});
    if(phase===1 && u.pathname.endsWith(f.requests[1].requestId))return seq<101?Response.json(await f.reply(f.requests[1],101)):new Response(null,{status:204});
    const response=stalled(init?.signal);
    init!.signal!.addEventListener('abort',()=>{aborted++;},{once:true});
    t.mock.timers.tick(120);
    return response;
  };
  let start=Date.now();
  const first=await f.client().activity({activityId:'fair',action:'poll'},{deadline:Date.now()+120});
  assert.deepEqual(first.controls.map((a:any)=>a.action),['pause']);assert.equal(Date.now()-start,120);
  assert.deepEqual(checked,[f.requests[2].requestId,f.requests[2].requestId,f.requests[0].requestId]);
  assert.equal(f.store.read('activity:fair').pollOffset,1);
  phase=1;start=Date.now();checked.length=0;
  const next=await f.client().activity({activityId:'fair',action:'poll'},{deadline:Date.now()+120});
  assert.deepEqual(next.controls.map((a:any)=>a.action),['pause']);assert.equal(Date.now()-start,120);
  assert.deepEqual(checked,[f.requests[2].requestId,f.requests[1].requestId,f.requests[1].requestId,f.requests[0].requestId]);
  assert.equal(aborted,2);
}));

test('doctor exposes approval and compatibility without credentials or private keys',()=>fixture(async(f)=>{
  globalThis.fetch=async(url)=>String(url).endsWith('/health')?Response.json({status:'healthy'}):Response.json({senders:[{senderKeyId:f.sender.senderKeyId,approved:1}]});
  const report=await f.client().doctor();assert(report.reachable);assert.equal(report.sender,'approved');assert.equal(report.requestProtocol,1);
  assert(!JSON.stringify(report).includes(f.config.token));assert(!JSON.stringify(report).includes('privateKey'));
}));

test('a missing old activity key cannot starve a newer control or brick updates',()=>fixture(async(f)=>{
  let answer=false;
  globalThis.fetch=async(url,init)=>{
    if(init?.method==='POST'){const r=JSON.parse(String(init.body));f.requests.push(r);return Response.json({requestId:r.requestId,seq:f.requests.length},{status:202});}
    if(answer && String(url).includes(f.requests.at(-1).requestId) && !String(url).endsWith('afterSeq=100'))return Response.json(await f.reply(f.requests.at(-1)));
    return new Response(null,{status:204});
  };
  await f.client().activity({activityId:'timer',action:'start',timerMinutes:10});
  f.store.remove('reply:'+f.requests[0].requestId);
  const update=await f.client().activity({activityId:'timer',action:'update',status:'Current'});assert.equal(update.status,'dispatched');assert(update.warnings.length);
  answer=true;const result=await f.client().activity({activityId:'timer',action:'poll'});assert.deepEqual(result.controls.map((a:any)=>a.action),['pause']);
  assert.deepEqual((await f.client().activity({activityId:'timer',action:'poll'})).controls,[]);
}));

test('an ambiguous activity start is retried before another revision is sent',()=>fixture(async(f)=>{
  let fail=true;
  globalThis.fetch=async(_url,init)=>{
    if(init?.method!=='POST')return new Response(null,{status:204});
    const r=JSON.parse(String(init.body));f.requests.push(r);if(fail){fail=false;throw Error('Network unavailable');}
    return Response.json({requestId:r.requestId,seq:f.requests.length},{status:202});
  };
  await assert.rejects(f.client().activity({activityId:'retry',action:'start',title:'Original'}));
  assert(f.store.read('activity:retry').pendingDispatch);
  assert.equal((await f.client().activity({activityId:'retry',action:'poll'})).status,'active');
  assert.deepEqual(f.requests[0],f.requests[1]);assert.equal(f.store.read('activity:retry').pendingDispatch,undefined);
}));

test('legacy trailing-slash storage migrates atomically without generating a new key',()=>fixture(async(f)=>{
  const scope=createHash('sha256').update(JSON.stringify([f.config.relay+'/',f.config.token,f.config.device.id,f.config.senderKeyId])).digest('hex');
  const key='reply:legacy',name=createHash('sha256').update(key).digest('hex')+'.json',directory=path.join(f.root,'pending',scope);
  fs.mkdirSync(directory,{recursive:true});const saved={privateKeyJwk:await crypto.subtle.exportKey('jwk',f.phone.enc.privateKey),expiresAt:Math.floor(Date.now()/1000)+300};
  const file=path.join(directory,name);fs.writeFileSync(file,JSON.stringify({value:saved,retainUntil:Date.now()+600000}),{mode:0o644});
  const store=new PendingStore(f.config,f.root);assert.deepEqual(store.read(key),saved);assert(!fs.existsSync(file));
  const canonical=fs.readdirSync(path.join(f.root,'pending')).filter(n=>n!==scope)[0];
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(f.root,'pending',canonical,name)).mode&0o777,0o600);
}));

test('failed pending-file replacement cleans temporary key files and prevents dispatch',()=>fixture(async(f)=>{
  const rename=fs.renameSync;let sent=false;
  globalThis.fetch=async()=>{sent=true;throw Error('Must not dispatch');};
  try {
    fs.renameSync=()=>{throw Error('Injected storage failure');};
    await assert.rejects(f.client().ask({title:'Cannot save',waitSeconds:0}),/storage failure/);assert(!sent);
  }finally{fs.renameSync=rename;}
  assert.equal(fs.readdirSync(path.join(f.root,'pending'),{recursive:true}).filter(n=>String(n).endsWith('.tmp')).length,0);
}));

test('pairing explicitly negotiates v2 and rejects downgrade or unknown protocol metadata',()=>fixture(async(f)=>{
  const store=new DestinationStore(f.root),bundle={v:1 as const,relay:f.config.relay+'/',token:f.config.token,device:f.config.device,pairSecret:toB64u(new Uint8Array(32))};
  const initial=await store.prepare('phone',bundle,'Fixture');
  const upgraded=await store.prepare('phone',{...bundle,requestProtocol:2,minimumRecipientGeneration:2},'Fixture');
  assert.equal(initial.record.keys.senderKeyId,upgraded.record.keys.senderKeyId);assert.equal(upgraded.record.config.requestProtocol,2);
  await assert.rejects(store.prepare('phone',bundle,'Fixture'),/downgrade/);
  await assert.rejects(parsePairingBundle('nbpair1.'+Buffer.from(JSON.stringify({...bundle,requestProtocol:3})).toString('base64url')),/Unsupported request protocol/);
  const parsed=await parsePairingBundle('nbpair1.'+Buffer.from(JSON.stringify({...bundle,requestProtocol:2,minimumRecipientGeneration:2})).toString('base64url'));
  assert.equal(parsed.relay,f.config.relay);assert.equal(parsed.minimumRecipientGeneration,2);
}));

async function manifest(f:any,watch:any,generation:number) {
  const grant:CompanionGrant={v:1,accountId:toHex(await sha256(new TextEncoder().encode(f.config.token.slice(7)))).slice(0,32),parentDeviceId:f.phone.id,deviceId:watch.id,
    encPub:watch.enc.publicKeyB64u,sigPub:watch.sig.publicKeyB64u,credentialHash:'0'.repeat(64),capabilities:['approval','text_input','timer_control'],generation,nonce:toB64u(new Uint8Array(32)),expiresAt:1};
  return {v:2,deviceId:f.phone.id,generation,primary:{deviceId:f.phone.id,encPub:f.phone.enc.publicKeyB64u,sigPub:f.phone.sig.publicKeyB64u},
    companions:[{grant,parentSignature:await ecdsaSign(f.phone.sig.privateKey,companionGrantInput(grant,'parent')),childSignature:await ecdsaSign(watch.sig.privateKey,companionGrantInput(grant,'child'))}]};
}
async function groupReply(f:any,q:GroupRequest,watch:any) {
  const delivery=q.deliveries.find(d=>d.deviceId===watch.id)!;
  const payload=JSON.parse(await hpkeOpen(watch.enc.privateKey,delivery.enc,'notibuddy/v2/request',groupDeliveryHeader(q,watch.id),delivery.ct));
  const r:GroupResponse={v:2,kind:q.primitive.startsWith('activity_')?'control':'reply',requestId:q.requestId,parentDeviceId:f.phone.id,deviceId:watch.id,generation:q.generation,
    responseId:randomUUID(),createdAt:Math.floor(Date.now()/1000),enc:'',ct:'',sig:'',receipts:[{deviceId:f.phone.id,enc:'',ct:''}]};
  const header=groupResponseHeader(r),text=JSON.stringify({action:'approve',authenticated:true});
  Object.assign(r,await hpkeSeal(payload.replyPub,'notibuddy/v2/reply',header+'|sender',text));
  Object.assign(r.receipts[0],await hpkeSeal(f.phone.enc.publicKeyB64u,'notibuddy/v2/receipt',header+'|receipt|'+f.phone.id,text));
  r.sig=await ecdsaSign(watch.sig.privateKey,groupResponseInput(r));return {seq:100,envelope:r};
}

test('v2 dispatch and resumed Watch reply use original proofs and canonical signed HTTP reads',()=>fixture(async(f)=>{
  const watch=await device(),nextWatch=await device(),original=await manifest(f,watch,2);let discoveries=0,lost=true,reply:any;
  globalThis.fetch=async(url,init)=>{
    const u=new URL(String(url));
    if(init?.method!=='POST') {
      const headers=new Headers(init?.headers),stamp=headers.get('X-Sender-Timestamp'),nonce=headers.get('X-Sender-Nonce');
      const input=new TextEncoder().encode(`nb1|http|GET|${u.pathname}${u.search}|${stamp}|${nonce}|${toHex(await sha256(new Uint8Array()))}`);
      assert(await ecdsaVerify(f.sender.publicKeyB64u,input,headers.get('X-Sender-Signature')!));
    }
    if(u.pathname==='/v2/recipients'){discoveries++;return Response.json(discoveries===1?original:await manifest(f,nextWatch,3));}
    if(u.pathname==='/v2/requests') {
      const q=JSON.parse(String(init?.body));f.requests.push(q);reply ??= await groupReply(f,q,watch);
      if(lost){lost=false;throw Error('Lost acknowledgement');}return Response.json({requestId:q.requestId,seq:1},{status:202});
    }
    assert(u.pathname.startsWith('/v2/replies/'));return Response.json(reply);
  };
  const config={requestProtocol:2 as const,minimumRecipientGeneration:2};
  const first=await f.client(config).ask({title:'Watch approval',waitSeconds:0});assert.equal(first.status,'pending');
  const resumed=await f.client(config).ask({resumeId:first.requestId,waitSeconds:0});assert.equal(resumed.status,'resolved');assert.equal(resumed.answer.action,'approve');
  assert.equal(discoveries,1);assert.deepEqual(f.requests[0],f.requests[1]);
}));

test('recipient-change rejection rebuilds one logical request with fresh verified keys and bounded retries',()=>fixture(async(f)=>{
  const old=await device(),watch=await device();let discoveries=0,rejected=0,answer:any;
  globalThis.fetch=async(url,init)=>{
    const pathname=new URL(String(url)).pathname;
    if(pathname==='/v2/recipients')return Response.json(await manifest(f,++discoveries===1?old:watch,discoveries===1?2:3));
    if(pathname==='/v2/requests') {
      const q=JSON.parse(String(init?.body));f.requests.push(q);
      if(!rejected++){return Response.json({code:'RECIPIENTS_CHANGED'},{status:409});}
      answer=await groupReply(f,q,watch);return Response.json({requestId:q.requestId,seq:1},{status:202});
    }
    return Response.json(answer);
  };
  assert.equal((await f.client({requestProtocol:2}).ask({title:'Membership changed',waitSeconds:0})).status,'resolved');
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].requestId,f.requests[1].requestId);assert.equal(f.requests[0].expiresAt,f.requests[1].expiresAt);
  assert.equal(f.requests[1].generation,3);assert.equal(discoveries,2);
}));

test('a v2 destination never downgrades because discovery is unavailable',()=>fixture(async(f)=>{
  const routes:string[]=[];globalThis.fetch=async(url)=>{routes.push(new URL(String(url)).pathname);return Response.json({code:'GROUP_DELIVERY_NOT_ENABLED'},{status:426});};
  await assert.rejects(f.client({requestProtocol:2}).ask({title:'No downgrade',waitSeconds:0}),/426/);
  assert.deepEqual(routes,['/v2/recipients']);
}));

test('the standalone transport enforces caller deadlines and bounds response sizes',()=>fixture(async(f)=>{
  globalThis.fetch=async(_url,init)=>stalled(init?.signal);
  await assert.rejects(relayJSON(f.config,'/v1/health',{}, {deadline:Date.now()+25}),DeadlineError);
  let cancelled=false;
  globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'900000'}});
  await assert.rejects(relayJSON(f.config,'/v1/health'),/size limit/);assert(cancelled);
}));
