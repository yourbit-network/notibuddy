import { relayJSON, RelayHTTPError, type CallOptions } from './client-http.js';
import type { NotiBuddyConfig } from './types.js';

type SenderStatus='approved'|'pending_approval'|'not_registered';
type SenderRow={senderKeyId:string;approved:0|1};
const object=(value:unknown):value is Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value);
const senderID=(value:unknown):value is string=>typeof value==='string' && value.length===28 && /^snd_[a-f0-9]{24}$/.test(value);
const row=(value:unknown):value is SenderRow=>object(value) && senderID(value.senderKeyId) && (value.approved===0 || value.approved===1);
const invalid=()=>new Error('Invalid sender status response');
const status=(sender:SenderRow|undefined):SenderStatus=>sender ? sender.approved===1?'approved':'pending_approval' : 'not_registered';

/** Read just this identity. Only an uncoded old-route 404 permits the legacy
 * complete list; errors, partial lists and malformed metadata cannot prove absence. */
export async function senderStatus(config:NotiBuddyConfig,options:CallOptions):Promise<SenderStatus> {
  if(!senderID(config.senderKeyId))throw invalid();
  try {
    const result=await relayJSON(config,'/v1/senders/'+config.senderKeyId,{}, {...options,maxResponseBytes:65536});
    if(result.status!==200 || !object(result.body) || !row(result.body.sender) || result.body.sender.senderKeyId!==config.senderKeyId)throw invalid();
    return status(result.body.sender);
  }catch(error) {
    if(!(error instanceof RelayHTTPError) || error.status!==404)throw error;
    if(error.code==='SENDER_NOT_FOUND')return 'not_registered';
    if(error.hasCode)throw error;
  }
  const result=await relayJSON(config,'/v1/senders',{},options);
  if(result.status!==200 || !object(result.body) || !Array.isArray(result.body.senders) || Object.hasOwn(result.body,'page'))throw invalid();
  const ids=new Set<string>();let selected:SenderRow|undefined;
  for(const value of result.body.senders) {
    if(!row(value) || ids.has(value.senderKeyId))throw invalid();
    ids.add(value.senderKeyId);
    if(value.senderKeyId===config.senderKeyId)selected=value;
  }
  return status(selected);
}
