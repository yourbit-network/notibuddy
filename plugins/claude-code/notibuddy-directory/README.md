# NotiBuddy

Turn your iPhone, iPad, and Apple Watch into a two-way native control surface for Claude—with a dynamic custom screen builder, biometric approval gates, Lock Screen Live Activities, and iPhone-to-Claude file sharing.

Unlike built-in notifications that only ping you to return to a chat thread, NotiBuddy lets Claude compose bespoke native iOS screens on the fly from 12 UI blocks (inline code diffs, KPI strips, key-value lists, alerts, checklists, toggles, pickers, steppers, and structured forms) with optional dry-run validation, or launch 8 ready-made developer presets across Claude, MCP-compatible IDEs, CI/CD pipelines, and local CLI scripts.

## Quick Start

1. Install the **NotiBuddy** companion app on iPhone or iPad ([App Store](https://apps.apple.com/app/id6823749991)).
2. Connect the bundled **NotiBuddy** remote MCP server (`https://mcp.notibuddy.app/mcp`) via the plugin's **Connectors** tab (or on first use in Claude Code) and complete OAuth pairing using a setup code (`nbpair1...`) from **NotiBuddy → Connect → Add a connection → Create setup code → Share Setup**.
3. Ask Claude to send a deployment gate or custom native screen, track a long-running task with a Live Activity, or inspect files shared from your iPhone.
4. *(Optional — local terminal workflows)* Claude Code users who want local-only encryption keys or opt-in terminal permission hooks can also install the local `notibuddy` CLI/MCP server and hooks plugin — see https://notibuddy.app/claude-code.

## Data & Privacy

- **Remote connection:** Connects over HTTPS using OAuth 2.1 with PKCE (`S256`) to `https://mcp.notibuddy.app/mcp`, which encrypts payloads between the hosted connector and your paired Apple device via `https://notibuddy.app`.
- **Data exchanged:** Sends only the notification titles, messages, native screen layouts/slots, Live Activity updates, and file-transfer requests initiated during your conversation, and returns your device's replies or explicitly requested shared files (via short-lived browser download links at `https://mcp.notibuddy.app/f/...` with the decryption key kept in the URL `#fragment`, or bounded UTF-8 text reads up to 128 KiB).
- **Guardrails:** Intentionally blocks `type: "secret"` / `fieldType: "secret"` form fields on the hosted connector and supports hiding lock-screen previews (`sensitive: true`).
- **Revocation:** Disconnecting in Claude revokes the OAuth grant (`POST /oauth/revoke`), purging stored per-connection keys and withdrawing the sender registration from your device.
- **Links:** [Privacy Policy](https://notibuddy.app/privacy) · [Terms of Service](https://notibuddy.app/terms) · [Support](https://notibuddy.app/support) · [Setup Guide](https://notibuddy.app/setup)
