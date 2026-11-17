import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DestinationStore, senderLabel } from '../src/config.js';
import { parseRoutingArgs, createDestinationRouter } from '../src/routing.js';
import { createMcpServer } from '../src/mcp.js';
import { NotiBuddyClient } from '../src/client.js';
import { PendingStore } from '../src/pending-store.js';
import { generateReplyKeyPair, generateSenderSigningKeyPair, deriveDeviceId, hpkeOpen } from '../src/crypto.js';
import { buildRequestHeader, sealReply } from '../src/protocol.js';
import type { PairingBundle, RequestEnvelope, ReplyEnvelope } from '../src/types.js';
process.env.NOTIBUDDY_NO_UPDATE_CHECK = '1'; // tests never contact the npm registry

const root=fs.mkdtempSync(path.join(os.tmpdir(),'nb-destinations-')), originalFetch=globalThis.fetch;
const clients:Client[]=[];
try {
  const store=new DestinationStore(root);
  const phone=async(name:string)=>{
    const enc=await generateReplyKeyPair(),sig=await generateSenderSigningKeyPair();
    const bundle:PairingBundle={v:1,relay:'https://relay.test',token:'nb_snd_fixture_'+name,
      pairSecret:Buffer.alloc(32).toString('base64url'),device:{id:await deriveDeviceId(enc.publicKeyB64u,sig.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:sig.publicKeyB64u,name}};
    return {bundle,enc,sig};
  };
  const personal=await phone('Personal'), work=await phone('Work');
  const a=await store.prepare('personal',personal.bundle,'My Mac'), b=await store.prepare('work',work.bundle,'My Mac');
  assert.notEqual(a.record.keys.senderKeyId,b.record.keys.senderKeyId,'Each destination has an independent connection key');
  assert.equal((await store.prepare('personal',personal.bundle,'My Mac')).record.connectionId,a.record.connectionId,'Pairing retries retain identity');
  await assert.rejects(store.prepare('personal',work.bundle,'My Mac'),/already names a different pairing/);
  assert.equal((await store.open('personal')).record.config.device.id,personal.bundle.device.id);
  await assert.rejects(store.prepare('../escape',work.bundle,'My Mac'));
  assert.throws(()=>senderLabel('bad\nlabel')); assert.throws(()=>senderLabel('bad\u202Elabel'));
  assert.equal(senderLabel(),os.hostname());
  assert.throws(()=>parseRoutingArgs(['mcp','--to','personal','--allow-to','work']),/not both/);
  assert.throws(()=>parseRoutingArgs(['mcp','--to','personal','--to','work']),/only once/);
  assert.deepEqual(parseRoutingArgs(['ask','Hello','--to=personal','--sender','CI runner']),{options:{to:'personal',sender:'CI runner'},rest:['ask','Hello']});
  await assert.rejects(createDestinationRouter({},store),/explicitly/);
  await assert.rejects(createDestinationRouter({to:'missing'},store),/not paired/);
  const competing=await Promise.allSettled([store.prepare('race',personal.bundle,'Race'),store.prepare('race',work.bundle,'Race')]);
  assert.equal(competing.filter(r=>r.status==='fulfilled').length,1,'Concurrent pairing cannot replace an alias');
  await store.open('race');
  const safe=JSON.stringify(store.list()); assert.ok(!safe.includes('privateKey')&&!safe.includes('nb_snd_fixture_'));

  const requests:RequestEnvelope[]=[], replies=new Map<string,ReplyEnvelope>(); let fetches=0;
  globalThis.fetch=async(input,init)=>{
    fetches++;
    if(init?.method==='POST') {const request=JSON.parse(String(init.body));requests.push(request);return Response.json({requestId:request.requestId,seq:requests.length},{status:202});}
    const requestId=new URL(String(input)).pathname.split('/').at(-1)!;
    return replies.has(requestId)?Response.json({...replies.get(requestId),seq:requests.findIndex(r=>r.requestId===requestId)+1}):new Response(null,{status:204});
  };
  const payload=async(request:RequestEnvelope)=>{
    const target=request.deviceId===personal.bundle.device.id?personal:work;
    return JSON.parse(await hpkeOpen(target.enc.privateKey,request.enc,'notibuddy/v1/request',buildRequestHeader(request.requestId,request.deviceId,request.senderKeyId,request.primitive,request.createdAt,request.expiresAt),request.ct));
  };
  const reply=async(request:RequestEnvelope)=>{
    const target=request.deviceId===personal.bundle.device.id?personal:work;
    replies.set(request.requestId,await sealReply({requestId:request.requestId,deviceId:request.deviceId,deviceSigningPrivateKey:target.sig.privateKey,replyPublicKey:(await payload(request)).replyPub,answer:{action:'approve'}}));
  };
  const connect=async(options:Parameters<typeof createMcpServer>[0])=>{
    const server=await createMcpServer(options,store),client=new Client({name:'fixture',version:'1'},{capabilities:{}});
    const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);clients.push(client);return client;
  };
  const mcp=await connect({allowTo:['personal','work'],sender:'Deployment script'});
  const tools=await mcp.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name),['notibuddy_notify','notibuddy_activity','notibuddy_files','notibuddy_list_destinations']);
  assert.ok(tools.tools.find(t=>t.name==='notibuddy_notify')!.inputSchema.required!.includes('to'));
  assert.ok(tools.tools.find(t=>t.name==='notibuddy_files')!.inputSchema.required!.includes('to'));
  const call=async(client:Client,name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
  const json=(result:any)=>JSON.parse(result.content[0].text);
  const text=(result:any)=>result.content[0].text as string;
  const listed=json(await call(mcp,'notibuddy_list_destinations',{}));
  assert.deepEqual(listed.map((d:any)=>d.to),['personal','work']);assert.ok(listed.every((d:any)=>d.acceptsNewMessages===false));
  for(const args of [{title:'No destination',options:['Go'],wait_seconds:0},{to:'race',title:'Hidden',options:['Go'],wait_seconds:0},{to:5,title:'Bad',options:['Go'],wait_seconds:0}]) {
    assert.equal((await call(mcp,'notibuddy_notify',args)).isError,true);
  }
  assert.equal((await call(mcp,'notibuddy_files',{action:'list',to:'race'})).isError,true);
  assert.equal((await call(mcp,'notibuddy_files',{action:'receive',id:'file_'+'a'.repeat(32)})).isError,true);
  const retiredAsk=await call(mcp,'notibuddy_ask',{to:'work',title:'Old'});
  assert.equal(retiredAsk.isError,true);assert.match(text(retiredAsk),/notibuddy_notify/);
  const retiredList=await call(mcp,'notibuddy_files_list',{to:'work'});
  assert.equal(retiredList.isError,true);assert.match(text(retiredList),/notibuddy_files.*"action": "list"/);
  const retiredReceive=await call(mcp,'notibuddy_files_receive',{to:'work',id:'file_'+'a'.repeat(32)});
  assert.equal(retiredReceive.isError,true);assert.match(text(retiredReceive),/notibuddy_files.*"action": "receive"/);
  const waitOnOneWay=await call(mcp,'notibuddy_notify',{to:'work',title:'One-way?',wait_seconds:10});
  assert.equal(waitOnOneWay.isError,true);assert.match(text(waitOnOneWay),/options|fields/);
  const badTimeout=await call(mcp,'notibuddy_notify',{to:'work',title:'Too long',timeout_seconds:99999});
  assert.equal(badTimeout.isError,true);assert.match(text(badTimeout),/Invalid timeout_seconds:/);assert.ok(!text(badTimeout).includes('"origin"'));
  assert.equal(fetches,0,'Routing and validation errors never dispatch or poll');
  const pending=json(await call(mcp,'notibuddy_notify',{to:'work',title:'Deploy?',options:['Approve','Deny'],wait_seconds:0}));
  assert.equal(pending.to,'work'); assert.equal(requests[0].deviceId,work.bundle.device.id);
  assert.deepEqual((await payload(requests[0])).source,{label:'Deployment script'});
  assert.ok(!JSON.stringify(requests[0]).includes('Deployment script'),'Sender label remains encrypted');
  await reply(requests[0]);
  const before=fetches;
  assert.equal((await call(mcp,'notibuddy_notify',{to:'personal',resume_id:pending.requestId,wait_seconds:0})).isError,true);
  assert.equal(fetches,before,'Wrong destination cannot poll or consume another connection reply');
  assert.equal(json(await call(mcp,'notibuddy_notify',{to:'work',resume_id:pending.requestId,wait_seconds:0})).status,'resolved');
  const pinned=await connect({to:'personal',sender:'Coding assistant'});
  const pinnedTools=await pinned.listTools();
  assert.equal('to' in (pinnedTools.tools.find(t=>t.name==='notibuddy_notify')!.inputSchema.properties ?? {}),false,'Pinned mode omits to from advertised schema');
  assert.equal((await call(pinned,'notibuddy_notify',{to:'work',title:'Escape',options:['Approve'],wait_seconds:0})).isError,true);
  assert.equal(json(await call(pinned,'notibuddy_notify',{title:'Pinned',options:['Approve'],wait_seconds:0})).to,'personal');
  const notified=json(await call(pinned,'notibuddy_notify',{title:'Bead closed',message:'crucible-123'}));
  assert.equal(notified.to,'personal');
  assert.equal(notified.status,'delivered');
  assert.deepEqual((await payload(requests.at(-1)!)).options,[]);
  const beforeRename=requests.at(-2)!;
  store.rename('personal','phone');
  await store.prepare('personal',work.bundle,'Replacement');
  await call(pinned,'notibuddy_notify',{title:'Still pinned',options:['Approve'],wait_seconds:0});
  assert.equal(requests.at(-1)!.deviceId,beforeRename.deviceId,'Running MCP keeps its original binding after alias reuse');
  await reply(beforeRename);
  const renamed=(await createDestinationRouter({to:'phone'},store)).resolve();
  assert.equal((await renamed.client.ask({resumeId:beforeRename.requestId,waitSeconds:0})).status,'resolved','Renaming retains pending replies');
  await renamed.client.activity({activityId:'job',action:'start',title:'Job'});
  const originalSource=(await payload(requests.at(-1)!)).source;
  const changedLabel=(await createDestinationRouter({to:'phone',sender:'Another label'},store)).resolve();
  await changedLabel.client.activity({activityId:'job',action:'update',status:'Progress'});
  assert.deepEqual((await payload(requests.at(-1)!)).source,originalSource,'Activity updates retain original source');
  assert.equal((await store.open('phone')).record.keys.senderKeyId,a.record.keys.senderKeyId,'Display labels never change connection keys');

  const brokenRoot=path.join(root,'broken'), brokenStore=new DestinationStore(brokenRoot);fs.mkdirSync(path.join(brokenRoot,'destinations'),{recursive:true});
  fs.writeFileSync(path.join(brokenRoot,'destinations','broken.json'),'invalid');
  await assert.rejects(brokenStore.open('broken'),/unreadable/);
  assert.equal(fs.readFileSync(path.join(brokenRoot,'destinations','broken.json'),'utf8'),'invalid','Corrupt credentials are never overwritten');
  if(process.platform!=='win32') for(const name of fs.readdirSync(path.join(root,'destinations'))) assert.equal(fs.statSync(path.join(root,'destinations',name)).mode&0o777,0o600);
  const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const run=(args:string[],home=root)=>spawnSync(process.execPath,['--import','tsx',cli,...args],{env:{...process.env,NOTIBUDDY_HOME:home,NOTIBUDDY_NO_UPDATE_CHECK:'1'},encoding:'utf8',timeout:15000});
  assert.equal(run(['--version']).status,0);assert.match(run(['--version']).stdout,/^notibuddy \d+\.\d+\.\d+/);
  assert.equal(run(['notify','--help']).status,0);assert.match(run(['notify','--help']).stdout,/nb notify/);
  assert.equal(run(['devices','list']).status,0);
  const statusOut=run(['status','--to','phone']);assert.equal(statusOut.status,0);assert.equal(JSON.parse(statusOut.stdout).fileReceiving,true);
  const unspecified=run(['notify','Never send']);assert.equal(unspecified.status,1);assert.match(unspecified.stderr,/--to/);
  const retiredCli=run(['ask','Deploy?','--to','phone']);assert.equal(retiredCli.status,1);assert.match(retiredCli.stderr,/nb notify --to phone "Deploy\?" --options "Approve,Reject"/);
  const guessedCmd=run(['ping']);assert.equal(guessedCmd.status,1);assert.match(guessedCmd.stderr,/nb doctor/);
  const unsupported=run(['notify','Never send','--to','phone','--profile','hidden']);assert.equal(unsupported.status,1);assert.match(unsupported.stderr,/Unknown option/);
  const badTimeoutCli=run(['notify','Hi','--to','phone','--timeout','99999']);assert.equal(badTimeoutCli.status,1);assert.match(badTimeoutCli.stderr,/Invalid --timeout:/);assert.ok(!badTimeoutCli.stderr.includes('"origin"'));
  const badNameCli=run(['pair','--to','BAD_NAME']);assert.equal(badNameCli.status,1);assert.ok(!badNameCli.stderr.includes('"origin"'));assert.match(badNameCli.stderr,/lowercase letters/);
  const emptyOptionLabel=run(['notify','Never send','--to','phone','--options',',']);assert.equal(emptyOptionLabel.status,1);
  const trailingCommaOption=run(['notify','Never send','--to','phone','--options','Approve,']);assert.equal(trailingCommaOption.status,1);
  const noMcpRoute=run(['mcp']);assert.equal(noMcpRoute.status,1);assert.match(noMcpRoute.stderr,/explicitly/);
  const removed=run(['devices','migrate','--to','imported']);assert.equal(removed.status,1);assert.match(removed.stderr,/nb pair --to imported/);
  assert.ok(!JSON.stringify(run(['devices','list'])).includes('privateKeyJwk'));

  // Single-destination CLI auto-selection (when only 1 phone is paired) keeps stderr clean.
  const singleHome=path.join(root,'single'), singleStore=new DestinationStore(singleHome);
  await singleStore.prepare('solo',personal.bundle,'Solo Mac');
  const soloStatus=run(['doctor'],singleHome); // fails network because relay.test is unreachable, but auto-selected 'solo'
  assert.equal(soloStatus.stderr,'');
  assert.equal(JSON.parse(soloStatus.stdout).to,'solo');
  // --message value starting with -- is accepted instead of rejected as missing value.
  assert.match(run(['notify','Dash msg','--message','--flag-value','--wait','10'],singleHome).stderr,/One-way notifications/);
  console.log('Destination/MCP integration passed: explicit routing, allowlist, pinning, encrypted labels, independent keys, concurrent creation, rename, reply isolation, activity continuity.');
} finally {for(const client of clients)await client.close();globalThis.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});}
