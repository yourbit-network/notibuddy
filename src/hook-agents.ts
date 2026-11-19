import type { ClaudePermissionInput } from './hook-display.js';

export type HookVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'passthrough'; cause: string };

export interface RenderedHookOutput {
  stdout: string;
  exitCode: 0;
}

export type ParseHookResult =
  | { ok: true; input: ClaudePermissionInput }
  | { ok: false; cause: string };

/**
 * Pure argv-only passthrough stdout bytes, computable before reading stdin so watchdogs,
 * signal handlers, and top-level error catches always emit valid host-specific output.
 */
export function passthroughStdoutFor(agent: string | undefined, event: string | undefined): string {
  if (agent === 'claude') return '';
  if (agent === 'antigravity') {
    return event === 'Stop' ? '{"decision":""}\n' : '{}\n';
  }
  return '{}\n';
}

export function defaultHookSenderLabel(agent: string): string {
  switch (agent) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'antigravity':
      return 'Antigravity';
    default:
      return agent;
  }
}

export function defaultHookTimeoutSeconds(agent: string): number {
  switch (agent) {
    case 'claude':
      return 300;
    case 'antigravity':
      return 180;
    default:
      return 180;
  }
}

/** Pure, hand-written stdin guard for Claude Code `PermissionRequest` (zero zod). */
export function parseClaudePermissionRequest(rawText: string): ParseHookResult {
  if (!rawText.trim()) return { ok: false, cause: 'empty_stdin' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, cause: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, cause: 'stdin_not_object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.hook_event_name !== 'PermissionRequest') {
    return { ok: false, cause: `unexpected_event_${String(obj.hook_event_name ?? 'missing')}` };
  }
  if (typeof obj.tool_name !== 'string' || obj.tool_name.trim().length === 0) {
    return { ok: false, cause: 'missing_tool_name' };
  }
  if (!obj.tool_input || typeof obj.tool_input !== 'object' || Array.isArray(obj.tool_input)) {
    return { ok: false, cause: 'missing_tool_input' };
  }
  const cwd = typeof obj.cwd === 'string' && obj.cwd.length > 0 ? obj.cwd : undefined;
  const sessionId = typeof obj.session_id === 'string' && obj.session_id.length > 0 ? obj.session_id : undefined;
  return {
    ok: true,
    input: {
      hookEventName: 'PermissionRequest',
      toolName: obj.tool_name,
      toolInput: obj.tool_input as Record<string, unknown>,
      ...(cwd ? { cwd } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
  };
}

/**
 * Pure renderer for Claude Code `PermissionRequest`.
 * Security invariant: never emits `updatedInput`, `updatedPermissions`, or `interrupt`.
 */
export function renderClaudePermission(verdict: HookVerdict): RenderedHookOutput {
  if (verdict.kind === 'allow') {
    return {
      stdout:
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        }) + '\n',
      exitCode: 0,
    };
  }
  if (verdict.kind === 'deny') {
    return {
      stdout:
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'deny',
              message: verdict.reason,
            },
          },
        }) + '\n',
      exitCode: 0,
    };
  }
  return { stdout: '', exitCode: 0 };
}
