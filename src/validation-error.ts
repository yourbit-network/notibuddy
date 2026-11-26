import { ZodError } from 'zod';

const MCP_FIELD_NAMES: Record<string, string> = {
  timeoutSeconds: 'timeout_seconds',
  waitSeconds: 'wait_seconds',
  declineOption: 'decline_option',
  inputPlaceholder: 'input_placeholder',
  requiresAuth: 'requires_auth',
  resumeId: 'resume_id',
  dryRun: 'dry_run',
  timerMinutes: 'timer_minutes',
  totalSteps: 'total_steps',
  activityId: 'id',
};

const CLI_FIELD_NAMES: Record<string, string> = {
  timeoutSeconds: '--timeout',
  waitSeconds: '--wait',
  declineOption: '--decline-option',
  inputPlaceholder: '--placeholder',
  requiresAuth: '--requires-auth',
  resumeId: '--resume',
  dryRun: '--dry-run',
  timerMinutes: '--timer',
  totalSteps: '--total-steps',
  activityId: '<id>',
  shortTitle: '--short-title',
  summary: '--summary',
  title: '--title',
  message: '--message',
  status: '--status',
  step: '--step',
  options: '--options',
  controls: '--controls',
  fields: '--fields',
  diff: '--diff',
  screen: '--screen',
};

function formatPath(path: PropertyKey[], mode: 'cli' | 'mcp'): string {
  const map = mode === 'cli' ? CLI_FIELD_NAMES : MCP_FIELD_NAMES;
  const parts: string[] = [];
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (parts.length > 0) parts[parts.length - 1] += `[${segment}]`;
      else parts.push(`[${segment}]`);
      continue;
    }
    const key = String(segment);
    parts.push(map[key] ?? key);
  }
  return parts.join('.');
}

/** Format Zod validation errors as a single readable sentence for CLI or MCP callers. */
export function formatValidationError(error: unknown, mode: 'cli' | 'mcp'): string {
  if (!(error instanceof ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const issue = error.issues[0];
  if (!issue) return 'Invalid input';
  const field = formatPath(issue.path, mode);
  return field ? `Invalid ${field}: ${issue.message}` : issue.message;
}
