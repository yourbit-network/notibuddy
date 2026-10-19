import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {FileInbox} from '../src/files.js';
import {fixture} from './helpers/file-fixture.js';

async function bounded<T>(promise:Promise<T>,milliseconds=3000):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  try {return await Promise.race([promise,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(Error('Cancellation did not finish promptly')),milliseconds);
  })]);} finally {clearTimeout(timer!);}
}

test('an already cancelled file operation performs no network or local write',async()=>{
  const f=await fixture(),controller=new AbortController();controller.abort();
  try {
    await assert.rejects(f.inbox.receive(f.manifest.id,{signal:controller.signal}),{name:'AbortError'});
    await assert.rejects(f.inbox.list({signal:controller.signal}),{name:'AbortError'});
    assert.equal(f.downloads,0);assert.equal(f.acks,0);assert(!fs.existsSync(f.inbox.directory));
  } finally {f.close();}
});

test('cancelling an incomplete file body releases its lock and permits a clean retry',async()=>{
  const f=await fixture(),controller=new AbortController(),normalFetch=globalThis.fetch;
  let body:ReadableStreamDefaultController<Uint8Array>,cancelled=false,started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  globalThis.fetch=async()=>new Response(new ReadableStream<Uint8Array>({
    start(value){body=value;value.enqueue(f.ciphertext.subarray(0,1));started();},
    cancel(){cancelled=true;},
  }),{headers:{'X-File-Manifest':Buffer.from(JSON.stringify(f.manifest)).toString('base64url')}});
  const pending=f.inbox.receive(f.manifest.id,{signal:controller.signal});void pending.catch(()=>{});
  try {
    await ready;controller.abort();await assert.rejects(bounded(pending),{name:'AbortError'});
    assert(cancelled);assert(!fs.existsSync(f.target));
    assert.deepEqual(fs.readdirSync(f.inbox.directory),[]);assert.equal(f.acks,0);
    globalThis.fetch=normalFetch;
    assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');assert.equal(f.acks,1);
  } finally {
    try{body!.error(Error('Fixture cleanup'));}catch{}
    await pending.catch(()=>{});f.close();
  }
});

test('cancelling a receipt preserves the saved file and retries only acknowledgement',async()=>{
  const f=await fixture(),controller=new AbortController(),normalFetch=globalThis.fetch;
  let release!:()=>void,started!:()=>void,requests=0;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  globalThis.fetch=async(input,init)=>{
    if(String(input).endsWith('/ack')) {
      requests++;started();
      return new Promise<Response>(resolve=>{release=()=>resolve(Response.json({status:'delivered'}));});
    }
    return normalFetch(input,init);
  };
  const pending=f.inbox.receive(f.manifest.id,{signal:controller.signal});void pending.catch(()=>{});
  try {
    await ready;controller.abort();await assert.rejects(bounded(pending),{name:'AbortError'});
    assert.equal(requests,1);assert.equal(f.downloads,1);
    const receipt=JSON.parse(fs.readFileSync(path.join(f.target,'receipt.json'),'utf8'));
    assert.equal(receipt.delivered,false);assert.deepEqual(fs.readFileSync(path.join(f.target,receipt.name)),f.bytes);
    assert.deepEqual(fs.readdirSync(f.inbox.directory),[f.manifest.id]);
    release();globalThis.fetch=normalFetch;
    assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');
    assert.equal(f.downloads,1);assert.equal(f.acks,1);
  } finally {release?.();await pending.catch(()=>{});f.close();}
});

test('file deadlines also bound response bodies that never finish',async()=>{
  const f=await fixture();let cancelled=false;
  globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}));
  try {
    await assert.rejects(bounded(f.inbox.list({deadline:Date.now()+1000})),/deadline reached/);
    assert(cancelled);
  } finally {f.close();}
});

test('real MCP cancellation stops a download and the same server can retry its file ID',async()=>{
  const f=await fixture();let started!:()=>void,closed!:()=>void,complete=false,downloads=0,acks=0,serverFailure:unknown;
  const ready=new Promise<void>(resolve=>{started=resolve;}),disconnected=new Promise<void>(resolve=>{closed=resolve;});
  let inbox:FileInbox;
  const server=http.createServer(async(request,response)=>{
    try {
      assert.equal(request.headers.authorization,'Bearer '+f.record.config.token);
      if(request.method==='GET' && request.url==='/v1/files/'+f.manifest.id) {
        downloads++;response.writeHead(200,{'X-File-Manifest':Buffer.from(JSON.stringify(f.manifest)).toString('base64url')});
        if(complete)response.end(f.ciphertext);
        else {response.on('close',closed);response.write(f.ciphertext.subarray(0,1));started();}
      } else if(request.method==='POST' && request.url==='/v1/files/'+f.manifest.id+'/ack') {
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        assert.equal(JSON.parse(Buffer.concat(chunks).toString()).sha256,f.manifest.sha256);
        const target=path.join(inbox.directory,f.manifest.id),receipt=JSON.parse(fs.readFileSync(path.join(target,'receipt.json'),'utf8'));
        assert.deepEqual(fs.readFileSync(path.join(target,receipt.name)),f.bytes);
        acks++;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({status:'delivered'}));
      } else {throw Error('Unexpected fixture route');}
    } catch(error) {serverFailure=error;response.destroy();}
  });
  const client=new Client({name:'file-cancellation-test',version:'1'},{capabilities:{}});
  try {
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    f.record.config.relay='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
    fs.writeFileSync(path.join(f.root,'destinations/phone.json'),JSON.stringify(f.record),{mode:0o600});
    inbox=new FileInbox(f.record,f.signingKey,f.root);
    const transport=new StdioClientTransport({command:process.execPath,
      args:['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('../src/mcp-entry.ts',import.meta.url)),'--to','phone'],
      env:{...process.env,NOTIBUDDY_HOME:f.root},stderr:'pipe'});
    let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
    await client.connect(transport,{timeout:10_000});
    const controller=new AbortController(),call=client.callTool({name:'notibuddy_files_receive',arguments:{id:f.manifest.id}},undefined,{signal:controller.signal,timeout:10_000});
    void call.catch(()=>{});await bounded(ready,10_000);controller.abort();await assert.rejects(call);
    await bounded(disconnected);
    assert.equal(acks,0);assert.deepEqual(fs.readdirSync(inbox.directory),[]);
    complete=true;
    const result=await client.callTool({name:'notibuddy_files_receive',arguments:{id:f.manifest.id}},undefined,{timeout:10_000});
    assert(!result.isError);assert.equal(JSON.parse((result.content as {text:string}[])[0].text).result.status,'delivered');
    assert.equal(downloads,2);assert.equal(acks,1);assert.equal(serverFailure,undefined);assert.equal(stderr,'');
  } finally {
    server.closeAllConnections();await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();
  }
});
