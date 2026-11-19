import type { DiffInput } from './types.js';

/** Maximum UTF-8 bytes allowed in a literal approval message before falling through to the local terminal. */
export const MAX_HOOK_MESSAGE_BYTES = 8_000;
/** Maximum combined UTF-8 bytes allowed for Edit/Write diff review via hook; larger edits fall through (never truncated). */
export const MAX_HOOK_DIFF_BYTES = 16_000;
export const MAX_HOOK_DIFF_LINES = 400;
export const MAX_HOOK_FILENAME_BYTES = 512;

export interface ClaudePermissionInput {
  hookEventName: 'PermissionRequest';
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
  sessionId?: string;
}

export type HookPromptSpec =
  | {
      kind: 'approval';
      title: string;
      message: string;
    }
  | {
      kind: 'diff';
      title: string;
      message: string;
      diff: DiffInput;
    };

export type FormatHookResult = { ok: true; prompt: HookPromptSpec } | { ok: false; cause: string };

/**
 * Visibly escape control characters (except \n and \t), carriage returns, Unicode format/bidi
 * characters (\p{Cf}), and lone surrogates into `\u{XXXX}` notation without Unicode normalization.
 * Stronger than silent stripping: Trojan Source and terminal-overwrite spoofing become visibly obvious.
 */
export function escapeUntrustedVisible(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    // Detect lone UTF-16 surrogates first so output is always valid Unicode.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        out += `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`;
        i += 1;
        continue;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`;
      i += 1;
      continue;
    }

    const cp = text.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + step);
    i += step;

    if (cp === 0x0a || cp === 0x09) {
      out += ch;
    } else if (cp === 0x0d) {
      out += '\\r';
    } else if (/^[\p{Cc}\p{Cf}]$/u.test(ch)) {
      out += `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function escapeSingleLine(text: string): string {
  return escapeUntrustedVisible(text).replaceAll('\n', '\\n').replaceAll('\t', '\\t');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

function formatCwdLine(cwd?: string): string {
  return cwd ? `Dir: ${escapeSingleLine(cwd)}\n\n` : '';
}

function inferLanguage(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0 || dot === filePath.length - 1) return undefined;
  const ext = filePath.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    py: 'python',
    swift: 'swift',
    rs: 'rust',
    go: 'go',
    sh: 'bash',
    zsh: 'bash',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    tf: 'hcl',
    toml: 'toml',
    css: 'css',
    html: 'html',
    astro: 'astro',
  };
  return map[ext];
}

/**
 * Formats a Claude Code PermissionRequest for NotiBuddy strictly upholding display invariants:
 * - Attacker-influenced text NEVER enters `title`, `shortTitle`, or `summary`.
 * - Literal command is shown; model-written `description` is omitted for Bash.
 * - Never truncates and approves: oversized inputs fail closed to passthrough.
 */
export function formatClaudePermission(input: ClaudePermissionInput): FormatHookResult {
  const { toolName, toolInput, cwd } = input;

  if (toolName === 'Bash') {
    const command = toolInput.command;
    if (typeof command !== 'string' || command.length === 0) {
      return { ok: false, cause: 'missing_bash_command' };
    }
    // Intentionally omit `toolInput.description` (model-written prose can contradict the literal command).
    const message = `${formatCwdLine(cwd)}$ ${escapeUntrustedVisible(command)}`;
    if (byteLength(message) > MAX_HOOK_MESSAGE_BYTES) {
      return { ok: false, cause: 'oversized_bash_command' };
    }
    return {
      ok: true,
      prompt: {
        kind: 'approval',
        title: 'Approve Bash command?',
        message,
      },
    };
  }

  if (toolName === 'Edit') {
    const filePath = toolInput.file_path;
    const oldString = toolInput.old_string;
    const newString = toolInput.new_string;
    const replaceAll = toolInput.replace_all === true;
    if (typeof filePath !== 'string' || !filePath.trim() || typeof oldString !== 'string' || typeof newString !== 'string') {
      return { ok: false, cause: 'invalid_edit_input' };
    }
    const safeFilename = escapeSingleLine(filePath.trim());
    const escapedOld = escapeUntrustedVisible(oldString);
    const escapedNew = escapeUntrustedVisible(newString);
    if (
      byteLength(safeFilename) > MAX_HOOK_FILENAME_BYTES ||
      byteLength(escapedOld) + byteLength(escapedNew) > MAX_HOOK_DIFF_BYTES ||
      lineCount(escapedOld) + lineCount(escapedNew) > MAX_HOOK_DIFF_LINES
    ) {
      return { ok: false, cause: 'oversized_edit_diff' };
    }
    const prefix = replaceAll ? 'Replace all occurrences\n' : '';
    const message = `${prefix}${formatCwdLine(cwd)}File: ${safeFilename}`.trimEnd();
    if (byteLength(message) > MAX_HOOK_MESSAGE_BYTES) {
      return { ok: false, cause: 'oversized_edit_message' };
    }
    const language = inferLanguage(filePath);
    return {
      ok: true,
      prompt: {
        kind: 'diff',
        title: 'Approve file edit?',
        message,
        diff: {
          filename: safeFilename,
          ...(language ? { language } : {}),
          original: escapedOld,
          modified: escapedNew,
        },
      },
    };
  }

  if (toolName === 'Write') {
    const filePath = toolInput.file_path;
    const content = toolInput.content;
    if (typeof filePath !== 'string' || !filePath.trim() || typeof content !== 'string') {
      return { ok: false, cause: 'invalid_write_input' };
    }
    const safeFilename = escapeSingleLine(filePath.trim());
    const escapedContent = escapeUntrustedVisible(content);
    if (
      byteLength(safeFilename) > MAX_HOOK_FILENAME_BYTES ||
      byteLength(escapedContent) > MAX_HOOK_DIFF_BYTES ||
      lineCount(escapedContent) + 1 > MAX_HOOK_DIFF_LINES
    ) {
      return { ok: false, cause: 'oversized_write_diff' };
    }
    const message = `${formatCwdLine(cwd)}Write file: ${safeFilename}`.trimEnd();
    if (byteLength(message) > MAX_HOOK_MESSAGE_BYTES) {
      return { ok: false, cause: 'oversized_write_message' };
    }
    const language = inferLanguage(filePath);
    return {
      ok: true,
      prompt: {
        kind: 'diff',
        title: 'Approve file write?',
        message,
        diff: {
          filename: safeFilename,
          ...(language ? { language } : {}),
          original: '',
          modified: escapedContent,
        },
      },
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(toolInput, null, 2);
  } catch {
    return { ok: false, cause: 'unserializable_tool_input' };
  }
  const message = `Tool: ${escapeSingleLine(toolName)}\n${formatCwdLine(cwd)}${escapeUntrustedVisible(serialized)}`;
  if (byteLength(message) > MAX_HOOK_MESSAGE_BYTES) {
    return { ok: false, cause: 'oversized_tool_input' };
  }
  return {
    ok: true,
    prompt: {
      kind: 'approval',
      title: 'Approve tool request?',
      message,
    },
  };
}
