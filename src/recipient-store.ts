import fs from 'node:fs';
import { normalizeRelay } from './relay-url.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireFileLock } from './file-lock.js';
import { NOTIBUDDY_DIR } from './config.js';
import type { NotiBuddyConfig } from './types.js';
import { recipientCheckpoint, type RecipientCheckpoint, type VerifiedRecipients } from './groups.js';

export const DEFAULT_RECIPIENT_CACHE_TTL_MS = 3_600_000;

/** Membership rollback protection follows the cryptographic destination,
 * independent of its alias or free-form sender label. Never expires on a timer.
 * The verified raw `/v2/recipients` payload may also be cached in a sidecar with a
 * soft TTL; callers MUST still run `verifyRecipients(cached, config, store.read())`. */
export class RecipientStore {
  private readonly directory:string;
  private readonly file:string;
  private readonly cacheFile:string;
  private readonly deviceId:string;
  private memCache?:{cachedAt:number;body:unknown};
  constructor(config:NotiBuddyConfig,root=NOTIBUDDY_DIR) {
    this.directory=path.join(root,'recipients');
    const scope=(relay:string)=>createHash('sha256').update(JSON.stringify([relay,config.pairingToken ?? config.token,config.device.id,config.device.encPub,config.device.sigPub])).digest('hex');
    const normalized=normalizeRelay(config.relay);
    this.file=path.join(this.directory,scope(normalized)+'.json');
    this.cacheFile=this.file+'.cache';
    this.deviceId=config.device.id;
  }
  private readFile(file:string):RecipientCheckpoint|undefined {
    let value:any;
    try {value=JSON.parse(fs.readFileSync(file,'utf8'));}
    catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return;
      throw Error('Recipient checkpoint is unreadable; preserve it before repairing the destination');
    }
    if(!value || Object.keys(value).sort().join(',')!=='fingerprint,generation' || !Number.isSafeInteger(value.generation) || value.generation<0 ||
      typeof value.fingerprint!=='string' || value.fingerprint.length!==64 || !/^[a-f0-9]{64}$/.test(value.fingerprint))throw Error('Invalid recipient checkpoint; it will not be reset automatically');
    return value;
  }
  read():RecipientCheckpoint|undefined {
    return this.readFile(this.file);
  }
  readCached(ttlMs=DEFAULT_RECIPIENT_CACHE_TTL_MS,now=Date.now()):unknown|undefined {
    if(!Number.isFinite(ttlMs) || ttlMs<=0)return undefined;
    if(this.memCache && this.memCache.cachedAt<=now+60_000 && now-this.memCache.cachedAt<ttlMs) {
      return structuredClone(this.memCache.body);
    }
    let parsed:any;
    try {parsed=JSON.parse(fs.readFileSync(this.cacheFile,'utf8'));}
    catch{return undefined;}
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) ||
      typeof parsed.cachedAt!=='number' || !Number.isFinite(parsed.cachedAt) ||
      parsed.cachedAt>now+60_000 || now-parsed.cachedAt>=ttlMs ||
      !parsed.body || typeof parsed.body!=='object' || Array.isArray(parsed.body)) {
      return undefined;
    }
    this.memCache={cachedAt:parsed.cachedAt,body:structuredClone(parsed.body)};
    return structuredClone(parsed.body);
  }
  invalidateCache():void {
    this.memCache=undefined;
    try {fs.unlinkSync(this.cacheFile);}catch{}
  }
  private writeCacheFile(rawBody:unknown,now:number):void {
    const temporary=this.cacheFile+'.'+randomUUID()+'.tmp';
    try {
      const fd=fs.openSync(temporary,'wx',0o600);
      try {fs.writeFileSync(fd,JSON.stringify({cachedAt:now,body:rawBody}));}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,this.cacheFile);
      this.memCache={cachedAt:now,body:structuredClone(rawBody)};
    } catch {
      // Cache sidecar writes are best-effort; rollback checkpoint durability is already committed.
    } finally {if(fs.existsSync(temporary))try{fs.unlinkSync(temporary);}catch{}}
  }
  remember(snapshot:VerifiedRecipients,rawBody?:unknown,now=Date.now()):void {
    const checkpoint=recipientCheckpoint(snapshot);
    if(snapshot.deviceId!==this.deviceId)throw Error('Recipient checkpoint belongs to another destination');
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});fs.chmodSync(this.directory,0o700);
    const unlock=acquireFileLock(this.file+'.lock');
    try {
      const previous=this.read();
      if(previous && (snapshot.generation<previous.generation || snapshot.generation===previous.generation && snapshot.fingerprint!==previous.fingerprint))throw Error('Recipient membership changed while verifying; refresh before sending');
      if(previous?.generation!==snapshot.generation) {
        const temporary=this.file+'.'+randomUUID()+'.tmp';
        try {
          const fd=fs.openSync(temporary,'wx',0o600);
          try {fs.writeFileSync(fd,JSON.stringify(checkpoint));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
          fs.renameSync(temporary,this.file);
          if(process.platform!=='win32') {const directory=fs.openSync(this.directory,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
        } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
      }
      if(rawBody!==undefined)this.writeCacheFile(rawBody,now);
    } finally {unlock();}
  }
}
