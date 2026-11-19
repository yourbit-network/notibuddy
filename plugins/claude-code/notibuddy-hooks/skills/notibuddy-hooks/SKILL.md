---
name: notibuddy-hooks
description: Configure and troubleshoot NotiBuddy's opt-in native permission hook (`nb hook`) for remote approvals from iPhone and Apple Watch.
---

# NotiBuddy Hooks

This opt-in plugin wires native permission requests to `nb hook` without using `npx`.

## Requirements

- Install `nb` locally so hook startup stays fast:
  ```bash
  brew install yourbit-network/tap/notibuddy
  # or: npm install -g notibuddy
  ```
- If `nb` is not installed, unpaired, or unbound with 2+ destinations, the hook exits `0` immediately and lets your normal terminal prompt appear.

## Behavior

- **10-second grace period (`--grace 10`):** When you are at your desk and answer the terminal prompt within 10 seconds, the host cancels the hook and zero notifications or Free-tier requests are sent.
- **Hidden previews by default (`sensitive: true`):** Lock Screen previews stay hidden until you open NotiBuddy.
- **Face ID opt-in:** Face ID is off by default for routine permission approvals; add `--requires-auth` in a custom hook command if you want biometrics on every hook prompt.
- **Fail-safe passthrough:** Timeouts, quota limits (`402` triggers a 15m -> 30m -> 60m cooldown), network drops, or oversized inputs fall through silently to the terminal.
- **Debugging:** Set `NOTIBUDDY_HOOK_DEBUG=1` to print metadata-only passthrough causes to stderr (never prints `tool_input` or commands).
