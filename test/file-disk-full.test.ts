// Explicit macOS-only acceptance: fill a disposable 64 MiB HFS+ image, never the host filesystem.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fixture} from './helpers/file-fixture.js';

test('actual filesystem ENOSPC cannot acknowledge a partial file and collection recovers after space is freed',{timeout:120000},async()=>{
  assert.equal(process.platform,'darwin','This explicit check requires macOS hdiutil.');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nb-receiver-disk-'));
  const image=path.join(temporary,'receiver.dmg'),mount=path.join(temporary,'volume');
  fs.mkdirSync(mount);
  const run=(command:string,args:string[])=>execFileSync(command,args,{encoding:'utf8',timeout:30000});
  let attached=false,f:Awaited<ReturnType<typeof fixture>>|undefined;
  try {
    run('/usr/bin/hdiutil',['create','-size','64m','-fs','HFS+','-volname','NotiBuddyDiskTest',image]);
    const plist=run('/usr/bin/hdiutil',['attach','-nobrowse','-mountpoint',mount,'-plist',image]);attached=true;
    const attachment=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:plist,encoding:'utf8'}));
    const mounted=attachment['system-entities'].find((entry:Record<string,string>)=>entry['mount-point'] && fs.realpathSync(entry['mount-point'])===fs.realpathSync(mount));
    assert.match(mounted?.['dev-entry'] || '',/^\/dev\/disk\d+s\d+$/);
    assert.notEqual(fs.statSync(mount).dev,fs.statSync(temporary).dev,'Refuse to fill the host filesystem.');
    const stat=fs.statfsSync(mount),capacity=stat.blocks*stat.bsize;
    assert.ok(capacity>=16*1024*1024 && capacity<=128*1024*1024,'Refuse an unexpectedly large filesystem.');

    f=await fixture('durability.bin',{parent:mount,bytes:Buffer.alloc(4*1024*1024,42)});
    const filler=path.join(mount,'disposable-filler'),fd=fs.openSync(filler,'wx',0o600),chunk=Buffer.alloc(1024*1024,43);
    let full=false;
    try {
      // Independent byte budget is a second guard even after validating the mount/device/capacity.
      for(let written=0;written<128*1024*1024;) {
        try {written+=fs.writeSync(fd,chunk);}catch(error){assert.equal((error as NodeJS.ErrnoException).code,'ENOSPC');full=true;break;}
      }
      assert.ok(full,'Expected the disposable image to become full within the bounded write budget.');
      fs.ftruncateSync(fd,Math.max(0,fs.fstatSync(fd).size-1024*1024));fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
    const available=fs.statfsSync(mount);assert.ok(available.bavail*available.bsize<f.bytes.length);
    await assert.rejects(f.inbox.receive(f.manifest.id),error=>(error as NodeJS.ErrnoException).code==='ENOSPC');
    assert.equal(f.acks,0);assert.equal(fs.existsSync(f.target),false);
    assert.deepEqual(fs.readdirSync(f.inbox.directory),[],'A failed save must remove its lock and partial staging directory.');
    fs.unlinkSync(filler);
    const received=await f.inbox.receive(f.manifest.id);assert.equal(received.status,'delivered');
    assert.deepEqual(fs.readFileSync(received.path),f.bytes);assert.equal(f.acks,1);assert.equal(f.downloads,2);
    console.log('Verified real ENOSPC on a disposable 64 MiB HFS+ image: no premature ACK, partial cleanup, and exact 4 MiB recovery.');
  } finally {
    f?.close();
    // If detach fails, leave the isolated image for inspection; never recursively delete a mounted path.
    if(attached)run('/usr/bin/hdiutil',['detach',mount]);
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
