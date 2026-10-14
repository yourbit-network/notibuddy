import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DestinationStore} from '../../src/config.js';
import {generateReplyKeyPair,generateSenderSigningKeyPair,deriveDeviceId,hpkeSealBytes,ecdsaSign} from '../../src/crypto.js';
import {FileInbox,fileHeader,fileSignatureInput,type FileManifest} from '../../src/files.js';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function fixture(name='durability.bin',options:{parent?:string;bytes?:Buffer}={}) {
  const root=fs.mkdtempSync(path.join(options.parent || os.tmpdir(),'nb-file-durability-'));
  const phone=await generateSenderSigningKeyPair(),enc=await generateReplyKeyPair();
  const store=new DestinationStore(root);
  const bundle={v:1 as const,relay:'https://fixture.test',token:'nb_snd_'+randomUUID(),pairSecret:Buffer.alloc(32).toString('base64url'),
    device:{id:await deriveDeviceId(enc.publicKeyB64u,phone.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:phone.publicKeyB64u}};
  const {record,signingKey}=await store.prepare('phone',bundle,'Fixture');
  const now=Math.floor(Date.now()/1000),bytes=options.bytes || Buffer.from('Verified file contents for a disposable durability fixture.');
  const manifest:FileManifest={v:1,id:'file_'+randomUUID().replaceAll('-',''),deviceId:bundle.device.id,senderKeyId:record.keys.senderKeyId,
    fileEncPub:record.fileKey!.publicKeyB64u,createdAt:now,expiresAt:now+86400,size:bytes.length,cipherSize:0,enc:'',sha256:'',sig:''};
  const metadata=Buffer.from(JSON.stringify({name,type:'application/octet-stream'})),length=Buffer.alloc(4);length.writeUInt32BE(metadata.length);
  const sealed=await hpkeSealBytes(manifest.fileEncPub,'notibuddy/file/v1',fileHeader(manifest),Buffer.concat([length,metadata,bytes]));
  Object.assign(manifest,{enc:sealed.enc,cipherSize:sealed.ct.length,sha256:hash(sealed.ct)});
  manifest.sig=await ecdsaSign(phone.privateKey,fileSignatureInput(manifest));
  const inbox=new FileInbox(record,signingKey,root),target=path.join(inbox.directory,manifest.id),originalFetch=globalThis.fetch;
  let downloads=0,acks=0;
  const f={root,manifest,bytes,inbox,target,record,signingKey,ciphertext:sealed.ct,failAck:false,beforeAck:()=>{},
    get downloads(){return downloads;},get acks(){return acks;},
    close(){globalThis.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});}};
  globalThis.fetch=async(input,init)=>{
    if(String(input).endsWith('/ack')) {
      f.beforeAck();acks++;
      assert.equal(JSON.parse(String(init?.body)).sha256,manifest.sha256);
      assert.deepEqual(fs.readFileSync(path.join(target,name)),bytes);
      if(f.failAck)throw Error('Injected lost receipt');
      return Response.json({status:'delivered'});
    }
    downloads++;
    return new Response(sealed.ct,{headers:{'X-File-Manifest':Buffer.from(JSON.stringify(manifest)).toString('base64url')}});
  };
  return f;
}
