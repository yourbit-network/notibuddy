// Persistent signed screen template record cache and inline skeletonizer memo (mode 0600).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireFileLock } from './file-lock.js';
import { normalizeRelay } from './relay-url.js';
import { isPlainObject, isSafeInt53 } from './screen-canon.js';
import type { ScreenSignedTemplateRecord, ScreenTaPublicKey } from './screen-catalog.js';
import { verifySignedTemplateRecord } from './screen-record.js';
import type { ScreenFeedbackItem } from './screen-skeletonizer.js';
import { isHex64, isValidTemplateId, type ScreenSkeleton, type ScreenTemplateId } from './screen-types.js';
import { validateScreenSkeleton } from './screen-wire.js';

/** Non-catalog templates are refreshed via PUT /v2/templates/:id when absent or >= 15 days old. */
export const SCREEN_REFRESH_AFTER_MS = 15 * 24 * 60 * 60 * 1000;

const MAX_CACHE_FILE_BYTES = 262_144;

export interface CachedScreenTemplateEntry {
  templateId: ScreenTemplateId;
  record: ScreenSignedTemplateRecord;
  lastRefreshedAt?: number;
}

export interface ScreenInlineMemoEntry {
  relayOrigin: string;
  skeletonizerVersion: number;
  inputSkeletonHash: string;
  templateId: ScreenTemplateId;
  repaired: boolean;
  changes?: ScreenFeedbackItem[];
  repairedSkeleton?: ScreenSkeleton;
}

export function relayOriginOf(relayUrl: string): string {
  return new URL(normalizeRelay(relayUrl)).origin;
}

export function needsTemplateRefresh(lastRefreshedAt: number | undefined, nowMs: number): boolean {
  if (lastRefreshedAt === undefined || !isSafeInt53(lastRefreshedAt) || lastRefreshedAt <= 0) {
    return true;
  }
  return nowMs - lastRefreshedAt >= SCREEN_REFRESH_AFTER_MS;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function relativeSegmentsUnderRoot(root: string, dir: string): string[] {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Screen cache path escapes storage root');
  }
  return rel.split(path.sep).filter(Boolean);
}

function hasSafeNonSymlinkParentDirs(root: string, dir: string): boolean {
  let segments: string[];
  try {
    segments = relativeSegmentsUnderRoot(root, dir);
  } catch {
    return false;
  }
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      return false;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return false;
    }
  }
  return true;
}

function ensurePrivateDir(root: string, dir: string): void {
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  const segments = relativeSegmentsUnderRoot(resolvedRoot, dir);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error('Refusing to traverse symlink or non-directory in screen cache');
      }
      if (process.platform !== 'win32') {
        fs.chmodSync(current, 0o700);
      }
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
      if (process.platform !== 'win32') {
        fs.chmodSync(current, 0o700);
      }
    }
  }
}

function syncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWritePrivateJson(root: string, target: string, payload: unknown): void {
  const dir = path.dirname(target);
  ensurePrivateDir(root, dir);
  const bytes = JSON.stringify(payload);
  if (Buffer.byteLength(bytes) > MAX_CACHE_FILE_BYTES) {
    throw new Error('Screen cache entry exceeds storage limit');
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  const unlock = acquireFileLock(`${target}.lock`);
  try {
    if (!hasSafeNonSymlinkParentDirs(root, dir)) {
      throw new Error('Refusing to traverse symlink or non-directory in screen cache');
    }
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error('Refusing to overwrite symlink or non-regular file in screen cache');
    }
    const fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
      0o600
    );
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    syncDir(dir);
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } finally {
      unlock();
    }
  }
}

function readPrivateJson(root: string, target: string): unknown | undefined {
  const dir = path.dirname(target);
  if (!hasSafeNonSymlinkParentDirs(root, dir)) return undefined;
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(target);
  } catch {
    return undefined;
  }
  if (!lstat.isFile() || lstat.isSymbolicLink()) return undefined;
  const unlock = acquireFileLock(`${target}.lock`);
  try {
    if (!hasSafeNonSymlinkParentDirs(root, dir)) return undefined;
    let fd: number;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
    } catch {
      return undefined;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_CACHE_FILE_BYTES) return undefined;
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
      return undefined;
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    unlock();
  }
}

function parseFeedbackList(raw: unknown): ScreenFeedbackItem[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: ScreenFeedbackItem[] = [];
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.code !== 'string' || typeof item.message !== 'string') {
      return undefined;
    }
    const entry: ScreenFeedbackItem = { code: item.code, message: item.message };
    if (item.at !== undefined) {
      if (typeof item.at !== 'string') return undefined;
      entry.at = item.at;
    }
    if (item.ordinal !== undefined) {
      if (typeof item.ordinal !== 'string') return undefined;
      entry.ordinal = item.ordinal;
    }
    out.push(entry);
  }
  return out;
}

export class ScreenTemplateStore {
  private readonly recordsBase: string;
  private readonly memoDir: string;

  constructor(
    readonly root = process.env.NOTIBUDDY_HOME || path.join(os.homedir(), '.notibuddy'),
    private readonly resolveTaPublicKey?: (kid: string) => ScreenTaPublicKey | undefined
  ) {
    const base = path.join(root, 'screens');
    this.recordsBase = path.join(base, 'records');
    this.memoDir = path.join(base, 'memo');
  }

  recordPath(relayOrigin: string, templateId: ScreenTemplateId): string {
    if (!isValidTemplateId(templateId)) {
      throw new Error('Invalid screen templateId');
    }
    const scope = sha256Hex(relayOrigin);
    return path.join(this.recordsBase, scope, `${templateId}.json`);
  }

  memoPath(relayOrigin: string, skeletonizerVersion: number, inputSkeletonHash: string): string {
    if (!isSafeInt53(skeletonizerVersion) || skeletonizerVersion < 1 || !isHex64(inputSkeletonHash)) {
      throw new Error('Invalid inline memo key');
    }
    const key = sha256Hex(JSON.stringify([relayOrigin, skeletonizerVersion, inputSkeletonHash]));
    return path.join(this.memoDir, `${key}.json`);
  }

  async readRecord(
    relayOrigin: string,
    templateId: ScreenTemplateId
  ): Promise<CachedScreenTemplateEntry | undefined> {
    if (!isValidTemplateId(templateId)) return undefined;
    const raw = readPrivateJson(this.root, this.recordPath(relayOrigin, templateId));
    if (!isPlainObject(raw) || raw.templateId !== templateId) return undefined;
    if (raw.lastRefreshedAt !== undefined && (!isSafeInt53(raw.lastRefreshedAt) || raw.lastRefreshedAt <= 0)) {
      return undefined;
    }
    try {
      const record = await verifySignedTemplateRecord(raw.record, {
        expectedTemplateId: templateId,
        expectedPurpose: 'attestation',
        resolveTaPublicKey: this.resolveTaPublicKey,
      });
      return raw.lastRefreshedAt !== undefined
        ? { templateId, record, lastRefreshedAt: raw.lastRefreshedAt }
        : { templateId, record };
    } catch {
      return undefined;
    }
  }

  async writeRecord(
    relayOrigin: string,
    entry: CachedScreenTemplateEntry
  ): Promise<void> {
    const verified = await verifySignedTemplateRecord(entry.record, {
      expectedTemplateId: entry.templateId,
      expectedPurpose: 'attestation',
      resolveTaPublicKey: this.resolveTaPublicKey,
    });
    const toPersist: CachedScreenTemplateEntry =
      entry.lastRefreshedAt !== undefined
        ? { templateId: verified.templateId, record: verified, lastRefreshedAt: entry.lastRefreshedAt }
        : { templateId: verified.templateId, record: verified };
    atomicWritePrivateJson(this.root, this.recordPath(relayOrigin, verified.templateId), toPersist);
  }

  readInlineMemo(
    relayOrigin: string,
    skeletonizerVersion: number,
    inputSkeletonHash: string
  ): ScreenInlineMemoEntry | undefined {
    if (!isSafeInt53(skeletonizerVersion) || skeletonizerVersion < 1 || !isHex64(inputSkeletonHash)) {
      return undefined;
    }
    const raw = readPrivateJson(
      this.root,
      this.memoPath(relayOrigin, skeletonizerVersion, inputSkeletonHash)
    );
    if (
      !isPlainObject(raw) ||
      raw.relayOrigin !== relayOrigin ||
      raw.skeletonizerVersion !== skeletonizerVersion ||
      raw.inputSkeletonHash !== inputSkeletonHash ||
      !isValidTemplateId(raw.templateId) ||
      typeof raw.repaired !== 'boolean'
    ) {
      return undefined;
    }
    const changes = parseFeedbackList(raw.changes);
    if (raw.changes !== undefined && changes === undefined) return undefined;
    let repairedSkeleton: ScreenSkeleton | undefined;
    if (raw.repairedSkeleton !== undefined) {
      try {
        repairedSkeleton = validateScreenSkeleton(raw.repairedSkeleton);
      } catch {
        return undefined;
      }
    }
    return {
      relayOrigin,
      skeletonizerVersion,
      inputSkeletonHash,
      templateId: raw.templateId,
      repaired: raw.repaired,
      ...(changes !== undefined ? { changes } : {}),
      ...(repairedSkeleton !== undefined ? { repairedSkeleton } : {}),
    };
  }

  writeInlineMemo(entry: ScreenInlineMemoEntry): void {
    const target = this.memoPath(entry.relayOrigin, entry.skeletonizerVersion, entry.inputSkeletonHash);
    atomicWritePrivateJson(this.root, target, entry);
  }
}
