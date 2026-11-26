// Canonical JSON serialization for certified screen skeletons and render digests.
// Rules: UTF-8, no whitespace, UTF-8 bytewise key sorting, RFC 8785 string escaping,
// plain decimal safe integers (int53), booleans, arrays, and objects.

import type { ScreenFormMap } from './screen-types.js';

export type ScreenCanonValue =
  | string
  | boolean
  | number
  | readonly ScreenCanonValue[]
  | { readonly [key: string]: ScreenCanonValue };

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/u;
const utf8Encoder = new TextEncoder();

export function isValidUnicodeString(value: string): boolean {
  return !LONE_SURROGATE_RE.test(value);
}

export function hasControlOrFormatScalar(value: string): boolean {
  return CONTROL_OR_FORMAT_RE.test(value);
}

/**
 * Returns a human-readable description of the first disallowed control or format scalar
 * (e.g. `newline (\n, U+000A)`), or `undefined` if none is present.
 */
export function describeDisallowedControlOrFormatScalar(value: string): string | undefined {
  for (const ch of value) {
    if (CONTROL_OR_FORMAT_RE.test(ch)) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x0a) return 'newline (\\n, U+000A)';
      if (cp === 0x0d) return 'carriage return (\\r, U+000D)';
      if (cp === 0x09) return 'tab (\\t, U+0009)';
      return `control/format character U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return undefined;
}

export function isSafeInt53(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

/**
 * RFC 8785 §3.2.2.2 string escaping for canonical JSON.
 * Escapes quotation mark, reverse solidus, and control characters U+0000..U+001F
 * (using \b, \t, \n, \f, \r where defined and lowercase \u00xx otherwise).
 */
export function escapeCanonString(value: string): string {
  if (!isValidUnicodeString(value)) {
    throw new Error('Canonical JSON string must be valid Unicode without lone surrogates');
  }
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x08:
        out += '\\b';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0c:
        out += '\\f';
        break;
      case 0x0d:
        out += '\\r';
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      default:
        if (code < 0x20) {
          out += '\\u00' + code.toString(16).padStart(2, '0');
        } else {
          out += value[i];
        }
        break;
    }
  }
  return out + '"';
}

/**
 * Compares two valid Unicode strings by UTF-8 byte order (identical to Unicode scalar value order).
 * Returns -1 if a < b, 0 if a === b, or 1 if a > b.
 */
export function compareUtf8Bytes(a: string, b: string): -1 | 0 | 1 {
  if (!isValidUnicodeString(a) || !isValidUnicodeString(b)) {
    throw new Error('Canonical JSON keys must be valid Unicode without lone surrogates');
  }
  const ab = utf8Encoder.encode(a);
  const bb = utf8Encoder.encode(b);
  const len = Math.min(ab.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    if (ab[i] < bb[i]) return -1;
    if (ab[i] > bb[i]) return 1;
  }
  if (ab.length < bb.length) return -1;
  if (ab.length > bb.length) return 1;
  return 0;
}

export function sortKeysBytewise(keys: readonly string[]): string[] {
  return [...keys].sort(compareUtf8Bytes);
}

/**
 * Serializes a value in the screen value domain (`string | boolean | int53 | array | object`)
 * to canonical UTF-8 JSON with no whitespace and UTF-8 bytewise sorted object keys.
 */
export function canonJson(value: ScreenCanonValue): string {
  if (typeof value === 'string') {
    return escapeCanonString(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!isSafeInt53(value)) {
      throw new Error('Canonical JSON numbers must be safe integers (int53)');
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ',';
      out += canonJson(value[i]);
    }
    return out + ']';
  }
  if (isPlainObject(value)) {
    const record = value as Record<string, ScreenCanonValue>;
    const keys = sortKeysBytewise(Object.keys(record));
    let out = '{';
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const entry = record[key];
      if (entry === undefined) {
        throw new Error(`Canonical JSON object key "${key}" cannot be undefined`);
      }
      if (i > 0) out += ',';
      out += escapeCanonString(key) + ':' + canonJson(entry);
    }
    return out + '}';
  }
  throw new Error('Unsupported value in canonical JSON (null/undefined/non-int53 forbidden)');
}

/**
 * Canonical serialization of `{ action, form }` used as the input suffix to `renderDigest`.
 */
export function canonRenderInput(action: string, form: ScreenFormMap): string {
  return canonJson({ action, form });
}
