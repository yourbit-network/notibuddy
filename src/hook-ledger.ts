import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireFileLock } from './file-lock.js';
import { notibuddyHome } from './home.js';

const HOUR_MS = 3_600_000;
const QUOTA_COOLDOWNS_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const;
const MAX_LOG_BYTES = 256 * 1024;

export interface HookLedgerState {
  v: 1;
  dispatches: number[];
  quotaOpenUntil?: number;
  consecutiveQuotaErrors?: number;
}

export interface HookEventLogEntry {
  ts: number;
  agent: string;
  event: string;
  key: string;
  verdict: 'allow' | 'deny' | 'passthrough';
  cause?: string;
  requestId?: string;
  durationMs: number;
}

export type LedgerCheckResult =
  | { allowed: true }
  | { allowed: false; cause: 'quota_breaker_open' | 'hourly_budget_exceeded'; retryAtMs?: number };

function sanitizeKey(raw: string): string {
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe || 'default';
}

function hooksDir(root: string): string {
  return path.join(root, 'hooks');
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

function ledgerFile(root: string, key: string): string {
  return path.join(hooksDir(root), `ledger-${sanitizeKey(key)}.json`);
}

function readLedgerUnlocked(file: string): HookLedgerState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HookLedgerState>;
    const dispatches = Array.isArray(raw.dispatches)
      ? raw.dispatches.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : [];
    const quotaOpenUntil =
      typeof raw.quotaOpenUntil === 'number' && Number.isFinite(raw.quotaOpenUntil)
        ? raw.quotaOpenUntil
        : undefined;
    const consecutiveQuotaErrors =
      typeof raw.consecutiveQuotaErrors === 'number' && Number.isInteger(raw.consecutiveQuotaErrors) && raw.consecutiveQuotaErrors >= 0
        ? raw.consecutiveQuotaErrors
        : 0;
    return {
      v: 1,
      dispatches,
      ...(quotaOpenUntil !== undefined ? { quotaOpenUntil } : {}),
      ...(consecutiveQuotaErrors > 0 ? { consecutiveQuotaErrors } : {}),
    };
  } catch {
    return { v: 1, dispatches: [] };
  }
}

function writeLedgerUnlocked(file: string, state: HookLedgerState): void {
  const dir = path.dirname(file);
  ensurePrivateDir(path.dirname(dir));
  ensurePrivateDir(dir);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function withLedgerLock<T>(root: string, key: string, fn: (file: string) => T): T {
  const dir = hooksDir(root);
  ensurePrivateDir(root);
  ensurePrivateDir(dir);
  const file = ledgerFile(root, key);
  const unlock = acquireFileLock(`${file}.lock`);
  try {
    return fn(file);
  } finally {
    unlock();
  }
}

/** Fast read-only preflight check before waiting or importing crypto/network modules. */
export function checkHookLedger(
  key: string,
  maxPerHour: number,
  nowMs = Date.now(),
  root = notibuddyHome(),
): LedgerCheckResult {
  const state = readLedgerUnlocked(ledgerFile(root, key));
  if (state.quotaOpenUntil !== undefined && nowMs < state.quotaOpenUntil) {
    return { allowed: false, cause: 'quota_breaker_open', retryAtMs: state.quotaOpenUntil };
  }
  const cutoff = nowMs - HOUR_MS;
  const recent = state.dispatches.filter((ts) => ts > cutoff);
  if (maxPerHour > 0 && recent.length >= maxPerHour) {
    return { allowed: false, cause: 'hourly_budget_exceeded' };
  }
  return { allowed: true };
}

/** Atomically check and reserve one dispatch slot right before posting to the relay. */
export function reserveHookDispatch(
  key: string,
  maxPerHour: number,
  nowMs = Date.now(),
  root = notibuddyHome(),
): LedgerCheckResult {
  try {
    return withLedgerLock(root, key, (file) => {
      const state = readLedgerUnlocked(file);
      if (state.quotaOpenUntil !== undefined && nowMs < state.quotaOpenUntil) {
        return { allowed: false, cause: 'quota_breaker_open', retryAtMs: state.quotaOpenUntil };
      }
      const cutoff = nowMs - HOUR_MS;
      const recent = state.dispatches.filter((ts) => ts > cutoff);
      if (maxPerHour > 0 && recent.length >= maxPerHour) {
        return { allowed: false, cause: 'hourly_budget_exceeded' };
      }
      recent.push(nowMs);
      writeLedgerUnlocked(file, {
        ...state,
        dispatches: recent,
      });
      return { allowed: true };
    });
  } catch {
    // Lock contention or unreadable ledger fails safely to passthrough.
    return { allowed: false, cause: 'hourly_budget_exceeded' };
  }
}

/** Clear quota breaker on any accepted dispatch. */
export function recordHookDispatchSuccess(key: string, root = notibuddyHome()): void {
  try {
    withLedgerLock(root, key, (file) => {
      const state = readLedgerUnlocked(file);
      if (state.quotaOpenUntil === undefined && !state.consecutiveQuotaErrors) return;
      writeLedgerUnlocked(file, { v: 1, dispatches: state.dispatches });
    });
  } catch {
    // Best-effort bookkeeping; never fail a hook.
  }
}

/** Trip stepped cooldown (15m -> 30m -> 60m) on relay 402 DAILY_LIMIT_EXCEEDED. */
export function recordHookQuotaExceeded(key: string, nowMs = Date.now(), root = notibuddyHome()): number {
  let openUntil = nowMs + QUOTA_COOLDOWNS_MS[0];
  try {
    withLedgerLock(root, key, (file) => {
      const state = readLedgerUnlocked(file);
      const nextCount = (state.consecutiveQuotaErrors ?? 0) + 1;
      const cooldown = QUOTA_COOLDOWNS_MS[Math.min(nextCount - 1, QUOTA_COOLDOWNS_MS.length - 1)];
      openUntil = nowMs + cooldown;
      // Refund the reserved slot since the relay refused before writing to usage_ledger.
      const dispatches = state.dispatches.length > 0 ? state.dispatches.slice(0, -1) : [];
      writeLedgerUnlocked(file, {
        v: 1,
        dispatches,
        quotaOpenUntil: openUntil,
        consecutiveQuotaErrors: nextCount,
      });
    });
  } catch {
    // Best-effort bookkeeping.
  }
  return openUntil;
}

/** Append strictly metadata-only hook outcome JSONL (never tool_input, commands, or prompts). */
export function appendHookEventLog(entry: HookEventLogEntry, root = notibuddyHome()): void {
  try {
    const dir = hooksDir(root);
    ensurePrivateDir(root);
    ensurePrivateDir(dir);
    const file = path.join(dir, 'events.jsonl');
    try {
      const stat = fs.statSync(file);
      if (stat.size >= MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // File does not exist yet.
    }
    const safeEntry: HookEventLogEntry = {
      ts: entry.ts,
      agent: entry.agent,
      event: entry.event,
      key: entry.key,
      verdict: entry.verdict,
      ...(entry.cause ? { cause: entry.cause } : {}),
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      durationMs: entry.durationMs,
    };
    fs.appendFileSync(file, JSON.stringify(safeEntry) + '\n', { mode: 0o600 });
  } catch {
    // Logging must never break or fail a hook.
  }
}
