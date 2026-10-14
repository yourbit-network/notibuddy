import fs from 'node:fs';
import { normalizeRelay } from './relay-url.js';
import { validatePairingBundle, validateRequestSettings } from './protocol.js';
import { acquireFileLock } from './file-lock.js';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NotiBuddyConfig, SenderKeyPair, PairingBundle } from './types.js';
import { deriveDeviceId, deriveSenderKeyId, generateSenderSigningKeyPair, importSenderPrivateKey, ecdsaSign, ecdsaVerify, generateReplyKeyPair, hpkeSealBytes, hpkeOpenBytes, isValidP256PublicKey } from './crypto.js';

// The override relocates the whole store (e.g. for tests); it is not profile selection.
export const NOTIBUDDY_DIR = process.env.NOTIBUDDY_HOME || path.join(os.homedir(), '.notibuddy');
const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/, 'Use a destination name of 1–48 lowercase letters, digits, hyphens or underscores, starting with a letter');
export const senderLabelSchema = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'Sender labels cannot contain control characters');
export function senderLabel(value = os.hostname()): string { return senderLabelSchema.parse(value); }
export function destinationName(value: string): string { return nameSchema.parse(value); }
const configSchema = z.object({
  relay: z.string().url(), token: z.string().min(1),
  device: z.object({id:z.string().min(1),encPub:z.string().min(1),sigPub:z.string().min(1),name:z.string().optional()}),
  senderKeyId:z.string().min(1), senderLabel:z.string().min(1),
  requestProtocol:z.union([z.literal(1),z.literal(2)]).optional(),minimumRecipientGeneration:z.number().int().safe().nonnegative().optional(),
});
const keysSchema = z.object({senderKeyId:z.string(),publicKeyB64u:z.string(),privateKeyJwk:z.record(z.string(),z.unknown())});
const recordSchema = z.object({version:z.literal(2),connectionId:z.string().uuid(),config:configSchema,keys:keysSchema,fileKey:z.object({publicKeyB64u:z.string(),privateKeyJwk:z.record(z.string(),z.unknown())}).optional()});
export interface DestinationRecord { version: 2; connectionId: string; config: NotiBuddyConfig; keys: SenderKeyPair; fileKey?: {publicKeyB64u:string; privateKeyJwk:JsonWebKey} }
export interface DestinationSummary { name: string; connectionId: string; deviceId: string; deviceName: string; connectionLabel: string }

/** Named destinations contain one immutable pairing each. Aliases never determine reply storage. */
export class DestinationStore {
  constructor(readonly root = NOTIBUDDY_DIR) {}
  private file(name: string): string { return path.join(this.root, 'destinations', destinationName(name)+'.json'); }
  private ensure(): void {
    fs.mkdirSync(this.root,{recursive:true,mode:0o700}); fs.chmodSync(this.root,0o700);
    const directory=path.join(this.root,'destinations');
    fs.mkdirSync(directory,{recursive:true,mode:0o700}); fs.chmodSync(directory,0o700);
  }
  read(name: string): DestinationRecord {
    const file=this.file(name);
    try { return recordSchema.parse(JSON.parse(fs.readFileSync(file,'utf8'))) as DestinationRecord; }
    catch(error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') {
        const legacy=fs.existsSync(path.join(this.root,'config.json'));
        throw new Error(legacy ? `Destination '${name}' is not saved. Import the existing pairing with: nb devices migrate --to ${name}` : `Destination '${name}' is not paired. Run: nb pair <bundle> --to ${name}`);
      }
      throw new Error(`Destination '${name}' is unreadable. Preserve its file and restore it; keys will not be regenerated automatically.`);
    }
  }
  private create(name: string, record: DestinationRecord): void {
    this.ensure();
    const target=this.file(name), temporary=target+'.'+randomUUID()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(record,null,2)+'\n',{mode:0o600,flag:'wx'});
    try { fs.linkSync(temporary,target); } // Atomic create, never replace an existing pairing.
    finally { fs.unlinkSync(temporary); }
  }
  list(): DestinationSummary[] {
    const directory=path.join(this.root,'destinations');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(n=>n.endsWith('.json')).sort().map(file=>{
      const name=file.slice(0,-5), record=this.read(name);
      return {name,connectionId:record.connectionId,deviceId:record.config.device.id,
        deviceName:record.config.device.name || 'iPhone',connectionLabel:record.config.senderLabel};
    });
  }
  async open(name: string): Promise<{record:DestinationRecord; signingKey:CryptoKey}> {
    const record=this.read(name), {config,keys}=record;validateRequestSettings(config);
    const signingKey=await importSenderPrivateKey(keys.privateKeyJwk);
    const challenge=new TextEncoder().encode('notibuddy/local-key-check');
    if (!isValidP256PublicKey(config.device.encPub) || !isValidP256PublicKey(config.device.sigPub) ||
        config.senderKeyId!==keys.senderKeyId || await deriveSenderKeyId(keys.publicKeyB64u)!==keys.senderKeyId ||
        !await ecdsaVerify(keys.publicKeyB64u,challenge,await ecdsaSign(signingKey,challenge)) ||
        await deriveDeviceId(config.device.encPub,config.device.sigPub)!==config.device.id) {
      throw new Error(`Destination '${name}' contains mismatched keys. Preserve it and restore the correct pairing.`);
    }
    if (record.fileKey) {
      const key=await crypto.subtle.importKey('jwk',record.fileKey.privateKeyJwk,{name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
      const sealed=await hpkeSealBytes(record.fileKey.publicKeyB64u,'notibuddy/key-check','',challenge);
      const opened=await hpkeOpenBytes(key,sealed.enc,'notibuddy/key-check','',sealed.ct);
      if (!Buffer.from(opened).equals(Buffer.from(challenge))) throw new Error('File receiving keys do not match');
    }
    return {record,signingKey};
  }
  async prepare(name:string,bundle:PairingBundle,label:string): Promise<{record:DestinationRecord;signingKey:CryptoKey}> {
    destinationName(name); senderLabel(label);
    bundle=await validatePairingBundle(bundle);
    if (!fs.existsSync(this.file(name))) {
      const keys=await generateSenderSigningKeyPair();
      const record:DestinationRecord={version:2,connectionId:randomUUID(),config:{
        relay:bundle.relay,token:bundle.token,device:bundle.device,senderKeyId:keys.senderKeyId,senderLabel:label,
        requestProtocol:bundle.requestProtocol,minimumRecipientGeneration:bundle.minimumRecipientGeneration,
      },keys:{senderKeyId:keys.senderKeyId,publicKeyB64u:keys.publicKeyB64u,privateKeyJwk:keys.privateKeyJwk}};
      try { this.create(name,record); }
      catch(error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
    }
    const opened=await this.open(name), config=opened.record.config;
    if (normalizeRelay(config.relay)!==bundle.relay || config.token!==bundle.token || config.device.id!==bundle.device.id || config.device.encPub!==bundle.device.encPub || config.device.sigPub!==bundle.device.sigPub || config.senderLabel!==label) {
      throw new Error(`Destination '${name}' already names a different pairing or connection label. Use a new destination name; existing requests will not be redirected.`);
    }
    const generated=!opened.record.fileKey ? await generateReplyKeyPair() : undefined;
    const fileKey=generated ? {publicKeyB64u:generated.publicKeyB64u,privateKeyJwk:await crypto.subtle.exportKey('jwk',generated.privateKey)} : opened.record.fileKey;
    const unlock=acquireFileLock(this.file(name)+'.lock');
    try {
      const latest=this.read(name);
      if(latest.connectionId!==opened.record.connectionId)throw Error('Destination changed during pairing. Retry.');
      if((latest.config.requestProtocol ?? 1)>(bundle.requestProtocol ?? 1) ||
        (latest.config.minimumRecipientGeneration ?? 0)>(bundle.minimumRecipientGeneration ?? 0))throw Error('Pairing data would downgrade the destination. Share fresh setup data from the phone.');
      latest.fileKey ??= fileKey;latest.config.relay=bundle.relay;
      latest.config.requestProtocol=bundle.requestProtocol;latest.config.minimumRecipientGeneration=bundle.minimumRecipientGeneration;
      const temp=this.file(name)+'.'+randomUUID()+'.tmp';
      try {
        const fd=fs.openSync(temp,'wx',0o600);
        try {fs.writeFileSync(fd,JSON.stringify(latest,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        fs.renameSync(temp,this.file(name));
        if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(this.file(name)),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
      }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    }finally{unlock();}
    return this.open(name);
  }
  async migrate(name: string): Promise<void> {
    destinationName(name);
    let config:NotiBuddyConfig, keys:SenderKeyPair;
    try {
      config=configSchema.parse(JSON.parse(fs.readFileSync(path.join(this.root,'config.json'),'utf8')));
      keys=keysSchema.parse(JSON.parse(fs.readFileSync(path.join(this.root,'sender.json'),'utf8'))) as SenderKeyPair;
    } catch { throw new Error('Existing pairing is missing or unreadable. Preserve config.json and sender.json; no files were changed.'); }
    const record:DestinationRecord={version:2,connectionId:randomUUID(),config,keys};
    // Validate in memory before publishing the imported record.
    const signingKey=await importSenderPrivateKey(keys.privateKeyJwk);
    const challenge=new TextEncoder().encode('notibuddy/local-key-check');
    if (config.senderKeyId!==keys.senderKeyId || await deriveSenderKeyId(keys.publicKeyB64u)!==keys.senderKeyId ||
        !await ecdsaVerify(keys.publicKeyB64u,challenge,await ecdsaSign(signingKey,challenge)) ||
        await deriveDeviceId(config.device.encPub,config.device.sigPub)!==config.device.id) throw new Error('Legacy pairing keys do not match. No files were changed.');
    this.create(name,record);
    // Keep original files for rollback. PendingStore uses the unchanged cryptographic scope.
  }
  rename(from:string,to:string):void {
    this.read(from); this.ensure();
    fs.linkSync(this.file(from),this.file(to));
    fs.unlinkSync(this.file(from));
  }
  forget(name:string):void { this.read(name); fs.unlinkSync(this.file(name)); }
}
