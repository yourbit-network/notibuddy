import { assertClientId, resolveClientDestination } from './client-binding.js';
import { NotiBuddyClient } from './client.js';
import { DestinationStore, destinationName, senderLabel, type DestinationRecord } from './config.js';
import { FileInbox } from './files.js';
import { defaultClientSenderLabel } from './home.js';
import { PendingStore } from './pending-store.js';

export interface RoutingOptions {
  to?: string;
  allowTo?: string[];
  client?: string;
  sender?: string;
}

export interface ResolvedDestinationEntry {
  name: string;
  record: DestinationRecord;
  files: FileInbox;
  client: NotiBuddyClient;
}

export function parseRoutingArgs(args: string[]): { options: RoutingOptions; rest: string[] } {
  const options: RoutingOptions = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    if (!['--to', '--allow-to', '--client', '--sender'].includes(flag)) {
      rest.push(args[i]);
      continue;
    }
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--allow-to') {
      (options.allowTo ??= []).push(destinationName(value));
    } else if (flag === '--to') {
      if (options.to) throw new Error('Specify --to only once');
      options.to = destinationName(value);
    } else if (flag === '--client') {
      if (options.client) throw new Error('Specify --client only once');
      options.client = assertClientId(value);
    } else {
      if (options.sender) throw new Error('Specify --sender only once');
      options.sender = senderLabel(value);
    }
  }
  const modes = Number(Boolean(options.to)) + Number(Boolean(options.allowTo)) + Number(Boolean(options.client));
  if (modes > 1) {
    throw new Error('Choose one of --to <name>, --allow-to <name>, or --client <id>, not both');
  }
  return { options, rest };
}

/** Snapshot only explicitly exposed connections; later config edits cannot redirect this process. */
export async function createDestinationRouter(
  options: RoutingOptions,
  store = new DestinationStore(),
  keepStreamAlive = false,
) {
  if (options.client) {
    throw new Error('createDestinationRouter expects --to or --allow-to; use createClientMcpRouter for --client');
  }
  const names = options.to ? [destinationName(options.to)] : options.allowTo?.map(destinationName);
  if (options.to && options.allowTo) throw new Error('Choose --to or --allow-to, not both');
  if (!names?.length) {
    throw new Error(
      'Select a destination explicitly: --to <name>, --client <id>, or repeat --allow-to <name> for MCP. Run nb devices list.',
    );
  }
  if (new Set(names).size !== names.length) throw new Error('Destination allowlist contains duplicates');
  const label = senderLabel(options.sender);
  const entries = await Promise.all(
    names.map(async (name): Promise<ResolvedDestinationEntry> => {
      const { record, signingKey } = await store.open(name);
      return {
        name,
        record,
        files: new FileInbox(record, signingKey, store.root, { store, name }),
        client: new NotiBuddyClient(
          record.config,
          signingKey,
          new PendingStore(record.config, store.root),
          label,
          { store, name },
          { keepAlive: keepStreamAlive },
          undefined,
          keepStreamAlive ? undefined : { activityUpdateDebounceMs: 0 },
        ),
      };
    }),
  );
  return {
    selectable: !options.to,
    names,
    close: () => {
      for (const entry of entries) entry.client.close();
    },
    list: () =>
      entries.map(({ name, record }) => ({
        to: name,
        deviceName: record.config.device.name || 'iPhone',
        deviceId: record.config.device.id,
        connectionId: record.connectionId,
        connectionLabel: record.config.senderLabel,
        sender: label,
        status: 'saved_pairing',
        acceptsNewMessages: false,
        acceptsFiles: !!record.fileKey,
      })),
    resolve(to?: string) {
      if (options.to && to && to !== options.to) throw new Error(`This server is pinned to '${options.to}'`);
      const selected = to ?? options.to;
      if (!selected) throw new Error(`Select 'to' explicitly: ${names.join(', ')}`);
      const entry = entries.find((e) => e.name === selected);
      if (!entry) throw new Error('Destination is not exposed by this server');
      return entry;
    },
  };
}

/**
 * Per-client dynamic-until-first-use MCP router (`nb mcp --client <id>`).
 * - Starts cleanly with 0 or 2+ destinations without network or key loads.
 * - Resolves explicitly via `~/.notibuddy/clients/<id>.json` (pinned by `connectionId`),
 *   or sole paired destination if exactly 1 exists.
 * - Once bound in-memory to a `connectionId` on first call, never retargets to a different
 *   `connectionId` mid-session; every subsequent call verifies live resolution still matches.
 */
export function createClientMcpRouter(
  clientId: string,
  senderOverride?: string,
  store = new DestinationStore(),
  keepStreamAlive = true,
) {
  const safeClient = assertClientId(clientId);
  const label = senderLabel(senderOverride ?? defaultClientSenderLabel(safeClient));
  let pinnedConnectionId: string | undefined;
  let cached: ResolvedDestinationEntry | undefined;

  const closeCached = () => {
    if (cached) {
      cached.client.close();
      cached = undefined;
    }
  };

  return {
    clientId: safeClient,
    selectable: false as const,
    close: () => {
      closeCached();
    },
    list() {
      const resolved = resolveClientDestination(safeClient, store.root);
      if (!resolved.ok) {
        return {
          client: safeClient,
          status: resolved.code,
          message: resolved.message,
          destinations: [] as unknown[],
        };
      }
      if (pinnedConnectionId !== undefined && resolved.connectionId !== pinnedConnectionId) {
        return {
          client: safeClient,
          status: 'binding_changed',
          message: `Client '${safeClient}' binding changed mid-session; restart this MCP server to use '${resolved.destination}'.`,
          destinations: [] as unknown[],
        };
      }
      const record = store.read(resolved.destination);
      if (record.connectionId !== resolved.connectionId) {
        return {
          client: safeClient,
          status: 'stale_binding',
          message: `Destination '${resolved.destination}' changed identity; re-bind with: nb bind --client ${safeClient} --to ${resolved.destination}`,
          destinations: [] as unknown[],
        };
      }
      return [
        {
          to: resolved.destination,
          client: safeClient,
          bindingMode: resolved.mode,
          deviceName: record.config.device.name || 'iPhone',
          deviceId: record.config.device.id,
          connectionId: record.connectionId,
          connectionLabel: record.config.senderLabel,
          sender: label,
          status: 'saved_pairing',
          acceptsNewMessages: false,
          acceptsFiles: !!record.fileKey,
        },
      ];
    },
    async resolve(to?: string): Promise<ResolvedDestinationEntry> {
      if (to !== undefined) {
        throw new Error(`This server uses client binding '--client ${safeClient}' and does not accept a per-call 'to' parameter.`);
      }
      const resolved = resolveClientDestination(safeClient, store.root);
      if (!resolved.ok) {
        throw new Error(resolved.message);
      }
      if (pinnedConnectionId !== undefined && resolved.connectionId !== pinnedConnectionId) {
        throw new Error(
          `Client '${safeClient}' binding changed mid-session; restart this MCP server to send to '${resolved.destination}'.`,
        );
      }
      if (cached && cached.record.connectionId === resolved.connectionId && cached.name === resolved.destination) {
        return cached;
      }
      // Open and verify cryptographic key integrity; re-verify connectionId matches resolved binding.
      const { record, signingKey } = await store.open(resolved.destination);
      if (record.connectionId !== resolved.connectionId) {
        throw new Error(
          `Destination '${resolved.destination}' changed identity while opening. Re-bind explicitly with: nb bind --client ${safeClient} --to ${resolved.destination}`,
        );
      }
      if (pinnedConnectionId !== undefined && record.connectionId !== pinnedConnectionId) {
        throw new Error(`Client '${safeClient}' binding changed mid-session; restart this MCP server.`);
      }
      closeCached();
      pinnedConnectionId = record.connectionId;
      cached = {
        name: resolved.destination,
        record,
        files: new FileInbox(record, signingKey, store.root, { store, name: resolved.destination }),
        client: new NotiBuddyClient(
          record.config,
          signingKey,
          new PendingStore(record.config, store.root),
          label,
          { store, name: resolved.destination },
          { keepAlive: keepStreamAlive },
        ),
      };
      return cached;
    },
  };
}
