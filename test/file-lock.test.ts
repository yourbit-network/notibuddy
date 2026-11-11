import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lock from '../src/file-lock.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'notibuddy-file-lock-test-'));
// The implementation records the start time the checker itself reads (ps), falling back to the clock.
const startSeconds=()=>lock.processStartSeconds(process.pid)??Math.round((Date.now()-process.uptime()*1000)/1000);
const deadPid=()=>{
  const child=spawnSync(process.execPath,['-e',''],{stdio:'ignore'});
  assert.ok(child.pid);return child.pid;
};
const age=(target:string,seconds:number)=>{const t=new Date(Date.now()-seconds*1000);fs.utimesSync(target,t,t);};
let n=0;
const fresh=()=>path.join(directory,`op${n++}.lock`);
const owner=(file:string)=>fs.readFileSync(file,'utf8');
const holdsOurPid=(file:string)=>{
  const text=owner(file);
  const pid=/^\d+$/.test(text)?Number(text):(JSON.parse(text) as {pid:number}).pid;
  return pid===process.pid;
};
try {
  {
    const file=fresh();fs.writeFileSync(file,JSON.stringify({pid:deadPid(),start:startSeconds()}));
    const unlock=lock.acquireFileLock(file);
    assert.ok(holdsOurPid(file),'dead pid lock reclaimed');
    const parsed=JSON.parse(owner(file)) as {pid:number;start:number};
    assert.equal(parsed.pid,process.pid);assert.ok(Math.abs(parsed.start-startSeconds())<=2);
    unlock();assert.equal(fs.existsSync(file),false,'unlock removes the lock file');
  }
  {
    const file=fresh();fs.writeFileSync(file,String(deadPid()));
    lock.acquireFileLock(file);assert.ok(holdsOurPid(file),'legacy dead pid reclaimed');
  }
  {
    const file=fresh();fs.writeFileSync(file,JSON.stringify({pid:process.pid,start:startSeconds()}));
    assert.throws(()=>lock.acquireFileLock(file),/Another process owns/);
    assert.doesNotMatch(owner(file),/^$/);
  }
  {
    const file=fresh();fs.writeFileSync(file,String(process.pid));
    assert.throws(()=>lock.acquireFileLock(file),/Another process owns/,'legacy live pid is held');
  }
  {
    const file=fresh();fs.writeFileSync(file,JSON.stringify({pid:process.pid,start:startSeconds()-1000}));
    const read=(lock as {processStartSeconds?:(pid:number)=>number|undefined}).processStartSeconds;
    if(process.platform==='darwin'||process.platform==='linux'){
      assert.equal(typeof read,'function');
      assert.notEqual(read!(process.pid),undefined);
      lock.acquireFileLock(file);assert.ok(holdsOurPid(file),'reused pid reclaimed');
    } else assert.throws(()=>lock.acquireFileLock(file),/Another process owns/);
  }
  {
    const file=fresh();fs.writeFileSync(file,'');age(file,10);
    lock.acquireFileLock(file);assert.ok(holdsOurPid(file),'old empty lock reclaimed');
  }
  {
    const file=fresh();fs.writeFileSync(file,'');
    assert.throws(()=>lock.acquireFileLock(file),/Another process owns/);
  }
  {
    const file=fresh();fs.writeFileSync(file,JSON.stringify({pid:deadPid(),start:startSeconds()}));
    fs.mkdirSync(file+'.recovery');age(file+'.recovery',60);
    lock.acquireFileLock(file);assert.ok(holdsOurPid(file),'stale recovery dir cleaned');
    assert.equal(fs.existsSync(file+'.recovery'),false);
  }
  {
    const file=fresh();fs.writeFileSync(file,JSON.stringify({pid:deadPid(),start:startSeconds()}));
    fs.mkdirSync(file+'.recovery');
    assert.throws(()=>lock.acquireFileLock(file),/Another process is recovering/);
  }
  console.log('file-lock tests passed');
} finally {fs.rmSync(directory,{recursive:true,force:true});}
