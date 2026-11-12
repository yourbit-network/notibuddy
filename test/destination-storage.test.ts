import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DestinationStore } from '../src/config.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';

async function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nb-destination-storage-'));
  try {
    const enc=await generateReplyKeyPair(), phone=await generateSenderSigningKeyPair();
    const bundle={v:1 as const,relay:'https://relay.test',token:'nb_snd_'+randomUUID(),pairSecret:Buffer.alloc(32).toString('base64url'),
      device:{id:await deriveDeviceId(enc.publicKeyB64u,phone.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:phone.publicKeyB64u}};
    return {root,directory:path.join(root,'destinations'),store:new DestinationStore(root),bundle,label:'Storage test'};
  } catch(error) {fs.rmSync(root,{recursive:true,force:true});throw error;}
}

for(const code of ['ENOSPC','EIO'])test('failed destination write removes its partial record: '+code,async()=>{
  const f=await fixture(), originalOpen=fs.openSync, originalWrite=fs.writeFileSync;
  const paths=new Map<number,string>();let injected=false;
  try {
    fs.openSync=((file,...args:any[])=>{
      const fd=(originalOpen as any)(file,...args);paths.set(fd,path.resolve(String(file)));return fd;
    }) as typeof fs.openSync;
    fs.writeFileSync=((file,data,...args:any[])=>{
      const name=typeof file==='number'?paths.get(file):path.resolve(String(file));
      if(name && path.dirname(name)===f.directory && name.endsWith('.tmp')) {
        injected=true;
        // Actually leave partial bytes before the filesystem reports failure.
        (originalWrite as any)(file,String(data).slice(0,120),...args);
        throw Object.assign(new Error('Injected destination write failure'),{code});
      }
      (originalWrite as any)(file,data,...args);
    }) as typeof fs.writeFileSync;
    await assert.rejects(f.store.prepare('phone',f.bundle,f.label),error=>(error as NodeJS.ErrnoException).code===code);
    assert.ok(injected);
    assert.deepEqual(fs.readdirSync(f.directory),[],'Failed creation must not retain a partial credential record');
    fs.openSync=originalOpen;fs.writeFileSync=originalWrite;
    const created=await f.store.prepare('phone',f.bundle,f.label);
    assert.equal((await f.store.open('phone')).record.keys.senderKeyId,created.record.keys.senderKeyId);
    assert.deepEqual(fs.readdirSync(f.directory),['phone.json']);
  } finally {
    fs.openSync=originalOpen;fs.writeFileSync=originalWrite;
    fs.rmSync(f.root,{recursive:true,force:true});
  }
});

test('a destination publish failure removes its staging file and a retry creates the pairing',async()=>{
  const f=await fixture(), originalLink=fs.linkSync;let injected=false;
  try {
    fs.linkSync=(from,to)=>{
      if(String(to)===path.join(f.directory,'phone.json')) {
        injected=true;throw Object.assign(new Error('Injected destination publish failure'),{code:'EIO'});
      }
      originalLink(from,to);
    };
    await assert.rejects(f.store.prepare('phone',f.bundle,f.label),error=>(error as NodeJS.ErrnoException).code==='EIO');
    assert.ok(injected);assert.deepEqual(fs.readdirSync(f.directory),[]);
    fs.linkSync=originalLink;
    const first=await f.store.prepare('phone',f.bundle,f.label);
    // prepare is idempotent: it never replaces an existing pairing's keys or connection.
    const again=await f.store.prepare('phone',f.bundle,f.label);
    assert.equal(again.record.connectionId,first.record.connectionId);
    assert.equal(again.record.keys.senderKeyId,first.record.keys.senderKeyId);
    assert.deepEqual(fs.readdirSync(f.directory),['phone.json']);
  } finally {fs.linkSync=originalLink;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('exclusive creation failure never removes a temporary file owned by another writer',async()=>{
  const f=await fixture(), originalOpen=fs.openSync;let occupied:string|undefined;
  try {
    fs.openSync=((file,...args:any[])=>{
      const name=path.resolve(String(file));
      if(path.dirname(name)===f.directory && name.endsWith('.tmp') && args[0]==='wx') {
        occupied=name;
        const fd=originalOpen(name,'wx',0o600);
        try{fs.writeSync(fd,'another writer');}finally{fs.closeSync(fd);}
      }
      return (originalOpen as any)(file,...args);
    }) as typeof fs.openSync;
    // prepare treats a lost create race as benign, then finds no pairing to open.
    await assert.rejects(f.store.prepare('phone',f.bundle,f.label),/not paired/);
    assert.ok(occupied);assert.equal(fs.readFileSync(occupied,'utf8'),'another writer');
    assert.equal(fs.existsSync(path.join(f.directory,'phone.json')),false);
  } finally {fs.openSync=originalOpen;fs.rmSync(f.root,{recursive:true,force:true});}
});
