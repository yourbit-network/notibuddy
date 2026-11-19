import type { AskParams, AskResult, NotiBuddyClient } from './client.js';
import { pollPause } from './client-http.js';
import { MAX_REPLY_WAIT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS } from './request-timeout.js';

export interface ApprovalSpec {
  /** Exact signed `answer.action` value that constitutes approval (e.g. `"Approve"` or `"approve"` for diffs). */
  approveAction: string;
  /** When true, `answer.authenticated === true` is strictly required for approval. */
  requiresAuth: boolean;
}

export type DecisionOutcome =
  | {
      outcome: 'approved';
      requestId: string;
      action: string;
      authenticated: boolean;
    }
  | {
      outcome: 'rejected';
      requestId: string;
      reason: 'declined' | 'unauthenticated' | 'unexpected_action';
      action?: string;
      authenticated: boolean;
    }
  | {
      outcome: 'expired';
      requestId: string;
    }
  | {
      outcome: 'error';
      requestId?: string;
      errorCode?: string;
      message: string;
    };

export interface WaitForDecisionOptions {
  /** Additional seconds to keep polling after `timeoutSeconds` to observe the relay's 410 expiry cleanly. */
  localGraceSeconds?: number;
  /** Per-call wait window in seconds (clamped to MAX_REPLY_WAIT_SECONDS). */
  windowSeconds?: number;
  signal?: AbortSignal;
  onPending?: (info: { requestId: string; attempt: number; errorCode?: string }) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Single authoritative fail-closed verdict function shared by `nb gate` and `nb hook`.
 * Only a cryptographically verified `resolved` reply whose `action` exactly equals
 * `spec.approveAction` (and `authenticated === true` when required) yields `approved`.
 */
export function judge(result: AskResult, spec: ApprovalSpec): DecisionOutcome {
  if (result.status === 'resolved') {
    const action = result.answer?.action;
    const authenticated = result.answer?.authenticated === true;
    if (action !== spec.approveAction) {
      return {
        outcome: 'rejected',
        requestId: result.requestId,
        reason: typeof action === 'string' && action.length > 0 ? 'declined' : 'unexpected_action',
        ...(typeof action === 'string' ? { action } : {}),
        authenticated,
      };
    }
    if (spec.requiresAuth && !authenticated) {
      return {
        outcome: 'rejected',
        requestId: result.requestId,
        reason: 'unauthenticated',
        action,
        authenticated: false,
      };
    }
    return {
      outcome: 'approved',
      requestId: result.requestId,
      action,
      authenticated,
    };
  }

  if (result.status === 'expired') {
    return { outcome: 'expired', requestId: result.requestId };
  }

  return {
    outcome: 'error',
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    message: result.message ?? `Request ended with status '${result.status}'.`,
  };
}

/**
 * Dispatch one interactive request and loop `--resume` windows until resolved, rejected,
 * definitively errored, expired, aborted, or the local deadline expires.
 * Never creates a second POST request for the same decision and backs off on transient
 * `RETRY_REQUIRED` / fast-failing network errors to avoid hot-spinning.
 */
export async function waitForDecision(
  client: Pick<NotiBuddyClient, 'ask'>,
  askInput: Omit<AskParams, 'resumeId' | 'waitSeconds'> & { timeoutSeconds: number },
  spec: ApprovalSpec,
  options: WaitForDecisionOptions = {},
): Promise<DecisionOutcome> {
  const timeoutSeconds = askInput.timeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_REQUEST_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be an integer between 1 and ${MAX_REQUEST_TIMEOUT_SECONDS}`);
  }
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? pollPause;
  const localGraceSeconds = Math.max(0, options.localGraceSeconds ?? 15);
  const maxWindowSeconds = Math.min(MAX_REPLY_WAIT_SECONDS, Math.max(1, options.windowSeconds ?? MAX_REPLY_WAIT_SECONDS));
  const deadlineMs = now() + (timeoutSeconds + localGraceSeconds) * 1000;

  let requestId: string | undefined;
  let attempt = 0;
  let backoffMs = 1_000;

  while (true) {
    options.signal?.throwIfAborted();
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      return requestId
        ? { outcome: 'expired', requestId }
        : { outcome: 'error', errorCode: 'WAIT_DEADLINE', message: 'Deadline expired before dispatch.' };
    }

    attempt += 1;
    const waitSeconds = Math.min(maxWindowSeconds, Math.max(1, Math.ceil(remainingMs / 1000)));
    const callStarted = now();
    const result =
      requestId === undefined
        ? await client.ask({ ...askInput, timeoutSeconds, waitSeconds }, { signal: options.signal })
        : await client.ask({ resumeId: requestId, waitSeconds }, { signal: options.signal });

    if (result.status !== 'pending') {
      return judge(result, spec);
    }

    requestId = result.requestId;
    options.onPending?.({ requestId, attempt, errorCode: result.errorCode });

    const remainingAfterMs = deadlineMs - now();
    if (remainingAfterMs <= 0) {
      return { outcome: 'expired', requestId };
    }

    const elapsedMs = now() - callStarted;
    const fastRetry = result.errorCode === 'RETRY_REQUIRED' || (waitSeconds > 2 && elapsedMs < 2_000);
    if (fastRetry) {
      const pauseMs = Math.min(backoffMs, remainingAfterMs);
      backoffMs = Math.min(10_000, backoffMs * 2);
      if (pauseMs > 0) await sleep(pauseMs, options.signal);
    } else {
      backoffMs = 1_000;
    }
  }
}
