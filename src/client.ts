import { randomUUID } from 'node:crypto';
import { signSenderRegistration } from './sender-registration.js';
import { z } from 'zod';
import type { NotiBuddyConfig, RequestEnvelope, ReplyEnvelope, ErrorEnvelope, AskPayload, ActivityPayload, AnswerPayload, PrimitiveType, SenderRegistrationPayload } from './types.js';
import { sealRequest, openReply, openError, validateIdentifier } from './protocol.js';
import { generateReplyKeyPair } from './crypto.js';
import { PendingStore, type PendingReply, type ActivitySession } from './pending-store.js';

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
  title:z.string().min(1).max(500).optional(), message:z.string().max(50000).optional(),
  options:z.array(z.string().min(1).max(200)).max(20).optional(), inputPlaceholder:z.string().max(500).optional(),
  fields:z.array(field).min(1).max(50).optional(), requiresAuth:z.boolean().optional(),
  timeoutSeconds:z.number().int().min(1).max(3600).default(300),
  waitSeconds:z.number().finite().min(0).max(55).default(25), resumeId:z.string().optional(),
}).refine(p => p.resumeId || p.title, 'A title is required for a new request')
  .refine(p => !p.fields || new Set(p.fields.map(f=>f.id)).size === p.fields.length,'Form field IDs must be unique');
const activitySchema = z.object({
  presentation: presentation.optional(),
  sensitive: z.boolean().optional(),
  action:z.enum(['start','update','end','poll']), activityId:z.string().min(1).max(64),
  title:z.string().min(1).max(500).optional(), status:z.string().max(1000).optional(),
  step:z.number().int().min(0).max(1000000).optional(), totalSteps:z.number().int().min(1).max(1000000).optional(),
  timerMinutes:z.number().positive().max(60).optional(),
  controls:z.array(z.enum(['pause','resume','cancel','add_5m'])).max(4).optional(),
});
export type AskParams = z.input<typeof askSchema>;
export type ActivityParams = z.input<typeof activitySchema>;
export type AskResult = {status:'resolved'|'pending'|'error'|'expired'|'not_found';requestId:string;answer?:AnswerPayload;errorCode?:string;message?:string};
export class DispatchRejectedError extends Error {
  constructor(public status:number, detail:string) { super(`Dispatch failed (${status}): ${detail}`); }
  get definitive():boolean {
    // A conflict may acknowledge an earlier acceptance; timeouts and 5xx are ambiguous.
    return this.status>=400 && this.status<500 && ![408,409,425].includes(this.status);
  }
}
export class TerminalRequestError extends Error {
  constructor(public status:'expired'|'not_found') { super(`Request ${status}`); }
}

export class NotiBuddyClient {
  private relay: string;
  private store: PendingStore;
  constructor(private config: NotiBuddyConfig, private signingKey: CryptoKey, store?: PendingStore) {
    this.relay = config.relay.replace(/\/$/,'');
    this.store = store ?? new PendingStore(config);
  }
  private async fetch(route: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.relay+route,{...init, signal:AbortSignal.timeout(15000),headers:{
      'Authorization':`Bearer ${this.config.token}`,'Content-Type':'application/json',...init.headers,
    }});
  }
  async registerSender(payload: SenderRegistrationPayload): Promise<'registered'|'pending_approval'> {
    const registration = await signSenderRegistration(payload, this.config.token, this.signingKey);
    const response = await this.fetch('/v1/senders',{method:'POST',body:JSON.stringify(registration)});
    if (!response.ok) throw new Error(`Sender registration failed (${response.status}): ${await response.text()}`);
    const result=await response.json() as {status?:string};
    return result.status==='registered'?'registered':'pending_approval';
  }
  async postRequest(envelope: RequestEnvelope): Promise<{requestId:string;seq:number}> {
    const response = await this.fetch('/v1/requests',{method:'POST',body:JSON.stringify(envelope)});
    if (!response.ok) throw new DispatchRejectedError(response.status,await response.text());
    return await response.json() as {requestId:string;seq:number};
  }
  async getReply(requestId: string, _waitSeconds = 0, afterSeq = 0): Promise<((ReplyEnvelope|ErrorEnvelope)&{seq?:number})|null> {
    const response = await this.fetch(`/v1/replies/${encodeURIComponent(requestId)}?afterSeq=${afterSeq}`);
    if (response.status === 204) return null;
    if (response.status === 404 || response.status === 410) throw new TerminalRequestError(response.status===404?'not_found':'expired');
    if (!response.ok) throw new Error(`Reply fetch failed (${response.status}): ${await response.text()}`);
    const envelope = await response.json() as (ReplyEnvelope|ErrorEnvelope)&{seq?:number};
    if (envelope.requestId !== requestId) throw new Error('Reply belongs to a different request');
    return envelope;
  }
  private async saveKey(id: string, key: CryptoKey, expiresAt: number): Promise<void> {
    const privateKeyJwk = await crypto.subtle.exportKey('jwk',key);
    this.store.write('reply:'+id,{privateKeyJwk,expiresAt},(expiresAt+600)*1000);
  }
  private async replyKey(id: string): Promise<CryptoKey> {
    const stored = this.store.read<PendingReply>('reply:'+id);
    if (!stored) throw new Error(`No saved response key for '${id}'. Resume on the paired computer before the retention period ends.`);
    // HPKE needs the exact public point from the JWK when constructing KEM context.
    return crypto.subtle.importKey('jwk',stored.privateKeyJwk,{name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  }
  private async open(envelope: ReplyEnvelope|ErrorEnvelope, key: CryptoKey): Promise<AskResult> {
    const expected = {envelope,expectedDeviceId:this.config.device.id,deviceSigningPublicKey:this.config.device.sigPub};
    if (envelope.kind === 'error') {
      return {status:'error',requestId:envelope.requestId,errorCode:await openError({...expected,envelope})};
    }
    return {status:'resolved',requestId:envelope.requestId,answer:await openReply({...expected,envelope,replyPrivateKey:key})};
  }
  async ask(input: AskParams): Promise<AskResult> {
    const params = askSchema.parse(input);
    let id = params.resumeId;
    let key: CryptoKey;
    if (id) {
      validateIdentifier(id,'resumeId');
      key = await this.replyKey(id);
    } else {
      id = 'req_'+randomUUID().replaceAll('-','');
      const pair = await generateReplyKeyPair(); key=pair.privateKey;
      const primitive: PrimitiveType = params.fields?.length ? 'form' : params.inputPlaceholder !== undefined ? 'text_input' : 'approval';
      const payload: AskPayload = {type:'ask',replyPub:pair.publicKeyB64u,title:params.title!,message:params.message,
        options:params.options,inputPlaceholder:params.inputPlaceholder,fields:params.fields,requiresAuth:params.requiresAuth,sensitive:params.sensitive,
        presentation:params.presentation};
      const envelope=await this.seal(id,primitive,payload,params.timeoutSeconds);
      await this.saveKey(id,key,envelope.expiresAt);
      // Save before dispatch. If the connection is lost after acceptance the key survives.
      try { await this.postRequest(envelope); }
      catch (error) { throw new Error(`${(error as Error).message}. Retry lookup with resume_id='${id}' before creating another request.`); }
    }
    const deadline=Date.now()+params.waitSeconds*1000;
    try {
      do {
        const envelope = await this.getReply(id);
        if (envelope) {
          const result = await this.open(envelope,key);
          this.store.remove('reply:'+id); // Only discard after authentication and decryption succeed.
          return result;
        }
        if (Date.now()>=deadline) break;
        await new Promise(resolve=>setTimeout(resolve,Math.min(1000,deadline-Date.now())));
      } while (Date.now()<=deadline);
    } catch (error) {
      if (!(error instanceof TerminalRequestError)) throw error;
      this.store.remove('reply:'+id);
      return {status:error.status,requestId:id};
    }
    return {status:'pending',requestId:id,message:`Call notibuddy_ask with resume_id='${id}' to check again, including after restarting this client.`};
  }
  private seal(id:string, primitive:PrimitiveType, payload:AskPayload|ActivityPayload, timeoutSeconds:number):Promise<RequestEnvelope> {
    return sealRequest({requestId:id,deviceId:this.config.device.id,senderKeyId:this.config.senderKeyId,
      senderSigningPrivateKey:this.signingKey,deviceEncryptionPublicKey:this.config.device.encPub,primitive,payload,timeoutSeconds});
  }

  async activity(input: ActivityParams): Promise<{status:string;activityId:string;controls:AnswerPayload[]}> {
    const params=activitySchema.parse(input);
    const storeId='activity:'+params.activityId;
    let session=this.store.read<ActivitySession>(storeId);
    if (params.action !== 'start' && !session) throw new Error('Start this activity on this paired computer first');
    const controls: AnswerPayload[]=[];
    const pollDeadline = Date.now() + 20000;
    if (session) {
      session.expiresAt ??= session.requests.reduce((latest, request) => Math.max(latest, request.expiresAt), 0);
      for (const pending of session.requests) {
        if (Date.now() >= pollDeadline) break;
        try {
          let envelope;
          while (Date.now() < pollDeadline && (envelope=await this.getReply(pending.id,0,pending.afterSeq))) {
            if (pending.seenSignatures?.includes(envelope.sig)) break;
            const result=await this.open(envelope,await this.replyKey(pending.id));
            if (result.answer) {
              controls.push(result.answer);
              if (session.payload.primitive === 'timer') {
                const values=result.answer.values;
                if (values?.state === 'paused' || values?.state === 'running' || values?.state === 'cancelled') session.payload.state=values.state;
                if (typeof values?.targetTimestamp === 'number' && Number.isFinite(values.targetTimestamp)) session.payload.timerEndsAt=values.targetTimestamp;
                if (typeof values?.remainingSeconds === 'number' && Number.isFinite(values.remainingSeconds)) session.payload.remainingSeconds=values.remainingSeconds;
                else if (values?.state === 'running') session.payload.remainingSeconds=undefined;
              }
            }
            if (!envelope.seq || envelope.seq<=pending.afterSeq) break;
            pending.afterSeq=envelope.seq;
            (pending.seenSignatures ??= []).push(envelope.sig);
          }
        } catch (error) {
          if (!(error instanceof TerminalRequestError)) throw error;
          pending.expiresAt=0;
          this.store.remove('reply:'+pending.id);
        }
      }
      session.requests=session.requests.filter(p=>p.expiresAt>0);
      this.store.write(storeId,session,(session.expiresAt+600)*1000);
    }
    const expired=session !== undefined && (session.expiresAt ?? 0)*1000<=Date.now();
    if (params.action==='poll') return {status:session?.ended?'ended':expired?'expired':'active',activityId:params.activityId,controls};
    if (params.action!=='start' && expired) throw new Error('Activity expired; start a new activity');
    if (params.action==='start' && session && !session.ended && !expired) throw new Error('Activity is already active; update it or end it first');
    if (params.action!=='start' && session?.ended) throw new Error('Activity already ended');
    const requestId='act_'+randomUUID().replaceAll('-','');
    const pair=await generateReplyKeyPair();
    const previous=params.action==='start'?undefined:session?.payload;
    const payload: ActivityPayload={
      sensitive:params.sensitive===true || previous?.sensitive===true,
      type:'activity',action:params.action,revision:(previous?.revision??0)+1,activityId:previous?.activityId??requestId,
      primitive:params.timerMinutes!==undefined?'timer':previous?.primitive??'stepper',
      title:params.title??previous?.title??'Agent Activity',
      presentation:params.presentation??((params.title!==undefined || params.status!==undefined) ? undefined : previous?.presentation),
      status:params.status??previous?.status,step:params.step??previous?.step,totalSteps:params.totalSteps??previous?.totalSteps,
      timerEndsAt:params.timerMinutes!==undefined?Math.floor(Date.now()/1000)+Math.round(params.timerMinutes*60):previous?.timerEndsAt,
      state:params.timerMinutes!==undefined?'running':previous?.state,
      remainingSeconds:params.timerMinutes!==undefined?undefined:previous?.remainingSeconds,
      controls:params.controls??previous?.controls??['pause','add_5m','cancel'],replyPub:pair.publicKeyB64u,
    };
    const primitive:PrimitiveType=params.action==='start'?'activity_start':params.action==='end'?'activity_end':'activity_update';
    const envelope=await this.seal(requestId,primitive,payload,3600);
    await this.saveKey(requestId,pair.privateKey,envelope.expiresAt);
    const previousSession=session;
    session={payload,requests:[...(previous?session!.requests:[]),{id:requestId,afterSeq:0,expiresAt:envelope.expiresAt}],ended:params.action==='end',expiresAt:envelope.expiresAt};
    // Keep session IDs and keys even if acceptance is ambiguous after a network error.
    this.store.write(storeId,session,(envelope.expiresAt+600)*1000);
    try { await this.postRequest(envelope); }
    catch (error) {
      if (error instanceof DispatchRejectedError && error.definitive) {
        if (previousSession) this.store.write(storeId,previousSession,((previousSession.expiresAt ?? envelope.expiresAt)+600)*1000);
        else this.store.remove(storeId);
        this.store.remove('reply:'+requestId);
      }
      throw error;
    }
    return {status:'dispatched',activityId:params.activityId,controls};
  }
}
