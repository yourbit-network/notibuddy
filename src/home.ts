import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;

const CLIENT_SENDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  codex: 'Codex',
  mcp: 'MCP client',
};

/** Resolve NotiBuddy's local store root dynamically so tests and subprocesses can override NOTIBUDDY_HOME. */
export function notibuddyHome(): string {
  return process.env.NOTIBUDDY_HOME || path.join(os.homedir(), '.notibuddy');
}

export function isValidDestinationName(value: string): boolean {
  return ALIAS_PATTERN.test(value);
}

export function isValidClientId(value: string): boolean {
  return ALIAS_PATTERN.test(value);
}

export function defaultClientSenderLabel(clientId: string): string {
  return CLIENT_SENDER_LABELS[clientId] ?? clientId;
}

/** Fast directory-only destination discovery without parsing JSON records or loading crypto/zod. */
export function listDestinationNamesFast(root = notibuddyHome()): string[] {
  const dir = path.join(root, 'destinations');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const stem = entry.slice(0, -5);
    if (isValidDestinationName(stem)) names.push(stem);
  }
  return names.sort();
}
