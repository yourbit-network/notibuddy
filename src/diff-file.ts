import fs from 'node:fs';
import { parseDiff } from './diff.js';
import type { DiffInput } from './types.js';

export const MAX_DIFF_FILE_BYTES = 150_000;

/** Read a single regular JSON file without loading an unbounded or growing file. */
export function readDiffFile(filename: string): DiffInput {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_DIFF_FILE_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_DIFF_FILE_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > MAX_DIFF_FILE_BYTES) throw new Error();
    return parseDiff(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))));
  } catch {
    throw new Error('Diff file must be readable UTF-8 JSON within 150,000 bytes, containing a valid filename, optional language and original/modified text.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
