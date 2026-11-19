---
name: notibuddy-hooks
description: Configure and troubleshoot NotiBuddy's opt-in native permission hook (`nb hook`) for remote approvals from iPhone and Apple Watch.
---

# NotiBuddy Hooks

Forward Claude Code `PermissionRequest` prompts (including native encrypted diffs for `Edit`) to your paired iPhone or Apple Watch via `nb hook` without using `npx`.

## Requirements

- Install `nb` locally so hook startup stays fast (hooks never call `npx`):
  ```bash
  brew install yourbit-network/tap/notibuddy
  # or: npm install -g notibuddy
  ```
- Pair your iPhone in Terminal (`pbpaste | nb pair --to personal`) and, if you have two or more destinations, run `nb bind --client claude-code --to personal`.
- If `nb` is not installed, unpaired, or unbound with 2+ destinations, the hook exits `0` immediately and lets your normal terminal prompt appear.

## Enabling the Hook in Claude Code

Either install the opt-in hooks plugin from the GitHub marketplace:
```text
/plugin install notibuddy-hooks --marketplace yourbit-network/notibuddy
```

Or merge this `PermissionRequest` entry into `~/.claude/settings.json`:
```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nb hook claude PermissionRequest --client claude-code --timeout 300",
            "timeout": 330
          }
        ]
      }
    ]
  }
}
```

## Behavior

- **10-second grace period (`--grace 10`):** When you are at your desk and answer the terminal prompt within 10 seconds, the host cancels the hook and zero notifications or Free-tier requests are sent.
- **Hidden previews by default (`sensitive: true`):** Lock Screen previews stay hidden until you open NotiBuddy (opt out with `--show-preview`).
- **Face ID opt-in:** Face ID is off by default for routine permission approvals; add `--requires-auth` to the hook command if you want biometrics on every hook prompt.
- **Fail-safe passthrough:** Timeouts, quota limits (`402` triggers a 15m -> 30m -> 60m cooldown), network drops, or oversized inputs fall through silently to the terminal.
- **Debugging:** Set `NOTIBUDDY_HOOK_DEBUG=1` to print metadata-only passthrough causes to stderr (never prints `tool_input` or commands).
