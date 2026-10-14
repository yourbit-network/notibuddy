import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DestinationStore } from '../src/config.js';
import { resolveFileDestination } from '../src/file-routing.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair, hpkeSealBytes, ecdsaSign, ecdsaVerify } from '../src/crypto.js';
import { fileHeader, fileSignatureInput, type FileManifest } from '../src/files.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'nb-file-routing-'));
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
let downloads=0,acks=0;
let serve:(request:IncomingMessage,response:ServerResponse)=>Promise<void>=async()=>{throw Error('Fixture not ready');};
const server=createServer((request,response)=>{void serve(request,response).catch(error=>{response.statusCode=500;response.end(String(error));});});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  const address=server.address();assert.ok(address && typeof address!=='string');
  const relay=`http://127.0.0.1:${address.port}`,store=new DestinationStore(root);
  const phone=async(name:string)=>{
    const sig=await generateSenderSigningKeyPair(),enc=await generateReplyKeyPair();
    const bundle={v:1 as const,relay,token:'nb_snd_'+randomUUID(),pairSecret:Buffer.alloc(32).toString('base64url'),
      device:{id:await deriveDeviceId(enc.publicKeyB64u,sig.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:sig.publicKeyB64u,name}};
    return {sig,bundle};
  };
  const personal=await phone('Phone'),work=await phone('Work');
  const a=await store.prepare('personal',personal.bundle,'Sender'),b=await store.prepare('work',work.bundle,'Sender');
  const samePhone=await store.prepare('another-sender',personal.bundle,'Another sender');
  const pairing=`${a.record.config.device.id}:${a.record.config.senderKeyId}`;
  const resolved=await resolveFileDestination({pairing},store);assert.equal(resolved.name,'personal');
  assert.equal(resolved.record.connectionId,a.record.connectionId);
  assert.equal((await resolveFileDestination({to:'work'},store)).record.connectionId,b.record.connectionId);
  assert.equal((await resolveFileDestination({pairing:`${personal.bundle.device.id}:${samePhone.record.config.senderKeyId}`},store)).name,'another-sender');
  for(const invalid of [undefined,'',pairing+'\n',pairing+'; echo unsafe',pairing.toUpperCase(),'../escape'])await assert.rejects(resolveFileDestination({pairing:invalid},store));
  await assert.rejects(resolveFileDestination({to:'work',pairing},store),/not both/);
  await assert.rejects(resolveFileDestination({pairing:`${personal.bundle.device.id}:${b.record.config.senderKeyId}`},store),/not paired here/);
  store.rename('personal','renamed');await store.prepare('personal',work.bundle,'Reused alias');
  assert.equal((await resolveFileDestination({pairing},store)).name,'renamed');
  const originalOpen=store.open.bind(store);
  store.open=async()=>originalOpen('work');
  await assert.rejects(resolveFileDestination({pairing},store),/changed while selecting/);store.open=originalOpen;
  const duplicate=path.join(root,'destinations','duplicate.json');
  fs.copyFileSync(path.join(root,'destinations','renamed.json'),duplicate);
  await assert.rejects(resolveFileDestination({pairing},store),/Multiple local destinations/);fs.unlinkSync(duplicate);

  const now=Math.floor(Date.now()/1000),bytes=Buffer.from('Fixture file received with the exact identity selector.');
  const metadata=Buffer.from(JSON.stringify({name:'fixture.txt',type:'text/plain'})),length=Buffer.alloc(4);length.writeUInt32BE(metadata.length);
  const manifest:FileManifest={v:1,id:'file_'+randomUUID().replaceAll('-',''),deviceId:personal.bundle.device.id,senderKeyId:a.record.config.senderKeyId,
    fileEncPub:a.record.fileKey!.publicKeyB64u,createdAt:now,expiresAt:now+3600,size:bytes.length,cipherSize:0,enc:'',sha256:'',sig:''};
  const encrypted=await hpkeSealBytes(manifest.fileEncPub,'notibuddy/file/v1',fileHeader(manifest),Buffer.concat([length,metadata,bytes]));
  manifest.enc=encrypted.enc;const ciphertext=Buffer.from(encrypted.ct);
  manifest.cipherSize=ciphertext.length;manifest.sha256=hash(ciphertext);manifest.sig=await ecdsaSign(personal.sig.privateKey,fileSignatureInput(manifest));
  serve=async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);
    assert.equal(request.headers.authorization,'Bearer '+a.record.config.token);
    assert.equal(request.headers['x-sender-id'],a.record.config.senderKeyId);
    const route=request.url!.replace(/^\/v1/,'');
    const signing=new TextEncoder().encode(`nb1|http|${request.method}|${route}|${request.headers['x-sender-timestamp']}|${request.headers['x-sender-nonce']}|${hash(body)}`);
    assert.equal(await ecdsaVerify(a.record.keys.publicKeyB64u,signing,String(request.headers['x-sender-signature'])),true);
    if(request.method==='GET' && route==='/files/'+manifest.id) {
      downloads++;response.setHeader('X-File-Manifest',Buffer.from(JSON.stringify(manifest)).toString('base64url'));response.end(ciphertext);
    } else if(request.method==='POST' && route==='/files/'+manifest.id+'/ack') {
      assert.equal(JSON.parse(body.toString()).sha256,manifest.sha256);acks++;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({id:manifest.id,status:'delivered'}));
    } else {response.statusCode=404;response.end('{}');}
  };
  const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const run=(args:string[])=>new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',cli,...args],{env:{...process.env,NOTIBUDDY_HOME:root},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',data=>{out+=data;});child.stderr.on('data',data=>{err+=data;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
  const args=['files','receive',manifest.id,'--pairing',pairing];
  const received=await run(args);assert.equal(received.code,0,received.err);
  const result=JSON.parse(received.out);assert.equal(result.to,'renamed');assert.equal(result.result.status,'delivered');
  assert.deepEqual(fs.readFileSync(result.result.path),bytes);assert.equal(downloads,1);assert.equal(acks,1);
  assert.equal((await run(args)).code,0);assert.equal(downloads,1);assert.equal(acks,1);
  for(const args of [
    ['files','receive',manifest.id,'--pairing',`${personal.bundle.device.id}:${b.record.config.senderKeyId}`],
    ['files','receive',manifest.id,'--pairing',pairing,'--to','work'],
    ['files','receive',manifest.id,'--pairing',pairing,'--pairing',pairing],
    ['mcp','--pairing',pairing],
  ])assert.equal((await run(args)).code,1);
  assert.equal(downloads,1);assert.equal(acks,1);
  assert.ok(!received.out.includes(a.record.config.token));assert.ok(!received.out.includes('privateKey'));
  console.log('Phone receive command passed: exact identities, alias rename/reuse, ambiguity/race rejection, CLI signed fetch, authenticated decryption, durable save/receipt, idempotent retry.');
} finally {
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  fs.rmSync(root,{recursive:true,force:true});
}
