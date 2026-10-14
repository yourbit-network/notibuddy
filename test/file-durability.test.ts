import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {FileInbox,MAX_FILE_BYTES} from '../src/files.js';
import {fixture} from './helpers/file-fixture.js';


async function faults(hooks:{sync?:(file:string,fd:number)=>void;write?:(file:string,fd:number|fs.PathOrFileDescriptor)=>void;rename?:(from:string,to:string)=>void},run:()=>Promise<void>) {
  const original={open:fs.openSync,close:fs.closeSync,sync:fs.fsyncSync,write:fs.writeFileSync,rename:fs.renameSync};
  const paths=new Map<number,string>();
  fs.openSync=((file,...args:any[])=>{const fd=(original.open as any)(file,...args);paths.set(fd,path.resolve(String(file)));return fd;}) as typeof fs.openSync;
  fs.closeSync=fd=>{try{original.close(fd);}finally{paths.delete(fd);}};
  fs.fsyncSync=fd=>{hooks.sync?.(paths.get(fd) || '',fd);original.sync(fd);};
  fs.writeFileSync=((file,...args:any[])=>{hooks.write?.(typeof file==='number'?paths.get(file)||'':path.resolve(String(file)),file);(original.write as any)(file,...args);}) as typeof fs.writeFileSync;
  fs.renameSync=(from,to)=>{hooks.rename?.(String(from),String(to));original.rename(from,to);};
  try{await run();}finally{fs.openSync=original.open;fs.closeSync=original.close;fs.fsyncSync=original.sync;fs.writeFileSync=original.write;fs.renameSync=original.rename;}
}
const diskError=(code:string)=>Object.assign(Error('Injected '+code),{code});
const partials=(directory:string)=>fs.readdirSync(directory).filter(name=>name.endsWith('.tmp'));

test('partial disk-full writes and file flush failures cannot acknowledge or publish a partial file',async()=>{
  for(const failure of ['write','sync']) {
    const f=await fixture();try {
      let injected=false;
      const fail=(name:string,fd:any)=>{
        if(path.basename(name)==='durability.bin') {injected=true;if(failure==='write')fs.writeSync(fd,Buffer.from('partial'));throw diskError(failure==='write'?'ENOSPC':'EIO');}
      };
      await faults(failure==='write'?{write:fail}:{sync:fail},async()=>{
        await assert.rejects(f.inbox.receive(f.manifest.id),error=>(error as NodeJS.ErrnoException).code===(failure==='write'?'ENOSPC':'EIO'));
      });
      assert.ok(injected);assert.equal(f.acks,0);assert.equal(fs.existsSync(f.target),false);assert.deepEqual(partials(f.inbox.directory),[]);
      assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');assert.equal(f.acks,1);
    }finally{f.close();}
  }
});

test('a renamed but unflushed target must repeat its directory flush before acknowledging on retry',{skip:process.platform==='win32'},async()=>{
  const f=await fixture();try {
    await faults({sync:name=>{if(name===f.inbox.directory)throw diskError('EIO');}},async()=>{
      await assert.rejects(f.inbox.receive(f.manifest.id),/Injected EIO/);
    });
    assert.ok(fs.existsSync(f.target));assert.equal(f.acks,0);
    await faults({sync:name=>{if(name===f.inbox.directory)throw diskError('EIO');}},async()=>{
      await assert.rejects(new FileInbox(f.record,f.signingKey,f.root).receive(f.manifest.id),/Injected EIO/);
    });
    assert.equal(f.acks,0);assert.equal(f.downloads,1);
    assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');assert.equal(f.downloads,1);
  }finally{f.close();}
});

test('first collection flushes the newly created inbox ancestry before acknowledging',{skip:process.platform==='win32'},async()=>{
  const f=await fixture(),synced=new Set<string>();try {
    f.beforeAck=()=>{for(const directory of [f.target,f.inbox.directory,path.dirname(f.inbox.directory),f.root])assert.ok(synced.has(directory),'Missing durable directory: '+directory);};
    await faults({sync:name=>{synced.add(name);}},async()=>{assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');});
  }finally{f.close();}
});

test('pending retries must flush both the saved payload and its receipt before acknowledging',async()=>{
  for(const name of ['durability.bin','receipt.json']) {
    const f=await fixture();try {
      f.failAck=true;assert.equal((await f.inbox.receive(f.manifest.id)).status,'saved_pending_receipt');f.failAck=false;
      await faults({sync:file=>{if(file===path.join(f.target,name))throw diskError('EIO');}},async()=>{
        await assert.rejects(new FileInbox(f.record,f.signingKey,f.root).receive(f.manifest.id),/Injected EIO/);
      });
      assert.equal(f.acks,1);assert.equal(f.downloads,1);
      assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');assert.equal(f.acks,2);
    }finally{f.close();}
  }
});

test('receipt write failure preserves the saved file and removes only its temporary receipt',async()=>{
  const f=await fixture();try {
    await faults({write:(name,fd)=>{if(/^receipt\.[a-f0-9-]+\.tmp$/.test(path.basename(name))){fs.writeSync(fd as number,Buffer.from('{'));throw diskError('ENOSPC');}}},async()=>{
      assert.equal((await f.inbox.receive(f.manifest.id)).status,'saved_pending_receipt');
    });
    assert.equal(f.acks,1);assert.equal(f.downloads,1);assert.deepEqual(partials(f.target),[]);
    assert.deepEqual(fs.readFileSync(path.join(f.target,'durability.bin')),f.bytes);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'receipt.json'),'utf8')).delivered,false);
    assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');assert.equal(f.downloads,1);assert.equal(f.acks,2);
  }finally{f.close();}
});

test('a received filename resembling a receipt temporary is never cleaned up',async()=>{
  const name='receipt.'+randomUUID()+'.tmp',f=await fixture(name);try {
    assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');
    const abandoned='receipt.'+randomUUID()+'.tmp',unrecognized='receipt.notes.tmp';
    fs.writeFileSync(path.join(f.target,abandoned),'{');fs.writeFileSync(path.join(f.target,unrecognized),'unrelated');
    assert.equal((await f.inbox.receive(f.manifest.id)).status,'delivered');
    assert.deepEqual(partials(f.target).sort(),[name,unrecognized].sort());
    assert.deepEqual(fs.readFileSync(path.join(f.target,name)),f.bytes);assert.equal(f.acks,1);
  }finally{f.close();}
});

test('oversized or changed local files and receipts fail closed without an unbounded read',async()=>{
  for(const kind of ['payload-size','payload-hash','receipt']) {
    const f=await fixture(),read=fs.readSync;try {
      f.failAck=true;await f.inbox.receive(f.manifest.id);f.failAck=false;
      const file=path.join(f.target,kind==='receipt'?'receipt.json':'durability.bin');
      if(kind==='payload-hash')fs.writeFileSync(file,Buffer.alloc(f.bytes.length,42));
      else fs.truncateSync(file,kind==='receipt'?100_000:MAX_FILE_BYTES+1);
      let total=0;
      fs.readSync=((fd,buffer,...args:any[])=>{assert.ok(buffer.byteLength<=65536);const size=(read as any)(fd,buffer,...args);total+=size;return size;}) as typeof fs.readSync;
      await assert.rejects(f.inbox.receive(f.manifest.id),kind==='receipt'?/Invalid saved file receipt/:/Saved file changed/);
      assert.ok(total<65536);assert.equal(f.acks,1);assert.equal(f.downloads,1);
    }finally{fs.readSync=read;f.close();}
  }
});

test('newline-suffixed transfer IDs fail before creating an inbox or contacting the relay',async()=>{
  const f=await fixture();try {
    await assert.rejects(f.inbox.receive(f.manifest.id+'\n'));
    assert.equal(fs.existsSync(f.inbox.directory),false);assert.equal(f.downloads,0);assert.equal(f.acks,0);
  }finally{f.close();}
});

test('recovery does not follow local payload or staging symlinks',{skip:process.platform==='win32'},async()=>{
  const f=await fixture();try {
    f.failAck=true;await f.inbox.receive(f.manifest.id);f.failAck=false;
    const outside=path.join(f.root,'unrelated');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'sentinel'),'keep');
    const abandoned=path.join(f.inbox.directory,f.manifest.id+'.'+randomUUID()+'.tmp');fs.symlinkSync(outside,abandoned,'dir');
    const original=path.join(f.target,'durability.bin'),moved=path.join(outside,'payload');fs.renameSync(original,moved);fs.symlinkSync(moved,original);
    await assert.rejects(f.inbox.receive(f.manifest.id),/Saved file changed/);
    assert.equal(f.acks,1);assert.equal(f.downloads,1);assert.equal(fs.lstatSync(abandoned).isSymbolicLink(),true);
    assert.equal(fs.readFileSync(path.join(outside,'sentinel'),'utf8'),'keep');assert.deepEqual(fs.readFileSync(moved),f.bytes);
  }finally{f.close();}
});

for(const point of ['before-publish','after-publish','after-ack','before-receipt-publish','after-receipt-publish'])test('process death at '+point+' leaves a recoverable transfer',async()=>{
  const f=await fixture();try {
    const input=path.join(f.root,'child-fixture.json');
    fs.writeFileSync(input,JSON.stringify({root:f.root,manifest:f.manifest,ciphertext:Buffer.from(f.ciphertext).toString('base64url'),point}),{mode:0o600});
    const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./helpers/file-receive-child.ts',import.meta.url)),input],{encoding:'utf8',timeout:20000});
    assert.equal(fs.readFileSync(path.join(f.root,'crash-reached'),'utf8'),point,child.stderr);
    if(process.platform==='win32') {assert.notEqual(child.status,0);assert.equal(child.stderr,'');}
    else assert.equal(child.signal,'SIGKILL',child.stderr);
    assert.equal(fs.existsSync(path.join(f.root,'ack-recorded')),point==='after-ack' || point.includes('receipt'));
    assert.equal(fs.existsSync(f.target),point!=='before-publish');
    const unrelated='file_'+'e'.repeat(32)+'.'+randomUUID()+'.tmp';fs.mkdirSync(path.join(f.inbox.directory,unrelated));
    const unrecognized=f.manifest.id+'.notes.tmp';fs.mkdirSync(path.join(f.inbox.directory,unrecognized));
    assert.equal((await new FileInbox(f.record,f.signingKey,f.root).receive(f.manifest.id)).status,'delivered');
    assert.equal(f.downloads,point==='before-publish'?1:0);assert.equal(f.acks,point==='after-receipt-publish'?0:1);
    assert.deepEqual(partials(f.inbox.directory).sort(),[unrelated,unrecognized].sort());
    assert.deepEqual(partials(f.target),[]);
    assert.deepEqual(fs.readFileSync(path.join(f.target,'durability.bin')),f.bytes);
  }finally{f.close();}
});
