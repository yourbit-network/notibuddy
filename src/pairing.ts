import { relayJSON, pollPause, RelayHTTPError, DeadlineError, type CallOptions } from './client-http.js';
import { createPairingClaim, validateFirstUse } from './pairing-invitation.js';
import { signSenderRegistration } from './sender-registration.js';
import type { FirstUsePairing, NotiBuddyConfig, SenderRegistrationPayload } from './types.js';

export type PairingResult = { status: 'registered' | 'pending_approval' } | { status: 'pending_automatic'; expiresAt: number };
export interface PairingOptions extends CallOptions {
  /** Extra time after the first automatic reservation, 0–60 seconds. Default 45. */
  waitSeconds?: number;
  onWaiting?: () => void;
}
type SignedRegistration = Awaited<ReturnType<typeof signSenderRegistration>>;

async function post(config: NotiBuddyConfig, registration: SignedRegistration, wire: string,
                    options: CallOptions, expectedExpiry?: number): Promise<PairingResult> {
  const { status, body } = await relayJSON(config, '/v1/senders', { method: 'POST', body: wire }, { ...options, maxResponseBytes: 8192 });
  if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body) ||
      (body.senderKeyId !== undefined || registration.invitation !== undefined) && body.senderKeyId !== registration.senderKeyId) throw Error('Invalid sender registration result');
  if (body.status === 'registered' || body.status === 'pending_approval') return { status: body.status };
  if (body.status !== 'pending_automatic' || !registration.invitation || body.senderKeyId !== registration.senderKeyId ||
      !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= 0 || body.expiresAt > Date.now() + 600_000 ||
      expectedExpiry !== undefined && body.expiresAt !== expectedExpiry) throw Error('Invalid automatic pairing result');
  return { status: 'pending_automatic', expiresAt: body.expiresAt };
}

export async function registerSenderOnce(config: NotiBuddyConfig, key: CryptoKey, payload: SenderRegistrationPayload,
                                         options: CallOptions = {}): Promise<PairingResult> {
  config = structuredClone(config);
  const registration = await signSenderRegistration(payload, config.token, key);
  return post(config, registration, JSON.stringify(registration), options);
}

/** Keep the capability in memory only. Reuse the same signed request/nonce
 * while waiting: polling cannot create fresh manual requests or supersede one.
 * A timeout is pending, never success; interruption leaves the saved keys intact. */
export async function pairSender(config: NotiBuddyConfig, key: CryptoKey, payload: SenderRegistrationPayload,
                                 firstUse?: FirstUsePairing, options: PairingOptions = {}): Promise<PairingResult> {
  const wait = options.waitSeconds ?? 45;
  if (!Number.isFinite(wait) || wait < 0 || wait > 60) throw Error('Pairing wait must be between 0 and 60 seconds');
  options.signal?.throwIfAborted();
  config = structuredClone(config); payload = structuredClone(payload);
  if (payload.senderKeyId !== config.senderKeyId || payload.fileDeviceId !== config.device.id) throw Error('Pairing identity does not match this destination');
  const invitation = firstUse ? validateFirstUse(firstUse, config) : undefined;
  if (invitation) payload.invitation = createPairingClaim(invitation, config, payload);
  else if (payload.invitation !== undefined) throw Error('Use the complete private setup code for automatic pairing');
  const registration = await signSenderRegistration(payload, config.token, key), wire = JSON.stringify(registration);
  let result = await post(config, registration, wire, options, invitation?.invitation.expiresAt);
  if (result.status !== 'pending_automatic') return result;
  options.onWaiting?.();
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + wait * 1000, result.expiresAt);
  while (Date.now() < deadline) {
    await pollPause(Math.min(2000, deadline - Date.now()), options.signal);
    if (Date.now() >= deadline) break;
    try {
      result = await post(config, registration, wire, { signal: options.signal, deadline }, invitation?.invitation.expiresAt);
      if (result.status !== 'pending_automatic') return result;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof DeadlineError && Date.now() >= deadline) break;
      // Retrying these ambiguous transport outcomes uses the exact same proof.
      // Authorization/stale/coded errors and malformed replies never downgrade.
      if (error instanceof RelayHTTPError ? ![408, 429, 500, 502, 503, 504].includes(error.status) : !(error instanceof TypeError || error instanceof DeadlineError)) throw error;
    }
  }
  options.signal?.throwIfAborted();
  return result;
}
