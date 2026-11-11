import type { Readable, Writable } from 'node:stream';

/** Upper bound for a pasted or piped setup code; real bundles are a few KiB. */
export const MAX_SETUP_CODE_BYTES = 64 * 1024;
export const SETUP_CODE_PROMPT = 'Paste the setup code from NotiBuddy, then press Return: ';

export type SetupCodeInput = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

function tooLarge(): Error { return new Error(`The setup code is longer than ${MAX_SETUP_CODE_BYTES / 1024} KiB. Copy it again from NotiBuddy.`); }
function empty(): Error { return new Error('No setup code received. Copy it from NotiBuddy and paste it when asked.'); }

async function readPiped(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    size += buffer.length;
    if (size > MAX_SETUP_CODE_BYTES) throw tooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readHidden(input: SetupCodeInput, output: Writable): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
      try { input.setRawMode?.(false); } catch { /* terminal already closed */ }
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(text);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') { process.exitCode = 130; return finish(Object.assign(new Error('Interrupted'), { name: 'AbortError' })); }
        if (char === '\u0004') return finish();
        if (char === '\u007f' || char === '\b') { text = text.slice(0, -1); continue; }
        text += char;
        if (Buffer.byteLength(text) > MAX_SETUP_CODE_BYTES) return finish(tooLarge());
      }
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    input.on('data', onData); input.once('end', onEnd); input.once('error', onError);
    try { input.setRawMode?.(true); } catch (error) { return finish(error as Error); }
    input.resume();
  });
}

/** Reads the setup code without echo from a terminal, or from a pipe. The code never touches argv. */
export async function readSetupCode(input: SetupCodeInput, output: Writable): Promise<string> {
  let code: string;
  if (input.isTTY) {
    output.write(SETUP_CODE_PROMPT);
    code = await readHidden(input, output);
  } else code = await readPiped(input);
  code = code.trim();
  if (!code) throw empty();
  return code;
}
