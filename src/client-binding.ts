import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidClientId, isValidDestinationName, listDestinationNamesFast, notibuddyHome } from './home.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClientBinding {
  v: 1;
  client: string;
  destination: string;
  connectionId: string;
  updatedAt: number;
}

export type ClientResolution =
  | {
      ok: true;
      client: string;
      destination: string;
      connectionId: string;
      mode: 'bound' | 'single';
    }
  | {
      ok: false;
      client: string;
      code: 'unpaired' | 'ambiguous' | 'stale_binding' | 'corrupt_binding';
      message: string;
      destinations?: string[];
    };

export function assertClientId(value: string): string {
  if (!isValidClientId(value)) {
    throw new Error('Use a client ID of 1–48 lowercase letters, digits, hyphens or underscores, starting with a letter.');
  }
  return value;
}

function clientsDir(root: string): string {
  return path.join(root, 'clients');
}

function bindingPath(clientId: string, root: string): string {
  return path.join(clientsDir(root), `${assertClientId(clientId)}.json`);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

function writeAtomicPrivateJson(target: string, value: unknown): void {
  const dir = path.dirname(target);
  ensurePrivateDir(path.dirname(dir));
  ensurePrivateDir(dir);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
    if (process.platform !== 'win32') {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/** Cheaply reads a destination's immutable connectionId without importing zod or running crypto self-checks. */
export function readDestinationConnectionId(name: string, root = notibuddyHome()): string | undefined {
  if (!isValidDestinationName(name)) return undefined;
  const file = path.join(root, 'destinations', `${name}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; connectionId?: unknown };
    if (raw?.version !== 2 || typeof raw.connectionId !== 'string' || !UUID_PATTERN.test(raw.connectionId)) {
      return undefined;
    }
    return raw.connectionId;
  } catch {
    return undefined;
  }
}

function parseClientBinding(raw: unknown, expectedClient: string): ClientBinding | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return undefined;
  if (obj.client !== expectedClient) return undefined;
  if (typeof obj.destination !== 'string' || !isValidDestinationName(obj.destination)) return undefined;
  if (typeof obj.connectionId !== 'string' || !UUID_PATTERN.test(obj.connectionId)) return undefined;
  if (typeof obj.updatedAt !== 'number' || !Number.isSafeInteger(obj.updatedAt) || obj.updatedAt < 0) return undefined;
  return {
    v: 1,
    client: obj.client,
    destination: obj.destination,
    connectionId: obj.connectionId,
    updatedAt: obj.updatedAt,
  };
}

export function readClientBinding(clientId: string, root = notibuddyHome()): { exists: boolean; binding?: ClientBinding } {
  const file = bindingPath(clientId, root);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    return { exists: true, binding: undefined };
  }
  try {
    return { exists: true, binding: parseClientBinding(JSON.parse(text), clientId) };
  } catch {
    return { exists: true, binding: undefined };
  }
}

export function writeClientBinding(
  clientId: string,
  destination: string,
  connectionId: string,
  root = notibuddyHome(),
): ClientBinding {
  assertClientId(clientId);
  if (!isValidDestinationName(destination)) {
    throw new Error(`Invalid destination name '${destination}'.`);
  }
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error(`Destination '${destination}' has an invalid connectionId.`);
  }
  const binding: ClientBinding = {
    v: 1,
    client: clientId,
    destination,
    connectionId,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  writeAtomicPrivateJson(bindingPath(clientId, root), binding);
  return binding;
}

export function deleteClientBinding(clientId: string, root = notibuddyHome()): boolean {
  const file = bindingPath(clientId, root);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function listClientBindings(root = notibuddyHome()): ClientBinding[] {
  const dir = clientsDir(root);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const bindings: ClientBinding[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const clientId = entry.slice(0, -5);
    if (!isValidClientId(clientId)) continue;
    const parsed = readClientBinding(clientId, root);
    if (parsed.binding) bindings.push(parsed.binding);
  }
  return bindings;
}

/** Update any per-client bindings referencing `from` so `nb devices rename` keeps plugins bound to the same connectionId. */
export function updateBindingsOnRename(from: string, to: string, root = notibuddyHome()): string[] {
  const updated: string[] = [];
  for (const binding of listClientBindings(root)) {
    if (binding.destination === from) {
      writeClientBinding(binding.client, to, binding.connectionId, root);
      updated.push(binding.client);
    }
  }
  return updated;
}

export function findBindingsForDestination(destination: string, root = notibuddyHome()): ClientBinding[] {
  return listClientBindings(root).filter((b) => b.destination === destination);
}

/**
 * Resolve the single destination for a `--client <id>` host without ever guessing between two phones:
 * 1. Explicit `~/.notibuddy/clients/<id>.json` pinned by immutable `connectionId`.
 * 2. Otherwise, the sole paired destination (when count === 1).
 * 3. Otherwise, fail closed with an actionable refusal.
 */
export function resolveClientDestination(clientId: string, root = notibuddyHome()): ClientResolution {
  assertClientId(clientId);
  const stored = readClientBinding(clientId, root);
  if (stored.exists) {
    if (!stored.binding) {
      return {
        ok: false,
        client: clientId,
        code: 'corrupt_binding',
        message: `Client binding for '${clientId}' is unreadable. Re-bind explicitly with: nb bind --client ${clientId} --to <name>`,
      };
    }
    const liveConnectionId = readDestinationConnectionId(stored.binding.destination, root);
    if (!liveConnectionId || liveConnectionId !== stored.binding.connectionId) {
      return {
        ok: false,
        client: clientId,
        code: 'stale_binding',
        message: `Client '${clientId}' was bound to '${stored.binding.destination}', which was removed or re-paired with a different identity. Re-bind explicitly with: nb bind --client ${clientId} --to <name>`,
      };
    }
    return {
      ok: true,
      client: clientId,
      destination: stored.binding.destination,
      connectionId: liveConnectionId,
      mode: 'bound',
    };
  }

  const names = listDestinationNamesFast(root);
  if (names.length === 0) {
    return {
      ok: false,
      client: clientId,
      code: 'unpaired',
      message: `No NotiBuddy phone is paired yet. Open NotiBuddy on iPhone → Connect → Add → Share Setup, then run in your terminal: pbpaste | nb pair --to personal`,
      destinations: [],
    };
  }
  if (names.length === 1) {
    const dest = names[0];
    const connectionId = readDestinationConnectionId(dest, root);
    if (!connectionId) {
      return {
        ok: false,
        client: clientId,
        code: 'corrupt_binding',
        message: `Destination '${dest}' is unreadable. Preserve its file and restore it; keys will not be regenerated automatically.`,
      };
    }
    return {
      ok: true,
      client: clientId,
      destination: dest,
      connectionId,
      mode: 'single',
    };
  }
  return {
    ok: false,
    client: clientId,
    code: 'ambiguous',
    message: `Multiple destinations are paired (${names.join(', ')}). Bind '${clientId}' explicitly with: nb bind --client ${clientId} --to ${names[0]}`,
    destinations: names,
  };
}
