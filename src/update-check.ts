import { readFileSync } from 'node:fs';

const REGISTRY_URL = 'https://registry.npmjs.org/notibuddy/latest';
const MAX_BYTES = 65536;
const SEMVER = /^\d+\.\d+\.\d+$/;
/** The package's own version, read the same way the MCP server reads it. */
export const CLIENT_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** True when `candidate` is strictly newer than `running`. */
export function newer(candidate: string, running: string): boolean {
  const a = candidate.split('.').map(Number), b = running.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > (b[i] ?? 0);
  return false;
}

export type ReleaseLookup = { ok: true; latest: string } | { ok: false };

/** Best-effort lookup of a newer published release. Resolves to its version, or undefined; never throws. */
export async function latestNewerVersion(options: { signal?: AbortSignal; deadline?: number } = {}): Promise<string | undefined> {
  const result = await latestRelease(options);
  return result.ok && newer(result.latest, CLIENT_VERSION) ? result.latest : undefined;
}

/** The latest published version, or ok:false when offline, timed out, opted out or unreadable; never throws. */
export async function latestRelease(options: { signal?: AbortSignal; deadline?: number } = {}): Promise<ReleaseLookup> {
  const none: ReleaseLookup = { ok: false };
  if (process.env.NOTIBUDDY_NO_UPDATE_CHECK === '1') return none;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const remaining = Math.min(2000, (options.deadline ?? Infinity) - Date.now());
    if (!(remaining > 0) || options.signal?.aborted) return none;
    const timeout = new AbortController();
    timer = setTimeout(() => timeout.abort(new Error('Update check timed out')), remaining);
    const signal = AbortSignal.any([timeout.signal, ...(options.signal ? [options.signal] : [])]);
    const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    void aborted.catch(() => {});
    const response = await Promise.race([fetch(REGISTRY_URL, { headers: { Accept: 'application/json' }, redirect: 'error', signal }), aborted]);
    if (response.status !== 200) return none;
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return none;
    reader = response.body?.getReader();
    if (!reader) return none;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) return none;
      chunks.push(value);
    }
    const version = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))?.version;
    return typeof version === 'string' && SEMVER.test(version) ? { ok: true, latest: version } : none;
  } catch {
    return none;
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}
