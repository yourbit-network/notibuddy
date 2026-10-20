// Installed-artifact smoke reused from the accepted Linux 0.2.6 lane.
// Synthetic local phone responses only; no real relay, Apple device or APNs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
function gate() { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; }
async function within(promise,phase) {
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Installed file cancellation did not finish'),{name:phase+'Timeout'})),3000);})]);}
 finally{clearTimeout(timer);}
}
export async function fixture({installed,temporary,env,run,version,inspectStorage}) {
 const sha=b=>createHash('sha256').update(b).digest('hex'),api=await import(pathToFileURL(path.join(installed,'dist/index.js')).href);
 const req=createRequire(path.join(installed,'package.json'));const {Client}=await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href);const {StdioClientTransport}=await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
 const registrations=[],requests=[],unexpected=[],clients=[],replies=new Map(),files=new Map(),records=new Map(),counts={downloads:0,acks:0,signedFileHTTP:0,requestSignatures:0};
 const server=http.createServer(async(request,response)=>{try{
  const chunks=[];for await(const c of request)chunks.push(c);const raw=Buffer.concat(chunks).toString(),body=raw?JSON.parse(raw):undefined,url=new URL(request.url,'http://127.0.0.1');
  const json=(status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
  if(request.method==='POST'&&url.pathname==='/v1/senders'){registrations.push(body);json(200,{status:'registered',senderKeyId:body.senderKeyId});}
  else if(request.method==='POST'&&url.pathname==='/v1/requests') {const sender=registrations.find(v=>v.senderKeyId===body.senderKeyId);assert(sender);const header=api.buildRequestHeader(body.requestId,body.deviceId,body.senderKeyId,body.primitive,body.createdAt,body.expiresAt);assert(await api.ecdsaVerify(sender.senderPub,Buffer.concat([Buffer.from(header),Buffer.from([0]),Buffer.from(body.enc,'base64url'),Buffer.from(body.ct,'base64url')]),body.sig));counts.requestSignatures++;requests.push(body);json(202,{requestId:body.requestId,seq:requests.length});}
  else if(request.method==='GET'&&url.pathname.startsWith('/v1/replies/')){const reply=replies.get(url.pathname.split('/').pop());if(reply && reply.seq>Number(url.searchParams.get('afterSeq')||0))json(200,reply);else{response.writeHead(204);response.end();}}
  else if(url.pathname==='/v1/files'||url.pathname.startsWith('/v1/files/')){
   const record=records.get(request.headers['x-sender-id']);assert(record);assert.equal(request.headers.authorization,'Bearer '+record.config.token);const route=url.pathname.slice(3);assert(await api.ecdsaVerify(record.keys.publicKeyB64u,Buffer.from(`nb1|http|${request.method}|${route}|${request.headers['x-sender-timestamp']}|${request.headers['x-sender-nonce']}|${sha(raw)}`),request.headers['x-sender-signature']));counts.signedFileHTTP++;
   if(route==='/files'){json(200,{files:[...files.values()].filter(f=>f.m.senderKeyId===record.keys.senderKeyId).map(f=>({id:f.m.id,status:'ready',expiresAt:f.m.expiresAt,size:f.m.size}))});}
   else {const file=files.get(route.split('/')[2]);assert(file);assert.equal(file.m.senderKeyId,record.keys.senderKeyId);if(route.endsWith('/ack')){counts.acks++;file.acks++;assert.equal(body.sha256,file.m.sha256);const inbox=new api.FileInbox(record,null,env.NOTIBUDDY_HOME);const saved=path.join(inbox.directory,file.m.id,'_report.txt');assert.equal(fs.readFileSync(saved,'utf8'),file.text);if(file.loseFirstAck&&file.acks===1){response.destroy();return;}if(file.holdAck){response.writeHead(200,{'content-type':'application/json'});response.on('close',file.holdAck.closed.resolve);response.write('{');file.holdAck.started.resolve();return;}json(200,{status:'delivered'});}else{counts.downloads++;file.downloads++;response.writeHead(200,{'X-File-Manifest':Buffer.from(JSON.stringify(file.m)).toString('base64url')});if(file.holdDownload){response.on('close',file.holdDownload.closed.resolve);response.write(file.ct.subarray(0,1));file.holdDownload.started.resolve();return;}response.end(file.ct);}}
  }else{unexpected.push({method:request.method,route:url.pathname});response.writeHead(404);response.end();}
 }catch(e){unexpected.push({error:e.name,message:String(e.message).slice(0,180)});if(!response.headersSent)response.writeHead(500);response.end();}});
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Parent fetch denied during fixture');};
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const relay=`http://127.0.0.1:${server.address().port}`,guard=path.join(temporary,'loopback-only.mjs'),audit=path.join(temporary,'audit.jsonl');
  fs.writeFileSync(guard,`import {appendFileSync} from 'node:fs';const original=globalThis.fetch;let calls=0,blocked=0;globalThis.fetch=async(url,options)=>{if(new URL(String(url)).origin!==${JSON.stringify(relay)}){blocked++;throw Error('Blocked non-loopback fetch');}calls++;return original(url,options);};process.on('exit',()=>appendFileSync(${JSON.stringify(audit)},JSON.stringify({calls,blocked})+'\\n'));`,{mode:0o600});
  const cli=path.join(installed,'dist/cli.js');const cliCall=async(label,args)=>run(label,process.execPath,['--import',pathToFileURL(guard).href,cli,...args],{env});const cliJSON=async(label,args)=>JSON.parse((await cliCall(label,args)).stdout);
  async function phone(name){const enc=await api.generateReplyKeyPair(),sig=await api.generateSenderSigningKeyPair();const device={id:await api.deriveDeviceId(enc.publicKeyB64u,sig.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:sig.publicKeyB64u,name};const bundle='nbpair1.'+Buffer.from(JSON.stringify({v:1,relay,token:'nb_snd_installed_fixture_'+name,pairSecret:Buffer.alloc(32).toString('base64url'),device})).toString('base64url');return{enc,sig,device,bundle};}
  const personal=await phone('personal'),work=await phone('work');
  for(const p of [personal,work]){const paired=await cliCall('pair-'+p.device.name,['pair',p.bundle,'--to',p.device.name,'--label','Installed release fixture','--wait','0']);assert.match(paired.stdout,/Pairing confirmed/);assert.deepEqual(JSON.parse(paired.stdout.split('MCP configuration:\n')[1]).mcpServers.notibuddy.args,['-y','notibuddy@^'+version,'mcp','--to',p.device.name]);const record=new api.DestinationStore(env.NOTIBUDDY_HOME).read(p.device.name);p.record=record;records.set(record.keys.senderKeyId,record);}
  const start=await cliJSON('cli-encrypted-request',['ask','CLI fixture','--to','personal','--sender','Installed CLI','--wait','0']);assert.equal(start.status,'pending');
  const client=new Client({name:'installed-public-acceptance',version:'1'},{capabilities:{}});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(guard).href,path.join(installed,'dist/mcp-entry.js'),'--to','work','--sender','Installed MCP'],cwd:temporary,env,stderr:'pipe'});let mcpErrors='';transport.stderr?.on('data',c=>mcpErrors+=c.toString());await client.connect(transport,{timeout:10000});
  const call=async(name,args)=>{const response=await client.callTool({name,arguments:args},undefined,{timeout:10000});assert(!response.isError,JSON.stringify(response));return JSON.parse(response.content[0].text);};
  const tools=await client.listTools(),ask=tools.tools.find(t=>t.name==='notibuddy_ask');assert.equal(ask.inputSchema.properties.timeout_seconds.default,10800);assert.equal(ask.inputSchema.properties.timeout_seconds.maximum,10800);assert.deepEqual((await call('notibuddy_list_destinations',{})).map(v=>v.to),['work']);assert.equal((await client.callTool({name:'notibuddy_ask',arguments:{to:'personal',title:'wrong',wait_seconds:0}})).isError,true);assert.equal(requests.length,1);
  const mcpStart=await call('notibuddy_ask',{title:'MCP fixture',wait_seconds:0});assert.equal(mcpStart.status,'pending');assert.equal(requests.length,2);
  await inspectStorage?.('pending');
  for(const [i,p,title,sender] of [[0,personal,'CLI fixture','Installed CLI'],[1,work,'MCP fixture','Installed MCP']]){const r=requests[i];assert.equal(r.deviceId,p.device.id);assert.equal(r.expiresAt-r.createdAt,10800);const payload=JSON.parse(await api.hpkeOpen(p.enc.privateKey,r.enc,'notibuddy/v1/request',api.buildRequestHeader(r.requestId,r.deviceId,r.senderKeyId,r.primitive,r.createdAt,r.expiresAt),r.ct));assert.equal(payload.title,title);assert.equal(payload.source.label,sender);assert(!JSON.stringify(r).includes(title));assert(!JSON.stringify(r).includes(sender));const signed=await api.sealReply({requestId:r.requestId,deviceId:p.device.id,deviceSigningPrivateKey:p.sig.privateKey,replyPublicKey:payload.replyPub,answer:{action:'approve',values:{text:'Installed signed reply'}}});replies.set(r.requestId,{...signed,seq:1});}
  const good=replies.get(start.requestId);replies.set(start.requestId,{...good,sig:'A'.repeat(86)});const invalid=await cliJSON('cli-invalid-signature-retains-key',['ask','--resume',start.requestId,'--to','personal','--wait','0']);assert.equal(invalid.status,'pending');assert.equal(invalid.errorCode,'RETRY_REQUIRED');replies.set(start.requestId,good);const resumed=await cliJSON('cli-restart-signed-reply',['ask','--resume',start.requestId,'--to','personal','--wait','0']);assert.equal(resumed.status,'resolved');assert.equal(resumed.answer.action,'approve');assert.equal(resumed.answer.values.text,'Installed signed reply');const mcpReply=await call('notibuddy_ask',{resume_id:mcpStart.requestId,wait_seconds:0});assert.equal(mcpReply.status,'resolved');assert.equal(mcpReply.answer.action,'approve');
  const activityResults=[];
  async function openActivity(p) {
    const r=requests.at(-1);assert.equal(r.deviceId,p.device.id);
    const payload=JSON.parse(await api.hpkeOpen(p.enc.privateKey,r.enc,'notibuddy/v1/request',api.buildRequestHeader(r.requestId,r.deviceId,r.senderKeyId,r.primitive,r.createdAt,r.expiresAt),r.ct));
    return {r,payload};
  }
  for(const [surface,p,baseSeq] of [['CLI',personal,101],['MCP',work,201]]) {
    const id='default-timer-'+surface.toLowerCase();
    const activity=async(action,extra={})=>surface==='CLI'
      ? cliJSON('timer-'+surface+'-'+action,['activity',id,action,'--to',p.device.name,...(extra.title?['--title',extra.title]:[]),...(extra.timer_minutes?['--timer',String(extra.timer_minutes)]:[]),...(extra.status?['--status',extra.status]:[])])
      : call('notibuddy_activity',{id,action,...extra});
    assert.equal((await activity('start',{title:'Installed timer',timer_minutes:30})).status,'dispatched');
    const started=await openActivity(p),allowed=['pause','resume','add_5m','cancel'];
    assert.deepEqual(started.payload.controls,allowed);
    async function answer(item,action,values,seq) {
      replies.set(item.r.requestId,{...await api.sealReply({requestId:item.r.requestId,deviceId:p.device.id,deviceSigningPrivateKey:p.sig.privateKey,replyPublicKey:item.payload.replyPub,answer:{action,values}}),seq});
    }
    await answer(started,'pause',{state:'paused',remainingSeconds:1200},baseSeq);
    const paused=await activity('poll');assert.equal(paused.controls.length,1);assert.equal(paused.controls[0].action,'pause');
    await activity('update',{status:'Paused acknowledgement'});
    const updated=await openActivity(p);assert.deepEqual(updated.payload.controls,allowed);assert.equal(updated.payload.state,'paused');assert.equal(updated.payload.remainingSeconds,1200);
    const target=Math.floor(Date.now()/1000)+1200;
    await answer(updated,'resume',{state:'running',targetTimestamp:target},baseSeq+1);
    const resumed=await activity('poll');assert.equal(resumed.controls.length,1);assert.equal(resumed.controls[0].action,'resume');
    await activity('update',{status:'Resumed acknowledgement'});
    const running=await openActivity(p);assert.deepEqual(running.payload.controls,allowed);assert.equal(running.payload.state,'running');assert.equal(running.payload.timerEndsAt,target);assert.equal(running.payload.remainingSeconds,undefined);
    await activity('end');assert.equal((await activity('poll')).status,'ended');
    activityResults.push({surface,defaultControls:allowed,pauseVerified:true,resumeVerified:true,statePreservedAcrossUpdates:true,ended:true,processRestart:surface==='CLI'});
  }
  await call('notibuddy_activity',{id:'restricted-timer',action:'start',title:'Restricted timer',timer_minutes:30,controls:['cancel']});
  assert.deepEqual((await openActivity(work)).payload.controls,['cancel']);
  await call('notibuddy_activity',{id:'restricted-timer',action:'update',status:'Still restricted'});
  assert.deepEqual((await openActivity(work)).payload.controls,['cancel']);
  await call('notibuddy_activity',{id:'restricted-timer',action:'end'});
  async function file(p,loseFirstAck){const now=Math.floor(Date.now()/1000),text='Synthetic private installed file '+p.device.name,bytes=Buffer.from(text),m={v:1,id:'file_'+randomUUID().replaceAll('-',''),deviceId:p.device.id,senderKeyId:p.record.keys.senderKeyId,fileEncPub:p.record.fileKey.publicKeyB64u,createdAt:now,expiresAt:now+86400,size:bytes.length,cipherSize:0,enc:'',sha256:'',sig:''};const meta=Buffer.from(JSON.stringify({name:'../report.txt',type:'text/plain'})),length=Buffer.alloc(4);length.writeUInt32BE(meta.length);const sealed=await api.hpkeSealBytes(m.fileEncPub,'notibuddy/file/v1',api.fileHeader(m),Buffer.concat([length,meta,bytes]));Object.assign(m,{enc:sealed.enc,cipherSize:sealed.ct.length,sha256:sha(sealed.ct)});m.sig=await api.ecdsaSign(p.sig.privateKey,api.fileSignatureInput(m));const f={m,ct:sealed.ct,text,loseFirstAck,acks:0,downloads:0};files.set(m.id,f);return f;}
  const personalFile=await file(personal,true),workFile=await file(work,false);assert.equal((await cliJSON('cli-files-list',['files','list','--to','personal'])).result[0].id,personalFile.m.id);const saved=(await cliJSON('cli-file-lost-ack',['files','receive',personalFile.m.id,'--to','personal'])).result;assert.equal(saved.status,'saved_pending_receipt');assert.equal(fs.readFileSync(saved.path,'utf8'),personalFile.text);const relative=path.relative(env.NOTIBUDDY_HOME,saved.path);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));assert.equal(path.basename(saved.path),'_report.txt');assert.equal((await cliJSON('cli-file-restart-receipt',['files','receive',personalFile.m.id,'--to','personal'])).result.status,'delivered');assert.equal((await cliJSON('cli-file-idempotent',['files','receive',personalFile.m.id,'--to','personal'])).result.status,'delivered');assert.equal(personalFile.downloads,1);assert.equal(personalFile.acks,2);
  assert.equal((await call('notibuddy_files_list',{})).result[0].id,workFile.m.id);assert.equal((await call('notibuddy_files_receive',{id:workFile.m.id})).result.status,'delivered');assert.equal(workFile.downloads,1);assert.equal(workFile.acks,1);
  const cancelledFile=await file(work,false);
  cancelledFile.holdDownload={started:gate(),closed:gate()};
  const cancelDownload=new AbortController();
  const downloading=client.callTool({name:'notibuddy_files_receive',arguments:{id:cancelledFile.m.id}},undefined,{signal:cancelDownload.signal,timeout:10000});
  void downloading.catch(()=>{});
  await within(cancelledFile.holdDownload.started.promise,'DownloadStart');cancelDownload.abort();await assert.rejects(downloading);
  await within(cancelledFile.holdDownload.closed.promise,'DownloadCancel');
  const workInbox=new api.FileInbox(work.record,null,env.NOTIBUDDY_HOME);
  assert.equal(cancelledFile.acks,0);assert(!fs.existsSync(path.join(workInbox.directory,cancelledFile.m.id)));
  assert(!fs.existsSync(path.join(workInbox.directory,cancelledFile.m.id+'.lock')));
  delete cancelledFile.holdDownload;
  assert.equal((await call('notibuddy_files_receive',{id:cancelledFile.m.id})).result.status,'delivered');
  assert.equal(cancelledFile.downloads,2);assert.equal(cancelledFile.acks,1);

  const cancelledAck=await file(work,false);
  cancelledAck.holdAck={started:gate(),closed:gate()};
  const cancelReceipt=new AbortController();
  const acknowledging=client.callTool({name:'notibuddy_files_receive',arguments:{id:cancelledAck.m.id}},undefined,{signal:cancelReceipt.signal,timeout:10000});
  void acknowledging.catch(()=>{});
  await within(cancelledAck.holdAck.started.promise,'AcknowledgementStart');cancelReceipt.abort();await assert.rejects(acknowledging);
  await within(cancelledAck.holdAck.closed.promise,'AcknowledgementCancel');
  const savedTarget=path.join(workInbox.directory,cancelledAck.m.id);
  assert.equal(fs.readFileSync(path.join(savedTarget,'_report.txt'),'utf8'),cancelledAck.text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(savedTarget,'receipt.json'),'utf8')).delivered,false);
  assert(!fs.existsSync(path.join(workInbox.directory,cancelledAck.m.id+'.lock')));
  delete cancelledAck.holdAck;
  assert.equal((await call('notibuddy_files_receive',{id:cancelledAck.m.id})).result.status,'delivered');
  assert.equal(cancelledAck.downloads,1);assert.equal(cancelledAck.acks,2);
  await inspectStorage?.('received-files');
  await client.close();clients.length=0;assert.equal(mcpErrors,'');assert.deepEqual(unexpected,[]);const modes={files:0,directories:0,temporaryFiles:0,temporaryDirectories:0,lockFiles:0,lockDirectories:0,permissionCheck:process.platform==='win32'?(inspectStorage?'Windows DACLs checked separately':'Windows ACLs not asserted'):'Unix files0600/directories0700'};function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);assert(!entry.isSymbolicLink());const kind=entry.isDirectory()?'Directories':'Files';if(/\.tmp$/i.test(entry.name))modes['temporary'+kind]++;if(/\.lock$/i.test(entry.name))modes['lock'+kind]++;if(entry.isDirectory()){if(process.platform!=='win32')assert.equal(fs.statSync(p).mode&0o777,0o700);modes.directories++;walk(p);}else{if(process.platform!=='win32')assert.equal(fs.statSync(p).mode&0o777,0o600);modes.files++;}}}walk(env.NOTIBUDDY_HOME);for(const key of ['temporaryFiles','temporaryDirectories','lockFiles','lockDirectories'])assert.equal(modes[key],0);
  const auditRows=fs.readFileSync(audit,'utf8').trim().split('\n').map(v=>JSON.parse(v));assert(auditRows.every(v=>v.blocked===0));return{activityResults,explicitRestrictedControlsPreserved:true,registrations:registrations.length,encryptedRequests:requests.length,signedRequestChecks:counts.requestSignatures,signedRepliesResolved:2,invalidReplyPreservedKeyThenResolved:true,CLIProcessRestart:true,requestLifetimeSeconds:10800,generatedMcpVersion:'notibuddy@^'+version,wrongDestinationRejected:true,mcpStdoutProtocolAndStderrClean:true,manualEncryptedFiles:files.size,mcpDownloadCancellationAndRetry:true,mcpAcknowledgementCancellationPreservesFile:true,fileHTTP:counts,savedBeforeAcknowledgement:true,lostFileAckRecoveredAcrossProcessRestart:true,idempotentReceiveWithoutRedownload:true,pathTraversalSanitized:true,privateFilesystem:modes,childFetchAudit:auditRows,loopbackFetches:auditRows.reduce((n,v)=>n+v.calls,0),nonLoopbackFetchAttempts:0,limits:['Synthetic v1 phone responder; no physical Apple device, APNs, StoreKit or production relay','Fetch interception is not an OS packet capture','10800-second wire deadline checked; no new elapsed-duration test','No v2, invitation-first-use or signal/crash matrix in this bounded smoke']};
 }finally{for(const c of clients)await c.close();server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=originalFetch;}
}
