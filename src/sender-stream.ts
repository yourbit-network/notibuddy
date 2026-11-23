import { randomUUID } from 'node:crypto';
import { ecdsaSign } from './crypto.js';
import { normalizeRelay } from './relay-url.js';
import { httpSigningInput, recoverRotatedCredentials, type CallOptions } from './client-http.js';
import type { NotiBuddyConfig } from './types.js';

export type SenderStreamEvent =
  | { type: 'ready'; senderKeyId: string }
  | { type: 'pong' }
  | { type: 'reply.available' | 'activity.available'; requestId: string; seq?: number }
  | { type: 'file.available'; fileId: string };

export type WaitOutcome = 'available' | 'resync' | 'fallback';

const EMPTY_BODY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ROUTE = '/v2/sender/ws';
export const RESYNC_INTERVAL_MS = 90_000;
export const MAX_RESYNC_INTERVAL_MS = 300_000;
const CONNECT_TIMEOUT_MS = 5_000;
const FALLBACK_COOLDOWN_MS = 5_000;
const MAX_SEEN_REQUESTS = 256;

export function scaledResyncIntervalMs(loadScale = 1): number {
  const clamped = Number.isFinite(loadScale) ? Math.min(10, Math.max(1, loadScale)) : 1;
  return Math.min(MAX_RESYNC_INTERVAL_MS, Math.round(RESYNC_INTERVAL_MS * clamped));
}

interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

function wsEndpoint(relay: string): string {
  const normalized = normalizeRelay(relay);
  if (normalized.startsWith('https://')) return 'wss://' + normalized.slice(8) + ROUTE;
  if (normalized.startsWith('http://')) return 'ws://' + normalized.slice(7) + ROUTE;
  throw new Error('Invalid relay URL for sender stream');
}

/**
 * Authenticated, sender-scoped hibernating WebSocket listener for `/v2/sender/ws`.
 * Announces opaque request reply/activity availability without carrying ciphertext;
 * callers still fetch and verify payloads over signed HTTP.
 */
export class SenderStream {
  private socket?: SocketLike;
  private connecting?: Promise<boolean>;
  private closedPermanently = false;
  private cooldownUntil = 0;
  private rotationAttempted = false;
  private activeWaits = 0;
  private waiters = new Map<string, Set<(reason: WaitOutcome) => void>>();
  private bufferedAnnouncements = new Map<string, number>();
  private bufferedOverflow = false;
  private hadEstablishedConnection = false;
  private activityResyncNeeded = false;

  constructor(
    private config: NotiBuddyConfig,
    private signingKey: CryptoKey,
    private enabled = typeof (globalThis as any).WebSocket === 'function',
    private getLoadScale?: () => number,
  ) {}

  get isConnected(): boolean {
    return this.socket?.readyState === 1;
  }

  private rememberAnnouncement(requestId: string): void {
    if (this.bufferedAnnouncements.has(requestId)) {
      this.bufferedAnnouncements.delete(requestId);
    } else if (this.bufferedAnnouncements.size >= MAX_SEEN_REQUESTS) {
      const oldest = this.bufferedAnnouncements.keys().next().value;
      if (oldest !== undefined) {
        this.bufferedAnnouncements.delete(oldest);
        this.bufferedOverflow = true;
      }
    }
    this.bufferedAnnouncements.set(requestId, Date.now());
  }

  consumeBuffered(requestId: string): boolean {
    return this.bufferedAnnouncements.delete(requestId);
  }

  hasBufferedAny(requestIds: readonly string[]): boolean {
    if (this.bufferedOverflow) return true;
    for (const id of requestIds) {
      if (this.bufferedAnnouncements.has(id)) return true;
    }
    return false;
  }

  clearBufferedOverflow(): void {
    this.bufferedOverflow = false;
  }

  consumeActivityResyncNeeded(): boolean {
    if (!this.activityResyncNeeded) return false;
    this.activityResyncNeeded = false;
    return true;
  }

  async connect(deadline: number, signal?: AbortSignal): Promise<boolean> {
    return this.ensureConnected(deadline, signal);
  }

  private wakeWaiters(requestId: string, reason: WaitOutcome): void {
    const set = this.waiters.get(requestId);
    if (!set) return;
    for (const notify of Array.from(set)) notify(reason);
  }

  private wakeAllWaiters(reason: WaitOutcome): void {
    for (const set of Array.from(this.waiters.values())) {
      for (const notify of Array.from(set)) notify(reason);
    }
  }

  private handleRawMessage(raw: unknown): void {
    let parsed: any;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (
      (parsed.type === 'reply.available' || parsed.type === 'activity.available') &&
      typeof parsed.requestId === 'string' &&
      parsed.requestId.length > 0
    ) {
      if (this.waiters.has(parsed.requestId)) {
        this.wakeWaiters(parsed.requestId, 'available');
      } else {
        this.rememberAnnouncement(parsed.requestId);
      }
    }
  }

  private async ensureConnected(deadline: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.enabled || this.closedPermanently) return false;
    if (this.socket?.readyState === 1) return true;
    if (Date.now() < this.cooldownUntil) return false;
    if (this.connecting) return this.connecting;

    this.connecting = this.openSocket(deadline, signal).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openSocket(deadline: number, signal?: AbortSignal): Promise<boolean> {
    const WebSocketCtor = (globalThis as any).WebSocket as
      | (new (url: string, options?: { headers?: Record<string, string> }) => SocketLike)
      | undefined;
    if (typeof WebSocketCtor !== 'function') return false;

    const tryDial = async (): Promise<boolean> => {
      const stamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomUUID();
      const input = httpSigningInput(this.config.token, 'GET', ROUTE, stamp, nonce, EMPTY_BODY_HASH);
      const signature = await ecdsaSign(this.signingKey, input);
      const headers: Record<string, string> = {
        Authorization: 'Bearer ' + this.config.token,
        'X-Sender-Key-ID': this.config.senderKeyId,
        'X-Sender-Timestamp': stamp,
        'X-Sender-Nonce': nonce,
        'X-Sender-Signature': signature,
      };
      const ws = new WebSocketCtor(wsEndpoint(this.config.relay), { headers });

      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(ok);
        };
        const timeoutMs = Math.max(100, Math.min(CONNECT_TIMEOUT_MS, deadline - Date.now()));
        const timer = setTimeout(() => {
          try {
            ws.close(1000, 'Connect timeout');
          } catch {}
          finish(false);
        }, timeoutMs);
        timer.unref?.();

        const onAbort = () => {
          try {
            ws.close(1000, 'Aborted');
          } catch {}
          finish(false);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        ws.addEventListener('open', () => {
          if (this.closedPermanently) {
            try {
              ws.close(1000, 'Closed');
            } catch {}
            finish(false);
            return;
          }
          this.socket = ws;
          this.rotationAttempted = false;
          if (this.hadEstablishedConnection) this.activityResyncNeeded = true;
          this.hadEstablishedConnection = true;
          finish(true);
        });
        ws.addEventListener('message', (event: any) => {
          this.handleRawMessage(event?.data);
        });
        ws.addEventListener('error', () => {
          if (this.socket === ws) this.socket = undefined;
          finish(false);
        });
        ws.addEventListener('close', (event: any) => {
          if (this.socket === ws) this.socket = undefined;
          const reason = typeof event?.reason === 'string' ? event.reason : '';
          if (reason === 'SENDER_REVOKED' || reason === 'ACCOUNT_DELETED') {
            this.closedPermanently = true;
          }
          finish(false);
          this.wakeAllWaiters('fallback');
        });
      });
    };

    const ok = await tryDial();
    if (ok) return true;
    if (!this.closedPermanently && !this.rotationAttempted && Date.now() < deadline) {
      this.rotationAttempted = true;
      try {
        const rotated = await recoverRotatedCredentials(this.config, { deadline, signal });
        if (rotated && (await tryDial())) return true;
      } catch {}
    }
    this.cooldownUntil = Date.now() + FALLBACK_COOLDOWN_MS;
    return false;
  }

  /**
   * Waits for an announcement for `requestId`, up to a bounded resync interval or `deadline`.
   * Returns `'available'` when signaled, `'resync'` on connected safety timeout, or `'fallback'`
   * if WebSockets are unavailable / disconnected.
   */
  async waitForReply(
    requestId: string,
    deadline: number,
    options: CallOptions = {},
    resyncMs = scaledResyncIntervalMs(this.getLoadScale?.() ?? 1),
  ): Promise<WaitOutcome> {
    options.signal?.throwIfAborted();
    if (this.consumeBuffered(requestId)) return 'available';
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'fallback';

    this.activeWaits++;
    try {
      const connected = await this.ensureConnected(deadline, options.signal);
      if (!connected) return 'fallback';
      if (this.consumeBuffered(requestId)) return 'available';

      const windowMs = Math.min(resyncMs, Math.max(0, deadline - Date.now()));
      if (windowMs <= 0) return 'fallback';

      return await new Promise<WaitOutcome>((resolve, reject) => {
        let settled = false;
        const set = this.waiters.get(requestId) ?? new Set();
        this.waiters.set(requestId, set);

        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          set.delete(onWake);
          if (set.size === 0) this.waiters.delete(requestId);
        };
        const onWake = (reason: WaitOutcome) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(reason);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(options.signal?.reason);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve('resync');
        }, windowMs);
        timer.unref?.();

        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        set.add(onWake);
      });
    } finally {
      this.activeWaits--;
    }
  }

  releaseIdle(keepAlive: boolean): void {
    if (!keepAlive && this.activeWaits === 0) this.close();
  }

  close(): void {
    const ws = this.socket;
    this.socket = undefined;
    if (ws) {
      try {
        ws.close(1000, 'Client closed');
      } catch {}
    }
    this.wakeAllWaiters('fallback');
  }
}
