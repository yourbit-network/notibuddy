import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { acquireFileLock } from './file-lock.js';
import { normalizeRelay } from './relay-url.js';
import type { NotiBuddyConfig, ActivityPayload, AskPayload, RequestEnvelope } from './types.js';
import type { GroupRequest } from './groups.js';

export interface PendingReply {
  privateKeyJwk: JsonWebKey;
  expiresAt: number;
  envelope?: RequestEnvelope | GroupRequest;
  payload?:AskPayload|ActivityPayload; // Retained privately only until dispatch acknowledgement.
  recipients?: unknown;
  dispatch?: 'pending' | 'accepted';
}
export interface ActivitySession {
  payload: ActivityPayload;
  requests: { id: string; afterSeq: number; expiresAt: number; seenSignatures?: string[]; unavailable?: boolean }[];
  ended?: boolean;
  expiresAt?: number;
  pollOffset?: number;
  lastControlSeq?: number;
  pendingDispatch?: string;
  previous?: ActivitySession;
  protocol?: 1 | 2;
}
export class PendingStorageError extends Error {}
const MAX_RECORD_BYTES=1024*1024;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Atomic records preserve the exact request and response key across restarts. */
export class PendingStore {
  private directory:string;
  private legacyDirectories:string[];
  constructor(config:NotiBuddyConfig,readonly root=process.env.NOTIBUDDY_HOME || path.join(os.homedir(),'.notibuddy')) {
    const scope=(relay:string)=>hash(JSON.stringify([relay,config.token,config.device.id,config.senderKeyId]));
    const normalized=normalizeRelay(config.relay);
    this.directory=path.join(root,'pending',scope(normalized));
    this.legacyDirectories=[...new Set([config.relay,normalized+'/'].map(relay=>path.join(root,'pending',scope(relay))))].filter(d=>d!==this.directory);
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});fs.chmodSync(this.directory,0o700);this.prune();
  }
  private file(key:string,directory=this.directory) {return path.join(directory,hash(key)+'.json');}
  private syncDirectory() {
    if(process.platform==='win32')return;
    const fd=fs.openSync(this.directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  async withOperation<T>(key:string,operation:()=>Promise<T>):Promise<T> {
    const unlock=acquireFileLock(this.file(key)+'.operation.lock');
    try{return await operation();}finally{unlock();}
  }
  private readFile(file:string):{value:unknown;retainUntil:number}|undefined {
    try {
      const fd=fs.openSync(file,'r');
      try {
        if(fs.fstatSync(fd).size>MAX_RECORD_BYTES)throw Error('Record too large');
        const stored=JSON.parse(fs.readFileSync(fd,'utf8'));
        if(!stored || Object.keys(stored).sort().join(',')!=='retainUntil,value' || !Number.isSafeInteger(stored.retainUntil) || stored.retainUntil<1)throw Error('Invalid record');
        if(process.platform!=='win32')fs.fchmodSync(fd,0o600);
        return stored;
      }finally{fs.closeSync(fd);}
    }catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return;
      throw new PendingStorageError('Pending request storage is unreadable; preserve it to recover the request');
    }
  }
  read<T>(key:string):T|undefined {
    const target=this.file(key),unlock=acquireFileLock(target+'.lock');
    try {
    let stored=this.readFile(target);
    if(!stored)for(const directory of this.legacyDirectories) {
      const file=this.file(key,directory),legacy=this.readFile(file);
      if(!legacy)continue;
      if(legacy.retainUntil<=Date.now()){fs.unlinkSync(file);continue;}
      // Publish without overwriting a concurrently saved canonical record.
      let published=false;
      try{fs.linkSync(file,target);this.syncDirectory();published=true;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      stored=this.readFile(target);if(published)fs.unlinkSync(file);break;
    }
    if(!stored)return;
    if(stored.retainUntil<=Date.now()){this.removeUnlocked(key);return;}
    return stored.value as T;
    }finally{unlock();}
  }
  write(key:string,value:unknown,retainUntil:number):void {
    if(!Number.isSafeInteger(retainUntil) || retainUntil<1)throw new PendingStorageError('Invalid pending retention deadline');
    const bytes=JSON.stringify({value,retainUntil});
    if(Buffer.byteLength(bytes)>MAX_RECORD_BYTES)throw new PendingStorageError('Pending record exceeds its storage limit');
    const target=this.file(key),temporary=target+'.'+randomUUID()+'.tmp',unlock=acquireFileLock(target+'.lock');
    try {
      const fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,target);this.syncDirectory();
    }finally{try{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}finally{unlock();}}
  }
  remove(key:string):void {
    const unlock=acquireFileLock(this.file(key)+'.lock');
    try{this.removeUnlocked(key);}finally{unlock();}
  }
  private removeUnlocked(key:string):void {
    for(const directory of [this.directory,...this.legacyDirectories])fs.rmSync(this.file(key,directory),{force:true});
    this.syncDirectory();
  }
  private prune():void {
    for(const directory of [this.directory,...this.legacyDirectories]) {
      if(!fs.existsSync(directory))continue;
      for(const name of fs.readdirSync(directory)) {
        const file=path.join(directory,name);
        try {
          if(/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(name) && Date.now()-fs.statSync(file).mtimeMs>86400000)fs.unlinkSync(file);
          else if(/^[a-f0-9]{64}\.json$/.test(name)) {
            const unlock=acquireFileLock(file+'.lock');
            try{const stored=this.readFile(file);if(stored && stored.retainUntil<=Date.now())fs.unlinkSync(file);}finally{unlock();}
          }
        }catch{/* Preserve damaged records; an attempted read reports the failure. */}
      }
    }
  }
}
