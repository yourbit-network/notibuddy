// Bounded regular-file readers and atomic repaired-template writer for CLI screen commands.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPlainObject } from './screen-canon.js';
import type { ScreenSignedTemplateRecord } from './screen-catalog.js';
import type { ScreenFeedbackItem } from './screen-skeletonizer.js';
import type { ScreenSkeleton, ScreenTemplateId } from './screen-types.js';

export const MAX_SCREEN_FILE_BYTES = 160_000;

function readBoundedRegularJson(filename: string, maxBytes: number): unknown {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error();
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > maxBytes) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Reads a bounded UTF-8 JSON screen specification for `nb notify --screen <file>`. */
export function readScreenFile(filename: string): Record<string, unknown> {
  try {
    const parsed = readBoundedRegularJson(filename, MAX_SCREEN_FILE_BYTES);
    if (!isPlainObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('Screen file must be a readable UTF-8 JSON object within 160,000 bytes.');
  }
}

/** Reads a bounded UTF-8 JSON template or skeleton file for `nb screen register <file>`. */
export function readScreenTemplateFile(filename: string): Record<string, unknown> {
  try {
    const parsed = readBoundedRegularJson(filename, MAX_SCREEN_FILE_BYTES);
    if (!isPlainObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('Template file must be a readable UTF-8 JSON object within 160,000 bytes.');
  }
}

export interface RepairedTemplateFilePayload {
  templateId: ScreenTemplateId;
  repaired: true;
  skeleton: ScreenSkeleton;
  suggestedTemplate: Record<string, unknown>;
  changes: ScreenFeedbackItem[];
  record: ScreenSignedTemplateRecord;
}

/** Computes `<stem>.repaired.json` alongside `inputPath` without modifying `inputPath`. */
export function repairedTemplateOutputPath(inputPath: string): string {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.repaired.json`);
}

/** Atomically writes `<stem>.repaired.json` (mode 0600) without mutating the input file. */
export function writeRepairedTemplateFile(
  inputPath: string,
  payload: RepairedTemplateFilePayload
): string {
  const target = repairedTemplateOutputPath(inputPath);
  const dir = path.dirname(target);
  const resolvedTarget = path.resolve(target);
  const resolvedInput = path.resolve(inputPath);
  if (resolvedTarget === resolvedInput) {
    throw new Error('Refusing to overwrite input template file');
  }
  const realDir = fs.realpathSync(dir);
  const realTarget = path.join(realDir, path.basename(target));
  try {
    if (fs.realpathSync(inputPath) === realTarget) {
      throw new Error('Refusing to overwrite input template file via symlink');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to overwrite')) throw error;
  }

  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('Refusing to overwrite symlink or non-regular repaired template output');
  }

  const nofollow = fs.constants.O_NOFOLLOW ?? 0;
  const temporary = `${target}.${randomUUID()}.tmp`;
  const bytes = JSON.stringify(payload, null, 2) + '\n';
  try {
    const fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | nofollow,
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
    if (process.platform !== 'win32') {
      const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | nofollow);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
    return target;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
