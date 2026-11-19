import type { DestinationStore } from './config.js';
import type { RoutingOptions } from './routing.js';
import type { PresentationHints } from './types.js';

export async function withShutdown<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort(new DOMException('Interrupted', 'AbortError'));
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort(new DOMException('Terminated', 'AbortError'));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    return await operation(controller.signal);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

export function quoteShell(arg: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function argumentsFor(
  args: string[],
  values: string[],
  booleans: string[] = [],
  repeatable: string[] = [],
) {
  const options: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  const aliases: Record<string, string> = {
    '-m': '--message',
    '-o': '--options',
    '-p': '--placeholder',
    '-w': '--wait',
    '-t': '--title',
    '-s': '--status',
    '-l': '--label',
  };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-') || args[i] === '-') {
      positional.push(args[i]);
      continue;
    }
    const [raw, inline] = args[i].split(/=(.*)/s, 2);
    const flag = aliases[raw] ?? raw;
    if (booleans.includes(flag)) {
      if (flag in options) throw new Error(`Duplicate option ${flag}`);
      if (inline !== undefined) throw new Error(`${flag} does not take a value`);
      options[flag] = true;
      continue;
    }
    if (repeatable.includes(flag)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      const existing = options[flag];
      if (Array.isArray(existing)) existing.push(value);
      else options[flag] = [value];
      continue;
    }
    if (flag in options) throw new Error(`Duplicate option ${flag}`);
    if (!values.includes(flag)) throw new Error(`Unknown option ${flag}`);
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    options[flag] = value;
  }
  return {
    positional,
    text: (flag: string) => options[flag] as string | undefined,
    list: (flag: string) => (options[flag] as string[] | undefined) ?? [],
    number: (flag: string) => {
      const raw = options[flag];
      if (raw === undefined) return undefined;
      const parsed = Number(raw);
      if (raw === '' || !Number.isFinite(parsed)) throw new Error(`${flag} must be a valid number`);
      return parsed;
    },
    flag: (flag: string) => options[flag] === true,
  };
}

export function resolveCliDestination(routing: RoutingOptions, store: DestinationStore): string {
  if (routing.to) return routing.to;
  const saved = store.list();
  if (saved.length === 1) {
    return saved[0].name;
  }
  if (saved.length === 0) {
    throw new Error('No destinations paired. Run: nb pair --to <name>');
  }
  throw new Error(
    `Choose a destination with --to <name>. Saved destinations: ${saved.map((d) => d.name).join(', ')}.`,
  );
}

export function presentationFrom(shortTitle?: string, summary?: string): PresentationHints | undefined {
  if (shortTitle === undefined && summary === undefined) return undefined;
  return {
    ...(shortTitle !== undefined ? { shortTitle } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}
