# NotiBuddy (notibuddy-mcp)

Zero-knowledge, hardware-backed, end-to-end encrypted human-in-the-loop bridge between autonomous AI agents and your iPhone.

The public CLI and MCP server from **Yourbit, LLC**, published on npm as [`notibuddy`](https://www.npmjs.com/package/notibuddy). This repository contains the computer client and protocol documentation. Support: **contact@notibuddy.com**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Protocol: v1](https://img.shields.io/badge/Protocol-v1-emerald.svg)](./PROTOCOL.md)

---

## 🔒 Security & Cryptographic Invariants

NotiBuddy is designed so that **neither the relay server nor Apple Push Notification service (APNs) can read prompts, choices, code, or user responses**.

1. **HPKE (RFC 9180):** All agent requests are encrypted directly to your iPhone's keychain-protected encryption key using `DHKEM(P-256, HKDF-SHA256)` + `AES-256-GCM`.
2. **Device ECDSA Signatures:** User answers (approvals, custom choices, text input) are signed with a NIST P-256 key inside the Apple **Secure Enclave**.
3. **Out-of-Band Pairing:** Public keys and device fingerprints are exchanged via out-of-band bundles (`nbpair1...`) verified with HMAC-SHA256.
4. **Relay Blindness:** The relay only sees opaque binary ciphertext blobs (`ct`, `enc`, `sig`) and routing metadata (`requestId`, expiration).

Read the complete normative specification in [PROTOCOL.md](./PROTOCOL.md).

---

## 🚀 Quick Start

### 1. Pair with your iPhone

In the NotiBuddy iOS app, tap **Connect → Share Setup** and AirDrop or copy the pairing string:

```bash
npx notibuddy pair "nbpair1.eyJ2IjoxLCJyZWxheSI6Imh0dHBzOi8vcmVsYXkubm90aWJ1ZGR5LmFwcCIsInRv..."
```

This derives your device identity, registers your sender signing key, and stores credentials locally in `~/.notibuddy/`.

Before sending a request, open **Connect** on your iPhone, compare the full **Sender Key ID** with the one shown in Terminal, and approve the computer. Keep the pairing bundle private. Pending registrations expire after 15 minutes; run pairing again if approval expires.

Use `npx notibuddy status` to inspect the locally saved configuration. Confirm approval in the phone's **Connect** screen; the status command does not check approval with the relay.

### 2. Test via CLI

```bash
# Ask for approval:
npx notibuddy ask "Deploy v1.2 to production?" --options "Approve,Deny"

# Ask with custom options and Face ID required:
npx notibuddy ask "Execute database migration?" --options "Proceed,Abort" --requires-auth

# Start a countdown timer on the Dynamic Island:
npx notibuddy activity "sprint-1" start --title "Sprint Timer" --timer 25
```

---

## 🛠️ Model Context Protocol (MCP) Setup

You can connect NotiBuddy directly to your favorite agent tools:

### Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "notibuddy": {
      "command": "npx",
      "args": ["-y", "notibuddy", "mcp"]
    }
  }
}
```

### Cursor / Antigravity / Claude Code
Run as a local stdio MCP server:
```json
{
  "mcpServers": {
    "notibuddy": {
      "command": "npx",
      "args": ["-y", "notibuddy", "mcp"]
    }
  }
}
```

---

## 🧪 Testing Test Vectors

Verify compliance with Protocol v1:
```bash
npm ci
npm run build
npm test
```

Test vectors are located in [`test-vectors/v1.json`](./test-vectors/v1.json).

Node.js 20 or newer is required. Tests use isolated local fixtures and do not need a phone, relay credentials, or access to another repository. Test-vector keys and pairing bundles are synthetic and are not usable production credentials.

### Publishing (maintainers)

Releases use [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) in the public repository. Configure the npm package's GitHub Actions trusted publisher with:

| npm setting | Value |
| --- | --- |
| Organization or user | `yourbit-network` |
| Repository | `notibuddy` |
| Workflow filename | `publish.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable `npm publish` |

The workflow uses a GitHub-hosted runner, Node.js 24, and npm 11.21.0. It installs dependencies, builds, tests, checks package contents, and publishes with OIDC and provenance. No npm token secret is required.

For a release, update `package.json` and `package-lock.json` to the next unpublished stable version, commit and push the reviewed changes to the public repository, then push a matching `v<version>` tag. For example, version `0.1.1` requires tag `v0.1.1`. Pushing the tag starts publishing to npm's `latest` channel; pushing `main` alone does not publish. Prerelease tags and mismatched package or lockfile versions are rejected.

Make the same package changes in the private monorepo's `notibuddy-mcp/` mirror. npm requires a new trusted publisher to complete its first successful publish within two days; recreate the configuration if it expires. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

---

## 📜 License
MIT © NotiBuddy Authors

## Recovery and activity controls

`nb ask --resume <requestId>` resumes a pending request after a CLI or MCP restart. Reply private keys are kept in owner-only files under `~/.notibuddy/pending`, scoped to the pairing, until completion or retention expiry. Missing and expired requests stop polling. Set `NOTIBUDDY_HOME` to use a separate configuration directory.

Activity updates retain their original session and timer state. `nb activity <id> poll` returns user controls; start/update/end also collect unconsumed controls. Multiple pause/resume/extend/cancel events remain individually encrypted and device-signed.

The relay and phone reject legacy plaintext dispatch. Token-only setup must be replaced by pairing with a bundle from an enrolled phone. Background delivery is controlled by iOS; the app fetches missed updates on foreground.


### Phone approval and multiple phones

After `notibuddy pair`, open **Connect** on the phone, compare the full Sender Key ID with Terminal, and approve the computer. Pending registrations expire after 15 minutes. A disconnected identity cannot be reused. For another phone or a fresh sender identity, set `NOTIBUDDY_HOME` to a separate private directory for both pairing and the MCP server, for example `$HOME/.notibuddy-work-phone`. Each profile targets one phone; messages are not broadcast to every phone on the account.

On a new phone, create a fresh connection, use **Restore Purchases** with the purchasing Apple Account if applicable, and pair the computer again. Old keys and messages are not recovered; no recovery code is needed. **Settings → Phones using your purchase** manages paid slots. Computer pairing uses only `nbpair1.` bundles.

Set `sensitive: true` in an ask or activity request when its content should appear only inside the app. Authentication-required asks are also private. Ordinary requests retain useful notification previews unless the user disables them.
