import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireFileLock } from './file-lock.js';
import { NOTIBUDDY_DIR } from './config.js';
import type { NotiBuddyConfig } from './types.js';
import { recipientCheckpoint, type RecipientCheckpoint, type VerifiedRecipients } from './groups.js';

/** Membership rollback protection follows the cryptographic destination,
 * independent of its alias or free-form sender label. Never expires on a timer. */
export class RecipientStore {
  private readonly directory:string;
  private readonly file:string;
  private readonly deviceId:string;
  constructor(config:NotiBuddyConfig,root=NOTIBUDDY_DIR) {
    this.directory=path.join(root,'recipients');
    const scope=createHash('sha256').update(JSON.stringify([config.relay,config.token,config.device.id,config.device.encPub,config.device.sigPub])).digest('hex');
    this.file=path.join(this.directory,scope+'.json');this.deviceId=config.device.id;
  }
  read():RecipientCheckpoint|undefined {
    let value:any;
    try {value=JSON.parse(fs.readFileSync(this.file,'utf8'));}
    catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return;
      throw Error('Recipient checkpoint is unreadable; preserve it before repairing the destination');
    }
    if(!value || Object.keys(value).sort().join(',')!=='fingerprint,generation' || !Number.isSafeInteger(value.generation) || value.generation<0 ||
      typeof value.fingerprint!=='string' || value.fingerprint.length!==64 || !/^[a-f0-9]{64}$/.test(value.fingerprint))throw Error('Invalid recipient checkpoint; it will not be reset automatically');
    return value;
  }
  remember(snapshot:VerifiedRecipients):void {
    const checkpoint=recipientCheckpoint(snapshot);
    if(snapshot.deviceId!==this.deviceId)throw Error('Recipient checkpoint belongs to another destination');
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});fs.chmodSync(this.directory,0o700);
    const unlock=acquireFileLock(this.file+'.lock');
    try {
      const previous=this.read();
      if(previous && (snapshot.generation<previous.generation || snapshot.generation===previous.generation && snapshot.fingerprint!==previous.fingerprint))throw Error('Recipient membership changed while verifying; refresh before sending');
      if(previous?.generation===snapshot.generation)return;
      const temporary=this.file+'.'+randomUUID()+'.tmp';
      try {
        const fd=fs.openSync(temporary,'wx',0o600);
        try {fs.writeFileSync(fd,JSON.stringify(checkpoint));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        fs.renameSync(temporary,this.file);
        if(process.platform!=='win32') {const directory=fs.openSync(this.directory,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
      } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    } finally {unlock();}
  }
}
