import { normalizeRelay } from './relay-url.js';
import { validateRequestSettings } from './protocol.js';
import { relayJSON, pollPause, RelayHTTPError, DeadlineError, type CallOptions } from './client-http.js';
import { RecipientStore } from './recipient-store.js';
import { verifyRecipients, sealGroupRequest, openGroupResponse, type GroupRequest, type GroupResponse } from './groups.js';
import { validGroupRequest } from './group-wire.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { signSenderRegistration } from './sender-registration.js';
import { z } from 'zod';
import type { NotiBuddyConfig, RequestEnvelope, ReplyEnvelope, ErrorEnvelope, AskPayload, ActivityPayload, AnswerPayload, PrimitiveType, SenderRegistrationPayload } from './types.js';
import { sealRequest, openReply, openError, validateIdentifier } from './protocol.js';
import { generateReplyKeyPair } from './crypto.js';
import { PendingStore, PendingStorageError, type PendingReply, type ActivitySession } from './pending-store.js';
import { parseDiff } from './diff.js';
import type { DiffInput } from './types.js';

const field = z.object({
  id:z.string().min(1).max(80), type:z.enum(['text','email','url','toggle','stepper','picker','date']),
  label:z.string().min(1).max(200), placeholder:z.string().optional(), required:z.boolean().optional(),
  default:z.union([z.string(),z.number().finite(),z.boolean()]).optional(), min:z.number().finite().optional(), max:z.number().finite().optional(),
  options:z.array(z.object({id:z.string(),label:z.string()})).max(100).optional(),
});
const presentation = z.object({
  shortTitle: z.string().trim().min(1).max(40).regex(/^[^\r\n]+$/, 'Use a single line').optional(),
  summary: z.string().trim().min(1).max(100).regex(/^[^\r\n]+$/, 'Use a single line').optional(),
}).strict();
const askSchema = z.object({
  presentation: presentation.optional(),
  sensitive: z.boolean().optional(),
  diff: z.unknown().optional(),
  title:z.string().min(1).max(500).optional(), message:z.string().max(50000).optional(),
  options:z.array(z.string().min(1).max(200)).max(20).optional(), inputPlaceholder:z.string().max(500).optional(),
  fields:z.array(field).min(1).max(50).optional(), requiresAuth:z.boolean().optional(),
  timeoutSeconds:z.number().int().min(1).max(3600).default(300),
  waitSeconds:z.number().finite().min(0).max(55).default(25), resumeId:z.string().optional(),
}).refine(p => p.resumeId || p.title, 'A title is required for a new request')
  .refine(p => !p.fields || new Set(p.fields.map(f=>f.id)).size === p.fields.length,'Form field IDs must be unique')
  .refine(p => p.diff === undefined || (!p.fields && !p.options && p.inputPlaceholder === undefined && !p.resumeId),
    'A new diff request cannot include form fields, choices, text input or a resume ID');
const activitySchema = z.object({
  presentation: presentation.optional(),
  sensitive: z.boolean().optional(),
  action:z.enum(['start','update','end','poll']), activityId:z.string().min(1).max(64),
  title:z.string().min(1).max(500).optional(), status:z.string().max(1000).optional(),
  step:z.number().int().min(0).max(1000000).optional(), totalSteps:z.number().int().min(1).max(1000000).optional(),
  timerMinutes:z.number().positive().max(60).optional(),
  controls:z.array(z.enum(['pause','resume','cancel','add_5m'])).max(4).optional(),
});
export type AskParams = Omit<z.input<typeof askSchema>, 'diff'> & { diff?: DiffInput };
export type ActivityParams = z.input<typeof activitySchema>;
export type AskResult = {status:'resolved'|'pending'|'error'|'expired'|'not_found';requestId:string;answer?:AnswerPayload;errorCode?:string;message?:string};
export class DispatchRejectedError extends Error {
  constructor(public status:number, detail:string,public code?:string) { super(`Dispatch failed (${status}): ${detail}`); }
  get definitive():boolean {
    // A conflict may acknowledge an earlier acceptance; timeouts and 5xx are ambiguous.
    return this.status>=400 && this.status<500 && ![408,409,425].includes(this.status);
  }
}
export class TerminalRequestError extends Error {
  constructor(public status:'expired'|'not_found') { super(`Request ${status}`); }
}

export class ResumableRequestError extends Error {
  constructor(readonly requestId:string){super(`Request interrupted. Resume with resume_id='${requestId}' before creating another request.`);}
}
type WireRequest=RequestEnvelope|GroupRequest;
type WireResponse=ReplyEnvelope|ErrorEnvelope|GroupResponse;
type ActivityResult={status:string;activityId:string;controls:AnswerPayload[];warnings?:string[]};

export class NotiBuddyClient {
  private store:PendingStore;
  private recipients:RecipientStore;
  constructor(private config:NotiBuddyConfig,private signingKey:CryptoKey,store?:PendingStore,private sender=os.hostname()) {
    validateRequestSettings(config);
    this.config=structuredClone(config);this.config.relay=normalizeRelay(config.relay);
    this.sender=z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}]+$/u).parse(sender);
    this.store=store ?? new PendingStore(config);
    this.recipients=new RecipientStore(config,this.store.root);
  }
  async doctor(options:CallOptions={}) {
    const call={...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+15000)};
    const report={relay:this.config.relay,reachable:false,requestProtocol:this.config.requestProtocol ?? 1,
      deviceId:this.config.device.id,sender:'unverified',recipientCount:null as number|null,issues:[] as string[]};
    try {
      const health=await relayJSON(this.config,'/v1/health',{},call);
      report.reachable=health.body?.status==='healthy';if(!report.reachable)report.issues.push('Relay health response was not recognized');
      const result=await relayJSON(this.config,'/v1/senders',{},call);
      if(!Array.isArray(result.body?.senders))throw Error('Invalid sender status response');
      const sender=result.body.senders.find((s:any)=>s.senderKeyId===this.config.senderKeyId);
      report.sender=sender?(sender.approved===1?'approved':'pending_approval'):'not_registered';
      if(report.requestProtocol===2) {
        const {body}=await relayJSON(this.config,'/v2/recipients?deviceId='+this.config.device.id,{},call,this.signingKey);
        const recipients=await verifyRecipients(body,this.config,this.recipients.read());
        if(recipients.generation<(this.config.minimumRecipientGeneration ?? 0))throw Error('Recipient membership predates pairing');
        this.recipients.remember(recipients);report.recipientCount=recipients.recipients.length;
      }else report.recipientCount=1;
    }catch(error) {
      options.signal?.throwIfAborted();
      report.issues.push(error instanceof RelayHTTPError?`Relay returned ${error.status}${error.code?' '+error.code:''}`:'Verification did not complete; check connectivity, pairing approval, and client compatibility');
    }
    return report;
  }
  async registerSender(payload:SenderRegistrationPayload,options:CallOptions={}):Promise<'registered'|'pending_approval'> {
    const registration=await signSenderRegistration(payload,this.config.token,this.signingKey);
    const {body}=await relayJSON(this.config,'/v1/senders',{method:'POST',body:JSON.stringify(registration)},options);
    if(body?.status!=='registered' && body?.status!=='pending_approval')throw Error('Invalid sender registration result');
    return body.status;
  }
  async postRequest(envelope:WireRequest,options:CallOptions={}):Promise<{requestId:string;seq:number}> {
    try {
      const {body}=await relayJSON(this.config,`/v${envelope.v}/requests`,{method:'POST',body:JSON.stringify(envelope)},options);
      if(body?.requestId!==envelope.requestId || !Number.isSafeInteger(body.seq) || body.seq<1)throw Error('Invalid dispatch acknowledgement');
      return body;
    }catch(error){if(error instanceof RelayHTTPError)throw new DispatchRejectedError(error.status,error.code ?? 'Request rejected',error.code);throw error;}
  }
  async getReply(requestId:string,_waitSeconds=0,afterSeq=0,options:CallOptions={}):Promise<((ReplyEnvelope|ErrorEnvelope)&{seq?:number})|null> {
    const reply=await this.getSavedReply(requestId,undefined,afterSeq,options);
    return reply ? {...reply.envelope as ReplyEnvelope|ErrorEnvelope,seq:reply.seq} : null;
  }
  private async getSavedReply(id:string,saved:PendingReply|undefined,afterSeq:number,options:CallOptions) {
    validateIdentifier(id,'requestId');
    if(!Number.isSafeInteger(afterSeq) || afterSeq<0)throw Error('Invalid reply cursor');
    const version=saved?.envelope?.v ?? 1;
    try {
      const {status,body}=await relayJSON(this.config,`/v${version}/replies/${encodeURIComponent(id)}?afterSeq=${afterSeq}`,{},options,version===2?this.signingKey:undefined);
      if(status===204)return null;
      const envelope=version===2 ? body?.envelope : body,seq=body?.seq;
      if(!envelope || envelope.requestId!==id || envelope.v!==version || !Number.isSafeInteger(seq) || seq<1 || seq<=afterSeq)throw Error('Invalid reply binding or sequence');
      const {seq:ignored,...wire}=envelope;
      return {envelope:wire as WireResponse,seq:seq as number};
    }catch(error) {
      if(error instanceof RelayHTTPError && [404,410].includes(error.status))throw new TerminalRequestError(error.status===404?'not_found':'expired');
      throw error;
    }
  }
  private readPending(id:string):PendingReply {
    const saved=this.store.read<PendingReply>('reply:'+id);
    if(!saved)throw new PendingStorageError(`No saved response key for '${id}'. Preserve the pairing and remaining pending files.`);
    if(!saved.privateKeyJwk || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt<1 ||
      saved.envelope && (saved.envelope.requestId!==id || saved.envelope.deviceId!==this.config.device.id || saved.envelope.expiresAt!==saved.expiresAt || ![1,2].includes(saved.envelope.v)))throw new PendingStorageError('Invalid saved request binding');
    return saved;
  }
  private savePending(id:string,saved:PendingReply) {this.store.write('reply:'+id,saved,(saved.expiresAt+600)*1000);}
  private async replyKey(saved:PendingReply):Promise<CryptoKey> {
    return crypto.subtle.importKey('jwk',saved.privateKeyJwk,{name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  }
  private async seal(id:string,primitive:PrimitiveType,payload:AskPayload|ActivityPayload,timeout:number,options:CallOptions,version=this.config.requestProtocol ?? 1,expiresAt?:number):Promise<{envelope:WireRequest;recipients?:unknown}> {
    if(version===1)return {envelope:await sealRequest({requestId:id,deviceId:this.config.device.id,senderKeyId:this.config.senderKeyId,
      senderSigningPrivateKey:this.signingKey,deviceEncryptionPublicKey:this.config.device.encPub,primitive,payload,timeoutSeconds:timeout})};
    const {body}=await relayJSON(this.config,'/v2/recipients?deviceId='+this.config.device.id,{},options,this.signingKey);
    const recipients=await verifyRecipients(body,this.config,this.recipients.read());
    if(recipients.generation<(this.config.minimumRecipientGeneration ?? 0))throw Error('Relay membership predates the pairing document');
    this.recipients.remember(recipients);
    return {recipients:body,envelope:await sealGroupRequest({requestId:id,senderKeyId:this.config.senderKeyId,signingKey:this.signingKey,recipients,primitive,payload,timeoutSeconds:timeout,expiresAt,
      ...(payload.type==='activity'?{sessionId:payload.activityId,revision:payload.revision}: {})})};
  }
  private async prepare(id:string,primitive:PrimitiveType,payload:AskPayload|ActivityPayload,key:CryptoKey,timeout:number,options:CallOptions,version?:1|2):Promise<PendingReply> {
    const prepared=await this.seal(id,primitive,payload,timeout,options,version);
    const saved:PendingReply={privateKeyJwk:await crypto.subtle.exportKey('jwk',key),expiresAt:prepared.envelope.expiresAt,...prepared,payload,dispatch:'pending'};
    this.savePending(id,saved);return saved;
  }
  private async dispatchSaved(id:string,saved:PendingReply,options:CallOptions):Promise<PendingReply> {
    if(saved.dispatch!=='pending' || !saved.envelope || saved.expiresAt<=Math.floor(Date.now()/1000))return saved;
    for(let attempt=0;attempt<2;attempt++) {
      try {
        await this.postRequest(saved.envelope!,options);
        const accepted={...saved,dispatch:'accepted' as const,payload:undefined};this.savePending(id,accepted);return accepted;
      }catch(error) {
        if(attempt===0 && error instanceof DispatchRejectedError && error.code==='RECIPIENTS_CHANGED' && saved.envelope!.v===2 && saved.payload) {
          const remaining=saved.expiresAt-Math.floor(Date.now()/1000);if(remaining<=0)return saved;
          const refreshed=await this.seal(id,saved.envelope!.primitive as PrimitiveType,saved.payload,remaining,options,2,saved.expiresAt);
          saved={...saved,...refreshed,expiresAt:refreshed.envelope.expiresAt};this.savePending(id,saved);continue;
        }
        throw error;
      }
    }
    return saved;
  }
  private async open(id:string,envelope:WireResponse,saved:PendingReply):Promise<AskResult> {
    const key=await this.replyKey(saved);
    if(envelope.v===2) {
      if(!saved.envelope || !validGroupRequest(saved.envelope))throw new PendingStorageError('Missing original group request');
      const recipients=await verifyRecipients(saved.recipients,this.config);
      return {status:'resolved',requestId:envelope.requestId,answer:await openGroupResponse({input:envelope,request:saved.envelope,recipients,replyKey:key})};
    }
    if(envelope.createdAt>Math.floor(Date.now()/1000)+120 || envelope.createdAt>=saved.expiresAt || saved.envelope && envelope.createdAt<saved.envelope.createdAt-120)throw Error('Reply timestamp outside saved request lifetime');
    const expected={expectedRequestId:id,expectedDeviceId:this.config.device.id,deviceSigningPublicKey:this.config.device.sigPub};
    if(envelope.kind==='error')return {status:'error',requestId:envelope.requestId,errorCode:await openError({...expected,envelope})};
    return {status:'resolved',requestId:envelope.requestId,answer:await openReply({...expected,envelope,replyPrivateKey:key})};
  }
  async ask(input:AskParams,options:CallOptions={}):Promise<AskResult> {
    const params=askSchema.parse(input),diff=params.diff === undefined ? undefined : parseDiff(params.diff);
    const id=params.resumeId ?? 'req_'+randomUUID().replaceAll('-','');validateIdentifier(id,'resumeId');
    // wait=0 means one lookup with a bounded network budget; positive waits are
    // one end-to-end deadline including discovery, dispatch and response bytes.
    const call={...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+(params.waitSeconds===0?15000:params.waitSeconds*1000))};
    return this.store.withOperation('reply:'+id,async()=>{
      let saved:PendingReply;
      if(params.resumeId) {saved=this.readPending(id);if(saved.envelope?.primitive.startsWith('activity_'))throw Error('Use activity poll to resume activity controls');}
      else {
        const pair=await generateReplyKeyPair(),primitive:PrimitiveType=diff?'diff':params.fields?.length?'form':params.inputPlaceholder!==undefined?'text_input':'approval';
        const payload:AskPayload={type:'ask',source:{label:this.sender},replyPub:pair.publicKeyB64u,title:params.title!,message:params.message,
          options:params.options,inputPlaceholder:params.inputPlaceholder,fields:params.fields,requiresAuth:params.requiresAuth,sensitive:params.sensitive,presentation:params.presentation,...diff};
        saved=await this.prepare(id,primitive,payload,pair.privateKey,params.timeoutSeconds,call);
      }
      try {
        saved=await this.dispatchSaved(id,saved,call);
        do {
          const response=await this.getSavedReply(id,saved,0,call);
          if(response){const result=await this.open(id,response.envelope,saved);this.store.remove('reply:'+id);return result;}
          if(params.waitSeconds===0 || Date.now()>=call.deadline)break;
          await pollPause(Math.min(1000,call.deadline-Date.now()),options.signal);
        }while(Date.now()<call.deadline);
      }catch(error) {
        if(options.signal?.aborted)throw new ResumableRequestError(id);
        if(error instanceof TerminalRequestError){this.store.remove('reply:'+id);return {status:error.status,requestId:id};}
        if(error instanceof DispatchRejectedError && error.definitive){this.store.remove('reply:'+id);return {status:'error',requestId:id,errorCode:error.code ?? 'HTTP_'+error.status,message:error.message};}
        return {status:'pending',requestId:id,errorCode:error instanceof DeadlineError?'WAIT_DEADLINE':'RETRY_REQUIRED',message:`Request is saved but no verified answer was received. Resume with resume_id='${id}'.`};
      }
      return {status:'pending',requestId:id,message:`Call notibuddy_ask with resume_id='${id}' to check again, including after restarting this client.`};
    });
  }
  private writeActivity(id:string,session:ActivitySession) {
    this.store.write('activity:'+id,session,((session.expiresAt ?? 0)+600)*1000);
  }
  private async pollActivity(session:ActivitySession,options:CallOptions):Promise<{controls:AnswerPayload[];warnings:string[]}> {
    const warnings:string[]=[],events:{seq:number;answer:AnswerPayload}[]=[];
    const requests=session.requests,n=requests.length;
    if(!n)return {controls:[],warnings};
    // Always check the newest snapshot, then rotate through older history so
    // missing keys or slow endpoints cannot starve a current timer control.
    const latest=n-1,indices=[latest];let offset=session.pollOffset ?? 0;
    for(let count=0;count<Math.min(4,n-1);count++)indices.push((offset+count)%latest);
    for(const index of indices) {
      if(Date.now()>=(options.deadline ?? Infinity))break;
      if(index!==latest)offset=(index+1)%latest;
      const pending=requests[index];
      if((pending.expiresAt+600)*1000<=Date.now()){pending.expiresAt=0;continue;}
      try {
        const saved=this.readPending(pending.id);delete pending.unavailable;
        const call={...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+2000)};
        for(let count=0;count<(index===latest?8:2);count++) {
          if(Date.now()>=call.deadline)break;
          const response=await this.getSavedReply(pending.id,saved,pending.afterSeq,call);if(!response)break;
          if(pending.seenSignatures?.includes(response.envelope.sig)){warnings.push(`Repeated reply for ${pending.id} was ignored`);break;}
          const result=await this.open(pending.id,response.envelope,saved);
          // Dedupe and validate sequence before returning any action to callers.
          pending.afterSeq=response.seq;(pending.seenSignatures ??= []).push(response.envelope.sig);
          if(result.answer)events.push({seq:response.seq,answer:result.answer});
        }
      }catch(error) {
        options.signal?.throwIfAborted();
        if(error instanceof TerminalRequestError){pending.expiresAt=0;this.store.remove('reply:'+pending.id);}
        else {pending.unavailable=true;warnings.push(`Could not verify a reply for ${pending.id}; its saved data was preserved`);}
      }
    }
    if(n>1)session.pollOffset=offset;else delete session.pollOffset;session.requests=requests.filter(r=>r.expiresAt>0);
    const controls:AnswerPayload[]=[];
    for(const event of events.sort((a,b)=>a.seq-b.seq)) {
      if(event.seq<=(session.lastControlSeq ?? 0))continue;
      controls.push(event.answer);session.lastControlSeq=event.seq;
      if(session.payload.primitive==='timer') {
        const values=event.answer.values;
        if(values?.state==='paused' || values?.state==='running' || values?.state==='cancelled')session.payload.state=values.state;
        if(typeof values?.targetTimestamp==='number' && Number.isFinite(values.targetTimestamp))session.payload.timerEndsAt=values.targetTimestamp;
        if(typeof values?.remainingSeconds==='number' && Number.isFinite(values.remainingSeconds))session.payload.remainingSeconds=values.remainingSeconds;
        else if(values?.state==='running')session.payload.remainingSeconds=undefined;
      }
    }
    return {controls,warnings};
  }
  async activity(input:ActivityParams,options:CallOptions={}):Promise<ActivityResult> {
    const params=activitySchema.parse(input);validateIdentifier(params.activityId,'activityId');
    const call={...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+20000)};
    return this.store.withOperation('activity:'+params.activityId,async()=>{
      const storeId='activity:'+params.activityId;
      let session=this.store.read<ActivitySession>(storeId);
      if(params.action!=='start' && !session)throw Error('Start this activity on this paired computer first');
      if(session?.pendingDispatch && (session.expiresAt ?? 0)*1000<=Date.now()) {
        delete session.pendingDispatch;delete session.previous;session.ended=false;this.writeActivity(params.activityId,session);
      }
      if(session?.pendingDispatch) {
        const id=session.pendingDispatch,saved=this.readPending(id);
        try {
          await this.dispatchSaved(id,saved,call);
          delete session.pendingDispatch;delete session.previous;this.writeActivity(params.activityId,session);
        }catch(error) {
          if(error instanceof DispatchRejectedError && error.definitive) {
            const previous=session.previous;
            if(previous)this.writeActivity(params.activityId,previous);else this.store.remove(storeId);
            this.store.remove('reply:'+id);
          }
          throw Error(`Activity '${params.activityId}' has an unconfirmed dispatch. Retry this activity before starting a replacement.`);
        }
      }
      let controls:AnswerPayload[]=[],warnings:string[]=[];
      if(session) {
        session.expiresAt ??= session.requests.reduce((latest,r)=>Math.max(latest,r.expiresAt),0);
        const polled=await this.pollActivity(session,{...call,deadline:Math.min(call.deadline-(params.action==='poll'?0:5000),Date.now()+10000)});
        controls=polled.controls;warnings=polled.warnings;this.writeActivity(params.activityId,session);
      }
      const expired=session!==undefined && (session.expiresAt ?? 0)*1000<=Date.now();
      if(params.action==='poll')return {status:session?.ended?'ended':expired?'expired':'active',activityId:params.activityId,controls,...(warnings.length?{warnings}:{})};
      if(params.action!=='start' && expired)throw Error('Activity expired; start a new activity');
      if(params.action==='start' && session && !session.ended && !expired)throw Error('Activity is already active; update it or end it first');
      if(params.action!=='start' && session?.ended)throw Error('Activity already ended');
      const requestId='act_'+randomUUID().replaceAll('-',''),pair=await generateReplyKeyPair();
      const previous=params.action==='start'?undefined:session?.payload;
      const payload:ActivityPayload={
        sensitive:params.sensitive===true || previous?.sensitive===true,
        type:'activity',action:params.action,revision:(previous?.revision ?? 0)+1,activityId:previous?.activityId ?? requestId,
        primitive:params.timerMinutes!==undefined?'timer':previous?.primitive ?? 'stepper',
        title:params.title ?? previous?.title ?? 'Agent Activity',source:previous?.source ?? {label:this.sender},
        presentation:params.presentation ?? ((params.title!==undefined || params.status!==undefined)?undefined:previous?.presentation),
        status:params.status ?? previous?.status,step:params.step ?? previous?.step,totalSteps:params.totalSteps ?? previous?.totalSteps,
        timerEndsAt:params.timerMinutes!==undefined?Math.floor(Date.now()/1000)+Math.round(params.timerMinutes*60):previous?.timerEndsAt,
        state:params.timerMinutes!==undefined?'running':previous?.state,remainingSeconds:params.timerMinutes!==undefined?undefined:previous?.remainingSeconds,
        controls:params.controls ?? previous?.controls ?? ['pause','add_5m','cancel'],replyPub:pair.publicKeyB64u,
      };
      const primitive:PrimitiveType=params.action==='start'?'activity_start':params.action==='end'?'activity_end':'activity_update';
      const version=params.action==='start'?(this.config.requestProtocol ?? 1):(session?.protocol ?? 1);
      const saved=await this.prepare(requestId,primitive,payload,pair.privateKey,3600,call,version);
      const previousSession=session;
      session={payload,requests:[...(previous?session!.requests:[]),{id:requestId,afterSeq:0,expiresAt:saved.expiresAt}],
        ended:params.action==='end',expiresAt:saved.expiresAt,protocol:version,pendingDispatch:requestId,previous:previousSession,
        lastControlSeq:previous?previousSession?.lastControlSeq:undefined,pollOffset:previous?previousSession?.pollOffset:undefined};
      this.writeActivity(params.activityId,session);
      try {
        await this.dispatchSaved(requestId,saved,call);
        delete session.pendingDispatch;delete session.previous;this.writeActivity(params.activityId,session);
      }catch(error) {
        if(error instanceof DispatchRejectedError && error.definitive) {
          if(previousSession)this.writeActivity(params.activityId,previousSession);else this.store.remove(storeId);
          this.store.remove('reply:'+requestId);
        }
        throw error;
      }
      return {status:'dispatched',activityId:params.activityId,controls,...(warnings.length?{warnings}:{})};
    });
  }
}
