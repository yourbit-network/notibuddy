import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NOTIBUDDY_DIR } from './config.js';
import { CLIENT_VERSION, latestRelease, newer, type ReleaseLookup } from './update-check.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = 'update-check.json';

export type ReleaseLookupFn = (options: { signal?: AbortSignal; deadline?: number }) => Promise<ReleaseLookup>;

/** The one-line notice shown on stderr (CLI) or as an extra tool-result item (MCP). */
export function updateNotice(current: string, latest: string): string {
  return `NotiBuddy ${latest} is available (this is ${current}). Update with: npm install -g notibuddy@${latest} — or, if you run it through npx or an MCP configuration, change notibuddy@${current} to notibuddy@${latest}.`;
}

const optedOut = (): boolean => process.env.NOTIBUDDY_NO_UPDATE_CHECK === '1';

interface Cache { v: 1; checkedAt: number | null; latest: string | null; notifiedAt: number | null }
const emptyCache = (): Cache => ({ v: 1, checkedAt: null, latest: null, notifiedAt: null });

/** Once-a-day update notice for CLI commands, remembered in `<home>/update-check.json`. */
export class UpdateNotifier {
  constructor(
    private readonly home: string = NOTIBUDDY_DIR,
    private readonly now: () => number = Date.now,
    private readonly lookup: ReleaseLookupFn = latestRelease,
  ) {}

  private get file(): string { return path.join(this.home, CACHE_FILE); }

  private read(): Cache {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      const latest = typeof raw?.latest === 'string' && /^\d+\.\d+\.\d+$/.test(raw.latest) ? raw.latest : null;
      if (raw?.v !== 1) return emptyCache();
      return { v: 1, checkedAt: time(raw.checkedAt), latest, notifiedAt: time(raw.notifiedAt) };
    } catch {
      return emptyCache();
    }
  }

  private write(cache: Cache): void {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.home, `${CACHE_FILE}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(cache) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
    }
  }

  /** The notice to print, or undefined. Never throws; `deadline` bounds the registry lookup and
   * `signal` cancels it (a cancelled lookup records nothing, so the notice is not lost). */
  async cliNotice(deadline: number, signal?: AbortSignal): Promise<string | undefined> {
    if (optedOut()) return undefined;
    try {
      const cache = this.read(), now = this.now();
      const within = (at: number | null): boolean => at !== null && now - at >= 0 && now - at < DAY_MS;
      if (within(cache.notifiedAt)) return undefined;
      if (!within(cache.checkedAt)) {
        const result = await this.lookup({ deadline, ...(signal ? { signal } : {}) });
        if (!result.ok || signal?.aborted) return undefined;
        cache.checkedAt = now;
        cache.latest = result.latest;
        this.write(cache);
      }
      if (cache.latest === null || !newer(cache.latest, CLIENT_VERSION)) return undefined;
      cache.notifiedAt = now;
      this.write(cache);
      return updateNotice(CLIENT_VERSION, cache.latest);
    } catch {
      return undefined;
    }
  }
}

/** One lookup per MCP session, no cache or files; the notice is handed out at most once. */
export class SessionUpdateNotice {
  private latest: string | undefined;
  private delivered = false;
  private readonly current: string;
  constructor(lookup: ReleaseLookupFn = latestRelease, current: string = CLIENT_VERSION) {
    this.current = current;
    if (optedOut()) { this.delivered = true; return; }
    void Promise.resolve().then(() => lookup({ deadline: Date.now() + 2000 })).then(result => {
      if (result.ok && newer(result.latest, current)) this.latest = result.latest;
    }, () => {});
  }
  /** The notice text the first time it is called after a newer release was found; undefined otherwise. */
  take(): string | undefined {
    if (this.delivered || this.latest === undefined) return undefined;
    this.delivered = true;
    return updateNotice(this.current, this.latest);
  }
}
