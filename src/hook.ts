import type { AskParams, NotiBuddyClient } from './client.js';
import type { DecisionOutcome } from './approval.js';
import { readDestinationConnectionId, resolveClientDestination } from './client-binding.js';
import {
  defaultHookSenderLabel,
  defaultHookTimeoutSeconds,
  parseClaudePermissionRequest,
  passthroughStdoutFor,
  renderClaudePermission,
  type HookVerdict,
  type RenderedHookOutput,
} from './hook-agents.js';
import { formatClaudePermission } from './hook-display.js';
import {
  appendHookEventLog,
  checkHookLedger,
  recordHookDispatchSuccess,
  recordHookQuotaExceeded,
  reserveHookDispatch,
} from './hook-ledger.js';
import { isValidClientId, isValidDestinationName, listDestinationNamesFast, notibuddyHome } from './home.js';
import { MAX_REQUEST_TIMEOUT_SECONDS } from './request-timeout.js';

export const MAX_HOOK_STDIN_BYTES = 1024 * 1024;
export const HOOK_STDIN_TIMEOUT_MS = 2_000;
export const DEFAULT_HOOK_GRACE_SECONDS = 10;
export const DEFAULT_HOOK_MAX_PER_HOUR = 30;

export interface ParsedHookArgs {
  agent?: string;
  event?: string;
  client?: string;
  to?: string;
  sender?: string;
  timeout?: number;
  grace: number;
  maxPerHour: number;
  requiresAuth: boolean;
  showPreview: boolean;
  help: boolean;
  errorCause?: string;
}

export interface HookRuntimeIO {
  root?: string;
  debug?: boolean;
  readStdin?: (maxBytes: number, timeoutMs: number, signal?: AbortSignal) => Promise<{ ok: true; text: string } | { ok: false; cause: string }>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable test hook to bypass network/crypto while exercising full engine policy. */
  dispatch?: (params: {
    destination: string;
    sender: string;
    askInput: Omit<AskParams, 'resumeId' | 'waitSeconds'> & { timeoutSeconds: number };
    approveAction: string;
    requiresAuth: boolean;
    signal: AbortSignal;
  }) => Promise<DecisionOutcome>;
  signal?: AbortSignal;
}

export function printHookHelp(): void {
  console.log(`Usage:
  nb hook claude PermissionRequest [--client <id> | --to <name>] [options]

Native agent lifecycle hook adapter. Only ever emits a verified allow or deny;
every other outcome (unpaired, ambiguous, timeout, quota, error, or oversized input)
exits 0 with host pass-through output so your local prompt works normally.

Options:
  --client <id>           Per-client destination binding (preferred for plugins)
  --to <name>             Explicit destination alias (for manual settings.json hooks)
  --sender <label>        Display label override (default: adapter name, e.g. "Claude Code")
  --timeout <seconds>     Signed request lifetime & wait budget (default: 300 for claude)
  --grace <seconds>       Wait before paging so local terminal answers cost zero requests (default: ${DEFAULT_HOOK_GRACE_SECONDS})
  --max-per-hour <n>      Rolling local dispatch cap per hour (default: ${DEFAULT_HOOK_MAX_PER_HOUR}; 0 disables)
  --requires-auth         Require Face ID / Touch ID / passcode / unlocked Watch (off by default)
  --show-preview          Show content in Lock Screen previews (hidden/sensitive by default)

Set NOTIBUDDY_HOOK_DEBUG=1 to log passthrough causes to stderr (metadata only; never tool_input).
`);
}

export function parseHookArgs(rawArgs: string[]): ParsedHookArgs {
  const result: ParsedHookArgs = {
    grace: DEFAULT_HOOK_GRACE_SECONDS,
    maxPerHour: DEFAULT_HOOK_MAX_PER_HOUR,
    requiresAuth: false,
    showPreview: false,
    help: false,
  };
  const positional: string[] = [];
  const seen = new Set<string>();

  const parseNumber = (flag: string, value: string | undefined): number | undefined => {
    if (value === undefined || value === '') {
      result.errorCause ??= `missing_value_${flag}`;
      return undefined;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      result.errorCause ??= `invalid_number_${flag}`;
      return undefined;
    }
    return n;
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    const [flag, inline] = token.split(/=(.*)/s, 2);
    if (seen.has(flag)) {
      result.errorCause ??= `duplicate_flag_${flag}`;
      continue;
    }
    seen.add(flag);

    if (flag === '--requires-auth') {
      if (inline !== undefined) result.errorCause ??= 'flag_takes_no_value';
      result.requiresAuth = true;
      continue;
    }
    if (flag === '--show-preview') {
      if (inline !== undefined) result.errorCause ??= 'flag_takes_no_value';
      result.showPreview = true;
      continue;
    }

    const value = inline ?? rawArgs[++i];
    if (value === undefined) {
      result.errorCause ??= `missing_value_${flag}`;
      continue;
    }

    switch (flag) {
      case '--client':
        if (!isValidClientId(value)) result.errorCause ??= 'invalid_client_id';
        else result.client = value;
        break;
      case '--to':
        if (!isValidDestinationName(value)) result.errorCause ??= 'invalid_destination_name';
        else result.to = value;
        break;
      case '--sender':
        result.sender = value;
        break;
      case '--timeout': {
        const n = parseNumber(flag, value);
        if (n !== undefined) {
          if (!Number.isInteger(n) || n < 1 || n > MAX_REQUEST_TIMEOUT_SECONDS) {
            result.errorCause ??= 'invalid_timeout_range';
          } else {
            result.timeout = n;
          }
        }
        break;
      }
      case '--grace': {
        const n = parseNumber(flag, value);
        if (n !== undefined) {
          if (!Number.isFinite(n) || n < 0 || n > 300) result.errorCause ??= 'invalid_grace_range';
          else result.grace = n;
        }
        break;
      }
      case '--max-per-hour': {
        const n = parseNumber(flag, value);
        if (n !== undefined) {
          if (!Number.isInteger(n) || n < 0 || n > 10_000) result.errorCause ??= 'invalid_max_per_hour';
          else result.maxPerHour = n;
        }
        break;
      }
      default:
        result.errorCause ??= `unknown_flag_${flag}`;
        break;
    }
  }

  result.agent = positional[0];
  result.event = positional[1];
  if (positional.length > 2) result.errorCause ??= 'unexpected_positional_args';
  if (result.client && result.to) result.errorCause ??= 'conflicting_client_and_to';

  return result;
}

function readProcessStdinBounded(
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; cause: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, cause: 'aborted' });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const finish = (outcome: { ok: true; text: string } | { ok: false; cause: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      process.stdin.pause();
      resolve(outcome);
    };

    const onAbort = () => finish({ ok: false, cause: 'aborted' });
    const onError = () => finish({ ok: false, cause: 'stdin_read_error' });
    const onEnd = () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buf.length;
      if (total > maxBytes) {
        finish({ ok: false, cause: 'stdin_too_large' });
        return;
      }
      chunks.push(buf);
    };

    const timer = setTimeout(() => finish({ ok: false, cause: 'stdin_timeout' }), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveHookTarget(parsed: ParsedHookArgs, root: string): { ok: true; destination: string } | { ok: false; cause: string } {
  if (parsed.client) {
    const res = resolveClientDestination(parsed.client, root);
    return res.ok ? { ok: true, destination: res.destination } : { ok: false, cause: res.code };
  }
  if (parsed.to) {
    const connId = readDestinationConnectionId(parsed.to, root);
    return connId ? { ok: true, destination: parsed.to } : { ok: false, cause: 'destination_not_paired' };
  }
  const names = listDestinationNamesFast(root);
  if (names.length === 0) return { ok: false, cause: 'unpaired' };
  if (names.length > 1) return { ok: false, cause: 'ambiguous' };
  const connId = readDestinationConnectionId(names[0], root);
  return connId ? { ok: true, destination: names[0] } : { ok: false, cause: 'corrupt_destination' };
}

function mapDecisionToVerdict(decision: DecisionOutcome): HookVerdict {
  if (decision.outcome === 'approved') {
    return { kind: 'allow' };
  }
  if (decision.outcome === 'rejected' && decision.reason === 'declined') {
    return { kind: 'deny', reason: 'Rejected on NotiBuddy device' };
  }
  if (decision.outcome === 'rejected') {
    return { kind: 'passthrough', cause: `rejected_${decision.reason}` };
  }
  if (decision.outcome === 'expired') {
    return { kind: 'passthrough', cause: 'expired' };
  }
  return { kind: 'passthrough', cause: decision.errorCode ?? 'dispatch_error' };
}

async function defaultDispatch(params: {
  destination: string;
  sender: string;
  askInput: Omit<AskParams, 'resumeId' | 'waitSeconds'> & { timeoutSeconds: number };
  approveAction: string;
  requiresAuth: boolean;
  signal: AbortSignal;
  root: string;
}): Promise<DecisionOutcome> {
  // Dynamically import heavy modules (zod, @hpke/core, client) ONLY when actually dispatching.
  const [{ DestinationStore }, { createDestinationRouter }, { waitForDecision }] = await Promise.all([
    import('./config.js'),
    import('./routing.js'),
    import('./approval.js'),
  ]);
  const store = new DestinationStore(params.root);
  const router = await createDestinationRouter({ to: params.destination, sender: params.sender }, store, true);
  try {
    const route = router.resolve();
    return await waitForDecision(
      route.client as Pick<NotiBuddyClient, 'ask'>,
      params.askInput,
      { approveAction: params.approveAction, requiresAuth: params.requiresAuth },
      { signal: params.signal, localGraceSeconds: 0 },
    );
  } finally {
    router.close();
  }
}

/**
 * Harness-agnostic hook execution engine. Never throws or exits non-zero: every
 * failure, timeout, signal, or policy miss emits valid host passthrough bytes and exits 0.
 */
export async function runHook(rawArgs: string[], io: HookRuntimeIO = {}): Promise<RenderedHookOutput> {
  const now = io.now ?? (() => Date.now());
  const startedMs = now();
  const parsed = parseHookArgs(rawArgs);
  const root = io.root ?? notibuddyHome();
  const debug = io.debug ?? process.env.NOTIBUDDY_HOOK_DEBUG === '1';
  const writeStdout = io.writeStdout ?? ((s: string) => { if (s) process.stdout.write(s); });
  const writeStderr = io.writeStderr ?? ((s: string) => { process.stderr.write(s); });
  const sleep = io.sleep ?? defaultSleep;
  const readStdin = io.readStdin ?? readProcessStdinBounded;

  // Compute passthrough bytes from argv ONLY before touching stdin.
  const passthroughStdout = passthroughStdoutFor(parsed.agent, parsed.event);
  const ledgerKey = parsed.client ?? parsed.to ?? 'default';
  const agentLabel = parsed.agent ?? 'unknown';
  const eventLabel = parsed.event ?? 'unknown';

  const emit = (verdict: HookVerdict, requestId?: string): RenderedHookOutput => {
    const rendered: RenderedHookOutput =
      parsed.agent === 'claude' && parsed.event === 'PermissionRequest'
        ? renderClaudePermission(verdict)
        : { stdout: passthroughStdout, exitCode: 0 };

    if (debug && verdict.kind === 'passthrough') {
      writeStderr(`[notibuddy hook] passthrough (${agentLabel}/${eventLabel}): ${verdict.cause}\n`);
    }
    appendHookEventLog(
      {
        ts: Math.floor(now() / 1000),
        agent: agentLabel,
        event: eventLabel,
        key: ledgerKey,
        verdict: verdict.kind,
        ...(verdict.kind === 'passthrough' ? { cause: verdict.cause } : {}),
        ...(requestId ? { requestId } : {}),
        durationMs: Math.max(0, now() - startedMs),
      },
      root,
    );
    writeStdout(rendered.stdout);
    return rendered;
  };

  if (parsed.errorCause) {
    return emit({ kind: 'passthrough', cause: parsed.errorCause });
  }
  if (parsed.agent !== 'claude' || parsed.event !== 'PermissionRequest') {
    return emit({ kind: 'passthrough', cause: 'unsupported_agent_or_event' });
  }

  const timeoutSeconds = parsed.timeout ?? defaultHookTimeoutSeconds(parsed.agent);
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(io.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  if (io.signal) {
    if (io.signal.aborted) return emit({ kind: 'passthrough', cause: 'aborted' });
    io.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Watchdog guarantees the hook exits cleanly before the host harness kills it.
  const watchdogMs = (parsed.grace + timeoutSeconds + 2) * 1000;
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    controller.abort(new DOMException('Hook watchdog expired', 'AbortError'));
  }, watchdogMs);
  watchdog.unref?.();

  try {
    const stdinResult = await readStdin(MAX_HOOK_STDIN_BYTES, HOOK_STDIN_TIMEOUT_MS, controller.signal);
    if (!stdinResult.ok) {
      return emit({ kind: 'passthrough', cause: stdinResult.cause });
    }

    const parsedInput = parseClaudePermissionRequest(stdinResult.text);
    if (!parsedInput.ok) {
      return emit({ kind: 'passthrough', cause: parsedInput.cause });
    }

    const formatted = formatClaudePermission(parsedInput.input);
    if (!formatted.ok) {
      return emit({ kind: 'passthrough', cause: formatted.cause });
    }

    // Fast preflight ledger check before waiting or resolving files.
    const preflight = checkHookLedger(ledgerKey, parsed.maxPerHour, now(), root);
    if (!preflight.allowed) {
      return emit({ kind: 'passthrough', cause: preflight.cause });
    }

    // Fast cheap binding/destination check before waiting out grace.
    const target = resolveHookTarget(parsed, root);
    if (!target.ok) {
      return emit({ kind: 'passthrough', cause: target.cause });
    }

    // Wait out grace period: if the user answers locally in Claude Code, Claude sends SIGTERM
    // and we exit cleanly without spending network latency or Free-tier quota.
    if (parsed.grace > 0) {
      await sleep(parsed.grace * 1000, controller.signal);
    }

    // Re-verify binding/destination and atomically reserve hourly budget slot right before POST.
    const confirmedTarget = resolveHookTarget(parsed, root);
    if (!confirmedTarget.ok) {
      return emit({ kind: 'passthrough', cause: confirmedTarget.cause });
    }
    const reserved = reserveHookDispatch(ledgerKey, parsed.maxPerHour, now(), root);
    if (!reserved.allowed) {
      return emit({ kind: 'passthrough', cause: reserved.cause });
    }

    const sender = parsed.sender ?? defaultHookSenderLabel(parsed.agent);
    const sensitive = !parsed.showPreview;
    const requiresAuth = parsed.requiresAuth;
    const prompt = formatted.prompt;

    const askInput: Omit<AskParams, 'resumeId' | 'waitSeconds'> & { timeoutSeconds: number } =
      prompt.kind === 'diff'
        ? {
            title: prompt.title,
            message: prompt.message,
            diff: prompt.diff,
            requiresAuth,
            sensitive,
            timeoutSeconds,
          }
        : {
            title: prompt.title,
            message: prompt.message,
            options: ['Approve', 'Reject'],
            declineOption: 'Reject',
            requiresAuth,
            sensitive,
            timeoutSeconds,
          };

    const approveAction = prompt.kind === 'diff' ? 'approve' : 'Approve';
    const decision = io.dispatch
      ? await io.dispatch({
          destination: confirmedTarget.destination,
          sender,
          askInput,
          approveAction,
          requiresAuth,
          signal: controller.signal,
        })
      : await defaultDispatch({
          destination: confirmedTarget.destination,
          sender,
          askInput,
          approveAction,
          requiresAuth,
          signal: controller.signal,
          root,
        });

    if (decision.outcome === 'error' && decision.errorCode === 'DAILY_LIMIT_EXCEEDED') {
      recordHookQuotaExceeded(ledgerKey, now(), root);
    } else if (decision.outcome !== 'error') {
      recordHookDispatchSuccess(ledgerKey, root);
    }

    return emit(mapDecisionToVerdict(decision), decision.requestId);
  } catch {
    const cause = watchdogFired ? 'watchdog_timeout' : controller.signal.aborted ? 'aborted' : 'internal_error';
    return emit({ kind: 'passthrough', cause });
  } finally {
    clearTimeout(watchdog);
    if (io.signal) io.signal.removeEventListener('abort', onExternalAbort);
  }
}

/** CLI entrypoint for `nb hook ...` with process signal handling and guaranteed exit code 0. */
export async function runHookCli(rawArgs: string[]): Promise<void> {
  const parsed = parseHookArgs(rawArgs);
  if (parsed.help || rawArgs.length === 0) {
    printHookHelp();
    return;
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort(new DOMException('Signal received', 'AbortError'));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await runHook(rawArgs, { signal: controller.signal });
    process.exitCode = 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
