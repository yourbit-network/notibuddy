# NotiBuddy for Claude Code

End-to-end encrypted iPhone and Apple Watch custom screens, approvals, code diffs, structured forms, live progress, and file sharing for AI agents.

## Install

```
/plugin install notibuddy --marketplace yourbit-network/notibuddy
```

## Quick Start

1. Install the **NotiBuddy** app on iPhone or iPad ([App Store](https://apps.apple.com/app/id6823749991)).
2. Open **NotiBuddy → Connect → Add → Create setup code → Share Setup**, then run in your own terminal:
   ```bash
   pbpaste | npx -y notibuddy@^0.4.0 pair --to personal
   ```
3. If you pair more than one phone or CI destination, bind Claude Code explicitly:
   ```bash
   nb bind --client claude-code --to personal
   ```

Full setup guide: https://notibuddy.app/claude-code
