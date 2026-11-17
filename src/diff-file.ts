import fs from 'node:fs';
import { parseDiff } from './diff.js';
import type { DiffInput } from './types.js';

export const MAX_DIFF_FILE_BYTES = 150_000;

function readBoundedJson(filename: string, maxBytes: number): unknown {
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

/** Read a single regular JSON file without loading an unbounded or growing file. */
export function readDiffFile(filename: string): DiffInput {
  try {
    return parseDiff(readBoundedJson(filename, MAX_DIFF_FILE_BYTES));
  } catch {
    throw new Error('Diff file must be readable UTF-8 JSON within 150,000 bytes, containing a valid filename, optional language and original/modified text.');
  }
}

/** Read a bounded UTF-8 JSON array of form fields for `nb notify --fields`. */
export function readFieldsFile(filename: string): unknown[] {
  try {
    const parsed = readBoundedJson(filename, MAX_DIFF_FILE_BYTES);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50) throw new Error();
    return parsed;
  } catch {
    throw new Error('Fields file must be readable UTF-8 JSON within 150,000 bytes containing a non-empty array of 1–50 form field objects.');
  }
}
