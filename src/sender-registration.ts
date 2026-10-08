import { randomUUID } from 'node:crypto';
import type { SenderRegistrationPayload } from './types.js';

/** Ownership proof is scoped to this pairing realm and every mutable field. */
export async function signSenderRegistration(payload: SenderRegistrationPayload, token: string, key: CryptoKey) {
  const createdAt=Math.floor(Date.now()/1000), nonce=randomUUID();
  const realm=token.replace(/^nb_(?:snd|dev|usr)_/,'');
  const input=new TextEncoder().encode(JSON.stringify(['nb1','sender-registration',realm,
    payload.senderKeyId,payload.senderPub,payload.label,payload.mac,createdAt,nonce]));
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,input);
  return {...payload,createdAt,nonce,sig:Buffer.from(signature).toString('base64url')};
}
