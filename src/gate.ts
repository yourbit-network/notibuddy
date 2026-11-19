import { waitForDecision, type DecisionOutcome } from './approval.js';
import { argumentsFor, presentationFrom, resolveCliDestination, withShutdown } from './cli-support.js';
import { DestinationStore } from './config.js';
import { readDiffFile } from './diff-file.js';
import { MAX_REQUEST_TIMEOUT_SECONDS } from './request-timeout.js';
import { createDestinationRouter, type RoutingOptions } from './routing.js';

export const DEFAULT_GATE_TIMEOUT_SECONDS = 600;

export function gateExitCode(outcome: DecisionOutcome['outcome']): number {
  switch (outcome) {
    case 'approved':
      return 0;
    case 'rejected':
      return 2;
    case 'expired':
      return 3;
    case 'error':
      return 1;
  }
}

export function printGateHelp(): void {
  console.log(`Usage:
  nb gate "<title>" [--to <name>] [--sender <label>] [options]

Wait for a verified signed decision and exit with a fail-closed status code:
  0   Approved (verified reply matching approve action, plus device auth if --requires-auth)
  1   Operational or config error (no human decision: pairing, network, quota 402, device error)
  2   Rejected (verified human decline, missing required auth, or unexpected action)
  3   Expired or local deadline reached without a reply
  130 / 143  Interrupted (SIGINT / SIGTERM)

Options:
  --message, -m <text>       Context body shown on iPhone/Watch
  --approve <label>          Approving option label & ID (default: "Approve")
  --reject <label>           Declining option label (default: "Reject"; always skips Face ID)
  --diff <json-file>         Review original/modified diff (approves on action === "approve"; exclusive with --approve/--reject)
  --requires-auth            Require Face ID / Touch ID / passcode / unlocked Watch
  --sensitive                Hide content in notification previews
  --timeout <seconds>        Signed lifetime AND wait budget (default ${DEFAULT_GATE_TIMEOUT_SECONDS}, range 1–${MAX_REQUEST_TIMEOUT_SECONDS})
  --short-title <text>       Single-line presentation title override (max 40 chars)
  --summary <text>           Single-line presentation summary override (max 100 chars)
`);
}

export async function runGateCommand(
  routing: RoutingOptions,
  rest: string[],
  store = new DestinationStore(),
): Promise<void> {
  if (routing.client) {
    throw new Error('nb gate requires an explicit destination (--to <name>), not --client.');
  }
  if (routing.allowTo) {
    throw new Error('--allow-to is only supported by MCP; use --to.');
  }

  const args = argumentsFor(
    rest,
    ['--message', '--approve', '--reject', '--diff', '--timeout', '--short-title', '--summary'],
    ['--requires-auth', '--sensitive'],
  );
  if (args.positional.length !== 1 || !args.positional[0].trim()) {
    throw new Error('Provide one quoted gate title: nb gate "<title>" [--to <name>] [options]');
  }
  const title = args.positional[0];
  const diffFile = args.text('--diff');
  const rawApprove = args.text('--approve');
  const rawReject = args.text('--reject');

  if (diffFile !== undefined && (rawApprove !== undefined || rawReject !== undefined)) {
    throw new Error('--diff cannot be combined with --approve or --reject.');
  }

  const approveLabel = (rawApprove ?? 'Approve').trim();
  const rejectLabel = (rawReject ?? 'Reject').trim();
  if (!approveLabel || !rejectLabel) {
    throw new Error('--approve and --reject labels must be non-empty.');
  }
  if (approveLabel === rejectLabel) {
    throw new Error('--approve and --reject must be different.');
  }

  const timeoutSeconds = args.number('--timeout') ?? DEFAULT_GATE_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_REQUEST_TIMEOUT_SECONDS) {
    throw new Error(`Invalid --timeout: use a whole number between 1 and ${MAX_REQUEST_TIMEOUT_SECONDS}.`);
  }

  const diff = diffFile === undefined ? undefined : readDiffFile(diffFile);
  const requiresAuth = args.flag('--requires-auth');
  const sensitive = args.flag('--sensitive') || undefined;
  const presentation = presentationFrom(args.text('--short-title'), args.text('--summary'));

  const targetTo = resolveCliDestination(routing, store);
  const router = await createDestinationRouter({ ...routing, to: targetTo }, store, true);
  try {
    const route = router.resolve();
    const askInput =
      diff !== undefined
        ? {
            title,
            message: args.text('--message'),
            diff,
            requiresAuth,
            sensitive,
            presentation,
            timeoutSeconds,
          }
        : {
            title,
            message: args.text('--message'),
            options: [approveLabel, rejectLabel],
            declineOption: rejectLabel,
            requiresAuth,
            sensitive,
            presentation,
            timeoutSeconds,
          };

    const spec = {
      approveAction: diff !== undefined ? 'approve' : approveLabel,
      requiresAuth,
    };

    const outcome = await withShutdown((signal) =>
      waitForDecision(route.client, askInput, spec, {
        signal,
        localGraceSeconds: 15,
        onPending: ({ requestId, attempt }) => {
          if (attempt === 1) {
            console.error(`Waiting for reply on '${route.name}' (request ${requestId})...`);
          }
        },
      }),
    );

    const output: Record<string, unknown> = {
      outcome: outcome.outcome,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
      ...('action' in outcome && outcome.action !== undefined ? { action: outcome.action } : {}),
      ...('authenticated' in outcome ? { authenticated: outcome.authenticated } : {}),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('errorCode' in outcome && outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
      ...('message' in outcome && outcome.message !== undefined ? { message: outcome.message } : {}),
      to: route.name,
      connectionId: route.record.connectionId,
    };
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = gateExitCode(outcome.outcome);
  } finally {
    router.close();
  }
}
