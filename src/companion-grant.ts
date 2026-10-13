const devicePattern=/^dev_[a-f0-9]{24}$/;
const capabilities=['approval','text_input','timer_control'];
const grantFields='accountId,capabilities,credentialHash,deviceId,encPub,expiresAt,generation,nonce,parentDeviceId,sigPub,v';
export type CompanionGrant={v:1;accountId:string;parentDeviceId:string;deviceId:string;encPub:string;sigPub:string;
  credentialHash:string;capabilities:string[];generation:number;nonce:string;expiresAt:number};
function validCapabilities(value:unknown):value is string[] {
  return Array.isArray(value) && value.length>0 && value.length<=capabilities.length &&
    value.every(v=>typeof v==='string' && capabilities.includes(v)) &&
    new Set(value).size===value.length && [...value].sort().join(',')===value.join(',');
}

export function validCompanionGrant(value:unknown):value is CompanionGrant {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const g=value as CompanionGrant;
  return Object.keys(g).sort().join(',')===grantFields && g.v===1 &&
    typeof g.accountId==='string' && g.accountId.length===32 && /^[a-f0-9]{32}$/.test(g.accountId) &&
    typeof g.parentDeviceId==='string' && g.parentDeviceId.length===28 && devicePattern.test(g.parentDeviceId) &&
    typeof g.deviceId==='string' && g.deviceId.length===28 && devicePattern.test(g.deviceId) && g.deviceId!==g.parentDeviceId &&
    typeof g.encPub==='string' && g.encPub.length===87 && /^[A-Za-z0-9_-]{87}$/.test(g.encPub) &&
    typeof g.sigPub==='string' && g.sigPub.length===87 && /^[A-Za-z0-9_-]{87}$/.test(g.sigPub) && g.encPub!==g.sigPub &&
    typeof g.credentialHash==='string' && g.credentialHash.length===64 && /^[a-f0-9]{64}$/.test(g.credentialHash) && validCapabilities(g.capabilities) &&
    Number.isSafeInteger(g.generation) && g.generation>0 &&
    typeof g.nonce==='string' && g.nonce.length===43 && /^[A-Za-z0-9_-]{43}$/.test(g.nonce) &&
    Number.isSafeInteger(g.expiresAt) && g.expiresAt>0;
}

export function companionGrantInput(g:CompanionGrant,role:'parent'|'child'):Uint8Array {
  if(!validCompanionGrant(g))throw Error('Invalid companion grant');
  return new TextEncoder().encode(`nb1|companion-${role}|${g.accountId}|${g.parentDeviceId}|${g.deviceId}|${g.encPub}|${g.sigPub}|${g.credentialHash}|${g.capabilities.join(',')}|${g.generation}|${g.nonce}|${g.expiresAt}`);
}
