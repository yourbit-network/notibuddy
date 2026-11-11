import { createHash } from 'node:crypto';
import type { DestinationStore } from './config.js';
import { ecdsaVerify, fromB64u, hpkeOpenBytes, sha256, toB64u, toHex } from './crypto.js';
import type { NotiBuddyConfig } from './types.js';

const EPOCH_TOKEN=/^nb_snd_([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
const RECORD_INFO='notibuddy/v2/sender-credentials';

/** The 32-hex account the relay edge derives from a sender token: embedded for an epoch token, else sha256 of the secret part. */
export function accountIdOf(token:string):string {
  const epoch=EPOCH_TOKEN.exec(token);
  if(epoch)return epoch[1];
  return createHash('sha256').update(token.replace(/^nb_(?:snd|dev|usr)_/,''),'utf8').digest('hex').slice(0,32);
}

export class CredentialRecoveryError extends Error {
  constructor(readonly destination:string) {
    super(`This computer's NotiBuddy credentials were rotated on the phone and could not be refreshed. Pair again: in NotiBuddy on the phone add this computer, then run: nb pair --to ${destination}`);
    this.name='CredentialRecoveryError';
  }
}

export interface CredentialBinding {store:DestinationStore;name:string;signingKey:CryptoKey}
const bindings=new WeakMap<NotiBuddyConfig,CredentialBinding>();
const inflight=new WeakMap<NotiBuddyConfig,Promise<boolean>>();
/** Held outside the config because structuredClone forbids functions and keys on it. */
export function bindCredentials(config:NotiBuddyConfig,binding:CredentialBinding):void {bindings.set(config,binding);}
export function credentialBinding(config:NotiBuddyConfig):CredentialBinding|undefined {return bindings.get(config);}

const canonical=(value:unknown,size:number):Uint8Array=>{
  if(typeof value!=='string' || !/^[A-Za-z0-9_-]+$/.test(value))throw Error('Malformed credential record');
  const bytes=fromB64u(value);
  if(bytes.length!==size || toB64u(bytes)!==value)throw Error('Malformed credential record');
  return bytes;
};

/** Opens the phone's sealed record, then verifies its signature over the derived epoch hash. */
export async function openCredentialRecord(config:NotiBuddyConfig,privateKeyJwk:JsonWebKey,body:any):Promise<{token:string;epoch:number}> {
  if(!body || typeof body!=='object' || body.v!==1 || !Number.isSafeInteger(body.epoch) || body.epoch<1 ||
    body.deviceId!==config.device.id || !body.record || typeof body.record!=='object')throw Error('Malformed credential record');
  const {enc,ct,sig}=body.record,epoch=body.epoch as number;
  const encBytes=canonical(enc,65),ctBytes=canonical(ct,48);canonical(sig,64);
  const accountId=accountIdOf(config.token);
  const {kty,crv,x,y,d}=privateKeyJwk;
  const key=await crypto.subtle.importKey('jwk',{kty,crv,x,y,d},{name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const aad=`nb2|sender-credentials|${accountId}|${config.device.id}|${config.senderKeyId}|${epoch}`;
  const secret=await hpkeOpenBytes(key,enc,RECORD_INFO,aad,ctBytes);
  if(secret.length!==32)throw Error('Malformed credential record');
  const epochHash=toHex(await sha256(secret));
  const joined=new Uint8Array(encBytes.length+ctBytes.length);joined.set(encBytes,0);joined.set(ctBytes,encBytes.length);
  const input=new TextEncoder().encode(`nb2|sender-credentials|${accountId}|${config.device.id}|${config.senderKeyId}|${epoch}|${epochHash}|${toHex(await sha256(joined))}`);
  if(!await ecdsaVerify(config.device.sigPub,input,sig))throw Error('Credential record signature is invalid');
  return {token:`nb_snd_${accountId}.${toB64u(secret)}`,epoch};
}

const adopt=(config:NotiBuddyConfig,from:NotiBuddyConfig)=>{
  config.token=from.token;config.credentialEpoch=from.credentialEpoch;
  if(from.pairingToken!==undefined)config.pairingToken=from.pairingToken;
};

/** Refreshes a rotated sender credential and persists it before returning true; false means this config is unbound. */
export function recoverCredentials(config:NotiBuddyConfig,fetchRecord:()=>Promise<{status:number;body:any}>):Promise<boolean> {
  const binding=bindings.get(config);
  if(!binding)return Promise.resolve(false);
  const running=inflight.get(config);
  if(running)return running;
  const {store,name}=binding;
  const run=(async()=>{
    const current=config.credentialEpoch ?? 0;
    // A destination re-paired under another sender key is not this config's to adopt or open.
    const ours=()=>{
      const record=store.read(name);
      if(record.config.senderKeyId!==config.senderKeyId || record.keys.senderKeyId!==config.senderKeyId)throw new CredentialRecoveryError(name);
      return record;
    };
    const stored=ours().config;
    if((stored.credentialEpoch ?? 0)>current){adopt(config,stored);return true;}
    const response=await fetchRecord();
    if(response.status===404) {
      const latest=ours().config;
      if((latest.credentialEpoch ?? 0)>current){adopt(config,latest);return true;}
      throw new CredentialRecoveryError(name);
    }
    if(response.status!==200)throw new CredentialRecoveryError(name);
    const keys=ours().keys;
    let opened:{token:string;epoch:number};
    try{
      opened=await openCredentialRecord(config,keys.privateKeyJwk,response.body);
      if(opened.epoch<=current)throw Error('Credential epoch did not increase');
    }catch{throw new CredentialRecoveryError(name);}
    const record=await store.rotateCredentials(name,{senderKeyId:config.senderKeyId,token:opened.token,epoch:opened.epoch});
    adopt(config,record.config);
    return true;
  })();
  inflight.set(config,run);
  const clear=()=>{if(inflight.get(config)===run)inflight.delete(config);};
  run.then(clear,clear);
  return run;
}
