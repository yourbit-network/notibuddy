import { DEFAULT_REQUEST_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS, MAX_ACTIVITY_TIMEOUT_SECONDS, MAX_REPLY_WAIT_SECONDS } from './request-timeout.js';
import { normalizeRelay } from './relay-url.js';
import { validateRequestSettings } from './protocol.js';
import {
  relayJSON,
  pollPause,
  RelayHTTPError,
  DeadlineError,
  LoadScaleTracker,
  parseRetryAfterMs,
  type CallOptions,
} from './client-http.js';
import { SenderStream, scaledResyncIntervalMs } from './sender-stream.js';
import { RecipientStore, DEFAULT_RECIPIENT_CACHE_TTL_MS } from './recipient-store.js';
import { verifyRecipients, sealGroupRequest, openGroupResponse, openGroupResponsePlaintext, type GroupRequest, type GroupResponse, type VerifiedRecipients } from './groups.js';
import { validGroupRequest } from './group-wire.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { registerSenderOnce } from './pairing.js';
import { senderStatus } from './sender-status.js';
import { latestNewerVersion } from './update-check.js';
import { z } from 'zod';
import { bindCredentials } from './credential-recovery.js';
import type { DestinationStore } from './config.js';
import type { NotiBuddyConfig, RequestEnvelope, ReplyEnvelope, ErrorEnvelope, AskPayload, ActivityPayload, AnswerPayload, PrimitiveType, SenderRegistrationPayload } from './types.js';
import { sealRequest, openReply, openError, validateIdentifier } from './protocol.js';
import { generateReplyKeyPair } from './crypto.js';
import { PendingStore, PendingStorageError, type PendingReply, type ActivitySession } from './pending-store.js';
import { parseDiff } from './diff.js';
import type { DiffInput } from './types.js';
import {
  dryRunLocalScreen,
  openPendingScreenDecodeContext,
  parseScreenAskInput,
  registerScreenTemplateOnRelay,
  resolveScreenForDispatch,
  sealPendingScreenDecodeContext,
  verifyScreenSettlement,
  type PendingScreenContext,
  type RegisterScreenTemplateResult,
  type ScreenAskInput,
  type ScreenRuntimeOptions,
} from './screen-client.js';
import { getScreenCatalogByTemplateId } from './screen-catalog.js';
import { isPlainObject } from './screen-canon.js';
import {
  decodeScreenAnswer,
  extractScreenDecodeContext,
  formatGeneralScreenRecoveryGuide,
  formatScreenRecoveryGuide,
  type DecodedScreenAnswer,
  type PublicScreenTemplateDescription,
  type ScreenDecodeContext,
} from './screen-describe.js';
import { validateScreenRequestBindings } from './screen-record.js';
import type { ScreenFeedbackItem } from './screen-skeletonizer.js';
import { ScreenTemplateStore } from './screen-store.js';
import type { ScreenFormMap, ScreenRequestPlaintext } from './screen-types.js';
import { computeScreenContextDigest, validateScreenRequestPlaintext } from './screen-wire.js';

const field = z.object({
  id:z.string().min(1).max(80), type:z.enum(['text','email','url','toggle','stepper','picker','date','secret']),
  label:z.string().min(1).max(200), placeholder:z.string().optional(), required:z.boolean().optional(),
  default:z.union([z.string(),z.number().finite(),z.boolean()]).optional(), min:z.number().finite().optional(), max:z.number().finite().optional(),
  options:z.array(z.object({id:z.string(),label:z.string()})).max(100).optional(),
});
const presentation = z.object({
  shortTitle: z.string().trim().min(1).max(40).regex(/^[^\r\n]+$/, 'Use a single line').optional(),
  summary: z.string().trim().min(1).max(100).regex(/^[^\r\n]+$/, 'Use a single line').optional(),
}).strict();
export const askFields = z.object({
  presentation: presentation.optional(),
  sensitive: z.boolean().optional(),
  diff: z.unknown().optional(),
  screen: z.unknown().optional(),
  title:z.string().min(1).max(500).optional(), message:z.string().max(50000).optional(),
  options:z.array(z.string().trim().min(1).max(200)).max(20).optional(), declineOption:z.string().trim().min(1).max(200).optional(), inputPlaceholder:z.string().max(500).optional(),
  fields:z.array(field).min(1).max(50).optional(), requiresAuth:z.boolean().optional(),
  dryRun:z.boolean().optional(),
  timeoutSeconds:z.number().int().min(1).max(MAX_REQUEST_TIMEOUT_SECONDS).default(DEFAULT_REQUEST_TIMEOUT_SECONDS),
  waitSeconds:z.number().finite().min(0).max(MAX_REPLY_WAIT_SECONDS).default(25), resumeId:z.string().optional(),
});
const askSchema = askFields.refine(p => p.resumeId || p.title, 'A title is required for a new request')
  .refine(p => p.declineOption === undefined || !!p.options?.includes(p.declineOption),'declineOption must be one of options')
  .refine(p => !p.fields || new Set(p.fields.map(f=>f.id)).size === p.fields.length,'Form field IDs must be unique')
  .refine(p => !(p.dryRun && p.resumeId), 'Cannot combine dryRun with resumeId')
  .refine(p => p.diff === undefined || (!p.fields && !p.options && p.inputPlaceholder === undefined && !p.resumeId && p.screen === undefined),
    'A new diff request cannot include form fields, choices, text input, screen or a resume ID')
  .superRefine((p, ctx) => {
    if (
      p.screen !== undefined &&
      (p.message !== undefined ||
        p.fields !== undefined ||
        p.options !== undefined ||
        p.declineOption !== undefined ||
        p.inputPlaceholder !== undefined ||
        p.diff !== undefined ||
        p.resumeId !== undefined)
    ) {
      const maybeId =
        isPlainObject(p.screen) && typeof p.screen.templateId === 'string'
          ? p.screen.templateId.trim()
          : '';
      const guide =
        (maybeId ? formatScreenRecoveryGuide(maybeId) : '') || formatGeneralScreenRecoveryGuide();
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A new screen request cannot include message, choices, form fields, text input, diff or a resume ID. Pass all content in screen.slots (for presets) or screen.template (custom layouts).\n\n${guide}`,
      });
    }
  })
  .refine(p => !(p.options?.length === 0 && !p.fields && p.inputPlaceholder === undefined && p.screen === undefined && p.requiresAuth),
    'Passive notifications with empty options cannot require authentication');
export const activitySchema = z.object({
  presentation: presentation.optional(),
  sensitive: z.boolean().optional(),
  action:z.enum(['start','update','end','poll']), activityId:z.string().min(1).max(64),
  title:z.string().min(1).max(500).optional(), status:z.string().max(1000).optional(),
  step:z.number().int().min(0).max(1000000).optional(), totalSteps:z.number().int().min(1).max(1000000).optional(),
  timerMinutes:z.number().positive().max(60).optional(),
  controls:z.array(z.enum(['pause','resume','cancel','add_5m'])).max(4).optional(),
});
/** Marks the one chosen option as the sender's decline; the phone lets only that choice skip authentication. */
function declineMarked(options:string[]|undefined,decline:string|undefined):AskPayload['options'] {
  if(!options||decline===undefined) return options;
  const index=options.indexOf(decline);
  return options.map((label,i)=>i===index?{id:label,label,role:'decline' as const}:label);
}
export const notifySchema = z.object({
  presentation: presentation.optional(),
  sensitive: z.boolean().optional(),
  title:z.string().min(1).max(500), message:z.string().max(50000).optional(),
  timeoutSeconds:z.number().int().min(1).max(MAX_REQUEST_TIMEOUT_SECONDS).default(DEFAULT_REQUEST_TIMEOUT_SECONDS),
});
export type AskParams = Omit<z.input<typeof askSchema>, 'diff' | 'screen'> & { diff?: DiffInput; screen?: ScreenAskInput };
export type ActivityParams = z.input<typeof activitySchema>;
export type NotifyParams = z.input<typeof notifySchema>;
export type AskResult = {
  status:'resolved'|'delivered'|'pending'|'error'|'expired'|'not_found'|'dry_run';
  requestId:string;
  answer?:AnswerPayload;
  decoded?:DecodedScreenAnswer;
  valid?:boolean;
  errors?:string[];
  layout?:PublicScreenTemplateDescription;
  preview?:string;
  errorCode?:string;
  message?:string;
  templateId?:string;
  templateSlug?:string;
  repaired?:boolean;
  suggestedTemplate?:Record<string, unknown>;
  changes?:ScreenFeedbackItem[];
  fixes?:ScreenFeedbackItem[];
};
export type NotifyResult = {status:'delivered';requestId:string};
export const clockSkewMessage = 'The relay rejected this computer\'s clock (more than 120 s off). Fix the system clock, then retry; run nb doctor to see the offset.';
export const requestIdConflictMessage='This request ID was already used for a different request. Send it again with a new request ID.';
export const DEFAULT_ACTIVITY_UPDATE_DEBOUNCE_MS = 5_000;
export const MAX_ACTIVITY_UPDATE_DEBOUNCE_MS = 60_000;
export const DEFAULT_DISPATCH_PACE_MS = 3_000;
export const MAX_DISPATCH_PACE_MS = 10_000;
export const MAX_FALLBACK_POLL_PAUSE_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const PACE_DEADLINE_HEADROOM_MS = 5_000;

export interface ClientPacingOptions {
  /** Base trailing-edge debounce window (ms) for coalescing rapid `activity(update)` calls.
   *  Scaled by `X-NotiBuddy-Load-Scale` and capped at 60,000 ms. Default: 5,000 (0 disables). */
  activityUpdateDebounceMs?: number;
  /** Base leading-edge minimum spacing (ms) between consecutive `ask`/`notify`/`activity_start`/`activity_end`
   *  dispatches. Scaled by `X-NotiBuddy-Load-Scale` and capped at 10,000 ms & call deadline headroom.
   *  Default: 3,000 (0 disables). */
  dispatchPaceMs?: number;
}

export class DispatchRejectedError extends Error {
  /** `resend`: the saved request can never be delivered as it is (a resumed request whose recipients
   * changed, with no plaintext kept to re-seal it); the caller must send a new one. */
  constructor(
    public status:number,
    detail:string,
    public code?:string,
    readonly resend=false,
    readonly retryAfter?:string,
  ) { super(`Dispatch failed (${status}): ${detail}`); }
  get definitive():boolean {
    if(this.resend)return true;
    // A conflict may acknowledge an earlier acceptance; timeouts, 429 rate limits, and 5xx are ambiguous/transient.
    if(this.status===409 && this.code==='REQUEST_ID_CONFLICT')return true;
    return this.status>=400 && this.status<500 && ![408,409,425,429].includes(this.status);
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
type ParsedActivityParams=z.output<typeof activitySchema>;
interface PendingActivityUpdate {
  params:ParsedActivityParams;
  dueAt:number;
  timer?:ReturnType<typeof setTimeout>;
}

function mergeActivityUpdateParams(prev:ParsedActivityParams,next:ParsedActivityParams):ParsedActivityParams {
  const presentation=
    next.presentation!==undefined
      ? next.presentation
      : (next.title!==undefined || next.status!==undefined)
        ? undefined
        : prev.presentation;
  return {
    activityId:next.activityId,
    action:next.action,
    title:next.title ?? prev.title,
    status:next.status ?? prev.status,
    step:next.step ?? prev.step,
    totalSteps:next.totalSteps ?? prev.totalSteps,
    timerMinutes:next.timerMinutes ?? prev.timerMinutes,
    controls:next.controls ?? prev.controls,
    sensitive:next.sensitive===true || prev.sensitive===true ? true : (next.sensitive ?? prev.sensitive),
    presentation,
  };
}

export class NotiBuddyClient {
  private store:PendingStore;
  private screenStore:ScreenTemplateStore;
  private screenRuntime:ScreenRuntimeOptions;
  private recipients:RecipientStore;
  private senderStream:SenderStream;
  private keepStreamAlive:boolean;
  private loadScaleTracker=new LoadScaleTracker();
  private readonly activityUpdateDebounceMs:number;
  private readonly dispatchPaceMs:number;
  private lastPacedDispatchAt=0;
  private paceQueue:Promise<void>=Promise.resolve();
  private recentNotifies=new Map<string,{at:number;promise:Promise<NotifyResult>}>();
  private pendingStarts=new Map<string,{cancel:()=>void}>();
  private pendingActivityUpdates=new Map<string,PendingActivityUpdate>();
  private inFlightActivityFlushes=new Map<string,Promise<void>>();
  constructor(
    private config:NotiBuddyConfig,
    private signingKey:CryptoKey,
    store?:PendingStore,
    private sender=os.hostname(),
    credentials?:{store:DestinationStore;name:string},
    stream?:{enabled?:boolean;keepAlive?:boolean},
    screenOptions?:ScreenRuntimeOptions,
    pacingOptions?:ClientPacingOptions
  ) {
    validateRequestSettings(config);
    this.config=structuredClone(config);this.config.relay=normalizeRelay(config.relay);
    if(credentials)bindCredentials(this.config,{...credentials,signingKey});
    this.sender=z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}]+$/u).parse(sender);
    this.store=store ?? new PendingStore(config);
    this.screenRuntime=screenOptions ?? {};
    this.screenStore=new ScreenTemplateStore(this.store.root,this.screenRuntime.resolveTaPublicKey);
    this.recipients=new RecipientStore(config,this.store.root);
    this.keepStreamAlive=stream?.keepAlive ?? false;
    const rawDebounce=pacingOptions?.activityUpdateDebounceMs ?? DEFAULT_ACTIVITY_UPDATE_DEBOUNCE_MS;
    const rawPace=pacingOptions?.dispatchPaceMs ?? DEFAULT_DISPATCH_PACE_MS;
    this.activityUpdateDebounceMs=Number.isFinite(rawDebounce) && rawDebounce>0 ? rawDebounce : 0;
    this.dispatchPaceMs=Number.isFinite(rawPace) && rawPace>0 ? rawPace : 0;
    this.senderStream=new SenderStream(this.config,this.signingKey,stream?.enabled,()=>this.loadScale);
  }
  get loadScale():number {
    return this.loadScaleTracker.current();
  }
  get effectiveActivityUpdateDebounceMs():number {
    if(this.activityUpdateDebounceMs<=0)return 0;
    return Math.min(MAX_ACTIVITY_UPDATE_DEBOUNCE_MS,Math.round(this.activityUpdateDebounceMs*this.loadScale));
  }
  get effectiveDispatchPaceMs():number {
    if(this.dispatchPaceMs<=0)return 0;
    return Math.min(MAX_DISPATCH_PACE_MS,Math.round(this.dispatchPaceMs*this.loadScale));
  }
  private withLoadScale<T extends CallOptions>(options:T):T {
    return {
      ...options,
      onLoadScale:(scale:number)=>{
        this.loadScaleTracker.observe(scale);
        options.onLoadScale?.(scale);
      },
    };
  }
  private rateLimitWaitMs(retryAfterHeader:string|undefined,attempt:number,deadline:number):number|undefined {
    const parsed=parseRetryAfterMs(retryAfterHeader);
    const baseMs=parsed ?? Math.min(5_000,1_000*(2**attempt));
    const remaining=deadline-Date.now();
    if(remaining<=0 || baseMs>=remaining)return undefined;
    if(baseMs===0)return 0;
    const jitterSpan=Math.min(250,Math.max(1,Math.round(baseMs*0.2)));
    const jitterMs=Math.floor(Math.random()*jitterSpan);
    return Math.min(baseMs+jitterMs,Math.max(0,remaining-25));
  }
  private async paceDispatch(deadline:number,options:CallOptions,activityStartId?:string):Promise<'proceed'|'cancelled'> {
    if(this.dispatchPaceMs<=0)return 'proceed';
    let cancelled=false;
    const cancelController=activityStartId ? new AbortController() : undefined;
    const entry=activityStartId
      ? {
          cancel:()=>{
            cancelled=true;
            cancelController!.abort();
          },
        }
      : undefined;
    if(activityStartId && entry)this.pendingStarts.set(activityStartId,entry);

    const prevQueue=this.paceQueue;
    let releaseQueue!:()=>void;
    this.paceQueue=new Promise<void>((resolve)=>{releaseQueue=resolve;});

    try {
      await prevQueue;
      if(cancelled)return 'cancelled';
      options.signal?.throwIfAborted();
      const scaledInterval=this.effectiveDispatchPaceMs;
      const now=Date.now();
      const elapsed=this.lastPacedDispatchAt>0 ? Math.max(0,now-this.lastPacedDispatchAt) : scaledInterval;
      const neededWait=Math.max(0,scaledInterval-elapsed);
      const remainingDeadline=Number.isFinite(deadline) ? Math.max(0,deadline-now) : Infinity;
      const maxAllowedWait=Number.isFinite(remainingDeadline)
        ? Math.min(scaledInterval,Math.max(0,remainingDeadline-PACE_DEADLINE_HEADROOM_MS),MAX_DISPATCH_PACE_MS)
        : Math.min(scaledInterval,MAX_DISPATCH_PACE_MS);
      const waitMs=Math.min(neededWait,maxAllowedWait);
      if(waitMs>0) {
        const waitController=new AbortController();
        const onCallerAbort=()=>waitController.abort(options.signal?.reason);
        const onStartCancel=()=>waitController.abort(new Error('ACTIVITY_START_CANCELLED'));
        options.signal?.addEventListener('abort',onCallerAbort,{once:true});
        cancelController?.signal.addEventListener('abort',onStartCancel,{once:true});
        try {
          if(options.signal?.aborted)onCallerAbort();
          else if(cancelController?.signal.aborted)onStartCancel();
          await pollPause(waitMs,waitController.signal);
        } catch(error) {
          if(cancelled)return 'cancelled';
          throw error;
        } finally {
          options.signal?.removeEventListener('abort',onCallerAbort);
          cancelController?.signal.removeEventListener('abort',onStartCancel);
        }
      }
      if(cancelled)return 'cancelled';
      options.signal?.throwIfAborted();
      this.lastPacedDispatchAt=Date.now();
      return 'proceed';
    } finally {
      if(activityStartId && entry && this.pendingStarts.get(activityStartId)===entry) {
        this.pendingStarts.delete(activityStartId);
      }
      releaseQueue();
    }
  }
  async registerScreenTemplate(input:unknown,options:CallOptions & {strict?:boolean}={}):Promise<RegisterScreenTemplateResult> {
    const call=this.withLoadScale({...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+15000)});
    return registerScreenTemplateOnRelay(this.config,this.signingKey,this.screenStore,input,{...call,strict:options.strict},this.screenRuntime);
  }
  async flushPendingActivities(options:CallOptions={}):Promise<void> {
    const ids=Array.from(this.pendingActivityUpdates.keys());
    const tasks:Promise<void>[]=[];
    for(const id of ids)tasks.push(this.flushSingleActivity(id,options));
    for(const inFlight of this.inFlightActivityFlushes.values())tasks.push(inFlight);
    await Promise.all(tasks);
  }
  close():void {
    for(const entry of this.pendingActivityUpdates.values()) {
      if(entry.timer)clearTimeout(entry.timer);
    }
    this.pendingActivityUpdates.clear();
    for(const start of this.pendingStarts.values())start.cancel();
    this.pendingStarts.clear();
    this.senderStream.close();
  }
  async doctor(options:CallOptions={}) {
    const call=this.withLoadScale({...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+15000)});
    const report={relay:this.config.relay,reachable:false,requestProtocol:this.config.requestProtocol ?? 1,
      deviceId:this.config.device.id,sender:'unverified',recipientCount:null as number|null,issues:[] as string[],clockSkewMs:undefined as number|undefined,newer:undefined as string|undefined};
    const update=latestNewerVersion(call);
    try {
      const t0=Date.now();
      const health=await relayJSON(this.config,'/v1/health',{}, {...call,maxResponseBytes:65536});
      const t1=Date.now(),edge=typeof health.body?.edgeTime==='string'?Date.parse(health.body.edgeTime):NaN;
      if(Number.isFinite(edge)) {
        const skew=Math.round(edge-(t0+t1)/2);report.clockSkewMs=skew;
        if(Math.abs(skew)>60000)report.issues.push(`This computer's clock is ${Math.round(Math.abs(skew)/1000)} s ${skew>0?'behind':'ahead of'} the relay; requests are rejected beyond 120 s. Fix the system clock.`);
      }
      report.reachable=health.body?.status==='healthy';if(!report.reachable)report.issues.push('Relay health response was not recognized');
      report.sender=await senderStatus(this.config,this.signingKey,call);
      if(report.requestProtocol===2) {
        const {body}=await relayJSON(this.config,'/v2/recipients?deviceId='+this.config.device.id,{},call,this.signingKey);
        const recipients=await verifyRecipients(body,this.config,this.recipients.read());
        if(recipients.generation<(this.config.minimumRecipientGeneration ?? 0))throw Error('Recipient membership predates pairing');
        this.recipients.remember(recipients,body);report.recipientCount=recipients.recipients.length;
      }else report.recipientCount=1;
    }catch(error) {
      options.signal?.throwIfAborted();
      report.issues.push(error instanceof RelayHTTPError&&error.code==='CLOCK_SKEW'?clockSkewMessage:error instanceof RelayHTTPError?`Relay returned ${error.status}${error.code?' '+error.code:''}`:'Verification did not complete; check connectivity, pairing approval, and client compatibility');
    }
    if(report.clockSkewMs===undefined)delete report.clockSkewMs;
    report.newer=await update;if(report.newer===undefined)delete report.newer;
    return report;
  }
  async registerSender(payload:SenderRegistrationPayload,options:CallOptions={}):Promise<'registered'|'pending_approval'|'pending_automatic'> {
    payload=structuredClone(payload);
    const result=await registerSenderOnce(this.config,this.signingKey,payload,this.withLoadScale(options));
    if(payload.senderKeyId===this.config.senderKeyId)this.config.senderPub=payload.senderPub;
    return result.status;
  }
  async postRequest(envelope:WireRequest,options:CallOptions={}):Promise<{requestId:string;seq:number}> {
    try {
      const {body}=await relayJSON(this.config,`/v${envelope.v}/requests`,{method:'POST',body:JSON.stringify(envelope)},this.withLoadScale(options));
      if(body?.requestId!==envelope.requestId || !Number.isSafeInteger(body.seq) || body.seq<1)throw Error('Invalid dispatch acknowledgement');
      return body;
    }catch(error){
      if(error instanceof RelayHTTPError)throw new DispatchRejectedError(error.status,error.code ?? 'Request rejected',error.code,false,error.retryAfter);
      throw error;
    }
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
      const {status,body}=await relayJSON(this.config,`/v${version}/replies/${encodeURIComponent(id)}?afterSeq=${afterSeq}`,{},this.withLoadScale(options),this.signingKey);
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
  private async fetchRecipients(options:CallOptions):Promise<{body:any}> {
    const call=this.withLoadScale(options);
    const deadline=call.deadline ?? Date.now()+15000;
    for(let rateAttempt=0;;rateAttempt++) {
      try {
        return await relayJSON(this.config,'/v2/recipients?deviceId='+this.config.device.id,{},call,this.signingKey);
      } catch(error) {
        if(error instanceof RelayHTTPError && error.status===429 && rateAttempt<MAX_RATE_LIMIT_RETRIES) {
          const waitMs=this.rateLimitWaitMs(error.retryAfter,rateAttempt,deadline);
          if(waitMs!==undefined) {
            await pollPause(waitMs,call.signal);
            continue;
          }
        }
        throw error;
      }
    }
  }
  private async seal(id:string,primitive:PrimitiveType,payload:AskPayload|ActivityPayload|ScreenRequestPlaintext,timeout:number,options:CallOptions,version=this.config.requestProtocol ?? 1,expiresAt?:number,forceRefreshRecipients=false):Promise<{envelope:WireRequest;recipients?:unknown}> {
    if(version===1) {
      if(primitive==='screen')throw Error('Certified screen requests require a Protocol v2 destination');
      return {envelope:await sealRequest({requestId:id,deviceId:this.config.device.id,senderKeyId:this.config.senderKeyId,
        senderSigningPrivateKey:this.signingKey,deviceEncryptionPublicKey:this.config.device.encPub,primitive,payload:payload as AskPayload|ActivityPayload,timeoutSeconds:timeout})};
    }
    const checkpoint=this.recipients.read();
    const cacheTtlMs=DEFAULT_RECIPIENT_CACHE_TTL_MS*this.loadScale;
    let body:unknown;
    let recipients:VerifiedRecipients|undefined;
    if(!forceRefreshRecipients) {
      const cachedBody=this.recipients.readCached(cacheTtlMs);
      if(cachedBody!==undefined) {
        try {
          const verified=await verifyRecipients(cachedBody,this.config,checkpoint);
          if(verified.generation>=(this.config.minimumRecipientGeneration ?? 0)) {
            body=cachedBody;
            recipients=verified;
          } else {
            this.recipients.invalidateCache();
          }
        } catch {
          this.recipients.invalidateCache();
        }
      }
    }
    if(!recipients) {
      const fetched=await this.fetchRecipients(options);
      body=fetched.body;
      recipients=await verifyRecipients(body,this.config,this.recipients.read());
      if(recipients.generation<(this.config.minimumRecipientGeneration ?? 0))throw Error('Relay membership predates the pairing document');
      this.recipients.remember(recipients,body);
    }
    return {recipients:body,envelope:await sealGroupRequest({requestId:id,senderKeyId:this.config.senderKeyId,signingKey:this.signingKey,recipients,primitive,payload,timeoutSeconds:timeout,expiresAt,
      ...(payload.type==='activity'?{sessionId:payload.activityId,revision:payload.revision}: {})})};
  }
  private async prepare(id:string,primitive:PrimitiveType,payload:AskPayload|ActivityPayload|ScreenRequestPlaintext,key:CryptoKey,timeout:number,options:CallOptions,version?:1|2,screen?:PendingScreenContext,screenDecode?:ScreenDecodeContext):Promise<PendingReply> {
    const prepared=await this.seal(id,primitive,payload,timeout,options,version);
    const privateKeyJwk=await crypto.subtle.exportKey('jwk',key);
    const screenDecodeCt=screenDecode?await sealPendingScreenDecodeContext(id,privateKeyJwk,screenDecode):undefined;
    const saved:PendingReply={privateKeyJwk,expiresAt:prepared.envelope.expiresAt,...prepared,dispatch:'pending',...(screen?{screen}:{}),...(screenDecodeCt?{screenDecodeCt}:{})};
    this.savePending(id,saved);return saved;
  }
  /** `plaintext` lives in memory only; a record saved by an earlier process has none. */
  private async dispatchSaved(id:string,saved:PendingReply,options:CallOptions,plaintext?:AskPayload|ActivityPayload|ScreenRequestPlaintext):Promise<PendingReply> {
    if(saved.dispatch!=='pending' || !saved.envelope || saved.expiresAt<=Math.floor(Date.now()/1000))return saved;
    if(saved.payload!==undefined) {
      // Legacy record: scrub the plaintext from disk before posting; use it in memory for this call only.
      plaintext??=saved.payload;
      const {payload:_legacy,...scrubbed}=saved;saved=scrubbed;this.savePending(id,saved);
    }
    const deadline=options.deadline ?? Date.now()+15000;
    let recipientRefreshes=0,rateLimitRetries=0;
    for(;;) {
      try {
        await this.postRequest(saved.envelope!,options);
        const accepted={...saved,dispatch:'accepted' as const};this.savePending(id,accepted);return accepted;
      }catch(error) {
        if(error instanceof DispatchRejectedError && error.status===429 && rateLimitRetries<MAX_RATE_LIMIT_RETRIES) {
          const waitMs=this.rateLimitWaitMs(error.retryAfter,rateLimitRetries,deadline);
          if(waitMs!==undefined) {
            rateLimitRetries++;
            await pollPause(waitMs,options.signal);
            continue;
          }
        }
        if(recipientRefreshes===0 && error instanceof DispatchRejectedError && error.code==='RECIPIENTS_CHANGED' && saved.envelope!.v===2) {
          this.recipients.invalidateCache();
          if(!plaintext)throw new DispatchRejectedError(error.status,'the phone\'s recipients changed while this request was waiting to be sent; send it again',error.code,true,error.retryAfter);
          const remaining=saved.expiresAt-Math.floor(Date.now()/1000);if(remaining<=0)return saved;
          recipientRefreshes++;
          const refreshed=await this.seal(id,saved.envelope!.primitive as PrimitiveType,plaintext,remaining,options,2,saved.expiresAt,true);
          saved={...saved,...refreshed,expiresAt:refreshed.envelope.expiresAt};this.savePending(id,saved);continue;
        }
        throw error;
      }
    }
  }
  private async open(id:string,envelope:WireResponse,saved:PendingReply):Promise<AskResult> {
    const key=await this.replyKey(saved);
    if(envelope.v===2) {
      if(!saved.envelope || !validGroupRequest(saved.envelope))throw new PendingStorageError('Missing original group request');
      const recipients=await verifyRecipients(saved.recipients,this.config);
      if(saved.envelope.primitive==='screen') {
        const plaintext=await openGroupResponsePlaintext({input:envelope,request:saved.envelope,recipients,replyKey:key});
        let rawAnswer:unknown;
        try{rawAnswer=JSON.parse(plaintext);}
        catch{return {status:'error',requestId:envelope.requestId,errorCode:'SETTLEMENT_UNVERIFIED',message:'Screen answer is not valid JSON.'};}
        const verified=await verifyScreenSettlement(saved.screen,rawAnswer);
        if(verified.status!=='resolved') {
          return {status:'error',requestId:envelope.requestId,errorCode:verified.errorCode,message:verified.message};
        }
        const decodeCtx=saved.screenDecodeCt
          ? await openPendingScreenDecodeContext(id,saved.privateKeyJwk,saved.screenDecodeCt)
          : undefined;
        const catalogSlug=saved.screen?getScreenCatalogByTemplateId(saved.screen.templateId)?.slug:undefined;
        const decoded=saved.screen
          ? decodeScreenAnswer(
              saved.screen.skeleton,
              (verified.answer.values?.form ?? {}) as ScreenFormMap,
              verified.answer.action,
              decodeCtx,
              catalogSlug ?? saved.screen.templateId,
            )
          : undefined;
        return {status:'resolved',requestId:envelope.requestId,answer:verified.answer,...(decoded?{decoded}:{})};
      }
      return {status:'resolved',requestId:envelope.requestId,answer:await openGroupResponse({input:envelope,request:saved.envelope,recipients,replyKey:key})};
    }
    if(envelope.createdAt>Math.floor(Date.now()/1000)+120 || envelope.createdAt>=saved.expiresAt || saved.envelope && envelope.createdAt<saved.envelope.createdAt-120)throw Error('Reply timestamp outside saved request lifetime');
    const expected={expectedRequestId:id,expectedDeviceId:this.config.device.id,deviceSigningPublicKey:this.config.device.sigPub};
    if(envelope.kind==='error')return {status:'error',requestId:envelope.requestId,errorCode:await openError({...expected,envelope})};
    return {status:'resolved',requestId:envelope.requestId,answer:await openReply({...expected,envelope,replyPrivateKey:key})};
  }
  async notify(input:NotifyParams,options:CallOptions={}):Promise<NotifyResult> {
    const params=notifySchema.parse(input);
    const paceWindowMs=this.effectiveDispatchPaceMs;
    const dedupeKey=paceWindowMs>0 ? JSON.stringify([params.title,params.message ?? '']) : undefined;
    if(dedupeKey!==undefined) {
      const now=Date.now();
      for(const [k,entry] of this.recentNotifies) {
        if(now-entry.at>=paceWindowMs)this.recentNotifies.delete(k);
      }
      const existing=this.recentNotifies.get(dedupeKey);
      if(existing && now-existing.at<paceWindowMs) {
        return existing.promise;
      }
    }
    const work=(async():Promise<NotifyResult>=>{
      const id='req_'+randomUUID().replaceAll('-','');
      const call=this.withLoadScale({...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+15000)});
      await this.paceDispatch(call.deadline,call);
      const pair=await generateReplyKeyPair();
      const payload:AskPayload={type:'ask',source:{label:this.sender},replyPub:pair.publicKeyB64u,title:params.title,message:params.message,
        options:[],sensitive:params.sensitive,presentation:params.presentation};
      let prepared=await this.seal(id,'approval',payload,params.timeoutSeconds,call);
      let recipientRefreshes=0,rateLimitRetries=0;
      for(;;) {
        try {
          await this.postRequest(prepared.envelope,call);
          return {status:'delivered',requestId:id};
        }catch(error) {
          if(error instanceof DispatchRejectedError && error.status===429 && rateLimitRetries<MAX_RATE_LIMIT_RETRIES) {
            const waitMs=this.rateLimitWaitMs(error.retryAfter,rateLimitRetries,call.deadline);
            if(waitMs!==undefined) {
              rateLimitRetries++;
              await pollPause(waitMs,call.signal);
              continue;
            }
          }
          if(recipientRefreshes===0 && error instanceof DispatchRejectedError && error.code==='RECIPIENTS_CHANGED' && prepared.envelope.v===2) {
            this.recipients.invalidateCache();
            const remaining=prepared.envelope.expiresAt-Math.floor(Date.now()/1000);if(remaining<=0)throw error;
            recipientRefreshes++;
            prepared=await this.seal(id,'approval',payload,remaining,call,2,prepared.envelope.expiresAt,true);continue;
          }
          throw error;
        }
      }
    })();
    if(dedupeKey!==undefined) {
      this.recentNotifies.set(dedupeKey,{at:Date.now(),promise:work});
      void work.catch(()=>{
        if(this.recentNotifies.get(dedupeKey)?.promise===work)this.recentNotifies.delete(dedupeKey);
      });
    }
    return work;
  }
  async ask(input:AskParams,options:CallOptions={}):Promise<AskResult> {
    const params=askSchema.parse(input),diff=params.diff === undefined ? undefined : parseDiff(params.diff);
    const screenInput=params.screen === undefined ? undefined : parseScreenAskInput(params.screen);
    if(params.dryRun) {
      if(screenInput) {
        const dry=await dryRunLocalScreen(this.config,this.screenStore,screenInput,params.title);
        return {status:'dry_run',requestId:'dry_run',...dry};
      }
      return {status:'dry_run',requestId:'dry_run',valid:true,message:'Dry-run validation passed; no notification was sent.'};
    }
    if(screenInput && (this.config.requestProtocol ?? 1)!==2) {
      throw Error('Certified screen requests require a Protocol v2 destination');
    }
    if(!params.resumeId && !diff && !screenInput && !params.fields?.length && params.inputPlaceholder===undefined && params.options?.length===0) {
      return this.notify({title:params.title!,message:params.message,timeoutSeconds:params.timeoutSeconds,sensitive:params.sensitive,presentation:params.presentation},options);
    }
    const id=params.resumeId ?? 'req_'+randomUUID().replaceAll('-','');validateIdentifier(id,'resumeId');
    // wait=0 means one lookup with a bounded network budget; positive waits are
    // one end-to-end deadline including discovery, dispatch and response bytes.
    const call=this.withLoadScale({...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+(params.waitSeconds===0?15000:params.waitSeconds*1000))});
    if(!params.resumeId) {
      await this.paceDispatch(call.deadline,call);
    }
    return this.store.withOperation('reply:'+id,async()=>{
      let saved:PendingReply,sealed:AskPayload|ScreenRequestPlaintext|undefined;
      let screenMeta:Pick<AskResult,'templateId'|'templateSlug'|'repaired'|'suggestedTemplate'|'changes'>|undefined;
      const withMeta=(result:AskResult):AskResult=>screenMeta ? {...result,...screenMeta} : result;
      if(params.resumeId) {
        saved=this.readPending(id);
        if(saved.envelope?.primitive.startsWith('activity_'))throw Error('Use activity poll to resume activity controls');
        if(saved.screen) {
          const resumeSlug=getScreenCatalogByTemplateId(saved.screen.templateId)?.slug;
          screenMeta={templateId:saved.screen.templateId,...(resumeSlug?{templateSlug:resumeSlug}:{})};
        }
      }
      else if(screenInput) {
        const resolved=await resolveScreenForDispatch(this.config,this.signingKey,this.screenStore,screenInput,call,this.screenRuntime);
        if(!resolved.ok) {
          return {
            status:'error',
            requestId:id,
            errorCode:resolved.errorCode,
            message:resolved.message,
            ...(resolved.suggestedTemplate!==undefined?{suggestedTemplate:resolved.suggestedTemplate}:{}),
            ...(resolved.changes!==undefined?{changes:resolved.changes}:{}),
            ...(resolved.fixes!==undefined?{fixes:resolved.fixes}:{}),
          };
        }
        const catalogSlug=resolved.templateSlug ?? getScreenCatalogByTemplateId(resolved.templateId)?.slug;
        screenMeta={
          templateId:resolved.templateId,
          ...(catalogSlug?{templateSlug:catalogSlug}:{}),
          ...(resolved.repaired?{repaired:true,suggestedTemplate:resolved.suggestedTemplate,changes:resolved.changes}:{}),
        };
        const pair=await generateReplyKeyPair();
        const candidatePayload:ScreenRequestPlaintext={
          type:'ask',
          replyPub:pair.publicKeyB64u,
          source:{label:this.sender},
          title:params.title!,
          ...(params.presentation!==undefined?{presentation:params.presentation}:{}),
          ...(params.sensitive!==undefined?{sensitive:params.sensitive}:{}),
          ...(params.requiresAuth!==undefined?{requiresAuth:params.requiresAuth}:{}),
          templateId:resolved.templateId,
          labels:resolved.labels,
          data:resolved.data,
          ...(screenInput.thread!==undefined?{thread:screenInput.thread}:{}),
        };
        const counts=validateScreenRequestBindings(resolved.skeleton,{labels:candidatePayload.labels,data:candidatePayload.data},catalogSlug);
        let validatedPayload:ScreenRequestPlaintext;
        try {
          validatedPayload=validateScreenRequestPlaintext(candidatePayload);
        } catch (err) {
          const msg=err instanceof Error ? err.message : 'Invalid screen request';
          const guide=catalogSlug ? formatScreenRecoveryGuide(catalogSlug) : '';
          throw Error(guide ? `${msg}\n\n${guide}` : msg);
        }
        const contextDigest=await computeScreenContextDigest(id,new TextEncoder().encode(JSON.stringify(validatedPayload)));
        const decodeCtx=extractScreenDecodeContext(resolved.skeleton,validatedPayload.labels,validatedPayload.data,catalogSlug);
        const pendingScreen:PendingScreenContext={
          templateId:resolved.templateId,
          contextDigest,
          skeleton:resolved.skeleton,
          checklistCounts:counts.checklistCounts,
          pickerOptionCounts:counts.pickerOptionCounts,
          ...(validatedPayload.sensitive!==undefined?{sensitive:validatedPayload.sensitive}:{}),
          ...(validatedPayload.requiresAuth!==undefined?{requiresAuth:validatedPayload.requiresAuth}:{}),
        };
        saved=await this.prepare(id,'screen',validatedPayload,pair.privateKey,params.timeoutSeconds,call,2,pendingScreen,decodeCtx);
        sealed=validatedPayload;
      } else {
        const pair=await generateReplyKeyPair(),primitive:PrimitiveType=diff?'diff':params.fields?.length?'form':params.inputPlaceholder!==undefined?'text_input':'approval';
        const payload:AskPayload={type:'ask',source:{label:this.sender},replyPub:pair.publicKeyB64u,title:params.title!,message:params.message,
          options:declineMarked(params.options,params.declineOption),inputPlaceholder:params.inputPlaceholder,fields:params.fields,requiresAuth:params.requiresAuth,sensitive:params.sensitive,presentation:params.presentation,...diff};
        saved=await this.prepare(id,primitive,payload,pair.privateKey,params.timeoutSeconds,call);sealed=payload;
      }
      try {
        saved=await this.dispatchSaved(id,saved,call,sealed);
        let pollDelayMs=1000,pollRateLimitAttempt=0;
        do {
          let response:{envelope:WireResponse;seq:number}|null;
          try {
            response=await this.getSavedReply(id,saved,0,call);
            pollRateLimitAttempt=0;
          } catch(pollError) {
            if(pollError instanceof RelayHTTPError && pollError.status===429 && params.waitSeconds>0) {
              const waitMs=this.rateLimitWaitMs(pollError.retryAfter,pollRateLimitAttempt++,call.deadline);
              if(waitMs!==undefined) {
                await pollPause(waitMs,options.signal);
                continue;
              }
            }
            throw pollError;
          }
          if(response){const result=await this.open(id,response.envelope,saved);this.store.remove('reply:'+id);return withMeta(result);}
          if(params.waitSeconds===0 || Date.now()>=call.deadline)break;
          const resyncMs=scaledResyncIntervalMs(this.loadScale);
          const wait=await this.senderStream.waitForReply(id,call.deadline,call,resyncMs);
          if(wait==='available' || wait==='resync')continue;
          const remaining=call.deadline-Date.now();
          if(remaining<=0)break;
          const scaledPollDelayMs=Math.min(MAX_FALLBACK_POLL_PAUSE_MS,Math.round(pollDelayMs*this.loadScale));
          await pollPause(Math.min(scaledPollDelayMs,remaining),options.signal);
          pollDelayMs=Math.min(5000,Math.round(pollDelayMs*1.5));
        }while(Date.now()<call.deadline);
      }catch(error) {
        if(options.signal?.aborted)throw new ResumableRequestError(id);
        if(error instanceof TerminalRequestError){this.store.remove('reply:'+id);return withMeta({status:error.status,requestId:id});}
        if(error instanceof DispatchRejectedError && error.definitive){this.store.remove('reply:'+id);return withMeta({status:'error',requestId:id,errorCode:error.code ?? 'HTTP_'+error.status,message:error.code==='CLOCK_SKEW'?clockSkewMessage:error.code==='REQUEST_ID_CONFLICT'?requestIdConflictMessage:error.message});}
        return withMeta({status:'pending',requestId:id,errorCode:error instanceof DeadlineError?'WAIT_DEADLINE':'RETRY_REQUIRED',message:`Request is saved but no verified answer was received. Resume with resume_id='${id}'.`});
      }finally {
        this.senderStream.releaseIdle(this.keepStreamAlive);
      }
      return withMeta({status:'pending',requestId:id,message:`Call notibuddy_notify with resume_id='${id}' (or run nb notify --resume '${id}') to check again, including after restarting this client.`});
    });
  }
  private writeActivity(id:string,session:ActivitySession) {
    this.store.write('activity:'+id,session,((session.expiresAt ?? 0)+600)*1000);
  }
  private async pollActivity(session:ActivitySession,options:CallOptions):Promise<{controls:AnswerPayload[];warnings:string[]}> {
    const warnings:string[]=[],events:{seq:number;answer:AnswerPayload}[]=[];
    const requests=session.requests,n=requests.length;
    if(!n)return {controls:[],warnings};
    // Always check the newest snapshot plus at most one previous/rotated request (<= 2 total)
    // so missing keys or slow endpoints cannot starve a current control or amplify HTTP reads.
    const latest=n-1,indices=[latest];let offset=session.pollOffset ?? 0;
    if(n>1)indices.push(offset%latest);
    for(const index of indices) {
      if(Date.now()>=(options.deadline ?? Infinity))break;
      if(index!==latest)offset=(index+1)%latest;
      const pending=requests[index];
      if((pending.expiresAt+600)*1000<=Date.now()){pending.expiresAt=0;continue;}
      this.senderStream.consumeBuffered(pending.id);
      try {
        const saved=this.readPending(pending.id);delete pending.unavailable;
        const call={...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+2000)};
        for(let count=0;count<(index===latest?8:2);count++) {
          if(Date.now()>=call.deadline)break;
          const response=await this.getSavedReply(pending.id,saved,pending.afterSeq,call);if(!response)break;
          const result=await this.open(pending.id,response.envelope,saved);
          // Verify even repeated signatures before advancing unsigned relay metadata.
          // Skip authenticated replays within the same bounded polling budget.
          pending.afterSeq=response.seq;
          if(pending.seenSignatures?.includes(response.envelope.sig)) {
            warnings.push(`Repeated reply for ${pending.id} was ignored`);continue;
          }
          (pending.seenSignatures ??= []).push(response.envelope.sig);
          if(result.answer)events.push({seq:response.seq,answer:result.answer});
        }
      }catch(error) {
        options.signal?.throwIfAborted();
        if(error instanceof TerminalRequestError){pending.expiresAt=0;this.store.remove('reply:'+pending.id);}
        else {pending.unavailable=true;warnings.push(`Could not verify a reply for ${pending.id}; its saved data was preserved`);}
      }
    }
    this.senderStream.clearBufferedOverflow();
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
  private scheduleBufferedActivityTimer(activityId:string,entry:PendingActivityUpdate,debounceMs:number):void {
    if(entry.timer)clearTimeout(entry.timer);
    entry.dueAt=Date.now()+debounceMs;
    const timer=setTimeout(()=>{
      void this.flushSingleActivity(activityId).catch(()=>{});
    },debounceMs);
    timer.unref?.();
    entry.timer=timer;
  }
  private async flushSingleActivity(activityId:string,options:CallOptions={}):Promise<void> {
    const entry=this.pendingActivityUpdates.get(activityId);
    if(!entry) {
      await this.inFlightActivityFlushes.get(activityId);
      return;
    }
    if(entry.timer)clearTimeout(entry.timer);
    this.pendingActivityUpdates.delete(activityId);
    const call=this.withLoadScale({...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+20000)});
    const work=(async()=>{
      await this.executeActivityNow(entry.params,call);
    })();
    const tracked=work.finally(()=>{
      if(this.inFlightActivityFlushes.get(activityId)===tracked)this.inFlightActivityFlushes.delete(activityId);
    });
    this.inFlightActivityFlushes.set(activityId,tracked);
    await tracked;
  }
  private async executeActivityNow(params:ParsedActivityParams,call:CallOptions):Promise<ActivityResult> {
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
        const requestIds=session.requests.map(r=>r.id);
        const wsCovered=
          params.action!=='poll' &&
          session.protocol===2 &&
          this.senderStream.isConnected &&
          !this.senderStream.consumeActivityResyncNeeded() &&
          !this.senderStream.hasBufferedAny(requestIds);
        if(!wsCovered) {
          const polled=await this.pollActivity(session,{...call,deadline:Math.min((call.deadline ?? Date.now()+20000)-(params.action==='poll'?0:5000),Date.now()+10000)});
          controls=polled.controls;warnings=polled.warnings;this.writeActivity(params.activityId,session);
        }
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
        controls:params.controls ?? previous?.controls ?? ['pause','resume','add_5m','cancel'],replyPub:pair.publicKeyB64u,
      };
      const primitive:PrimitiveType=params.action==='start'?'activity_start':params.action==='end'?'activity_end':'activity_update';
      const version=params.action==='start'?(this.config.requestProtocol ?? 1):(session?.protocol ?? 1);
      const saved=await this.prepare(requestId,primitive,payload,pair.privateKey,MAX_ACTIVITY_TIMEOUT_SECONDS,call,version);
      const previousSession=session;
      session={payload,requests:[...(previous?session!.requests:[]),{id:requestId,afterSeq:0,expiresAt:saved.expiresAt}],
        ended:params.action==='end',expiresAt:saved.expiresAt,protocol:version,pendingDispatch:requestId,previous:previousSession,
        lastControlSeq:previous?previousSession?.lastControlSeq:undefined,pollOffset:previous?previousSession?.pollOffset:undefined};
      this.writeActivity(params.activityId,session);
      try {
        await this.dispatchSaved(requestId,saved,call,payload);
        delete session.pendingDispatch;delete session.previous;this.writeActivity(params.activityId,session);
      }catch(error) {
        if(error instanceof DispatchRejectedError && error.definitive) {
          if(previousSession)this.writeActivity(params.activityId,previousSession);else this.store.remove(storeId);
          this.store.remove('reply:'+requestId);
          if(error.code==='CLOCK_SKEW')throw Error(clockSkewMessage);
          if(error.code==='REQUEST_ID_CONFLICT')throw Error(requestIdConflictMessage);
        }
        throw error;
      }
      if(params.action==='start' && version===2 && this.keepStreamAlive && !this.senderStream.isConnected) {
        try {
          await this.senderStream.connect(Math.min(call.deadline ?? Date.now()+5000,Date.now()+5000),call.signal);
        } catch {}
      }
      return {status:'dispatched',activityId:params.activityId,controls,...(warnings.length?{warnings}:{})};
    });
  }
  async activity(input:ActivityParams,options:CallOptions={}):Promise<ActivityResult> {
    const params=activitySchema.parse(input);validateIdentifier(params.activityId,'activityId');
    const call=this.withLoadScale({...options,deadline:Math.min(options.deadline ?? Infinity,Date.now()+20000)});

    if(params.action==='poll') {
      return this.executeActivityNow(params,call);
    }

    if(params.action==='start') {
      const paced=await this.paceDispatch(call.deadline,call,params.activityId);
      if(paced==='cancelled') {
        return {status:'cancelled',activityId:params.activityId,controls:[]};
      }
      const result=await this.executeActivityNow(params,call);
      const deferred=this.pendingActivityUpdates.get(params.activityId);
      if(deferred && !deferred.timer) {
        const debounceMs=this.effectiveActivityUpdateDebounceMs;
        if(debounceMs>0)this.scheduleBufferedActivityTimer(params.activityId,deferred,debounceMs);
        else await this.flushSingleActivity(params.activityId,call);
      }
      return result;
    }

    if(params.action==='end') {
      const pendingStart=this.pendingStarts.get(params.activityId);
      if(pendingStart) {
        pendingStart.cancel();
        this.pendingStarts.delete(params.activityId);
        const queued=this.pendingActivityUpdates.get(params.activityId);
        if(queued?.timer)clearTimeout(queued.timer);
        this.pendingActivityUpdates.delete(params.activityId);
        return {status:'cancelled',activityId:params.activityId,controls:[]};
      }
      const queued=this.pendingActivityUpdates.get(params.activityId);
      let effectiveParams=params;
      if(queued) {
        if(queued.timer)clearTimeout(queued.timer);
        this.pendingActivityUpdates.delete(params.activityId);
        effectiveParams=mergeActivityUpdateParams(queued.params,params);
      }
      const inFlight=this.inFlightActivityFlushes.get(params.activityId);
      if(inFlight)await inFlight.catch(()=>{});
      await this.paceDispatch(call.deadline,call);
      return this.executeActivityNow(effectiveParams,call);
    }

    // action === 'update'
    const debounceMs=this.effectiveActivityUpdateDebounceMs;
    if(debounceMs<=0) {
      return this.executeActivityNow(params,call);
    }
    if(this.pendingStarts.has(params.activityId)) {
      const existing=this.pendingActivityUpdates.get(params.activityId);
      if(existing) {
        existing.params=mergeActivityUpdateParams(existing.params,params);
      } else {
        this.pendingActivityUpdates.set(params.activityId,{params,dueAt:Infinity});
      }
      return {status:'coalesced',activityId:params.activityId,controls:[]};
    }
    const existingSession=this.store.read<ActivitySession>('activity:'+params.activityId);
    if(!existingSession)throw Error('Start this activity on this paired computer first');
    const existingExpired=(existingSession.expiresAt ?? 0)*1000<=Date.now();
    if(existingExpired && !existingSession.pendingDispatch)throw Error('Activity expired; start a new activity');
    if(existingSession.ended)throw Error('Activity already ended');

    const existing=this.pendingActivityUpdates.get(params.activityId);
    if(existing && Date.now()>=existing.dueAt) {
      await this.flushSingleActivity(params.activityId,call);
    }
    const current=this.pendingActivityUpdates.get(params.activityId);
    if(current) {
      current.params=mergeActivityUpdateParams(current.params,params);
      return {status:'coalesced',activityId:params.activityId,controls:[]};
    }
    const entry:PendingActivityUpdate={params,dueAt:Date.now()+debounceMs};
    this.pendingActivityUpdates.set(params.activityId,entry);
    this.scheduleBufferedActivityTimer(params.activityId,entry,debounceMs);
    return {status:'coalesced',activityId:params.activityId,controls:[]};
  }
}
