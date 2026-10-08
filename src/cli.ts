#!/usr/bin/env node

import os from 'node:os';
import { parsePairingBundle } from './protocol.js';
import { computePairingMac } from './crypto.js';
import { loadConfig, saveConfig, getOrCreateSenderKeyPair, NOTIBUDDY_DIR } from './config.js';
import { NotiBuddyClient } from './client.js';
import { runMcpServer } from './mcp.js';
import fs from 'node:fs';
import path from 'node:path';

function printHelp(): void {
  console.log(`
NotiBuddy CLI (nb) — Zero-Knowledge E2EE Bridge for AI Agents

Usage:
  nb pair <bundle> [--label <name>]    Pair with iPhone using out-of-band bundle
  nb ask "<title>" [options]           Ask user for an approval, choice, or text
  nb activity <id> <action> [options]  Control Dynamic Island Live Activity
  nb mcp                               Start Model Context Protocol (MCP) server
  nb status                            Display current pairing and device info
  nb unpair                            Clear local pairing credentials

Options for 'nb ask':
  --message, -m <text>         Detailed prompt text
  --options, -o <a,b,...>      Comma-separated list of action buttons
  --placeholder, -p <text>     Input placeholder for free-text reply
  --wait, -w <seconds>         Seconds to wait before returning pending (max 55)
  --resume <request-id>        Resume a request, including after a restart
  --requires-auth              Require Face ID / Touch ID on iPhone
  --sensitive                  Hide content in notifications and Live Activities

Options for 'nb activity':
  --title, -t <text>           Title displayed on Dynamic Island
  --status, -s <text>          Status text (e.g. "Running unit tests...")
  --step <number>              Current step number
  --total-steps <number>       Total steps in progress
  --timer <minutes>            Hardware countdown timer in minutes
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === 'mcp') {
    await runMcpServer();
    return;
  }

  if (command === 'status') {
    const config = loadConfig();
    if (!config) {
      console.log('NotiBuddy is NOT paired. Run "nb pair <bundle>" to connect.');
      return;
    }
    console.log(`
NotiBuddy configuration saved (confirm phone approval in Connect)
------------------------
Device Name:   ${config.device.name || 'iPhone'}
Device ID:     ${config.device.id}
Sender ID:     ${config.senderKeyId}
Sender Label:  ${config.senderLabel}
Relay URL:     ${config.relay}
`);
    return;
  }

  if (command === 'unpair') {
    const configPath = path.join(NOTIBUDDY_DIR, 'config.json');
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      console.log('Local pairing credentials removed.');
    } else {
      console.log('No active pairing found.');
    }
    return;
  }

  if (command === 'pair') {
    let bundleStr = args[1];
    let label = `${os.userInfo().username}@${os.hostname()}`;

    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '--label' || args[i] === '-l') && args[i + 1]) {
        label = args[i + 1];
        i++;
      }
    }

    if (!bundleStr) {
      console.error('Error: Missing pairing bundle. Run "nb pair nbpair1.<b64u>"');
      process.exit(1);
    }

    try {
      console.log('Validating cryptographic pairing bundle...');
      const bundle = await parsePairingBundle(bundleStr);

      const senderKeys = await getOrCreateSenderKeyPair();
      console.log(`Using sender identity: ${senderKeys.senderKeyId} (${label})`);

      const mac = await computePairingMac(
        bundle.pairSecret,
        bundle.device.id,
        senderKeys.senderKeyId,
        senderKeys.publicKeyB64u,
        label
      );

      const client = new NotiBuddyClient(
        {
          relay: bundle.relay,
          token: bundle.token,
          device: bundle.device,
          senderKeyId: senderKeys.senderKeyId,
          senderLabel: label,
        },
        senderKeys.signingKey
      );

      console.log(`Registering sender key with relay at ${bundle.relay}...`);
      const registrationStatus = await client.registerSender({
        senderKeyId: senderKeys.senderKeyId,
        senderPub: senderKeys.publicKeyB64u,
        label,
        mac,
      });

      saveConfig({
        relay: bundle.relay,
        token: bundle.token,
        device: bundle.device,
        senderKeyId: senderKeys.senderKeyId,
        senderLabel: label,
      });

      console.log(`
${registrationStatus === 'registered' ? 'Pairing confirmed' : 'Phone approval required'}
-------------------
Paired with:   ${bundle.device.name || 'iPhone'} (${bundle.device.id})
Relay:         ${bundle.relay}
Sender Key ID: ${senderKeys.senderKeyId}

Open NotiBuddy → Connect. Compare the Sender Key ID above, then approve this computer.
After approval you can use "nb ask" or connect your MCP client. Pending approval expires after 15 minutes.
`);
    } catch (err: any) {
      console.error(`Pairing failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'ask') {
    const config = loadConfig();
    if (!config) {
      console.error('Error: NotiBuddy is not paired. Run "nb pair <bundle>" first.');
      process.exit(1);
    }

    const title = args[1]?.startsWith('-') ? undefined : args[1];
    const resumeIndex = args.indexOf('--resume');
    const resumeId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
    if (!title && !resumeId) {
      console.error('Error: "nb ask" requires a title. Example: nb ask "Deploy to production?"');
      process.exit(1);
    }

    let message: string | undefined;
    let options: string[] | undefined;
    let inputPlaceholder: string | undefined;
    let waitSeconds = 45;
    let requiresAuth = false;
    let sensitive = false;

    for (let i = title ? 2 : 1; i < args.length; i++) {
      if ((args[i] === '--message' || args[i] === '-m') && args[i + 1]) {
        message = args[i + 1]; i++;
      } else if ((args[i] === '--options' || args[i] === '-o') && args[i + 1]) {
        options = args[i + 1].split(',').map((s) => s.trim()); i++;
      } else if ((args[i] === '--placeholder' || args[i] === '-p') && args[i + 1]) {
        inputPlaceholder = args[i + 1]; i++;
      } else if ((args[i] === '--wait' || args[i] === '-w') && args[i + 1]) {
        waitSeconds = parseInt(args[i + 1], 10); i++;
      } else if (args[i] === '--sensitive') {
        sensitive = true;
      } else if (args[i] === '--requires-auth') {
        requiresAuth = true;
      }
    }

    try {
      const senderKeys = await getOrCreateSenderKeyPair();
      const client = new NotiBuddyClient(config, senderKeys.signingKey);

      const result = await client.ask({
        title,
        resumeId,
        message,
        options,
        inputPlaceholder,
        requiresAuth,
        sensitive,
        waitSeconds,
      });

      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error(`Ask failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'activity') {
    const config = loadConfig();
    if (!config) {
      console.error('Error: NotiBuddy is not paired. Run "nb pair <bundle>" first.');
      process.exit(1);
    }

    const id = args[1];
    const action = args[2] as 'start' | 'update' | 'end' | 'poll';

    if (!id || !['start', 'update', 'end', 'poll'].includes(action)) {
      console.error('Usage: nb activity <id> <start|update|end|poll> [options]');
      process.exit(1);
    }

    let title: string | undefined;
    let status: string | undefined;
    let step: number | undefined;
    let totalSteps: number | undefined;
    let timerMinutes: number | undefined;

    for (let i = 3; i < args.length; i++) {
      if ((args[i] === '--title' || args[i] === '-t') && args[i + 1]) {
        title = args[i + 1]; i++;
      } else if ((args[i] === '--status' || args[i] === '-s') && args[i + 1]) {
        status = args[i + 1]; i++;
      } else if (args[i] === '--step' && args[i + 1]) {
        step = parseInt(args[i + 1], 10); i++;
      } else if (args[i] === '--total-steps' && args[i + 1]) {
        totalSteps = parseInt(args[i + 1], 10); i++;
      } else if (args[i] === '--timer' && args[i + 1]) {
        timerMinutes = parseFloat(args[i + 1]); i++;
      }
    }

    try {
      const senderKeys = await getOrCreateSenderKeyPair();
      const client = new NotiBuddyClient(config, senderKeys.signingKey);

      const result = await client.activity({
        activityId: id,
        action,
        title,
        status,
        step,
        totalSteps,
        timerMinutes,
      });

      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error(`Activity failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${command}. Run "nb help" for usage.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`Fatal CLI error: ${err.message}`);
  process.exit(1);
});
