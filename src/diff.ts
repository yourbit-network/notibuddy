import { z } from 'zod';
import type { DiffInput } from './types.js';

export const MAX_DIFF_TEXT_BYTES = 96_000;
export const MAX_DIFF_LINES = 20_000;
const unicode = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
const label = (limit: number) => z.string().max(limit).refine(value =>
  Buffer.byteLength(value, 'utf8') <= limit && unicode(value) && !/[\p{Cc}\p{Cf}]/u.test(value));
const text = z.string().max(MAX_DIFF_TEXT_BYTES).refine(unicode);
const schema = z.object({
  filename: label(512).refine(value => value.trim().length > 0),
  language: label(40).optional(),
  original: text,
  modified: text,
}).strict().refine(value => Buffer.byteLength(value.original, 'utf8') + Buffer.byteLength(value.modified, 'utf8') <= MAX_DIFF_TEXT_BYTES)
  .refine(value => value.original.split('\n').length + value.modified.split('\n').length <= MAX_DIFF_LINES);

/** Keep validation errors free of source text, filenames and unrecognized keys. */
export function parseDiff(input: unknown): DiffInput {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('Invalid diff: provide filename, optional language, and original/modified Unicode text totaling at most 96,000 UTF-8 bytes and 20,000 lines.');
  return result.data;
}
