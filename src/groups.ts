import { MAX_ACTIVITY_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS, requestTimeoutSeconds } from './request-timeout.js';
import { answerSchema } from './answer-validation.js';
import type { NotiBuddyConfig, AskPayload, ActivityPayload, AnswerPayload, PrimitiveType } from './types.js';
import { deriveDeviceId, ecdsaSign, ecdsaVerify, fromB64u, hpkeOpen, hpkeSeal, sha256, toB64u, toHex } from './crypto.js';
import { companionGrantInput, validCompanionGrant, type CompanionGrant } from './companion-grant.js';
import { groupDeliveryHeader, groupDeliveryInput, groupResponseHeader, groupResponseInput, validGroupRequest, validGroupResponse, type GroupRequest, type GroupResponse } from './group-wire.js';
export type { GroupRequest, GroupResponse } from './group-wire.js';

const verified:unique symbol=Symbol('verified recipients');
export type GroupRecipient={deviceId:string;encPub:string;sigPub:string;capabilities:string[]};
export type VerifiedRecipients={readonly [verified]:true;readonly deviceId:string;readonly generation:number;
  readonly fingerprint:string;readonly recipients:readonly Readonly<GroupRecipient>[]};
export type RecipientCheckpoint={generation:number;fingerprint:string};
const exact=(value:unknown,fields:string):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===fields;
const binary=(value:unknown,count:number)=>typeof value==='string' && /^[A-Za-z0-9_-]+$/.exec(value)?.[0]===value &&
  fromB64u(value).length===count && toB64u(fromB64u(value))===value;
const point=(value:unknown):value is string=>binary(value,65) && fromB64u(value as string)[0]===4;
const invalid=()=>new Error('Destination recipient verification failed; keep the pinned pairing and refresh its approved membership');

/** Verify each child grant against the out-of-band primary key. The relay is
 * still authoritative for roster absence/revocation; this is not attestation. */
export async function verifyRecipients(input:unknown,config:NotiBuddyConfig,checkpoint?:RecipientCheckpoint):Promise<VerifiedRecipients> {
  input=structuredClone(input);config=structuredClone(config);checkpoint=structuredClone(checkpoint);
  if(!exact(input,'companions,deviceId,generation,primary,v') || input.v!==2 || input.deviceId!==config.device.id ||
    !Number.isSafeInteger(input.generation) || (input.generation as number)<0 ||
    !exact(input.primary,'deviceId,encPub,sigPub') || input.primary.deviceId!==config.device.id ||
    input.primary.encPub!==config.device.encPub || input.primary.sigPub!==config.device.sigPub ||
    !Array.isArray(input.companions) || input.companions.length>1 || !point(config.device.encPub) || !point(config.device.sigPub) ||
    await deriveDeviceId(config.device.encPub,config.device.sigPub)!==config.device.id)throw invalid();
  const generation=input.generation as number;
  if(checkpoint && generation<checkpoint.generation)throw invalid();
  const realm=config.token.replace(/^nb_(?:snd|dev|usr)_/,''),accountId=toHex(await sha256(new TextEncoder().encode(realm))).slice(0,32);
  const recipients:GroupRecipient[]=[{deviceId:config.device.id,encPub:config.device.encPub,sigPub:config.device.sigPub,capabilities:[]}];
  for(const record of input.companions) {
    if(!exact(record,'childSignature,grant,parentSignature') || !validCompanionGrant(record.grant) ||
      !binary(record.parentSignature,64) || !binary(record.childSignature,64))throw invalid();
    const g:CompanionGrant=record.grant;
    if(g.accountId!==accountId || g.parentDeviceId!==config.device.id || g.generation!==generation ||
      !point(g.encPub) || !point(g.sigPub) || [config.device.encPub,config.device.sigPub].includes(g.encPub) ||
      [config.device.encPub,config.device.sigPub].includes(g.sigPub) || await deriveDeviceId(g.encPub,g.sigPub)!==g.deviceId ||
      !await ecdsaVerify(config.device.sigPub,companionGrantInput(g,'parent'),record.parentSignature as string) ||
      !await ecdsaVerify(g.sigPub,companionGrantInput(g,'child'),record.childSignature as string))throw invalid();
    // expiresAt is the enrollment deadline, not an active membership lifetime.
    recipients.push({deviceId:g.deviceId,encPub:g.encPub,sigPub:g.sigPub,capabilities:[...g.capabilities]});
  }
  recipients.sort((a,b)=>a.deviceId.localeCompare(b.deviceId));
  const fingerprint=toHex(await sha256(new TextEncoder().encode(JSON.stringify([config.device.id,generation,recipients]))));
  if(checkpoint && generation===checkpoint.generation && fingerprint!==checkpoint.fingerprint)throw invalid();
  for(const recipient of recipients){Object.freeze(recipient.capabilities);Object.freeze(recipient);}
  return Object.freeze({[verified]:true as const,deviceId:config.device.id,generation,fingerprint,recipients:Object.freeze(recipients)});
}

function requireVerified(recipients:VerifiedRecipients) {
  if(recipients[verified]!==true)throw invalid();
}

export function recipientCheckpoint(recipients:VerifiedRecipients):RecipientCheckpoint {
  requireVerified(recipients);
  return {generation:recipients.generation,fingerprint:recipients.fingerprint};
}

/** Pure protocol API. CLI/MCP stays on v1 until pairing negotiates v2 support. */
export async function sealGroupRequest(params:{requestId:string;senderKeyId:string;signingKey:CryptoKey;recipients:VerifiedRecipients;
  primitive:PrimitiveType;payload:AskPayload|ActivityPayload;timeoutSeconds?:number;expiresAt?:number;sessionId?:string;revision?:number}):Promise<GroupRequest> {
  requireVerified(params.recipients);
  // Low-level activity calls retain their existing default; client.activity supplies one hour.
  const activity = params.primitive.startsWith('activity_');
  const timeout = requestTimeoutSeconds(params.timeoutSeconds, activity ? 300 : undefined,
    activity ? MAX_ACTIVITY_TIMEOUT_SECONDS : MAX_REQUEST_TIMEOUT_SECONDS);
  const plaintext=JSON.stringify(params.payload);
  if(Buffer.byteLength(plaintext)>149984)throw Error('Encrypted group content exceeds the request limit');
  const now=Math.floor(Date.now()/1000);
  const expiresAt=Math.min(now+timeout,params.expiresAt ?? Infinity);
  if(!Number.isSafeInteger(expiresAt) || expiresAt<=now)throw Error('Request expired before encryption');
  const envelope:GroupRequest={v:2,kind:'request',requestId:params.requestId,deviceId:params.recipients.deviceId,senderKeyId:params.senderKeyId,
    primitive:params.primitive,createdAt:now,expiresAt,generation:params.recipients.generation,
    sessionId:params.sessionId ?? params.requestId,revision:params.revision ?? 1,
    deliveries:params.recipients.recipients.map(recipient=>({deviceId:recipient.deviceId,enc:recipient.encPub,ct:toB64u(new Uint8Array(16)),sig:toB64u(new Uint8Array(64))}))};
  if(!validGroupRequest(envelope))throw Error('Invalid group request metadata');
  for(const delivery of envelope.deliveries) {
    const recipient=params.recipients.recipients.find(r=>r.deviceId===delivery.deviceId)!;
    const sealed=await hpkeSeal(recipient.encPub,'notibuddy/v2/request',groupDeliveryHeader(envelope,delivery.deviceId),plaintext);
    Object.assign(delivery,sealed);
    delivery.sig=await ecdsaSign(params.signingKey,groupDeliveryInput(envelope,delivery));
  }
  return envelope;
}

/** Verifies against the recipient snapshot saved with this exact request,
 * never a display label or a freshly substituted Watch key. */
export async function openGroupResponse(params:{input:unknown;request:GroupRequest;recipients:VerifiedRecipients;replyKey:CryptoKey}):Promise<AnswerPayload> {
  requireVerified(params.recipients);
  const r=structuredClone(params.input),q=structuredClone(params.request);
  if(!validGroupResponse(r) || !validGroupRequest(q) || q.generation!==params.recipients.generation ||
    q.deviceId!==params.recipients.deviceId || q.deliveries.map(d=>d.deviceId).join(',')!==params.recipients.recipients.map(d=>d.deviceId).join(',') ||
    r.requestId!==q.requestId || r.parentDeviceId!==q.deviceId || r.generation!==q.generation ||
    r.createdAt<q.createdAt-120 || r.createdAt>=q.expiresAt || r.createdAt>Math.floor(Date.now()/1000)+120 ||
    r.kind!==(q.primitive.startsWith('activity_')?'control':'reply'))throw Error('Response does not match the saved group request');
  const responder=params.recipients.recipients.find(p=>p.deviceId===r.deviceId);
  if(!responder || !q.deliveries.some(d=>d.deviceId===r.deviceId) || r.receipts.some(p=>!q.deliveries.some(d=>d.deviceId===p.deviceId)))throw Error('Unrecognized group response device');
  if(responder.deviceId!==q.deviceId) {
    const capability=q.primitive==='approval'?'approval':q.primitive==='text_input'?'text_input':q.primitive.startsWith('activity_')?'timer_control':undefined;
    if(!capability || !responder.capabilities.includes(capability))throw Error('Companion cannot answer this request');
  }
  if(!await ecdsaVerify(responder.sigPub,groupResponseInput(r),r.sig))throw Error('Group response signature failed');
  const plaintext=await hpkeOpen(params.replyKey,r.enc,'notibuddy/v2/reply',groupResponseHeader(r)+'|sender',r.ct);
  return answerSchema.parse(JSON.parse(plaintext));
}
