#!/usr/bin/env node
import { readFileSync } from 'node:fs';

/**
 * Thin zero-dependency dispatcher so `--version` and skipped `nb hook` invocations
 * never pay the startup cost of loading zod, @hpke/core, or @modelcontextprotocol/sdk.
 */
function extractHookArgs(raw: string[]): string[] | undefined {
  if (raw[0] === 'hook') return raw.slice(1);
  // Also support routing flags placed before the `hook` subcommand (e.g. `nb --client claude-code hook ...`).
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (token === '--to' || token === '--client' || token === '--sender' || token === '--allow-to') {
      i += 1;
      continue;
    }
    if (
      token.startsWith('--to=') ||
      token.startsWith('--client=') ||
      token.startsWith('--sender=') ||
      token.startsWith('--allow-to=')
    ) {
      continue;
    }
    if (token.startsWith('-')) return undefined;
    if (token === 'hook') return [...raw.slice(0, i), ...raw.slice(i + 1)];
    return undefined;
  }
  return undefined;
}

async function dispatch(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw.length === 1 && (raw[0] === '--version' || raw[0] === '-V' || raw[0] === '-v')) {
    const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    console.log(`notibuddy ${version}`);
    return;
  }

  const hookArgs = extractHookArgs(raw);
  if (hookArgs !== undefined) {
    const { runHookCli } = await import('./hook.js');
    await runHookCli(hookArgs);
    return;
  }

  const { runMainCli } = await import('./cli-main.js');
  await runMainCli(raw);
}

void dispatch();
