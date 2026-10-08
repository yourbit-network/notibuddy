import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NotiBuddyConfig, SenderKeyPair } from './types.js';
import { generateSenderSigningKeyPair, importSenderPrivateKey } from './crypto.js';

export const NOTIBUDDY_DIR = process.env.NOTIBUDDY_HOME || path.join(os.homedir(), '.notibuddy');
const CONFIG_FILE = path.join(NOTIBUDDY_DIR, 'config.json');
const SENDER_KEY_FILE = path.join(NOTIBUDDY_DIR, 'sender.json');

export function ensureConfigDir(): void {
  if (!fs.existsSync(NOTIBUDDY_DIR)) {
    fs.mkdirSync(NOTIBUDDY_DIR, { mode: 0o700, recursive: true });
  }
  fs.chmodSync(NOTIBUDDY_DIR, 0o700);
}

export function loadConfig(): NotiBuddyConfig | null {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as NotiBuddyConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: NotiBuddyConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export async function getOrCreateSenderKeyPair(): Promise<{
  senderKeyId: string;
  publicKeyB64u: string;
  signingKey: CryptoKey;
}> {
  ensureConfigDir();

  if (fs.existsSync(SENDER_KEY_FILE)) {
    try {
      const raw = fs.readFileSync(SENDER_KEY_FILE, 'utf-8');
      const stored = JSON.parse(raw) as SenderKeyPair;
      const signingKey = await importSenderPrivateKey(stored.privateKeyJwk);
      return {
        senderKeyId: stored.senderKeyId,
        publicKeyB64u: stored.publicKeyB64u,
        signingKey,
      };
    } catch {
      throw new Error('Stored sender key is unreadable. Restore it or pair again with a new key.');
    }
  }

  const generated = await generateSenderSigningKeyPair();
  const pairData: SenderKeyPair = {
    senderKeyId: generated.senderKeyId,
    publicKeyB64u: generated.publicKeyB64u,
    privateKeyJwk: generated.privateKeyJwk,
  };

  fs.writeFileSync(SENDER_KEY_FILE, JSON.stringify(pairData, null, 2) + '\n', {
    mode: 0o600,
  });

  return {
    senderKeyId: generated.senderKeyId,
    publicKeyB64u: generated.publicKeyB64u,
    signingKey: generated.privateKey,
  };
}
