import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {acquireFileLock} from '../src/file-lock.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DestinationStore } from '../src/config.js';
import { generateReplyKeyPair, generateSenderSigningKeyPair, deriveDeviceId, hpkeSealBytes, ecdsaSign, ecdsaVerify, computePairingMac } from '../src/crypto.js';
import { FileInbox, openFile, fileHeader, fileSignatureInput, MAX_FILE_BYTES, type FileManifest } from '../src/files.js';
import { signSenderRegistration } from '../src/sender-registration.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'nb-files-')),originalFetch=globalThis.fetch;
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
try {
 const abandoned=path.join(root,'abandoned.lock');
 const child=spawnSync(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid),{mode:0o600});",abandoned]);
 assert.equal(child.status,0);const unlock=acquireFileLock(abandoned);assert.equal(fs.readFileSync(abandoned,'utf8'),String(process.pid));unlock();
 const phone=await generateSenderSigningKeyPair(),enc=await generateReplyKeyPair(),store=new DestinationStore(root);
 const bundle={v:1 as const,relay:'https://fixture.test',token:'nb_snd_'+randomUUID(),pairSecret:Buffer.alloc(32).toString('base64url'),device:{id:await deriveDeviceId(enc.publicKeyB64u,phone.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:phone.publicKeyB64u}};
 const {record,signingKey}=await store.prepare('phone',bundle,'Fixture');
 const receiving=record.fileKey!.publicKeyB64u;
 assert.equal((await store.prepare('phone',bundle,'Fixture')).record.fileKey!.publicKeyB64u,receiving);
 const mac=await computePairingMac(bundle.pairSecret,bundle.device.id,record.keys.senderKeyId,record.keys.publicKeyB64u,'Fixture',receiving);
 assert.notEqual(mac,await computePairingMac(bundle.pairSecret,bundle.device.id,record.keys.senderKeyId,record.keys.publicKeyB64u,'Fixture'));
 assert.notEqual(mac,await computePairingMac(bundle.pairSecret,bundle.device.id,record.keys.senderKeyId,record.keys.publicKeyB64u,'Fixture',(await generateReplyKeyPair()).publicKeyB64u));
 const registration=await signSenderRegistration({senderKeyId:record.keys.senderKeyId,senderPub:record.keys.publicKeyB64u,label:'Fixture',mac,fileDeviceId:bundle.device.id,fileEncPub:receiving},bundle.token,signingKey);
 const proof=(key:string)=>new TextEncoder().encode(JSON.stringify(['nb2','sender-registration',bundle.token.slice(7),registration.senderKeyId,registration.senderPub,registration.label,registration.mac,registration.createdAt,registration.nonce,registration.fileDeviceId,key]));
 assert.ok(await ecdsaVerify(registration.senderPub,proof(receiving),registration.sig));
 assert.equal(await ecdsaVerify(registration.senderPub,proof(enc.publicKeyB64u),registration.sig),false);
 const seal=async(bytes:Uint8Array,name='../report.txt')=>{
   const now=Math.floor(Date.now()/1000);
   const m:FileManifest={v:1,id:'file_'+randomUUID().replaceAll('-',''),deviceId:bundle.device.id,senderKeyId:record.keys.senderKeyId,fileEncPub:receiving,createdAt:now,expiresAt:now+86400,size:bytes.length,cipherSize:0,enc:'',sha256:'',sig:''};
   const meta=Buffer.from(JSON.stringify({name,type:'text/plain'})),len=Buffer.alloc(4);len.writeUInt32BE(meta.length);
   const sealed=await hpkeSealBytes(receiving,'notibuddy/file/v1',fileHeader(m),Buffer.concat([len,meta,bytes]));
   Object.assign(m,{enc:sealed.enc,cipherSize:sealed.ct.length,sha256:hash(sealed.ct)});m.sig=await ecdsaSign(phone.privateKey,fileSignatureInput(m));
   return {m,ct:sealed.ct};
 };
 for(const size of [0,1,MAX_FILE_BYTES]) {
   const fixture=await seal(Buffer.alloc(size,42));
   const opened=await openFile(record,fixture.m,fixture.ct);assert.equal(opened.bytes.length,size);assert.ok(!opened.name.includes('/'));
 }
 const f=await seal(Buffer.from('Private file text'));
 for(const m of [{...f.m,size:MAX_FILE_BYTES+1},{...f.m,deviceId:'dev_'+'a'.repeat(24)},{...f.m,senderKeyId:'snd_'+'b'.repeat(24)},{...f.m,expiresAt:0},{...f.m,fileEncPub:enc.publicKeyB64u},{...f.m,enc:enc.publicKeyB64u},{...f.m,sha256:'0'.repeat(64)}])await assert.rejects(openFile(record,m,f.ct));
 const damaged=f.ct.slice();damaged[0]^=1;await assert.rejects(openFile(record,f.m,damaged));
 const inbox=new FileInbox(record,signingKey,root);let downloads=0,acks=0;
 globalThis.fetch=async(input,init)=>{
   const url=new URL(String(input)),route=url.pathname.slice(3),headers=new Headers(init?.headers),body=String(init?.body || '');
   const signatureInput=`nb1|http|${init?.method}|${route}|${headers.get('X-Sender-Timestamp')}|${headers.get('X-Sender-Nonce')}|${hash(body)}`;
   assert.ok(await ecdsaVerify(record.keys.publicKeyB64u,new TextEncoder().encode(signatureInput),headers.get('X-Sender-Signature')!));
   if(route==='/files')return Response.json({files:[{id:f.m.id,status:'ready',expiresAt:f.m.expiresAt,size:f.m.size}]});
   if(route.endsWith('/ack')) {
     acks++;assert.equal(JSON.parse(body).sha256,f.m.sha256);
     const saved=path.join(inbox.directory,f.m.id,'_report.txt');assert.equal(fs.readFileSync(saved,'utf8'),'Private file text','Ack only after plaintext is saved');
     if(acks===1)throw new Error('Lost receipt response');return Response.json({status:'delivered'});
   }
   downloads++;return new Response(f.ct,{headers:{'X-File-Manifest':Buffer.from(JSON.stringify(f.m)).toString('base64url')}});
 };
 assert.equal((await inbox.list())[0].id,f.m.id);
 const first=await inbox.receive(f.m.id);assert.equal(first.status,'saved_pending_receipt');if(process.platform!=='win32')assert.equal(fs.statSync(first.path).mode&0o777,0o600);
 const second=await new FileInbox(record,signingKey,root).receive(f.m.id);assert.equal(second.status,'delivered');assert.equal(downloads,1);assert.equal(acks,2);
 assert.equal((await inbox.receive(f.m.id)).status,'delivered');assert.equal(acks,2,'Repeated receive never deletes or rewrites delivered content');
 await assert.rejects(inbox.receive('../escape'));
 fs.writeFileSync(first.path,'changed');await assert.rejects(inbox.receive(f.m.id),/changed/);assert.equal(acks,2);
 const oversized=await seal(Buffer.from('x'));
 globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(10_004_117));controller.close();}}),{headers:{'X-File-Manifest':Buffer.from(JSON.stringify(oversized.m)).toString('base64url')}});
 await assert.rejects(inbox.receive(oversized.m.id),/too large/);assert.ok(!fs.existsSync(path.join(inbox.directory,oversized.m.id)));
 console.log('File tests passed: key proof binding, 10 MB boundary, tampering, wrong recipients, safe paths, private durable save, lost receipts, restart, idempotency, bounded download.');
} finally {globalThis.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});}
