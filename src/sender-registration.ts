import { randomUUID } from 'node:crypto';
import type { SenderRegistrationPayload } from './types.js';

/** Ownership proof is scoped to this pairing realm and every mutable field. */
export async function signSenderRegistration(payload: SenderRegistrationPayload, token: string, key: CryptoKey) {
  // Snapshot only wire fields before yielding; never spread a setup document or
  // let caller mutation alter the registration after its signature is computed.
  payload = { senderKeyId: payload.senderKeyId, senderPub: payload.senderPub, label: payload.label, mac: payload.mac,
    ...(payload.fileEncPub !== undefined ? { fileEncPub: payload.fileEncPub } : {}),
    ...(payload.fileDeviceId !== undefined ? { fileDeviceId: payload.fileDeviceId } : {}),
    ...(payload.invitation !== undefined ? { invitation: { invitationId: payload.invitation.invitationId, signature: payload.invitation.signature } } : {}) };
  if (payload.invitation && (!payload.fileDeviceId || !payload.fileEncPub ||
      payload.invitation.invitationId.length !== 36 || !/^pin_[a-f0-9]{32}$/.test(payload.invitation.invitationId) ||
      payload.invitation.signature.length !== 86 || Buffer.from(payload.invitation.signature, 'base64url').length !== 64 ||
      Buffer.from(payload.invitation.signature, 'base64url').toString('base64url') !== payload.invitation.signature)) throw Error('Invalid pairing claim proof');
  const createdAt=Math.floor(Date.now()/1000), nonce=randomUUID();
  const realm=token.replace(/^nb_(?:snd|dev|usr)_/,'');
  const input=new TextEncoder().encode(JSON.stringify([payload.invitation ? 'nb3' : payload.fileEncPub ? 'nb2' : 'nb1','sender-registration',realm,
    payload.senderKeyId,payload.senderPub,payload.label,payload.mac,createdAt,nonce,
    ...(payload.fileEncPub ? [payload.fileDeviceId,payload.fileEncPub] : []),
    ...(payload.invitation ? [payload.invitation.invitationId,payload.invitation.signature] : [])]));
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,input);
  return {...payload,createdAt,nonce,sig:Buffer.from(signature).toString('base64url')};
}
