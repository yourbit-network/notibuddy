import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { NotiBuddyClient } from '../src/client.js';
import { PendingStore } from '../src/pending-store.js';
import { RecipientStore } from '../src/recipient-store.js';
import { relayJSON } from '../src/client-http.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair, ecdsaVerify, sha256, toHex } from '../src/crypto.js';
import type { NotiBuddyConfig } from '../src/types.js';

async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>) {
  const f=await setup(),original=globalThis.fetch;
  try {await run(f);} finally {globalThis.fetch=original;fs.rmSync(f.root,{recursive:true,force:true});}
}
async function setup() {
  const enc=await generateReplyKeyPair(),sig=await generateSenderSigningKeyPair(),sender=await generateSenderSigningKeyPair();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'notibuddy-doctor-'));
  const config:NotiBuddyConfig={relay:'https://relay.test',token:'nb_snd_'+randomUUID(),
    device:{id:await deriveDeviceId(enc.publicKeyB64u,sig.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:sig.publicKeyB64u},
    senderKeyId:sender.senderKeyId,senderLabel:'Fixture'};
  const client=(override:Partial<NotiBuddyConfig>={})=>{
    const selected={...config,...override};return new NotiBuddyClient(selected,sender.privateKey,new PendingStore(selected,root));
  };
  return {root,config,sender,client,route:'/v1/senders/'+sender.senderKeyId,
    row:(approved=1)=>({senderKeyId:sender.senderKeyId,approved})};
}
const health=()=>Response.json({status:'healthy'});
const unavailable=(report:Awaited<ReturnType<NotiBuddyClient['doctor']>>)=>{
  assert.equal(report.sender,'unverified');assert.equal(report.recipientCount,null);assert(report.issues.length>0);
};
const padding=(body:object,size:number)=>JSON.stringify({...body,padding:''}).replace('"padding":""','"padding":"'+'x'.repeat(size-Buffer.byteLength(JSON.stringify({...body,padding:''})))+'"');

test('doctor reads only its own sender, distinguishes approval, and excludes private metadata',()=>fixture(async f=>{
  for(const approved of [0,1]) {
    const routes:string[]=[];
    globalThis.fetch=async(url,init)=>{
      const route=new URL(String(url)).pathname;routes.push(route);
      assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+f.config.token);
      if(route==='/v1/health')return health();
      assert.equal(route,f.route,'No full sender catalog should be requested');
      return Response.json({sender:{...f.row(approved),label:'Private label',mac:'Private proof'}});
    };
    const report=await f.client().doctor();
    assert.deepEqual(routes,['/v1/health',f.route]);assert.equal(report.sender,approved?'approved':'pending_approval');
    assert.equal(report.requestProtocol,1);assert.equal(report.recipientCount,1);assert.deepEqual(report.issues,[]);
    for(const secret of [f.config.token,'Private label','Private proof','privateKey'])assert(!JSON.stringify(report).includes(secret));
  }
}));

test('typed sender absence never falls back to the catalog',()=>fixture(async f=>{
  const routes:string[]=[];
  globalThis.fetch=async url=>{const route=new URL(String(url)).pathname;routes.push(route);return route==='/v1/health'?health():Response.json({code:'SENDER_NOT_FOUND'},{status:404});};
  const report=await f.client().doctor();assert.equal(report.sender,'not_registered');assert.deepEqual(report.issues,[]);
  assert.deepEqual(routes,['/v1/health',f.route]);
}));

test('only an uncoded old-route 404 uses the complete legacy sender list',()=>fixture(async f=>{
  for(const missing of [()=>new Response('Not found',{status:404}),()=>new Response(null,{status:404}),()=>Response.json({error:'Not found'},{status:404})]) {
    for(const approved of [undefined,0,1]) {
      const routes:string[]=[];
      globalThis.fetch=async url=>{
        const route=new URL(String(url)).pathname;routes.push(route);
        if(route==='/v1/health')return health();if(route===f.route)return missing();
        assert.equal(route,'/v1/senders');return Response.json({senders:approved===undefined?[]:[f.row(approved)]});
      };
      const report=await f.client().doctor();assert.equal(report.sender,approved===undefined?'not_registered':approved?'approved':'pending_approval');
      assert.deepEqual(report.issues,[]);assert.deepEqual(routes,['/v1/health',f.route,'/v1/senders']);
    }
  }
}));

test('server errors and malformed error codes cannot masquerade as an old endpoint',()=>fixture(async f=>{
  const responses=[...['ACCOUNT_NOT_FOUND',null,1,false,'','sender_not_found','SENDER_NOT_FOUND\n','A'.repeat(81)].map(code=>()=>Response.json({code,error:f.config.token},{status:404})),
    ...[401,403,410,429,500,503].map(status=>()=>Response.json({code:'UNAVAILABLE',error:f.config.token},{status})),
    ()=>{throw Error('Private exception '+f.config.token);}];
  for(const response of responses) {
    const routes:string[]=[];
    globalThis.fetch=async url=>{const route=new URL(String(url)).pathname;routes.push(route);return route==='/v1/health'?health():response();};
    const report=await f.client().doctor();unavailable(report);assert(!JSON.stringify(report).includes(f.config.token));
    assert.deepEqual(routes,['/v1/health',f.route]);
  }
}));

test('wrong identities, invalid approval values, malformed bodies and unexpected success statuses fail closed',()=>fixture(async f=>{
  const responses=[...[null,{},[],{sender:null},{sender:{...f.row(),senderKeyId:'snd_'+'0'.repeat(24)}},
    ...[undefined,-1,2,true,'1',null].map(approved=>({sender:{...f.row(),approved}}))].map(body=>()=>Response.json(body)),
    ()=>new Response('{',{status:200}),()=>new Response(null,{status:204}),()=>Response.json({sender:f.row()},{status:201})];
  for(const response of responses) {
    const routes:string[]=[];
    globalThis.fetch=async url=>{const route=new URL(String(url)).pathname;routes.push(route);return route==='/v1/health'?health():response();};
    unavailable(await f.client().doctor());assert.deepEqual(routes,['/v1/health',f.route]);
  }
}));

test('a legacy list must be complete, unambiguous and valid before reporting absence or approval',()=>fixture(async f=>{
  const other={senderKeyId:'snd_'+'0'.repeat(24),approved:0};
  for(const body of [{}, {senders:null}, {senders:[null]}, {senders:[{}]}, {senders:[{...other,approved:2}]},
    {senders:[f.row(),f.row()]}, {senders:[other,other]}, {senders:[],page:null}, {senders:[f.row()],page:{next:'later'}}]) {
    const routes:string[]=[];
    globalThis.fetch=async url=>{
      const route=new URL(String(url)).pathname;routes.push(route);
      return route==='/v1/health'?health():route===f.route?new Response(null,{status:404}):Response.json(body);
    };
    unavailable(await f.client().doctor());assert.deepEqual(routes,['/v1/health',f.route,'/v1/senders']);
  }
}));

test('sender metadata has a 64 KiB byte limit, including streamed bodies, with cancellation on overflow',()=>fixture(async f=>{
  for(const mode of ['exact','header','stream','utf8']) {
    let cancelled=false,lookups=0;
    globalThis.fetch=async url=>{
      if(new URL(String(url)).pathname==='/v1/health')return health();lookups++;
      const value=mode==='utf8'?JSON.stringify({sender:f.row(),label:'é'.repeat(33000)}):padding({sender:f.row()},mode==='exact'?65536:65537);
      if(mode==='exact')return new Response(value);
      const bytes=new TextEncoder().encode(value);
      return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,32768));c.enqueue(bytes.subarray(32768));},cancel(){cancelled=true;}}),
        {headers:mode==='header'?{'content-length':'65537'}:{}});
    };
    const report=await f.client().doctor();assert.equal(lookups,1);
    if(mode==='exact'){assert.equal(report.sender,'approved');assert.deepEqual(report.issues,[]);}
    else {unavailable(report);assert(cancelled,mode);}
  }
}));

test('metadata limits also bound health and error responses, and cannot raise the transport ceiling',()=>fixture(async f=>{
  let cancelled=false,calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'65537'}});};
  unavailable(await f.client().doctor());assert.equal(calls,1);assert(cancelled);
  calls=0;
  for(const maxResponseBytes of [0,-1,0.5,NaN,Infinity,524289])await assert.rejects(relayJSON(f.config,'/v1/health',{}, {maxResponseBytes}),/Invalid relay response limit/);
  assert.equal(calls,0);
  const routes:string[]=[];
  globalThis.fetch=async url=>{
    const route=new URL(String(url)).pathname;routes.push(route);
    return route==='/v1/health'?health():new Response(padding({code:'SENDER_NOT_FOUND'},65537),{status:404});
  };
  unavailable(await f.client().doctor());assert.deepEqual(routes,['/v1/health',f.route]);
}));

test('old-server fallback retains the existing 512 KiB total response bound',()=>fixture(async f=>{
  for(const size of [524288,524289]) {
    let cancelled=false;
    globalThis.fetch=async url=>{
      const route=new URL(String(url)).pathname;
      if(route==='/v1/health')return health();if(route===f.route)return new Response(null,{status:404});
      const value=padding({senders:[f.row()]},size);
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(value));if(size===524288)c.close();},cancel(){cancelled=true;}}));
    };
    const report=await f.client().doctor();
    if(size===524288){assert.equal(report.sender,'approved');assert.deepEqual(report.issues,[]);}else {unavailable(report);assert(cancelled);}
  }
}));

test('one deadline covers health, exact lookup and the legacy body, including the default 15-second ceiling',{timeout:5000},t=>fixture(async f=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  for(const budget of [120,15000]) {
    let cancelled=false,bodyRead=false;
    const routes:string[]=[];
    globalThis.fetch=async url=>{
      const route=new URL(String(url)).pathname;routes.push(route);
      if(route==='/v1/health'){t.mock.timers.tick(budget/3);return health();}
      if(route===f.route){t.mock.timers.tick(budget/3);return new Response(null,{status:404});}
      return new Response(new ReadableStream({pull(){bodyRead=true;t.mock.timers.tick(budget/3);return new Promise(()=>{});},cancel(){cancelled=true;}}));
    };
    const start=Date.now(),report=await f.client().doctor(budget===120?{deadline:start+budget}:{});
    unavailable(report);assert.equal(Date.now()-start,budget);assert(bodyRead);assert(cancelled);
    assert.deepEqual(routes,['/v1/health',f.route,'/v1/senders']);
  }
}));

test('cancellation propagates through exact and fallback headers/bodies without another request',()=>fixture(async f=>{
  for(const target of ['exact','legacy'])for(const phase of ['headers','body']) {
    const controller=new AbortController(),reason=new Error('User cancelled');let cancelled=false,aborted=false;
    const routes:string[]=[];
    globalThis.fetch=async(url,init)=>{
      const route=new URL(String(url)).pathname;routes.push(route);
      if(route==='/v1/health')return health();if(target==='legacy' && route===f.route)return new Response(null,{status:404});
      init!.signal!.addEventListener('abort',()=>{aborted=true;},{once:true});
      if(phase==='headers'){controller.abort(reason);return new Promise(()=>{});}
      return new Response(new ReadableStream({pull(){controller.abort(reason);return new Promise(()=>{});},cancel(){cancelled=true;}}));
    };
    await assert.rejects(f.client().doctor({signal:controller.signal}),error=>error===reason);assert(aborted);
    if(phase==='body')assert(cancelled);
    assert.deepEqual(routes,['/v1/health',f.route,...(target==='legacy'?['/v1/senders']:[])]);
  }
  let called=false;globalThis.fetch=async()=>{called=true;return health();};
  await assert.rejects(f.client().doctor({signal:AbortSignal.abort()}));assert(!called);
  unavailable(await f.client().doctor({deadline:Date.now()-1}));assert(!called);
}));

test('v2 diagnostics preserve signed recipient discovery and saved rollback protection',()=>fixture(async f=>{
  let generation=4,badBinding=false,failDiscovery=false,signatures=0;
  const config={...f.config,requestProtocol:2 as const,minimumRecipientGeneration:4},client=f.client(config),routes:string[]=[];
  globalThis.fetch=async(url,init)=>{
    const u=new URL(String(url));routes.push(u.pathname);
    if(u.pathname==='/v1/health')return health();if(u.pathname===f.route)return Response.json({sender:f.row()});
    assert.equal(u.pathname,'/v2/recipients');assert.equal(u.searchParams.get('deviceId'),f.config.device.id);
    const h=new Headers(init?.headers),input=`nb1|http|GET|${u.pathname}${u.search}|${h.get('X-Sender-Timestamp')}|${h.get('X-Sender-Nonce')}|${toHex(await sha256(new Uint8Array()))}`;
    assert.equal(h.get('X-Sender-Key-ID'),f.sender.senderKeyId);
    assert(await ecdsaVerify(f.sender.publicKeyB64u,new TextEncoder().encode(input),h.get('X-Sender-Signature')!));signatures++;
    if(failDiscovery)return Response.json({code:'GROUP_DELIVERY_NOT_ENABLED'},{status:426});
    return Response.json({v:2,deviceId:f.config.device.id,generation,
      primary:{deviceId:badBinding?'dev_'+'0'.repeat(24):f.config.device.id,encPub:f.config.device.encPub,sigPub:f.config.device.sigPub},companions:[]});
  };
  assert.equal((await client.doctor()).recipientCount,1);
  const store=new RecipientStore(config,f.root),saved=store.read();assert.equal(saved?.generation,4);
  for(const mode of ['rollback','binding','unavailable']) {
    generation=mode==='rollback'?3:5;badBinding=mode==='binding';failDiscovery=mode==='unavailable';
    const report=await client.doctor();assert.equal(report.requestProtocol,2);assert.equal(report.recipientCount,null);assert(report.issues.length);assert.deepEqual(store.read(),saved);
  }
  assert.equal(signatures,4);assert(!routes.includes('/v1/senders'));assert(!routes.includes('/v1/recipients'));
}));

test('v2 discovery consumes the same remaining diagnostics deadline',{timeout:5000},t=>fixture(async f=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  let cancelled=false,bodyRead=false;const routes:string[]=[];
  globalThis.fetch=async url=>{
    const route=new URL(String(url)).pathname;routes.push(route);
    if(route==='/v1/health'){t.mock.timers.tick(40);return health();}
    if(route===f.route){t.mock.timers.tick(40);return Response.json({sender:f.row()});}
    return new Response(new ReadableStream({pull(){bodyRead=true;t.mock.timers.tick(40);return new Promise(()=>{});},cancel(){cancelled=true;}}));
  };
  const start=Date.now(),report=await f.client({requestProtocol:2}).doctor({deadline:start+120});
  assert.equal(report.sender,'approved');assert.equal(report.requestProtocol,2);assert.equal(report.recipientCount,null);assert(report.issues.length);
  assert.equal(Date.now()-start,120);assert(bodyRead);assert(cancelled);
  assert.deepEqual(routes,['/v1/health',f.route,'/v2/recipients']);assert.equal(new RecipientStore(f.config,f.root).read(),undefined);
}));

test('real localhost HTTP handles new and old relays and refuses redirects',{timeout:10000},()=>fixture(async f=>{
  let mode='direct',unexpected=0;const routes:string[]=[];
  const server=createServer((req,res)=>{
    routes.push(req.url!);
    if(req.headers.authorization!=='Bearer '+f.config.token){unexpected++;res.writeHead(401).end();return;}
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/health'){res.end(JSON.stringify({status:'healthy'}));return;}
    if(req.url===f.route){
      if(mode==='legacy'){res.writeHead(404).end(JSON.stringify({error:'Not found'}));return;}
      if(mode==='redirect'){res.writeHead(302,{location:'/forbidden'}).end();return;}
      if(mode==='oversize'){const value=padding({sender:f.row()},65537);res.write(value.slice(0,32768));res.end(value.slice(32768));return;}
      res.end(JSON.stringify({sender:f.row()}));return;
    }
    if(req.url==='/v1/senders' && mode==='legacy'){res.end(JSON.stringify({senders:[f.row()]}));return;}
    unexpected++;res.writeHead(500).end();
  });
  try {
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert(address && typeof address==='object');
    const client=f.client({relay:`http://127.0.0.1:${address.port}`});
    for(mode of ['direct','legacy','redirect','oversize']) {
      routes.length=0;const report=await client.doctor();
      if(['redirect','oversize'].includes(mode))unavailable(report);else {assert.equal(report.sender,'approved');assert.deepEqual(report.issues,[]);}
      assert.deepEqual(routes,['/v1/health',f.route,...(mode==='legacy'?['/v1/senders']:[])]);
    }
    assert.equal(unexpected,0);
  }finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}));
