# NotiBuddy Hooks for Claude Code

Opt-in native permission hook that forwards Claude Code prompts to your iPhone or Apple Watch after a short grace period.

## Install

```
/plugin install notibuddy-hooks --marketplace yourbit-network/notibuddy
```

## Prerequisites

Install the local `nb` CLI (hooks never call `npx`):

```bash
brew install yourbit-network/tap/notibuddy
# or: npm install -g notibuddy
```

Then pair your iPhone in Terminal (and run `nb bind --client claude-code --to <alias>` if you have more than one destination).

Full setup guide: https://notibuddy.app/claude-code
