import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { NotiBuddyConfig, ActivityPayload } from './types.js';

export interface PendingReply {
  privateKeyJwk: JsonWebKey;
  expiresAt: number;
}
export interface ActivitySession {
  payload: ActivityPayload;
  requests: { id: string; afterSeq: number; expiresAt: number; seenSignatures?: string[] }[];
  ended?: boolean;
  expiresAt?: number; // Latest snapshot lifetime, independent of response retention.
}

/** Private per-account files allow a new CLI/MCP process to resume a request. */
export class PendingStore {
  private directory: string;
  constructor(config: NotiBuddyConfig, root = process.env.NOTIBUDDY_HOME || path.join(os.homedir(), '.notibuddy')) {
    const scope = createHash('sha256').update(JSON.stringify([config.relay,config.token,config.device.id,config.senderKeyId])).digest('hex');
    this.directory = path.join(root, 'pending', scope);
    fs.mkdirSync(this.directory, {recursive:true, mode:0o700});
    fs.chmodSync(this.directory,0o700);
    this.prune();
  }
  private file(key: string): string {
    // Never turn an untrusted request/activity identifier into a filesystem path.
    return path.join(this.directory, createHash('sha256').update(key).digest('hex')+'.json');
  }
  read<T>(key: string): T | undefined {
    try {
      const stored = JSON.parse(fs.readFileSync(this.file(key),'utf8'));
      if (stored.retainUntil <= Date.now()) { this.remove(key); return undefined; }
      return stored.value as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Pending request storage is unreadable; preserve it to recover the request');
    }
  }
  write(key: string, value: unknown, retainUntil: number): void {
    const target = this.file(key);
    const temporary = target+'.'+randomUUID()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify({value,retainUntil}),{mode:0o600,flag:'wx'});
    fs.renameSync(temporary,target);
  }
  remove(key: string): void { fs.rmSync(this.file(key),{force:true}); }
  private prune(): void {
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.directory,name);
      try { if (JSON.parse(fs.readFileSync(file,'utf8')).retainUntil <= Date.now()) fs.unlinkSync(file); }
      catch { /* Preserve damaged data for recovery. */ }
    }
  }
}
