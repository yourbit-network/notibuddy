import fs from 'node:fs';
import { acquireFileLock } from './file-lock.js';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { DestinationRecord } from './config.js';
import { NOTIBUDDY_DIR } from './config.js';
import { ecdsaSign, ecdsaVerify, hpkeOpenBytes } from './crypto.js';

export const MAX_FILE_BYTES=10_000_000;
export const MAX_FILE_CIPHERTEXT=MAX_FILE_BYTES+4+4096+16;
const idSchema=z.string().length(37).regex(/^file_[a-f0-9]{32}$/);
export const fileManifestSchema=z.object({
  v:z.literal(1),id:idSchema,deviceId:z.string().regex(/^dev_[a-f0-9]{24}$/),senderKeyId:z.string().regex(/^snd_[a-f0-9]{24}$/),
  fileEncPub:z.string().regex(/^[A-Za-z0-9_-]{87}$/),createdAt:z.number().int().nonnegative(),expiresAt:z.number().int().nonnegative(),
  size:z.number().int().min(0).max(MAX_FILE_BYTES),cipherSize:z.number().int().min(20).max(MAX_FILE_CIPHERTEXT),
  enc:z.string().regex(/^[A-Za-z0-9_-]{87}$/),sha256:z.string().regex(/^[a-f0-9]{64}$/),sig:z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict().refine(m=>m.expiresAt>m.createdAt && m.expiresAt-m.createdAt<=86400 && m.cipherSize>=m.size+20 && m.cipherSize<=m.size+4116);
export type FileManifest=z.infer<typeof fileManifestSchema>;
export function fileHeader(m:Pick<FileManifest,'id'|'deviceId'|'senderKeyId'|'fileEncPub'|'createdAt'|'expiresAt'|'size'>) {
  return `nb1|file|${m.id}|${m.deviceId}|${m.senderKeyId}|${m.fileEncPub}|${m.createdAt}|${m.expiresAt}|${m.size}`;
}
export function fileSignatureInput(m:FileManifest):Uint8Array {
  return new TextEncoder().encode(`${fileHeader(m)}|${m.enc}|${m.cipherSize}|${m.sha256}`);
}
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const metadataSchema=z.object({name:z.string().min(1).max(255),type:z.string().max(200)}).strict();
export async function openFile(record:DestinationRecord, input:unknown, ciphertext:Uint8Array) {
  const m=fileManifestSchema.parse(input);
  if(!record.fileKey || m.fileEncPub!==record.fileKey.publicKeyB64u || m.deviceId!==record.config.device.id ||
    m.senderKeyId!==record.config.senderKeyId || m.expiresAt<=Math.floor(Date.now()/1000) || m.createdAt>Math.floor(Date.now()/1000)+120 ||
    ciphertext.length!==m.cipherSize || hash(ciphertext)!==m.sha256 ||
    !await ecdsaVerify(record.config.device.sigPub,fileSignatureInput(m),m.sig)) throw new Error('File authentication failed');
  const key=await crypto.subtle.importKey('jwk',record.fileKey.privateKeyJwk,{name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const plaintext=await hpkeOpenBytes(key,m.enc,'notibuddy/file/v1',fileHeader(m),ciphertext);
  const length=new DataView(plaintext.buffer,plaintext.byteOffset,plaintext.byteLength).getUint32(0);
  if(length>4096 || length+4>plaintext.length || plaintext.length-4-length!==m.size) throw new Error('Invalid encrypted file size');
  const metadata=metadataSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext.subarray(4,4+length))));
  const sanitized=metadata.name.replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu,'_').replace(/^\.+/,'').replace(/[. ]+$/,'');
  let name='';
  for(const character of sanitized) { if(Buffer.byteLength(name+character)>180)break;name+=character; }
  if(!name)name='file';
  if(/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))name='received-'+name;
  return {manifest:m,name,type:metadata.type,bytes:plaintext.subarray(4+length)};
}
async function bounded(response:Response, maximum:number) {
  if(Number(response.headers.get('content-length'))>maximum) throw new Error('File response is too large');
  const reader=response.body?.getReader(); if(!reader) throw new Error('Empty response');
  const chunks:Uint8Array[]=[]; let size=0;
  try { for(;;) { const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>maximum)throw new Error('File response is too large'); chunks.push(value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks,size);
}
function syncDirectory(directory:string) { if(process.platform==='win32')return; const fd=fs.openSync(directory,'r');try {fs.fsyncSync(fd);}finally{fs.closeSync(fd);} }
function writePrivate(file:string, data:Uint8Array|string) {
  const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
const receiptSchema=z.object({id:idSchema,name:z.string().min(1).max(255),size:z.number().int().min(0).max(MAX_FILE_BYTES),
  sha256:z.string().length(64).regex(/^[a-f0-9]{64}$/),plaintextHash:z.string().length(64).regex(/^[a-f0-9]{64}$/),delivered:z.boolean()});
type SavedFile=z.infer<typeof receiptSchema>;
const temporarySuffix=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
function cleanupStaging(directory:string,id:string) {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if(entry.isDirectory() && entry.name.startsWith(id+'.') && temporarySuffix.test(entry.name.slice(id.length+1))) {
      fs.rmSync(path.join(directory,entry.name),{recursive:true});
    }
  }
}
function cleanupReceipts(target:string,savedName:string) {
  for(const entry of fs.readdirSync(target,{withFileTypes:true})) {
    if(entry.isFile() && entry.name.toLowerCase()!==savedName.toLowerCase() && entry.name.startsWith('receipt.') && temporarySuffix.test(entry.name.slice(8))) {
      fs.unlinkSync(path.join(target,entry.name));
    }
  }
}
function readReceipt(target:string,id:string):SavedFile {
  if(!fs.lstatSync(target).isDirectory())throw new Error('Invalid saved file directory');
  const file=path.join(target,'receipt.json');
  if(!fs.lstatSync(file).isFile())throw new Error('Invalid saved file receipt');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW || 0));
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile() || stat.size>8192)throw new Error('Invalid saved file receipt');
    const bytes=Buffer.alloc(8193);let size=0,read=0;
    while(size<bytes.length && (read=fs.readSync(fd,bytes,size,bytes.length-size,null))>0)size+=read;
    if(size>8192)throw new Error('Invalid saved file receipt');
    const saved=receiptSchema.parse(JSON.parse(bytes.subarray(0,size).toString('utf8')));
    if(saved.id!==id || path.basename(saved.name)!==saved.name || saved.name==='.' || saved.name==='..' || saved.name.toLowerCase()==='receipt.json')throw new Error('Invalid saved file receipt');
    return saved;
  } finally {fs.closeSync(fd);}
}
function verifySavedFile(target:string,saved:SavedFile) {
  const file=path.join(target,saved.name),changed=()=>new Error('Saved file changed; delivery will not be acknowledged.');
  if(!fs.lstatSync(file).isFile())throw changed();
  const fd=fs.openSync(file,(saved.delivered?fs.constants.O_RDONLY:fs.constants.O_RDWR)|(fs.constants.O_NOFOLLOW || 0));
  try {
    const stat=fs.fstatSync(fd);if(!stat.isFile() || stat.size!==saved.size)throw changed();
    const digest=createHash('sha256'),chunk=Buffer.alloc(65536);let size=0,read=0;
    while((read=fs.readSync(fd,chunk,0,Math.min(chunk.length,saved.size-size+1),null))>0) {
      size+=read;if(size>saved.size)throw changed();digest.update(chunk.subarray(0,read));
    }
    if(size!==saved.size || digest.digest('hex')!==saved.plaintextHash || fs.fstatSync(fd).size!==saved.size)throw changed();
    if(!saved.delivered)fs.fsyncSync(fd);
  } finally {fs.closeSync(fd);}
}
function syncReceipt(target:string) {
  const fd=fs.openSync(path.join(target,'receipt.json'),fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW || 0));
  try {fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function replaceReceipt(target:string,saved:SavedFile) {
  const temporary=path.join(target,'receipt.'+randomUUID()+'.tmp');
  // Only clean up a temporary file after this operation has created it exclusively.
  const fd=fs.openSync(temporary,'wx',0o600);
  try {
    try {fs.writeFileSync(fd,JSON.stringify(saved));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,path.join(target,'receipt.json'));syncDirectory(target);
  } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

/** One authenticated inbox per pairing, independent of sender labels and destination aliases. */
export class FileInbox {
  readonly directory:string;
  constructor(private record:DestinationRecord,private signingKey:CryptoKey,root=NOTIBUDDY_DIR) {
    const c=record.config;
    this.directory=path.join(root,'inbox',hash(JSON.stringify([c.relay,c.token,c.device.id,c.senderKeyId])));
  }
  private async request(route:string,method='GET',body?:object) {
    if(!this.record.fileKey) throw new Error('Pair this destination again with a fresh connection document to enable files, then approve it on the phone.');
    const payload=body ? JSON.stringify(body) : '', timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
    const signature=await ecdsaSign(this.signingKey,new TextEncoder().encode(`nb1|http|${method}|${route}|${timestamp}|${nonce}|${hash(payload)}`));
    const response=await fetch(this.record.config.relay.replace(/\/$/,'')+'/v1'+route,{method,
      headers:{Authorization:`Bearer ${this.record.config.token}`,'Content-Type':'application/json',
        'X-Sender-ID':this.record.config.senderKeyId,'X-Sender-Timestamp':timestamp,'X-Sender-Nonce':nonce,'X-Sender-Signature':signature},
      body:payload || undefined,signal:AbortSignal.timeout(60_000)});
    if(!response.ok) { const bytes=await bounded(response,8192);let message=`File relay returned ${response.status}`;
      try{message=JSON.parse(bytes.toString()).error || message;}catch{} throw new Error(message); }
    return response;
  }
  async list() {
    const response=await this.request('/files');
    return z.object({files:z.array(z.object({id:idSchema,status:z.enum(['uploading','ready','delivered','cancelled','expired']),expiresAt:z.number().int(),size:z.number().int().max(MAX_FILE_BYTES)})).max(100)}).parse(JSON.parse((await bounded(response,65536)).toString())).files;
  }
  async receive(id:string) {
    idSchema.parse(id);
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});fs.chmodSync(this.directory,0o700);
    const lock=path.join(this.directory,id+'.lock'),target=path.join(this.directory,id);
    const unlock=acquireFileLock(lock);
    try {
      cleanupStaging(this.directory,id);
      let saved:SavedFile;
      if(fs.existsSync(target)) {
        saved=readReceipt(target,id);
      } else {
        const response=await this.request('/files/'+id);
        const header=response.headers.get('X-File-Manifest'); if(!header || header.length>8192)throw new Error('Missing file authentication');
        const m=fileManifestSchema.parse(JSON.parse(Buffer.from(header,'base64url').toString('utf8')));
        if(m.id!==id)throw new Error('Wrong transfer returned');
        const file=await openFile(this.record,m,await bounded(response,MAX_FILE_CIPHERTEXT));
        if(file.name.toLowerCase()==='receipt.json')file.name='received-receipt.json';
        saved={id,name:file.name,size:file.bytes.length,sha256:m.sha256,plaintextHash:hash(file.bytes),delivered:false};
        const temporary=path.join(this.directory,id+'.'+randomUUID()+'.tmp');fs.mkdirSync(temporary,{mode:0o700});
        try {
          writePrivate(path.join(temporary,file.name),file.bytes);
          writePrivate(path.join(temporary,'receipt.json'),JSON.stringify(saved));
          syncDirectory(temporary);fs.renameSync(temporary,target);syncDirectory(this.directory);
        } finally { if(fs.existsSync(temporary))fs.rmSync(temporary,{recursive:true}); }
      }
      verifySavedFile(target,saved);
      cleanupReceipts(target,saved.name);
      if(!saved.delivered) {
        // A prior process may have renamed the files but failed before its flush completed.
        // Repeat every durability boundary before allowing the relay to delete its copy.
        syncReceipt(target);syncDirectory(target);syncDirectory(this.directory);
        const inbox=path.dirname(this.directory);syncDirectory(inbox);syncDirectory(path.dirname(inbox));
        try {
          const response=await this.request('/files/'+id+'/ack','POST',{sha256:saved.sha256});
          const result=JSON.parse((await bounded(response,8192)).toString());
          if(result.status!=='delivered')throw new Error('Delivery could not be confirmed');
          saved.delivered=true;
          replaceReceipt(target,saved);
        } catch {
          return {id,path:path.join(target,saved.name),size:saved.size,status:'saved_pending_receipt',message:'Saved and verified locally. Retry receive with this ID to confirm delivery.'};
        }
      }
      return {id,path:path.join(target,saved.name),size:saved.size,status:'delivered'};
    } finally { unlock(); }
  }
}
