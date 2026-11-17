#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parsePairingBundle } from './protocol.js';
import { readSetupCode } from './setup-code.js';
import { computePairingMac } from './crypto.js';
import { DestinationStore, senderLabel } from './config.js';
import { runMcpServer } from './mcp.js';
import { createDestinationRouter, parseRoutingArgs, type RoutingOptions } from './routing.js';
import { resolveFileDestination } from './file-routing.js';
import { readDiffFile, readFieldsFile } from './diff-file.js';
import { pairSender } from './pairing.js';
import { UpdateNotifier } from './update-notice.js';
import { formatValidationError } from './validation-error.js';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS, MAX_REPLY_WAIT_SECONDS } from './request-timeout.js';
import type { PresentationHints } from './types.js';

const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const KNOWN_COMMANDS = new Set(['mcp', 'devices', 'status', 'files', 'unpair', 'pair', 'doctor', 'notify', 'activity']);

async function withShutdown<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 130; controller.abort(new DOMException('Interrupted', 'AbortError')); };
  const terminate = () => { process.exitCode = 143; controller.abort(new DOMException('Terminated', 'AbortError')); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    return await operation(controller.signal);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

function printHelp(command?: string): void {
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
  --diff <json-file>         Review original/modified text (cannot combine with options/fields/placeholder/resume)
  --fields <json-file>       In-app dynamic form JSON array (1–50 fields)
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
  nb activity <id> <start|update|end|poll> [--to <name>] [options]
  nb files list [--to <name>]
  nb files receive <file_id> [--to <name> | --pairing <device_id>:<sender_key_id>]
  nb pair --to <name> [--label <connection-name>] [--wait <seconds>]
  nb devices list
  nb devices rename <old> <new>      Change a local alias, keeping its identity
  nb doctor [--to <name>]            Verify relay, approval, and protocol compatibility
  nb status [--to <name>]            Inspect locally saved destinations
  nb unpair --to <name>              Forget locally; revoke separately on phone
  nb mcp --to <name> | --allow-to <name> ... [--sender <label>]

Destinations live under ~/.notibuddy (override with NOTIBUDDY_HOME).
When only one destination is paired, notify/activity/files/doctor auto-select it if --to is omitted.
MCP (--to / --allow-to) and pair/unpair always require an explicit destination.
--sender is a free-form display label (default: hostname), not a new pairing.
Paste pairing setup codes interactively or pipe them (pbpaste | nb pair --to <name>).

Notify options:
  --message, -m <text>       Notification details
  --options, -o <a,b,...>    Reply buttons (makes request interactive)
  --decline-option <text>    One of --options that declines; on --requires-auth only it skips authentication
  --placeholder, -p <text>   Free-text reply
  --diff <json-file>         Review original/modified text; cannot combine with choices/fields/input/resume
  --fields <json-file>       In-app dynamic form JSON array
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

function quoteShell(arg: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function retiredAskGuidance(routing: RoutingOptions, rest: string[]): string {
  const rebuilt = ['nb', 'notify'];
  const hasInteractive = rest.some((arg) =>
    ['--options', '-o', '--placeholder', '-p', '--diff', '--fields', '--requires-auth', '--resume', '--decline-option'].some(
      (flag) => arg === flag || arg.startsWith(flag + '=')
    )
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
      return new Error(`Unknown command '${command}'. Available commands: notify, activity, files, pair, unpair, devices, doctor, status, mcp. Run nb help.`);
  }
}

function argumentsFor(args: string[], values: string[], booleans: string[] = []) {
  const options: Record<string, string | boolean> = {};
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
    if (flag in options) throw new Error(`Duplicate option ${flag}`);
    if (booleans.includes(flag)) {
      if (inline !== undefined) throw new Error(`${flag} does not take a value`);
      options[flag] = true;
      continue;
    }
    if (!values.includes(flag)) throw new Error(`Unknown option ${flag}`);
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    options[flag] = value;
  }
  return {
    positional,
    text: (flag: string) => options[flag] as string | undefined,
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

function resolveCliDestination(routing: RoutingOptions, store: DestinationStore): string {
  if (routing.to) return routing.to;
  const saved = store.list();
  if (saved.length === 1) {
    return saved[0].name;
  }
  if (saved.length === 0) {
    throw new Error('No destinations paired. Run: nb pair --to <name>');
  }
  throw new Error(`Choose a destination with --to <name>. Saved destinations: ${saved.map((d) => d.name).join(', ')}.`);
}

function presentationFrom(shortTitle?: string, summary?: string): PresentationHints | undefined {
  if (shortTitle === undefined && summary === undefined) return undefined;
  return {
    ...(shortTitle !== undefined ? { shortTitle } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

async function run(): Promise<void> {
  const raw = process.argv.slice(2);
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
    await runMcpServer(routing);
    return;
  }
  if (routing.allowTo) throw new Error('--allow-to is only supported by MCP; use --to');

  if (command === 'devices') {
    const action = rest.shift();
    if (action === 'list' && !rest.length) {
      console.log(JSON.stringify(store.list(), null, 2));
      return;
    }
    if (action === 'rename' && rest.length === 2) {
      store.rename(rest[0], rest[1]);
      console.log('Destination renamed; pairing and pending replies are unchanged. Update any CLI/MCP destination arguments.');
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
      console.log(JSON.stringify({
        ...summary,
        fileReceiving: Boolean(opened.record.fileKey),
        note: 'Local pairing only; run nb doctor --to ' + routing.to + ' to verify relay and phone approval.',
      }, null, 2));
    } else {
      console.log(
        destinations.length
          ? JSON.stringify(destinations, null, 2)
          : 'No named destinations paired. Run nb pair --to <name> and paste the setup code.'
      );
    }
    return;
  }

  if (command === 'files') {
    const args = argumentsFor(rest, ['--pairing']);
    const action = args.positional[0];
    if (!(action === 'list' && args.positional.length === 1) && !(action === 'receive' && args.positional.length === 2)) {
      throw new Error('Use nb files list [--to <name>], or nb files receive <file_id> with --to <name> or --pairing <device_id>:<sender_key_id>.');
    }
    const pairing = args.text('--pairing');
    const targetTo = routing.to ?? (pairing ? undefined : resolveCliDestination(routing, store));
    const route = await resolveFileDestination({ to: targetTo, pairing }, store);
    const result = await withShutdown(async (signal) =>
      action === 'list' ? await route.files.list({ signal }) : await route.files.receive(args.positional[1], { signal })
    );
    console.log(JSON.stringify({ to: route.name, connectionId: route.record.connectionId, result }, null, 2));
    return;
  }

  if (command === 'unpair') {
    if (!routing.to) throw new Error('Choose a destination to unpair with --to <name>. Use nb devices list to see saved names.');
    if (rest.length) throw new Error('Unknown unpair arguments');
    store.forget(routing.to);
    console.log('Local destination credentials removed. Disconnect the connection on the phone to revoke access.');
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
    else console.error(`Warning: a setup code on the command line can be saved in shell history. Run \`nb pair --to ${routing.to}\` and paste it when asked instead.`);
    const bundle = await parsePairingBundle(setupCode);
    const label = args.text('--label') ?? store.list().find((d) => d.name === routing.to)?.connectionLabel ?? senderLabel();
    const { record, signingKey } = await store.prepare(routing.to, bundle, label);
    const { config, keys } = record;
    const mac = await computePairingMac(bundle.pairSecret, bundle.device.id, keys.senderKeyId, keys.publicKeyB64u, label, record.fileKey!.publicKeyB64u);
    const result = await withShutdown((signal) =>
      pairSender(config, signingKey, {
        senderKeyId: keys.senderKeyId,
        senderPub: keys.publicKeyB64u,
        label,
        mac,
        fileEncPub: record.fileKey!.publicKeyB64u,
        fileDeviceId: config.device.id,
      }, bundle.firstUse, {
        signal,
        waitSeconds,
        onWaiting: () => console.log('First-use code claimed. Keep NotiBuddy open and online while it finishes connecting…'),
      })
    );
    const guidance = result.status === 'registered'
      ? 'This sender is connected. No approval is needed. Configure or restart its MCP server below.'
      : result.status === 'pending_automatic'
        ? 'Connection is not confirmed yet. Keep NotiBuddy open and online. Run the same pairing command again with the same destination name; your saved sender keys will be reused. If the code expires, use fresh setup or the manual approval shown in Connect.'
        : 'Open NotiBuddy → Connect. Compare the full Sender Key ID, then approve the connection.\nA new pairing request replaces an older pending approval; approved connections stay paired.\nPending approval expires after 15 minutes.';
    console.log(`${result.status === 'registered' ? 'Pairing confirmed' : result.status === 'pending_automatic' ? 'Waiting for NotiBuddy' : 'Phone approval required'}
Destination: ${routing.to}
Phone: ${config.device.name || 'iPhone'}
Connection: ${label}
Sender Key ID: ${keys.senderKeyId}

${guidance}

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
    console.log(JSON.stringify({
      ...result,
      to: route.name,
      connectionId: route.record.connectionId,
      fileReceiving: route.record.fileKey ? 'enabled' : 'pair_again_to_enable',
      receiveCommand: `nb files list --to ${route.name}`,
    }, null, 2));
    return;
  }

  if (command === 'notify') {
    const args = argumentsFor(
      rest,
      ['--message', '--options', '--decline-option', '--placeholder', '--timeout', '--wait', '--resume', '--diff', '--fields', '--short-title', '--summary'],
      ['--requires-auth', '--sensitive']
    );
    if (args.positional.length > 1) throw new Error('Quote the notification title as one argument');
    const title = args.positional[0];
    const resumeId = args.text('--resume');
    if (resumeId !== undefined && title !== undefined) {
      throw new Error('Do not pass a title with --resume. Use: nb notify --resume <request-id> [--to <name>]');
    }

    const diffFile = args.text('--diff');
    if (diffFile !== undefined && ['--options', '--placeholder', '--fields', '--resume'].some((flag) => args.text(flag) !== undefined)) {
      throw new Error('--diff cannot be combined with --options, --placeholder, --fields or --resume');
    }
    const diff = diffFile === undefined ? undefined : readDiffFile(diffFile);
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
      fields !== undefined ||
      resumeId !== undefined ||
      requiresAuth;

    const route = (await createDestinationRouter(effectiveRouting, store)).resolve();

    if (!interactive) {
      if (waitSeconds !== undefined && waitSeconds > 0) {
        throw new Error('One-way notifications return immediately without waiting. Omit --wait, or add --options "Approve,Reject" (or --placeholder, --diff, --fields) to wait for a response.');
      }
      if (title === undefined) {
        throw new Error('Provide a notification title: nb notify "<title>" [--to <name>]');
      }
      const result = await withShutdown((signal) =>
        route.client.notify({
          title,
          message: args.text('--message'),
          timeoutSeconds,
          sensitive,
          presentation,
        }, { signal })
      );
      console.log(JSON.stringify({ ...result, to: route.name, connectionId: route.record.connectionId }, null, 2));
      return;
    }

    const result = await withShutdown((signal) =>
      route.client.ask({
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
      }, { signal })
    );
    console.log(JSON.stringify({ ...result, to: route.name, connectionId: route.record.connectionId }, null, 2));
    return;
  }

  if (command === 'activity') {
    const args = argumentsFor(
      rest,
      ['--title', '--status', '--step', '--total-steps', '--timer', '--controls', '--short-title', '--summary'],
      ['--sensitive']
    );
    if (args.positional.length !== 2) throw new Error('Use nb activity <id> <start|update|end|poll> [--to <name>]');
    const rawControls = args.text('--controls');
    const controls = rawControls === undefined ? undefined : rawControls === '' ? [] : rawControls.split(',').map((s) => s.trim());
    const presentation = presentationFrom(args.text('--short-title'), args.text('--summary'));
    const route = (await createDestinationRouter(effectiveRouting, store)).resolve();
    const result = await withShutdown((signal) =>
      route.client.activity({
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
      }, { signal })
    );
    console.log(JSON.stringify({ ...result, to: route.name, connectionId: route.record.connectionId }, null, 2));
    return;
  }

  throw unsupportedCommandError(command, routing, rest);
}

/** Every command but `mcp` (per-session notice) and `doctor` (reports `newer` itself) gets the daily notice. */
function wantsUpdateNotice(raw: string[]): boolean {
  try {
    const command = parseRoutingArgs(raw).rest[0];
    return command !== 'mcp' && command !== 'doctor';
  } catch {
    return true;
  }
}

const NOTICE_LOOKUP_MS = 1500;
const NOTICE_GRACE_MS = 300;

async function main(): Promise<void> {
  // Cancelled after the grace period: a late answer records nothing (the notice waits for the
  // next command) and cannot keep the process alive.
  const lookup = new AbortController();
  const notice = wantsUpdateNotice(process.argv.slice(2))
    ? new UpdateNotifier().cliNotice(Date.now() + NOTICE_LOOKUP_MS, lookup.signal)
    : undefined;
  try {
    await run();
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

void main();
