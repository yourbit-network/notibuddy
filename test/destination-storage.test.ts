import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DestinationStore } from '../src/config.js';
import { deriveDeviceId, generateReplyKeyPair, generateSenderSigningKeyPair } from '../src/crypto.js';

async function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nb-destination-storage-'));
  try {
    const enc=await generateReplyKeyPair(), phone=await generateSenderSigningKeyPair(), sender=await generateSenderSigningKeyPair();
    const config={relay:'https://relay.test',token:'local-storage-fixture',
      device:{id:await deriveDeviceId(enc.publicKeyB64u,phone.publicKeyB64u),encPub:enc.publicKeyB64u,sigPub:phone.publicKeyB64u},
      senderKeyId:sender.senderKeyId,senderLabel:'Storage test'};
    const keys={senderKeyId:sender.senderKeyId,publicKeyB64u:sender.publicKeyB64u,privateKeyJwk:sender.privateKeyJwk};
    const originals=new Map([['config.json',JSON.stringify(config)],['sender.json',JSON.stringify(keys)]]);
    for(const [name,contents] of originals)fs.writeFileSync(path.join(root,name),contents,{mode:0o600});
    return {root,directory:path.join(root,'destinations'),store:new DestinationStore(root),sender,originals};
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
    await assert.rejects(f.store.migrate('phone'),error=>(error as NodeJS.ErrnoException).code===code);
    assert.ok(injected);
    assert.deepEqual(fs.readdirSync(f.directory),[],'Failed creation must not retain a partial credential record');
    for(const [name,contents] of f.originals)assert.equal(fs.readFileSync(path.join(f.root,name),'utf8'),contents);
    fs.openSync=originalOpen;fs.writeFileSync=originalWrite;
    await f.store.migrate('phone');
    assert.equal((await f.store.open('phone')).record.keys.senderKeyId,f.sender.senderKeyId);
    assert.deepEqual(fs.readdirSync(f.directory),['phone.json']);
  } finally {
    fs.openSync=originalOpen;fs.writeFileSync=originalWrite;
    fs.rmSync(f.root,{recursive:true,force:true});
  }
});

test('a destination publish failure removes staging without changing the legacy pairing',async()=>{
  const f=await fixture(), originalLink=fs.linkSync;let injected=false;
  try {
    fs.linkSync=(from,to)=>{
      if(String(to)===path.join(f.directory,'phone.json')) {
        injected=true;throw Object.assign(new Error('Injected destination publish failure'),{code:'EIO'});
      }
      originalLink(from,to);
    };
    await assert.rejects(f.store.migrate('phone'),error=>(error as NodeJS.ErrnoException).code==='EIO');
    assert.ok(injected);assert.deepEqual(fs.readdirSync(f.directory),[]);
    for(const [name,contents] of f.originals)assert.equal(fs.readFileSync(path.join(f.root,name),'utf8'),contents);
    fs.linkSync=originalLink;
    await f.store.migrate('phone');
    const saved=fs.readFileSync(path.join(f.directory,'phone.json'));
    await assert.rejects(f.store.migrate('phone'),error=>(error as NodeJS.ErrnoException).code==='EEXIST');
    assert.deepEqual(fs.readFileSync(path.join(f.directory,'phone.json')),saved);
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
    await assert.rejects(f.store.migrate('phone'),error=>(error as NodeJS.ErrnoException).code==='EEXIST');
    assert.ok(occupied);assert.equal(fs.readFileSync(occupied,'utf8'),'another writer');
    assert.equal(fs.existsSync(path.join(f.directory,'phone.json')),false);
  } finally {fs.openSync=originalOpen;fs.rmSync(f.root,{recursive:true,force:true});}
});
