import { randomUUID } from 'node:crypto';
import { ecdsaSign, sha256, toHex } from './crypto.js';
import { normalizeRelay } from './relay-url.js';
import type { NotiBuddyConfig } from './types.js';
import { CLIENT_VERSION } from './update-check.js';
import { accountIdOf, credentialBinding, recoverCredentials } from './credential-recovery.js';

/** The 32-hex account the relay edge derives from a sender/device bearer token (sha256 of its secret part). */
export function httpSigningAccount(token:string):string {
  return accountIdOf(token);
}
/** `nb2|http|` input: names the account, then method, route, timestamp, nonce and body hash. */
export function httpSigningInput(token:string,method:string,route:string,timestamp:string,nonce:string,bodyHashHex:string):Uint8Array {
  return new TextEncoder().encode(`nb2|http|${httpSigningAccount(token)}|${method}|${route}|${timestamp}|${nonce}|${bodyHashHex}`);
}
export interface CallOptions {signal?:AbortSignal;deadline?:number}
interface RelayCallOptions extends CallOptions {maxResponseBytes?:number}
export class DeadlineError extends Error {constructor(){super('Request deadline reached; resume the saved request');}}
export class RelayHTTPError extends Error {
  constructor(readonly status:number,readonly code?:string,readonly hasCode=code!==undefined){super(`Relay request failed (${status})${code?' '+code:''}`);}
}

/** The relay's HTTP 426 CLIENT_UPGRADE_REQUIRED answer: this client is below the support floor. */
export class ClientUpgradeRequiredError extends Error {
  constructor(minimumVersion?:unknown) {
    const minimum=typeof minimumVersion==='string' && /^\d+\.\d+\.\d+$/.test(minimumVersion)?minimumVersion:undefined;
    super(`The NotiBuddy relay no longer supports this client (${CLIENT_VERSION}${minimum?`; the minimum is ${minimum}`:''}). Update with: npm install -g notibuddy@latest — or change notibuddy@${CLIENT_VERSION} to notibuddy@latest in your npx command or MCP configuration.`);
    this.name='ClientUpgradeRequiredError';
  }
}

const CREDENTIALS_ROUTE='/v1/sender/credentials';
/** Refreshes a rotated credential for a bound config; false when the config is unbound. */
export async function recoverRotatedCredentials(config:NotiBuddyConfig,options:CallOptions={}):Promise<boolean> {
  const binding=credentialBinding(config);
  if(!binding)return false;
  return recoverCredentials(config,async()=>{
    try {return await relayJSONOnce(config,CREDENTIALS_ROUTE,{},{...options,maxResponseBytes:8192},binding.signingKey);}
    catch(error) {
      if(error instanceof RelayHTTPError && (error.status===401 || error.status===404))return {status:error.status,body:null};
      throw error;
    }
  });
}

/** One bounded relay call; on 409 CREDENTIAL_ROTATED a bound config refreshes its credential and retries once. */
export async function relayJSON(config:NotiBuddyConfig,route:string,init:RequestInit={},options:RelayCallOptions={},signingKey?:CryptoKey):Promise<{status:number;body:any}> {
  try {return await relayJSONOnce(config,route,init,options,signingKey);}
  catch(error) {
    if(!(error instanceof RelayHTTPError) || error.status!==409 || error.code!=='CREDENTIAL_ROTATED' ||
      route.split('?')[0]===CREDENTIALS_ROUTE || !await recoverRotatedCredentials(config,options))throw error;
    return relayJSONOnce(config,route,init,options,signingKey);
  }
}

/** Bounds headers and response-body consumption with the same caller deadline. */
export async function relayJSONOnce(config:NotiBuddyConfig,route:string,init:RequestInit={},options:RelayCallOptions={},signingKey?:CryptoKey):Promise<{status:number;body:any}> {
  const maxBytes=options.maxResponseBytes ?? 524288;
  if(!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>524288)throw Error('Invalid relay response limit');
  const remaining=Math.min(15000,(options.deadline ?? Date.now()+15000)-Date.now());
  if(remaining<=0)throw new DeadlineError();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DeadlineError()),remaining);
  const upstream=[options.signal,init.signal].filter((s):s is AbortSignal=>!!s);
  const abort=()=>controller.abort(upstream.find(s=>s.aborted)?.reason ?? new DOMException('Cancelled','AbortError'));
  for(const signal of upstream){signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}
  const signal=controller.signal;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let onAbort:()=>void=()=>{};
  const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
  void aborted.catch(()=>{});
  try {
    signal.throwIfAborted();
    const headers=new Headers(init.headers);headers.set('Authorization','Bearer '+config.token);headers.set('Content-Type','application/json');
    if(signingKey) {
      const stamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
      const url=new URL(normalizeRelay(config.relay)+route),body=typeof init.body==='string'?init.body:'';
      const bodyHash=toHex(await sha256(new TextEncoder().encode(body)));
      // The edge strips /v1 before the account object verifies, so v1 routes sign the stripped path.
      const input=httpSigningInput(config.token,(init.method || 'GET').toUpperCase(),`${url.pathname.replace(/^\/v1(?=\/)/,'')}${url.search}`,stamp,nonce,bodyHash);
      headers.set('X-Sender-Key-ID',config.senderKeyId);headers.set('X-Sender-Timestamp',stamp);headers.set('X-Sender-Nonce',nonce);
      headers.set('X-Sender-Signature',await ecdsaSign(signingKey,input));
    }
    signal.throwIfAborted();
    const response=await Promise.race([fetch(normalizeRelay(config.relay)+route,{...init,headers,signal,redirect:'error'}),aborted]);
    if(response.status===204)return {status:204,body:null};
    reader=response.body?.getReader();
    if(Number(response.headers.get('content-length'))>maxBytes)throw Error('Relay response exceeds the size limit');
    const chunks:Uint8Array[]=[];let size=0;
    if(reader)for(;;) {
      const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;
      size+=value.length;if(size>maxBytes)throw Error('Relay response exceeds the size limit');chunks.push(value);
    }
    const text=Buffer.concat(chunks,size).toString('utf8');
    let body:any=null;
    try{if(text)body=JSON.parse(text);}catch{if(response.ok)throw Error('Relay returned invalid JSON');}
    if(response.status===426 && body?.code==='CLIENT_UPGRADE_REQUIRED')throw new ClientUpgradeRequiredError(body.minimumVersion);
    if(!response.ok)throw new RelayHTTPError(response.status,
      typeof body?.code==='string' && /^[A-Z_]{1,80}$/.exec(body.code)?.[0]===body.code?body.code:undefined,
      body!==null && typeof body==='object' && Object.hasOwn(body,'code'));
    return {status:response.status,body};
  }finally {
    clearTimeout(timer);signal.removeEventListener('abort',onAbort);
    for(const signal of upstream)signal.removeEventListener('abort',abort);
    if(reader)void reader.cancel().catch(()=>{});
  }
}

export async function pollPause(milliseconds:number,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(signal?.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},Math.max(0,milliseconds));
    signal?.addEventListener('abort',stop,{once:true});
  });
}
