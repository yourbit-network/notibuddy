// Canonical v2 wire contract; shared vectors pin compatibility with Swift and the relay.
import { fromB64u as fromB64, toB64u } from './crypto.js';

export type GroupDelivery={deviceId:string;enc:string;ct:string;sig:string};
export type GroupRequest={v:2;kind:'request';requestId:string;deviceId:string;senderKeyId:string;primitive:string;
  createdAt:number;expiresAt:number;generation:number;sessionId:string;revision:number;deliveries:GroupDelivery[]};
export type GroupReceipt={deviceId:string;enc:string;ct:string};
export type GroupResponse={v:2;kind:'reply'|'control';requestId:string;parentDeviceId:string;deviceId:string;
  generation:number;responseId:string;createdAt:number;enc:string;ct:string;receipts:GroupReceipt[];sig:string};

const identifier=(value:unknown,prefix='')=>typeof value==='string' && value.length<=64 &&
  (prefix ? new RegExp('^'+prefix+'[a-f0-9]{24}$').exec(value)?.[0]===value : /^[A-Za-z0-9_-]{1,64}$/.exec(value)?.[0]===value);
const integer=(value:unknown,min=0)=>typeof value==='number' && Number.isSafeInteger(value) && value>=min;
const fields=(value:unknown,names:string):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===names;
function binary(value:unknown,min:number,max:number):value is string {
  if(typeof value!=='string' || value.length>200000 || !/^[A-Za-z0-9_-]+$/.test(value))return false;
  try {const bytes=fromB64(value);return bytes.length>=min && bytes.length<=max && toB64u(bytes)===value;}
  catch{return false;}
}
const point=(value:unknown)=>binary(value,65,65) && fromB64(value)[0]===4;
const primitives=['approval','text_input','form','activity_start','activity_update','activity_end'];

export function validGroupRequest(value:unknown):value is GroupRequest {
  if(!fields(value,'createdAt,deliveries,deviceId,expiresAt,generation,kind,primitive,requestId,revision,senderKeyId,sessionId,v'))return false;
  const r=value as unknown as GroupRequest;
  if(r.v!==2 || r.kind!=='request' || !identifier(r.requestId) || !identifier(r.sessionId) ||
    !identifier(r.deviceId,'dev_') || !identifier(r.senderKeyId,'snd_') || !primitives.includes(r.primitive) ||
    !integer(r.createdAt,1) || !integer(r.expiresAt,1) || !integer(r.generation) || !integer(r.revision,1) ||
    !Array.isArray(r.deliveries) || r.deliveries.length<1 || r.deliveries.length>2)return false;
  const ids=r.deliveries.map(d=>d?.deviceId);
  return ids.includes(r.deviceId) && new Set(ids).size===ids.length && [...ids].sort().join(',')===ids.join(',') &&
    r.deliveries.every(d=>fields(d,'ct,deviceId,enc,sig') && identifier(d.deviceId,'dev_') && point(d.enc) && binary(d.ct,16,150000) && binary(d.sig,64,64));
}

export function groupDeliveryHeader(r:GroupRequest,recipient:string):string {
  return `nb2|request|${r.requestId}|${r.deviceId}|${recipient}|${r.senderKeyId}|${r.primitive}|${r.createdAt}|${r.expiresAt}|${r.generation}|${r.sessionId}|${r.revision}|${r.deliveries.map(d=>d.deviceId).join(',')}`;
}
export function groupDeliveryInput(r:GroupRequest,d:GroupDelivery):Uint8Array {
  return new Uint8Array([...new TextEncoder().encode(groupDeliveryHeader(r,d.deviceId)),0,...fromB64(d.enc),...fromB64(d.ct)]);
}

export function validGroupResponse(value:unknown):value is GroupResponse {
  if(!fields(value,'createdAt,ct,deviceId,enc,generation,kind,parentDeviceId,receipts,requestId,responseId,sig,v'))return false;
  const r=value as unknown as GroupResponse;
  if(r.v!==2 || !['reply','control'].includes(r.kind) || !identifier(r.requestId) || !identifier(r.responseId) ||
    !identifier(r.parentDeviceId,'dev_') || !identifier(r.deviceId,'dev_') || !integer(r.generation) || !integer(r.createdAt,1) ||
    !point(r.enc) || !binary(r.ct,16,150000) || !binary(r.sig,64,64) || !Array.isArray(r.receipts) || r.receipts.length>1)return false;
  return r.receipts.every(p=>fields(p,'ct,deviceId,enc') && identifier(p.deviceId,'dev_') && p.deviceId!==r.deviceId && point(p.enc) && binary(p.ct,16,150000));
}
export function groupResponseHeader(r:GroupResponse):string {
  return `nb2|${r.kind}|${r.requestId}|${r.parentDeviceId}|${r.deviceId}|${r.generation}|${r.responseId}|${r.createdAt}|${r.receipts.map(p=>p.deviceId).join(',')}`;
}
export function groupResponseInput(r:GroupResponse):Uint8Array {
  const chunks:Uint8Array[]=[new TextEncoder().encode(groupResponseHeader(r)),new Uint8Array([0])];
  for(const cipher of [r,...r.receipts]) {
    const ct=fromB64(cipher.ct),length=new Uint8Array(4);
    new DataView(length.buffer).setUint32(0,ct.length,false);
    chunks.push(fromB64(cipher.enc),length,ct);
  }
  const result=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;
  for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}
  return result;
}

/** Canonical wire serialization for idempotency; input validation rejects extra fields. */
export function canonicalGroupWire(value:GroupRequest|GroupResponse):string {
  const canonical=(v:unknown):unknown=>Array.isArray(v) ? v.map(canonical) : v && typeof v==='object'
    ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,canonical(item)])) : v;
  return JSON.stringify(canonical(value));
}
