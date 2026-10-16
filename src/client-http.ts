import { randomUUID } from 'node:crypto';
import { ecdsaSign, sha256, toHex } from './crypto.js';
import { normalizeRelay } from './relay-url.js';
import type { NotiBuddyConfig } from './types.js';

export interface CallOptions {signal?:AbortSignal;deadline?:number}
interface RelayCallOptions extends CallOptions {maxResponseBytes?:number}
export class DeadlineError extends Error {constructor(){super('Request deadline reached; resume the saved request');}}
export class RelayHTTPError extends Error {
  constructor(readonly status:number,readonly code?:string,readonly hasCode=code!==undefined){super(`Relay request failed (${status})${code?' '+code:''}`);}
}

/** Bounds headers and response-body consumption with the same caller deadline. */
export async function relayJSON(config:NotiBuddyConfig,route:string,init:RequestInit={},options:RelayCallOptions={},signingKey?:CryptoKey):Promise<{status:number;body:any}> {
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
      const input=new TextEncoder().encode(`nb1|http|${(init.method || 'GET').toUpperCase()}|${url.pathname}${url.search}|${stamp}|${nonce}|${bodyHash}`);
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
