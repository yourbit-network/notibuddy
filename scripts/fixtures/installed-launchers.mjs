// Actual public npx shims and generated MCP configuration, using synthetic phones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {verifyInstalledLock} from '../check-installed-client.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(label)), ms);
  })]).finally(() => clearTimeout(timer));
};

export function observeTransport(transport) {
  // Observe the SDK's raw read boundary, before it consumes complete frames.
  // Fail if the pinned installed SDK no longer exposes this boundary.
  const buffer=transport._readBuffer;
  assert.equal(typeof buffer?.append,'function');
  const original=buffer.append.bind(buffer),chunks=[];let bytes=0;
  buffer.append=chunk=>{
    bytes+=chunk.length;assert(bytes<=2*1024*1024,'Protocol capture limit exceeded');
    chunks.push(Buffer.from(chunk));return original(chunk);
  };
  return ()=>new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}

export function inspectProtocol(text, schema, secrets) {
  assert(text.endsWith('\n'), 'Protocol output must end at a frame boundary');
  const lines = text.slice(0, -1).split('\n');
  assert(lines.length > 0);
  for (const line of lines) schema.parse(JSON.parse(line));
  for (const secret of secrets) assert(!text.includes(secret), 'Synthetic credential appeared in output');
  return lines.length;
}

export async function fixture({installed, temporary, env, version, expected, installedFiles, inspectStorage}) {
  const api = await import(pathToFileURL(path.join(installed, 'dist/index.js')).href);
  const {PendingStore} = await import(pathToFileURL(path.join(installed, 'dist/pending-store.js')).href);
  const require = createRequire(path.join(installed, 'package.json'));
  const {Client} = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const {StdioClientTransport} = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const {JSONRPCMessageSchema} = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href);
  const {default:spawn} = await import(pathToFileURL(require.resolve('cross-spawn')).href);
  const registrations = new Map(), requests = [], replies = new Map(), clients = [], outputs = [], protocolErrors = [];
  const modes = new Map(), stalls = new Map(), dispatchSnapshots = new Map(), failures = [], commands = [], secrets = [], executedPaths=[],shutdowns=[];
  let relay, server, delayedDispatch=false,httpCalls=0,phase='setup',shutdownUnconfirmed=false;
  const lifecycle=path.join(temporary,'launcher-processes.jsonl');
  const childEnv = {...env, npm_config_ignore_scripts:'true',NB_ACCEPTANCE_LIFECYCLE:lifecycle};
  // Use the installed npm's actual shim. Do not replace npx with node npx-cli.js.
  // PATH still contains the Node installation's bin directory.
  const npx = process.platform === 'win32' ? path.join(path.dirname(process.execPath),'npx.cmd')
    : path.join(path.dirname(process.execPath),'npx');
  assert(fs.existsSync(npx), 'The advertised npx shim is not installed beside Node');
  const launcher = {command:'npx',args:['-y','notibuddy@'+version]};
  const guard = path.join(temporary,'launcher-guard.mjs');
  const captures = path.join(temporary,'protocol captures');
  fs.mkdirSync(captures,{mode:0o700});
  async function cli(label,args) {
    const started=Date.now(), commandArgs=[...launcher.args,...args];
    const out = await new Promise((resolve,reject)=>{
      const child=spawn(launcher.command,commandArgs,{cwd:temporary,env:childEnv,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32'});
      let stopping=false;
      const stop=()=>{
        if(!child.pid||stopping)return;
        stopping=true;
        const closing=new Promise(resolve=>child.once('close',resolve));
        let tree=Promise.resolve();
        if(process.platform==='win32'){
          const killer=spawn(path.join(env.SystemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{env,stdio:'ignore',windowsHide:true});
          tree=new Promise((resolve,reject)=>{
            killer.once('error',reject);
            killer.once('close',code=>code===0?resolve():reject(Error('Tree shutdown failed')));
          });
        } else {try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')shutdownUnconfirmed=true;}}
        shutdowns.push(bounded(Promise.all([closing,tree]),5000,'Child shutdown unconfirmed').catch(()=>{shutdownUnconfirmed=true;}));
      };
      const timer=setTimeout(()=>{stop();reject(Error('npx command timed out'));},90000);
      let stdout='',stderr='',bytes=0;
      const collect=which=>chunk=>{
        bytes+=chunk.length;
        if(bytes>1024*1024){stop();reject(Error('CLI output bound exceeded'));return;}
        if(which==='out')stdout+=chunk;else stderr+=chunk;
      };
      child.stdout.on('data',collect('out'));child.stderr.on('data',collect('err'));
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);commands.push({label,exitCode:code,elapsedMs:Date.now()-started,stdoutSHA256:sha(stdout),stderrSHA256:sha(stderr)});
        outputs.push(stdout,stderr);if(code!==0)reject(Error('CLI failed: '+label));else resolve({stdout,stderr});});
    });
    return out;
  }
  const json = result => {assert(!result.isError);return JSON.parse(result.content[0].text);};
  const call = (client,args,options={}) => client.callTool({name:'notibuddy_ask',arguments:args},undefined,{timeout:15000,...options});
  async function connect(config,label) {
    assert.equal(config.command,'npx');
    const capture=path.join(captures,label+'.txt');
    const transport=new StdioClientTransport({...config,cwd:temporary,env:{...childEnv,NB_ACCEPTANCE_CAPTURE:capture},stderr:'pipe'});
    const raw=observeTransport(transport);
    let stderr='';transport.stderr.on('data',chunk=>{
      if(stderr.length+chunk.length>1024*1024){failures.push('Stderr limit');void transport.close();return;}stderr+=chunk;
    });
    const client=new Client({name:'published-launcher-acceptance',version:'1'},{capabilities:{}});
    client.onerror=error=>{
      if(protocolErrors.length<32)protocolErrors.push({name:error.name});
      else void transport.close();
    };
    clients.push({client,capture,raw,stderr:()=>stderr});
    await client.connect(transport,{timeout:90000});
    return client;
  }
  async function signedReply(phone,request) {
    const header=api.buildRequestHeader(request.requestId,request.deviceId,request.senderKeyId,request.primitive,request.createdAt,request.expiresAt);
    const payload=JSON.parse(await api.hpkeOpen(phone.enc.privateKey,request.enc,'notibuddy/v1/request',header,request.ct));
    const reply=await api.sealReply({requestId:request.requestId,deviceId:phone.device.id,deviceSigningPrivateKey:phone.sig.privateKey,replyPublicKey:payload.replyPub,answer:{action:'approve'}});
    replies.set(request.requestId,{...reply,seq:1});return payload;
  }
  try {
    server=http.createServer(async(req,res)=>{
      try {
        httpCalls++;
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const raw=Buffer.concat(chunks).toString(),body=raw?JSON.parse(raw):undefined,url=new URL(req.url,relay);
        const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(value===undefined?'':JSON.stringify(value));};
        if(req.method==='POST'&&url.pathname==='/v1/senders'){registrations.set(body.senderKeyId,body);send(200,{status:'registered',senderKeyId:body.senderKeyId});}
        else if(req.method==='POST'&&url.pathname==='/v1/requests'){
          const sender=registrations.get(body.senderKeyId);assert(sender);
          const header=api.buildRequestHeader(body.requestId,body.deviceId,body.senderKeyId,body.primitive,body.createdAt,body.expiresAt);
          assert(await api.ecdsaVerify(sender.senderPub,Buffer.concat([Buffer.from(header),Buffer.from([0]),Buffer.from(body.enc,'base64url'),Buffer.from(body.ct,'base64url')]),body.sig));
          requests.push(body);
          if(delayedDispatch){
            const phone=phones.find(phone=>phone.device.id===body.deviceId);
            const pending=new PendingStore(phone.record.config,env.NOTIBUDDY_HOME).read('reply:'+body.requestId);
            assert(pending);
            dispatchSnapshots.set(body.requestId,pending);
            secrets.push(pending.privateKeyJwk.d);
            modes.set(body.requestId,'stall');stalls.set(body.requestId,stalls.get('next'));
            await delay(1200);
          }
          send(202,{requestId:body.requestId,seq:requests.length});
        } else if(req.method==='GET'&&url.pathname.startsWith('/v1/replies/')){
          const id=url.pathname.split('/').pop();
          if(modes.get(id)==='stall'){
            const observation=stalls.get(id);res.writeHead(200,{'content-type':'application/json'});res.write('{');
            res.on('close',()=>observation.closed());observation.started();
          } else if(replies.has(id))send(200,replies.get(id));else send(204);
        } else {failures.push('Unexpected route');send(404);}
      } catch(error) {failures.push(error.name);if(!res.headersSent)res.writeHead(500);res.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    relay='http://127.0.0.1:'+server.address().port;
    fs.writeFileSync(guard,`import fs from 'node:fs';import {createHash} from 'node:crypto';const entry=fs.realpathSync(process.argv[1]),life=process.env.NB_ACCEPTANCE_LIFECYCLE;const note=event=>fs.appendFileSync(life,JSON.stringify({event,pid:process.pid,entry})+'\\n',{mode:0o600});note('start');process.on('exit',()=>note('exit'));const original=globalThis.fetch;globalThis.fetch=(url,options)=>{if(new URL(String(url)).origin!==${JSON.stringify(relay)})throw Error('Non-loopback request blocked');return original(url,options);};if(process.env.NB_ACCEPTANCE_CAPTURE){const file=process.env.NB_ACCEPTANCE_CAPTURE;process.on('exit',()=>fs.appendFileSync(file+'.exits',JSON.stringify({entry,sha256:createHash('sha256').update(fs.readFileSync(entry)).digest('hex')})+'\\n',{mode:0o600}));}`,{mode:0o600});
    childEnv.NODE_OPTIONS='--import='+pathToFileURL(guard).href;
    phase='npx-install-help';
    assert.match((await cli('actual-npx-help',['--help'])).stdout,/NotiBuddy CLI/);
    assert.match((await cli('actual-npx-fresh-status',['status'])).stdout,/No named destinations paired/);
    const phones=[];
    phase='npx-pair';
    for(const name of ['personal','work']){
      const enc=await api.generateReplyKeyPair(),sig=await api.generateSenderSigningKeyPair();
      const device={id:await api.deriveDeviceId(enc.publicKeyB64u,sig.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:sig.publicKeyB64u,name};
      const token='nb_snd_launcher_synthetic_'+name,secret=Buffer.alloc(32,name==='personal'?3:4).toString('base64url');
      secrets.push(token,secret);
      const bundle='nbpair1.'+Buffer.from(JSON.stringify({v:1,relay,token,pairSecret:secret,device})).toString('base64url');
      secrets.push(bundle);
      const result=await cli('actual-npx-pair-'+name,['pair',bundle,'--to',name,'--label','Launcher fixture','--wait','0']);
      const config=JSON.parse(result.stdout.split('MCP configuration:\n')[1]).mcpServers.notibuddy;
      assert.deepEqual(config,{command:'npx',args:['-y','notibuddy@^'+version,'mcp','--to',name]});
      const record=new api.DestinationStore(env.NOTIBUDDY_HOME).read(name);
      secrets.push(record.keys.privateKeyJwk.d,record.fileKey.privateKeyJwk.d);
      phones.push({enc,sig,device,config,record});
    }
    await inspectStorage?.('launcher-paired');
    const beforeInvalid=httpCalls;
    phase='generated-mcp';const pinned=await connect(phones[0].config,'generated-pinned');
    assert.deepEqual(json(await pinned.callTool({name:'notibuddy_list_destinations',arguments:{}})).map(x=>x.to),['personal']);
    assert.equal((await call(pinned,{to:'work',title:'Wrong destination',wait_seconds:0})).isError,true);
    phase='selectable-mcp';const selected=await connect({command:'npx',args:['-y','notibuddy@'+version,'mcp','--allow-to','personal','--allow-to=work','--sender','Launcher sender with spaces']},'selectable');
    assert.deepEqual(json(await selected.callTool({name:'notibuddy_list_destinations',arguments:{}})).map(x=>x.to),['personal','work']);
    for(const args of [{title:'Missing destination'},{to:'hidden',title:'Hidden destination'}])assert.equal((await call(selected,args)).isError,true);
    assert.equal(requests.length,0);
    assert.equal(httpCalls,beforeInvalid);
    const start=json(await call(selected,{to:'work',title:'Durable MCP request',wait_seconds:0}));
    const request=requests[0];assert.equal(request.deviceId,phones[1].device.id);assert.equal(request.expiresAt-request.createdAt,10800);
    const store=new PendingStore(phones[1].record.config,env.NOTIBUDDY_HOME);
    const original=JSON.stringify(store.read('reply:'+start.requestId));
    secrets.push(store.read('reply:'+start.requestId).privateKeyJwk.d);
    const beforeWrongResume=httpCalls;
    assert.equal((await call(selected,{to:'personal',resume_id:start.requestId,wait_seconds:1})).isError,true);
    assert.equal(httpCalls,beforeWrongResume);
    function stall(id=start.requestId){
      let started,closed;const began=new Promise(r=>started=r),ended=new Promise(r=>closed=r);
      stalls.set(id,{started,closed});modes.set(id,'stall');return {began,ended};
    }
    phase='shared-deadline';const timed=stall('next');delayedDispatch=true;
    const before=performance.now();
    const timeout=json(await call(selected,{to:'personal',title:'Shared budget',wait_seconds:2}));
    delayedDispatch=false;
    assert.equal(timeout.status,'pending');assert.equal(timeout.errorCode,'WAIT_DEADLINE');
    const elapsed=performance.now()-before;assert(elapsed>=1750&&elapsed<2800,'Whole call exceeded its shared budget');
    await bounded(Promise.all([timed.began,timed.ended]),3000,'Timed-out HTTP body was not cancelled');
    const timedRecord=new PendingStore(phones[0].record.config,env.NOTIBUDDY_HOME).read('reply:'+timeout.requestId);
    for(const field of ['privateKeyJwk','expiresAt','envelope'])
      assert.deepEqual(timedRecord[field],dispatchSnapshots.get(timeout.requestId)[field]);
    await inspectStorage?.('launcher-pending');
    modes.delete(timeout.requestId);
    assert.equal(requests[1].deviceId,phones[0].device.id);
    const personalPayload=await signedReply(phones[0],requests[1]);assert.equal(personalPayload.title,'Shared budget');
    assert.equal(json(await call(pinned,{resume_id:timeout.requestId,wait_seconds:1})).status,'resolved');
    assert.equal(JSON.stringify(store.read('reply:'+start.requestId)),original);
    phase='cancel-resume';const cancelled=stall(),controller=new AbortController();
    const operation=call(selected,{to:'work',resume_id:start.requestId,wait_seconds:55},{signal:controller.signal});
    const rejected=assert.rejects(operation);
    await bounded(cancelled.began,5000,'Cancelled call never reached body');
    const cancellationStart=performance.now();controller.abort();
    await rejected;await bounded(cancelled.ended,3000,'MCP cancellation did not close HTTP body');
    // HTTP abort precedes the finally block which releases the operation lock.
    const operationLocks=()=>fs.readdirSync(store.directory).filter(name=>name.endsWith('.operation.lock'));
    for(let i=0;i<50&&operationLocks().length;i++)await delay(20);
    assert.deepEqual(operationLocks(),[]);
    assert.equal(JSON.stringify(store.read('reply:'+start.requestId)),original);
    modes.delete(start.requestId);
    const payload=await signedReply(phones[1],request);assert.equal(payload.source.label,'Launcher sender with spaces');
    const resumed=json(await call(selected,{to:'work',resume_id:start.requestId,wait_seconds:1}));
    assert.equal(resumed.status,'resolved');assert.equal(resumed.answer.action,'approve');assert.equal(requests.length,2);
    const cancellationMs=performance.now()-cancellationStart;
    // Both supported routing positions and = syntax go through the actual shim.
    phase='cli-flags';for(const [label,args] of [
      ['routing-before-command',['--to','personal','ask','Flag order before','--wait','0']],
      ['routing-after-command',['ask','Flag order after','--wait','0','--to=personal']],
    ]) {const response=JSON.parse((await cli(label,args)).stdout);assert.equal(response.to,'personal');assert.equal(response.status,'pending');}
    phase='protocol-and-exit';for(const item of clients)await item.client.close();
    const frames=clients.map(item=>{
      const text=item.raw(),stderr=item.stderr();outputs.push(stderr);
      const exits=fs.readFileSync(item.capture+'.exits','utf8').trim().split('\n').map(line=>JSON.parse(line));
      const packageExits=exits.filter(row=>row.entry.endsWith(path.join('notibuddy','dist','cli.js')));
      assert.equal(packageExits.length,1,'The launched package must exit before cleanup');
      assert.equal(packageExits[0].sha256,installedFiles.find(([name])=>name==='dist/cli.js')[1]);
      executedPaths.push(packageExits[0].entry);
      assert.equal(stderr,'');return inspectProtocol(text,JSONRPCMessageSchema,secrets);
    });
    assert.deepEqual(protocolErrors,[]);assert.deepEqual(failures,[]);
    // Prove that raw capture detects unterminated output bypassing stdout.write.
    phase='raw-capture-control';const negative=new StdioClientTransport({command:process.execPath,args:['--input-type=module','-e',`import fs from 'node:fs';let input='';process.stdin.on('data',c=>{input+=c;let i;while((i=input.indexOf('\\n'))>=0){const m=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{},serverInfo:{name:'negative-control',version:'1'}}})+'\\n');}});process.stdin.on('end',()=>fs.writeSync(1,'trailing-junk'));`],cwd:temporary,env,stderr:'pipe'});
    const negativeRaw=observeTransport(negative),negativeClient=new Client({name:'negative-control',version:'1'},{capabilities:{}});
    try{await negativeClient.connect(negative,{timeout:10000});await negativeClient.close();
      assert(negativeRaw().endsWith('trailing-junk'));assert.throws(()=>inspectProtocol(negativeRaw(),JSONRPCMessageSchema,[]));}
    finally{await negativeClient.close();}
    for(const text of outputs)for(const secret of secrets)assert(!text.includes(secret),'Synthetic credential appeared in CLI/diagnostic output');
    phase='cache-provenance';const cacheRoot=path.join(env.npm_config_cache,'_npx');
    const cacheRecords=[];
    for(const entry of fs.readdirSync(cacheRoot,{withFileTypes:true})){
      if(!entry.isDirectory())continue;
      const base=path.join(cacheRoot,entry.name),cached=path.join(base,'node_modules/notibuddy');
      if(!fs.existsSync(cached))continue;
      const lockBytes=fs.readFileSync(path.join(base,'package-lock.json')),lock=JSON.parse(lockBytes);
      verifyInstalledLock(lock,cached,expected);
      const actual=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else{assert(e.isFile());actual.push([path.relative(cached,file).split(path.sep).join('/'),sha(fs.readFileSync(file))]);}}}
      walk(cached);assert.deepEqual(actual.sort((a,b)=>a[0].localeCompare(b[0],'en')),installedFiles);
      const realEntry=fs.realpathSync(path.join(cached,'dist/cli.js'));
      cacheRecords.push({files:actual.length,version:expected.version,exactPayloadMatch:true,executed:executedPaths.includes(realEntry),
        lockSHA256:sha(lockBytes),dependencies:Object.fromEntries(Object.entries(lock.packages).filter(([key])=>key).map(([key,value])=>[key,{version:value.version,integrity:value.integrity}]))});
      for(let i=executedPaths.length-1;i>=0;i--)if(executedPaths[i]===realEntry)executedPaths.splice(i,1);
    }
    assert(cacheRecords.length>=1);
    assert.deepEqual(executedPaths,[],'Executed package paths must belong to fully verified npx caches');
    return {actualNpxShim:true,npxShimSHA256:sha(fs.readFileSync(npx)),generatedMcpConfigurationUsedUnchanged:true,
      selectableAllowlistAndPinnedIsolation:true,spaceContainingSenderPreserved:true,signedRequests:requests.length,
      waitDeadlineMilliseconds:elapsed,cancellationAndVerifiedRetryMilliseconds:cancellationMs,
      timedAndCancelledBodiesClosed:true,originalKeyEnvelopeExpiryPreserved:true,verifiedReplyAfterCancellation:true,
      protocolFrames:frames,protocolErrors:0,rawTrailingJunkNegativeControlRejected:true,syntheticCredentialLeaks:0,npxCacheRecords:cacheRecords,commands,
      limits:['Synthetic v1 relay; no physical Apple device or hosted relay.','Supported routing examples only, not every shell or arbitrary quoting syntax.','Windows executes the real npx.cmd via cross-spawn, the same launcher used by the SDK.']};
  } catch(error) {
    error.launcherStage=phase;throw error;
  } finally {
    for(const item of clients)await item.client.close().catch(()=>{});
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await Promise.all(shutdowns);
    try {
      if(fs.existsSync(lifecycle)){
        const live=()=>{const rows=fs.readFileSync(lifecycle,'utf8').trim().split('\n').map(line=>JSON.parse(line));
          for(const row of rows)assert(Number.isSafeInteger(row.pid)&&row.pid>0&&['start','exit'].includes(row.event));
          const ended=new Set(rows.filter(row=>row.event==='exit').map(row=>row.pid));
          return rows.filter(row=>row.event==='start'&&!ended.has(row.pid));};
        for(let i=0;i<50&&live().length;i++)await delay(20);
        if(live().some(row=>{try{process.kill(row.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}))
          shutdownUnconfirmed=true;
      }
    } catch {shutdownUnconfirmed=true;}
    if(shutdownUnconfirmed){
      const error=Error('Launched process exit unconfirmed');error.launcherStage='cleanup';error.cleanupUnconfirmed=true;throw error;
    }
  }
}
