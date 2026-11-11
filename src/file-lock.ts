import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const START_TOLERANCE_SECONDS=2;
const EMPTY_LOCK_GRACE_MS=5_000;
const RECOVERY_STALE_MS=30_000;

/** Start time of a live process in seconds since epoch, or undefined when it cannot be read. */
export function processStartSeconds(pid:number):number|undefined {
  if(process.platform!=='linux'&&process.platform!=='darwin')return undefined;
  try {
    const result=spawnSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:2000,env:{...process.env,LC_ALL:'C'}});
    if(result.error||result.status!==0)return undefined;
    const ms=Date.parse(result.stdout.trim());
    return Number.isFinite(ms)?Math.round(ms/1000):undefined;
  } catch {return undefined;}
}

// Read our own start time from the same source the checker uses, once. A
// clock-derived value (Date.now() - uptime) drifts after sleep or a clock
// change and would let another process steal a lock that is still held.
let cachedStart:number|undefined;
const ownStart=()=>cachedStart??=(processStartSeconds(process.pid)??Math.round((Date.now()-process.uptime()*1000)/1000));

function parseOwner(text:string):{pid:number;start?:number}|undefined {
  if(/^[1-9][0-9]*$/.test(text))return {pid:Number(text)};
  try {
    const value=JSON.parse(text) as {pid?:unknown;start?:unknown};
    if(typeof value.pid!=='number'||!Number.isInteger(value.pid)||value.pid<1)return undefined;
    return {pid:value.pid,start:typeof value.start==='number'&&Number.isInteger(value.start)?value.start:undefined};
  } catch {return undefined;}
}

const ageMs=(target:string)=>Date.now()-fs.statSync(target).mtimeMs;

/** Short exclusive local operation. A held lock is never stale by age alone; only a dead owner, a reused PID or a crashed empty write is reclaimed. */
export function acquireFileLock(file:string):()=>void {
  const take=()=>fs.writeFileSync(file,JSON.stringify({pid:process.pid,start:ownStart()}),{mode:0o600,flag:'wx'});
  const stale=()=>{
    const owner=parseOwner(fs.readFileSync(file,'utf8'));
    if(!owner)return ageMs(file)>EMPTY_LOCK_GRACE_MS;
    try{process.kill(owner.pid,0);}
    catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
    if(owner.start===undefined)return false;
    const live=processStartSeconds(owner.pid);
    return live!==undefined&&Math.abs(live-owner.start)>START_TOLERANCE_SECONDS;
  };
  const takeRecovery=(recovery:string)=>{
    try{fs.mkdirSync(recovery,{mode:0o700});return;}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      let old=false;
      try{old=ageMs(recovery)>RECOVERY_STALE_MS;}catch{/* vanished: retry below */old=true;}
      if(!old)throw new Error('Another process is recovering this operation. Retry when it finishes.');
      try{fs.rmdirSync(recovery);}catch{/* raced */}
      try{fs.mkdirSync(recovery,{mode:0o700});}
      catch{throw new Error('Another process is recovering this operation. Retry when it finishes.');}
    }
  };
  try{take();}
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const recovery=file+'.recovery';
    takeRecovery(recovery);
    try {
      if(!stale())throw new Error('Another process owns this operation. Retry when it finishes.');
      fs.unlinkSync(file);take();
    } finally {fs.rmdirSync(recovery);}
  }
  return ()=>fs.unlinkSync(file);
}
