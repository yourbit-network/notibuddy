import { readFileSync } from 'node:fs';
import {
  assertClientId,
  deleteClientBinding,
  findBindingsForDestination,
  listClientBindings,
  writeClientBinding,
} from './client-binding.js';
import { argumentsFor, presentationFrom, quoteShell, resolveCliDestination, withShutdown } from './cli-support.js';
import { DestinationStore, destinationName, senderLabel } from './config.js';
import { computePairingMac } from './crypto.js';
import { readDiffFile, readFieldsFile } from './diff-file.js';
import { readScreenFile, readScreenTemplateFile, writeRepairedTemplateFile } from './screen-file.js';
import type { ScreenAskInput } from './screen-client.js';
import { resolveFileDestination } from './file-routing.js';
import { printGateHelp, runGateCommand } from './gate.js';
import { printHookHelp } from './hook.js';
import { pairSender } from './pairing.js';
import { parsePairingBundle } from './protocol.js';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS, MAX_REPLY_WAIT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS } from './request-timeout.js';
import { createDestinationRouter, parseRoutingArgs, type RoutingOptions } from './routing.js';
import { readSetupCode } from './setup-code.js';
import { UpdateNotifier } from './update-notice.js';
import { formatValidationError } from './validation-error.js';

const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const KNOWN_COMMANDS = new Set([
  'mcp',
  'devices',
  'status',
  'files',
  'unpair',
  'pair',
  'doctor',
  'notify',
  'screen',
  'activity',
  'gate',
  'hook',
  'bind',
  'unbind',
]);

function printHelp(command?: string): void {
  if (command === 'gate') {
    printGateHelp();
    return;
  }
  if (command === 'hook') {
    printHookHelp();
    return;
  }
  if (command === 'bind' || command === 'unbind') {
    console.log(`Usage:
  nb bind                                          List current per-client destination bindings
  nb bind --client <id> [--client <id2> ...] --to <name>
                                                   Pin one or more plugin clients to a destination (by connectionId)
  nb unbind --client <id> [--client <id2> ...]     Remove per-client destination bindings
`);
    return;
  }
  if (command === 'notify') {
    console.log(`Usage:
  nb notify "<title>" [--to <name>] [--sender <label>] [options]
  nb notify --resume <request-id> [--to <name>] [--wait <seconds>]

Send a one-way E2EE notification by default, or add interactive options to wait for a reply.

Options:
  --message, -m <text>       Notification body text
  --options, -o <a,b,...>    Reply buttons (makes request interactive)
  --decline-option <text>    One of --options that declines without auth
  --placeholder, -p <text>   Inline text-reply prompt
  --diff <json-file>         Review original/modified text (cannot combine with options/fields/placeholder/screen/resume)
  --fields <json-file>       In-app dynamic form JSON array (1–50 fields)
  --screen <json-file>       Custom screen JSON object (cannot combine with message/options/fields/placeholder/diff/resume)
  --requires-auth            Require device-owner authentication (Face ID, Touch ID, passcode or unlocked Watch)
  --sensitive                Hide content in notification previews
  --short-title <text>       Single-line presentation title override (max 40 chars)
  --summary <text>           Single-line presentation summary override (max 100 chars)
  --timeout <seconds>        Request lifetime (default ${DEFAULT_REQUEST_TIMEOUT_SECONDS}, max ${MAX_REQUEST_TIMEOUT_SECONDS}; three hours)
  --wait, -w <seconds>       Wait before returning pending on interactive requests (default 45, max ${MAX_REPLY_WAIT_SECONDS}); does not change expiry
  --resume <request-id>      Check/resume a pending request (keeps original signed expiry)
`);
    return;
  }
  if (command === 'activity') {
    console.log(`Usage:
  nb activity <id> <start|update|end|poll> [--to <name>] [--sender <label>] [options]

Options:
  --title, -t <text>         Display title (for start)
  --status, -s <text>        Progress description
  --step <number>            Current step (0–1000000)
  --total-steps <number>     Total steps (1–1000000)
  --timer <minutes>          Hardware countdown timer (0–60)
  --controls <a,b,...>       Timer buttons: pause, resume, cancel, add_5m
  --short-title <text>       Single-line presentation title override
  --summary <text>           Single-line presentation summary override
  --sensitive                Hide content on Lock Screen and Live Activity
`);
    return;
  }
  if (command === 'screen') {
    console.log(`Usage:
  nb screen register <file> [--strict] [--to <name>]

Register a screen template JSON file on the relay.
Without --strict, auto-standardizations write <stem>.repaired.json (including the signed record)
next to <file> without mutating <file>. With --strict, suggested repairs exit non-zero without signing.
`);
    return;
  }
  if (command === 'files') {
    console.log(`Usage:
  nb files list [--to <name>]
  nb files receive <file_id> [--to <name> | --pairing <device_id>:<sender_key_id>]
`);
    return;
  }
  if (command === 'pair') {
    console.log(`Usage:
  nb pair --to <name> [--label <connection-name>] [--wait <seconds>]

Paste the setup code when prompted, or pipe it: pbpaste | nb pair --to <name>
Pairing waits up to 45 seconds for a first-use code; --wait accepts 0–60 seconds.
`);
    return;
  }
  if (command === 'devices') {
    console.log(`Usage:
  nb devices list
  nb devices rename <old> <new>
`);
    return;
  }
  if (command === 'mcp') {
    console.log(`Usage:
  nb mcp --to <name> [--sender <label>]
  nb mcp --allow-to <name> --allow-to <name> [--sender <label>]
  nb mcp --client <id> [--sender <label>]
`);
    return;
  }
  if (command === 'doctor' || command === 'status' || command === 'unpair') {
    console.log(`Usage:
  nb doctor [--to <name>]     Verify relay, approval, clock skew, and protocol compatibility
  nb status [--to <name>]     Inspect locally saved destination metadata
  nb unpair --to <name>       Forget locally; revoke separately on phone
`);
    return;
  }

  console.log(`NotiBuddy CLI (nb) v${PACKAGE_VERSION} — Encrypted notifications and replies

Usage:
  nb notify "<title>" [--to <name>] [--sender <label>] [options]
  nb notify --resume <request-id> [--to <name>] [--wait <seconds>]
  nb screen register <file> [--strict] [--to <name>]
  nb gate "<title>" [--to <name>] [--sender <label>] [options]
  nb hook claude PermissionRequest [--client <id> | --to <name>] [options]
  nb activity <id> <start|update|end|poll> [--to <name>] [options]
  nb files list [--to <name>]
  nb files receive <file_id> [--to <name> | --pairing <device_id>:<sender_key_id>]
  nb pair --to <name> [--label <connection-name>] [--wait <seconds>]
  nb bind --client <id> [--client <id2> ...] --to <name>
  nb unbind --client <id> [--client <id2> ...]
  nb devices list
  nb devices rename <old> <new>      Change a local alias, keeping its identity
  nb doctor [--to <name>]            Verify relay, approval, and protocol compatibility
  nb status [--to <name>]            Inspect locally saved destinations
  nb unpair --to <name>              Forget locally; revoke separately on phone
  nb mcp --to <name> | --allow-to <name> ... | --client <id> [--sender <label>]

Destinations live under ~/.notibuddy (override with NOTIBUDDY_HOME).
When only one destination is paired, notify/gate/activity/files/doctor auto-select it if --to is omitted.
MCP (--to / --allow-to / --client) and pair/unpair require explicit selection.
--sender is a free-form display label (default: hostname), not a new pairing.
Paste pairing setup codes interactively or pipe them (pbpaste | nb pair --to <name>).

Notify options:
  --message, -m <text>       Notification details
  --options, -o <a,b,...>    Reply buttons (makes request interactive)
  --decline-option <text>    One of --options that declines; on --requires-auth only it skips authentication
  --placeholder, -p <text>   Free-text reply
  --diff <json-file>         Review original/modified text; cannot combine with choices/fields/input/screen/resume
  --fields <json-file>       In-app dynamic form JSON array
  --screen <json-file>       Custom screen JSON object (templateId or inline template)
  --short-title <text> --summary <text>
  --timeout <seconds>        New request lifetime (default ${DEFAULT_REQUEST_TIMEOUT_SECONDS}, max ${MAX_REQUEST_TIMEOUT_SECONDS}; three hours)
  --wait, -w <seconds>       Wait before returning pending on interactive requests (default 45, max ${MAX_REPLY_WAIT_SECONDS}); does not change expiry
  --requires-auth            Require device-owner authentication (Face ID, Touch ID, passcode or unlocked Watch)
  --sensitive                Hide content in notification previews

Resuming keeps the original signed expiry; --timeout only applies to new requests.

Activity options:
  --title, -t <text>         Display title (for start)
  --status, -s <text>        Progress description
  --step <number> --total-steps <number>
  --timer <minutes> --controls <a,b,...> --sensitive
`);
}

function retiredAskGuidance(routing: RoutingOptions, rest: string[]): string {
  const rebuilt = ['nb', 'notify'];
  const hasInteractive = rest.some((arg) =>
    ['--options', '-o', '--placeholder', '-p', '--diff', '--fields', '--screen', '--requires-auth', '--resume', '--decline-option'].some(
      (flag) => arg === flag || arg.startsWith(flag + '='),
    ),
  );
  if (routing.to) rebuilt.push('--to', routing.to);
  if (routing.sender) rebuilt.push('--sender', quoteShell(routing.sender));
  for (const arg of rest) rebuilt.push(quoteShell(arg));
  if (!hasInteractive) rebuilt.push('--options', '"Approve,Reject"');
  return `'nb ask' was retired in favor of 'nb notify'. Run:\n  ${rebuilt.join(' ')}`;
}

function unsupportedCommandError(command: string, routing: RoutingOptions, rest: string[]): Error {
  const toFlag = routing.to ? ` --to ${routing.to}` : ' --to <name>';
  if (command === 'ask') {
    return new Error(retiredAskGuidance(routing, rest));
  }
  switch (command) {
    case 'send':
    case 'push':
    case 'alert':
    case 'message':
    case 'msg':
    case 'prompt':
      return new Error(`Unknown command '${command}'. Use:\n  nb notify "<title>"${toFlag}`);
    case 'check':
    case 'ping':
    case 'verify':
    case 'test':
    case 'health':
      return new Error(`Unknown command '${command}'. Use:\n  nb doctor${toFlag}`);
    case 'ls':
    case 'list':
      return new Error(`Unknown command '${command}'. Use:\n  nb devices list\n  nb files list${toFlag}`);
    case 'rm':
    case 'remove':
    case 'delete':
    case 'disconnect':
    case 'forget':
      return new Error(`Unknown command '${command}'. Use:\n  nb unpair${toFlag}`);
    case 'timer':
    case 'progress':
      return new Error(`Unknown command '${command}'. Use:\n  nb activity <id> start${toFlag} --title "<title>" --timer 25`);
    case 'receive':
    case 'download':
    case 'get':
      return new Error(`Unknown command '${command}'. Use:\n  nb files receive <file_id>${toFlag}`);
    default:
      return new Error(
        `Unknown command '${command}'. Available commands: notify, screen, gate, hook, activity, files, pair, bind, unbind, unpair, devices, doctor, status, mcp. Run nb help.`,
      );
  }
}

function runBindOrUnbind(command: 'bind' | 'unbind', rest: string[], store: DestinationStore): void {
  if (rest.includes('--help') || rest.includes('-h')) {
    printHelp(command);
    return;
  }
  if (command === 'bind') {
    if (rest.length === 0) {
      console.log(JSON.stringify(listClientBindings(store.root), null, 2));
      return;
    }
    const args = argumentsFor(rest, ['--to'], [], ['--client']);
    if (args.positional.length) throw new Error('Use: nb bind --client <id> [--client <id2> ...] --to <name>');
    const clients = args.list('--client');
    const rawTo = args.text('--to');
    if (!clients.length || !rawTo) {
      throw new Error('Specify at least one --client <id> and a --to <name> destination.');
    }
    const uniqueClients = [...new Set(clients.map(assertClientId))];
    const to = destinationName(rawTo);
    const record = store.read(to);
    const bindings = uniqueClients.map((clientId) => writeClientBinding(clientId, to, record.connectionId, store.root));
    console.log(
      JSON.stringify(
        {
          destination: to,
          connectionId: record.connectionId,
          bindings,
        },
        null,
        2,
      ),
    );
    return;
  }

  const args = argumentsFor(rest, [], [], ['--client']);
  if (args.positional.length) throw new Error('Use: nb unbind --client <id> [--client <id2> ...]');
  const clients = args.list('--client');
  if (!clients.length) throw new Error('Specify at least one --client <id> to unbind.');
  const uniqueClients = [...new Set(clients.map(assertClientId))];
  const unbound: string[] = [];
  const notFound: string[] = [];
  for (const clientId of uniqueClients) {
    if (deleteClientBinding(clientId, store.root)) unbound.push(clientId);
    else notFound.push(clientId);
  }
  console.log(JSON.stringify({ unbound, notFound }, null, 2));
}

async function run(raw: string[]): Promise<void> {
  if (!raw.length || ['--help', '-h', 'help'].includes(raw[0])) {
    if (raw[0] === 'help' && raw[1]) {
      if (!KNOWN_COMMANDS.has(raw[1])) {
        throw unsupportedCommandError(raw[1], {}, raw.slice(2));
      }
      printHelp(raw[1]);
      return;
    }
    printHelp();
    return;
  }
  if (['--version', '-V', '-v'].includes(raw[0]) && raw.length === 1) {
    console.log(`notibuddy ${PACKAGE_VERSION}`);
    return;
  }

  // Handle `bind` / `unbind` before `parseRoutingArgs` so repeatable `--client` flags are accepted cleanly.
  if (raw[0] === 'bind' || raw[0] === 'unbind') {
    runBindOrUnbind(raw[0], raw.slice(1), new DestinationStore());
    return;
  }

  const { options: routing, rest } = parseRoutingArgs(raw);
  if (!rest.length) {
    printHelp();
    return;
  }
  const command = rest.shift()!;

  if (command === 'help') {
    if (rest[0] && !KNOWN_COMMANDS.has(rest[0])) throw unsupportedCommandError(rest[0], routing, rest.slice(1));
    printHelp(rest[0]);
    return;
  }
  if (!KNOWN_COMMANDS.has(command)) {
    throw unsupportedCommandError(command, routing, rest);
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    printHelp(command);
    return;
  }

  const store = new DestinationStore();
  if (command === 'mcp') {
    if (rest.length) throw new Error('Unknown MCP arguments');
    const { runMcpServer } = await import('./mcp.js');
    await runMcpServer(routing);
    return;
  }

  if (command === 'gate') {
    await runGateCommand(routing, rest, store);
    return;
  }

  if (routing.client) {
    throw new Error('--client is supported only by nb mcp, nb hook, nb bind, and nb unbind; use --to.');
  }
  if (routing.allowTo) throw new Error('--allow-to is only supported by MCP; use --to');

  if (command === 'devices') {
    const action = rest.shift();
    if (action === 'list' && !rest.length) {
      console.log(JSON.stringify(store.list(), null, 2));
      return;
    }
    if (action === 'rename' && rest.length === 2) {
      const [fromName, toName] = rest;
      store.rename(fromName, toName);
      const updated = findBindingsForDestination(toName, store.root).map((b) => b.client);
      const bindingNote = updated.length ? ` Updated client bindings: ${updated.join(', ')}.` : '';
      console.log(
        `Destination renamed; pairing and pending replies are unchanged.${bindingNote} Update any CLI/MCP destination arguments.`,
      );
      return;
    }
    if (action === 'migrate') {
      throw new Error(`'nb devices migrate' was removed. Re-pair with: nb pair --to ${routing.to ?? '<name>'}`);
    }
    if (action === 'remove' || action === 'rm' || action === 'unpair' || action === 'delete') {
      throw new Error(`Use: nb unpair --to ${rest[0] ?? routing.to ?? '<name>'}`);
    }
    throw new Error('Use devices list or devices rename <old> <new>');
  }

  if (command === 'status') {
    if (rest.length) throw new Error('Unknown status arguments');
    const destinations = store.list();
    if (routing.to) {
      const opened = await store.open(routing.to);
      const summary = destinations.find((d) => d.name === routing.to);
      const boundClients = findBindingsForDestination(routing.to, store.root).map((b) => b.client);
      console.log(
        JSON.stringify(
          {
            ...summary,
            fileReceiving: Boolean(opened.record.fileKey),
            ...(boundClients.length ? { boundClients } : {}),
            note: 'Local pairing only; run nb doctor --to ' + routing.to + ' to verify relay and phone approval.',
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        destinations.length
          ? JSON.stringify(destinations, null, 2)
          : 'No named destinations paired. Run nb pair --to <name> and paste the setup code.',
      );
    }
    return;
  }

  if (command === 'files') {
    const args = argumentsFor(rest, ['--pairing']);
    const action = args.positional[0];
    if (!(action === 'list' && args.positional.length === 1) && !(action === 'receive' && args.positional.length === 2)) {
      throw new Error(
        'Use nb files list [--to <name>], or nb files receive <file_id> with --to <name> or --pairing <device_id>:<sender_key_id>.',
      );
    }
    const pairing = args.text('--pairing');
    const targetTo = routing.to ?? (pairing ? undefined : resolveCliDestination(routing, store));
    const route = await resolveFileDestination({ to: targetTo, pairing }, store);
    const result = await withShutdown(async (signal) =>
      action === 'list' ? await route.files.list({ signal }) : await route.files.receive(args.positional[1], { signal }),
    );
    console.log(JSON.stringify({ to: route.name, connectionId: route.record.connectionId, result }, null, 2));
    return;
  }

  if (command === 'unpair') {
    if (!routing.to) throw new Error('Choose a destination to unpair with --to <name>. Use nb devices list to see saved names.');
    if (rest.length) throw new Error('Unknown unpair arguments');
    const orphaned = findBindingsForDestination(routing.to, store.root).map((b) => b.client);
    store.forget(routing.to);
    const orphanNote = orphaned.length
      ? `\nOrphaned client bindings: ${orphaned.join(', ')}. Re-bind with 'nb bind --client <id> --to <name>' or remove with 'nb unbind --client <id>'.`
      : '';
    console.log(`Local destination credentials removed. Disconnect the connection on the phone to revoke access.${orphanNote}`);
    return;
  }

  if (command === 'pair') {
    if (!routing.to) throw new Error('Choose a destination name with --to <name> (e.g. nb pair --to personal).');
    if (routing.sender) throw new Error('Use --label for the approved connection name; --sender labels individual requests.');
    const args = argumentsFor(rest, ['--label', '--wait']);
    if (args.positional.length > 1) throw new Error('Use nb pair --to <name> and paste the setup code when asked');
    const waitSeconds = args.number('--wait') ?? 45;
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) {
      throw Error('Pairing wait must be between 0 and 60 seconds');
    }
    let setupCode = args.positional[0];
    if (setupCode === undefined) setupCode = await readSetupCode(process.stdin, process.stderr);
    else
      console.error(
        `Warning: a setup code on the command line can be saved in shell history. Run \`nb pair --to ${routing.to}\` and paste it when asked instead.`,
      );
    const bundle = await parsePairingBundle(setupCode);
    const label = args.text('--label') ?? store.list().find((d) => d.name === routing.to)?.connectionLabel ?? senderLabel();
    const { record, signingKey } = await store.prepare(routing.to, bundle, label);
    const { config, keys } = record;
    const mac = await computePairingMac(
      bundle.pairSecret,
      bundle.device.id,
      keys.senderKeyId,
      keys.publicKeyB64u,
      label,
      record.fileKey!.publicKeyB64u,
    );
    const result = await withShutdown((signal) =>
      pairSender(
        config,
        signingKey,
        {
          senderKeyId: keys.senderKeyId,
          senderPub: keys.publicKeyB64u,
          label,
          mac,
          fileEncPub: record.fileKey!.publicKeyB64u,
          fileDeviceId: config.device.id,
        },
        bundle.firstUse,
        {
          signal,
          waitSeconds,
          onWaiting: () => console.log('First-use code claimed. Keep NotiBuddy open and online while it finishes connecting…'),
        },
      ),
    );
    const guidance =
      result.status === 'registered'
        ? 'This sender is connected. No approval is needed. Configure or restart its MCP server below.'
        : result.status === 'pending_automatic'
          ? 'Connection is not confirmed yet. Keep NotiBuddy open and online. Run the same pairing command again with the same destination name; your saved sender keys will be reused. If the code expires, use fresh setup or the manual approval shown in Connect.'
          : 'Open NotiBuddy → Connect. Compare the full Sender Key ID, then approve the connection.\nA new pairing request replaces an older pending approval; approved connections stay paired.\nPending approval expires after 15 minutes.';
    const savedDestinations = store.list();
    const bindHint =
      savedDestinations.length >= 2
        ? `\nMultiple destinations are paired (${savedDestinations.map((d) => d.name).join(', ')}). If you use a plugin (--client), bind each host explicitly, e.g.:\n  nb bind --client claude-code --to ${routing.to}\n`
        : '';
    console.log(`${result.status === 'registered' ? 'Pairing confirmed' : result.status === 'pending_automatic' ? 'Waiting for NotiBuddy' : 'Phone approval required'}
Destination: ${routing.to}
Phone: ${config.device.name || 'iPhone'}
Connection: ${label}
Sender Key ID: ${keys.senderKeyId}

${guidance}${bindHint}
MCP configuration:
${JSON.stringify({ mcpServers: { notibuddy: { command: 'npx', args: ['-y', `notibuddy@${PACKAGE_VERSION}`, 'mcp', '--to', routing.to] } } })}`);
    return;
  }

  const targetTo = resolveCliDestination(routing, store);
  const effectiveRouting: RoutingOptions = { ...routing, to: targetTo };

  if (command === 'doctor') {
    if (rest.length) throw Error('Use nb doctor [--to <name>]');
    const route = (await createDestinationRouter(effectiveRouting, store)).resolve();
    const result = await withShutdown((signal) => route.client.doctor({ signal }));
    console.log(
      JSON.stringify(
        {
          ...result,
          to: route.name,
          connectionId: route.record.connectionId,
          fileReceiving: route.record.fileKey ? 'enabled' : 'pair_again_to_enable',
          receiveCommand: `nb files list --to ${route.name}`,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'screen') {
    const args = argumentsFor(rest, [], ['--strict']);
    const action = args.positional[0];
    if (action !== 'register' || args.positional.length !== 2) {
      throw new Error('Use: nb screen register <file> [--strict] [--to <name>]');
    }
    const inputPath = args.positional[1];
    const parsed = readScreenTemplateFile(inputPath);
    const strict = args.flag('--strict');
    const route = (await createDestinationRouter(effectiveRouting, store)).resolve();
    const result = await withShutdown((signal) =>
      route.client.registerScreenTemplate(parsed, { signal, strict }),
    );
    if (result.status === 'certified' && result.repaired) {
      const repairedPath = writeRepairedTemplateFile(inputPath, {
        templateId: result.templateId,
        repaired: true,
        skeleton: result.skeleton,
        suggestedTemplate: result.suggestedTemplate,
        changes: result.changes,
        record: result.record,
      });
      console.log(
        JSON.stringify(
          {
            status: result.status,
            templateId: result.templateId,
            repaired: true,
            repairedPath,
            changes: result.changes,
            record: result.record,
            to: route.name,
            connectionId: route.record.connectionId,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (result.status === 'certified') {
      console.log(
        JSON.stringify(
          {
            status: result.status,
            templateId: result.templateId,
            repaired: false,
            record: result.record,
            to: route.name,
            connectionId: route.record.connectionId,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(JSON.stringify({ ...result, to: route.name, connectionId: route.record.connectionId }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (command === 'notify') {
    const args = argumentsFor(
      rest,
      [
        '--message',
        '--options',
        '--decline-option',
        '--placeholder',
        '--timeout',
        '--wait',
        '--resume',
        '--diff',
        '--fields',
        '--screen',
        '--short-title',
        '--summary',
      ],
      ['--requires-auth', '--sensitive'],
    );
    if (args.positional.length > 1) throw new Error('Quote the notification title as one argument');
    const title = args.positional[0];
    const resumeId = args.text('--resume');
    if (resumeId !== undefined && title !== undefined) {
      throw new Error('Do not pass a title with --resume. Use: nb notify --resume <request-id> [--to <name>]');
    }

    const diffFile = args.text('--diff');
    if (diffFile !== undefined && ['--options', '--placeholder', '--fields', '--screen', '--resume'].some((flag) => args.text(flag) !== undefined)) {
      throw new Error('--diff cannot be combined with --options, --placeholder, --fields, --screen or --resume');
    }
    const screenFile = args.text('--screen');
    if (screenFile !== undefined && ['--message', '--options', '--decline-option', '--placeholder', '--fields', '--diff', '--resume'].some((flag) => args.text(flag) !== undefined)) {
      throw new Error('--screen cannot be combined with --message, --options, --decline-option, --placeholder, --fields, --diff or --resume');
    }
    const diff = diffFile === undefined ? undefined : readDiffFile(diffFile);
    const screen = screenFile === undefined ? undefined : (readScreenFile(screenFile) as ScreenAskInput);
    const fieldsFile = args.text('--fields');
    const fields = fieldsFile === undefined ? undefined : readFieldsFile(fieldsFile);
    const rawOptions = args.text('--options');
    const options = rawOptions === undefined ? undefined : rawOptions === '' ? [] : rawOptions.split(',').map((s) => s.trim());
    const declineOption = args.text('--decline-option')?.trim();
    const inputPlaceholder = args.text('--placeholder');
    const requiresAuth = args.flag('--requires-auth');
    const sensitive = args.flag('--sensitive') || undefined;
    const presentation = presentationFrom(args.text('--short-title'), args.text('--summary'));
    const timeoutSeconds = args.number('--timeout');
    const waitSeconds = args.number('--wait');

    const interactive =
      (options !== undefined && options.length > 0) ||
      declineOption !== undefined ||
      inputPlaceholder !== undefined ||
      diff !== undefined ||
      screen !== undefined ||
      fields !== undefined ||
      resumeId !== undefined ||
      requiresAuth;

    const route = (await createDestinationRouter(effectiveRouting, store)).resolve();

    if (!interactive) {
      if (waitSeconds !== undefined && waitSeconds > 0) {
        throw new Error(
          'One-way notifications return immediately without waiting. Omit --wait, or add --options "Approve,Reject" (or --placeholder, --diff, --fields, --screen) to wait for a response.',
        );
      }
      if (title === undefined) {
        throw new Error('Provide a notification title: nb notify "<title>" [--to <name>]');
      }
      const result = await withShutdown((signal) =>
        route.client.notify(
          {
            title,
            message: args.text('--message'),
            timeoutSeconds,
            sensitive,
            presentation,
          },
          { signal },
        ),
      );
      console.log(JSON.stringify({ ...result, to: route.name, connectionId: route.record.connectionId }, null, 2));
      return;
    }

    const result = await withShutdown((signal) =>
      route.client.ask(
        {
          title,
          resumeId,
          message: args.text('--message'),
          options,
          declineOption,
          inputPlaceholder,
          fields: fields as any,
          timeoutSeconds,
          waitSeconds: waitSeconds ?? 45,
          requiresAuth,
          sensitive: args.flag('--sensitive'),
          presentation,
          diff,
          screen,
        },
        { signal },
      ),
    );
    console.log(JSON.stringify({ ...result, to: route.name, connectionId: route.record.connectionId }, null, 2));
    return;
  }

  if (command === 'activity') {
    const args = argumentsFor(
      rest,
      ['--title', '--status', '--step', '--total-steps', '--timer', '--controls', '--short-title', '--summary'],
      ['--sensitive'],
    );
    if (args.positional.length !== 2) throw new Error('Use nb activity <id> <start|update|end|poll> [--to <name>]');
    const rawControls = args.text('--controls');
    const controls = rawControls === undefined ? undefined : rawControls === '' ? [] : rawControls.split(',').map((s) => s.trim());
    const presentation = presentationFrom(args.text('--short-title'), args.text('--summary'));
    const route = (await createDestinationRouter(effectiveRouting, store)).resolve();
    const result = await withShutdown((signal) =>
      route.client.activity(
        {
          activityId: args.positional[0],
          action: args.positional[1] as 'start' | 'update' | 'end' | 'poll',
          title: args.text('--title'),
          status: args.text('--status'),
          step: args.number('--step'),
          totalSteps: args.number('--total-steps'),
          timerMinutes: args.number('--timer'),
          controls: controls as ('pause' | 'resume' | 'cancel' | 'add_5m')[] | undefined,
          presentation,
          sensitive: args.flag('--sensitive') || undefined,
        },
        { signal },
      ),
    );
    console.log(JSON.stringify({ ...result, to: route.name, connectionId: route.record.connectionId }, null, 2));
    return;
  }

  throw unsupportedCommandError(command, routing, rest);
}

/** Every command except `mcp`, `doctor`, `gate`, and `hook` gets the daily update notice. */
function wantsUpdateNotice(raw: string[]): boolean {
  if (raw[0] === 'bind' || raw[0] === 'unbind' || raw[0] === 'gate' || raw[0] === 'hook') {
    return raw[0] === 'bind' || raw[0] === 'unbind';
  }
  try {
    const command = parseRoutingArgs(raw).rest[0];
    return command !== 'mcp' && command !== 'doctor' && command !== 'gate' && command !== 'hook';
  } catch {
    return true;
  }
}

const NOTICE_LOOKUP_MS = 1500;
const NOTICE_GRACE_MS = 300;

export async function runMainCli(raw: string[]): Promise<void> {
  const lookup = new AbortController();
  const notice = wantsUpdateNotice(raw)
    ? new UpdateNotifier().cliNotice(Date.now() + NOTICE_LOOKUP_MS, lookup.signal)
    : undefined;
  try {
    await run(raw);
  } catch (err: unknown) {
    console.error(`NotiBuddy: ${formatValidationError(err, 'cli')}`);
    process.exitCode ??= 1;
  }
  if (!notice) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    notice,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), NOTICE_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
  lookup.abort();
  if (text) console.error(text);
}
