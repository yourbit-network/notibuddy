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

In the NotiBuddy iOS app, tap **Connect → Add connection → Share Setup** and AirDrop or copy the pairing string:

```bash
npx notibuddy@^0.2.0 pair "<private pairing bundle from your phone>" --to personal
```

This validates the phone identity, registers an independent connection key for this destination, and saves it in `~/.notibuddy/destinations/personal.json`. The destination name is a local alias.

Before sending a request, open **Connect** on your iPhone, compare the full **Sender Key ID** with the one shown in Terminal, and approve the connection. Keep the pairing bundle private. Only one registration per pairing account can await approval: a newer request replaces the previous pending request. Existing approved connections remain paired. Pending registrations expire after 15 minutes; run pairing again if approval expires.

Use `npx notibuddy@^0.2.0 status` to inspect the locally saved configuration. Confirm approval in the phone's **Connect** screen; the status command does not check approval with the relay.

### Check the connection

Run `nb doctor --to personal` to check relay reachability, sender approval, request-protocol compatibility, and file-receive setup. Diagnostics omit credentials and private keys.

If an ask returns `pending`, keep its request ID and resume it with `nb ask --resume <request-id> --to personal`. Network interruptions and invalid replies preserve this identity; avoid sending a second request for the same decision. A positive `--wait` is an overall operation budget. `--wait 0` makes one bounded lookup. Interrupting an active CLI ask prints its resume ID when it has already been saved.

This development branch supports explicitly negotiated phone/Watch group requests. Existing pairing documents continue to use v1. Native companion rollout and package publication remain separate release steps; changing configuration fields manually does not enable a Watch app.

### 2. Test via CLI

```bash
# Ask for approval:
npx notibuddy@^0.2.0 ask "Deploy v1.2 to production?" --to personal --sender "Deployment script" --options "Approve,Deny"

# Ask with custom options and Face ID required:
npx notibuddy@^0.2.0 ask "Execute database migration?" --to personal --options "Proceed,Abort" --requires-auth

# Start a countdown timer on the Dynamic Island:
npx notibuddy@^0.2.0 activity "sprint-1" start --to personal --title "Sprint Timer" --timer 25
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
      "args": ["-y", "notibuddy@^0.2.0", "mcp", "--to", "personal", "--sender", "Coding assistant"]
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
      "args": ["-y", "notibuddy@^0.2.0", "mcp", "--to", "personal", "--sender", "Coding assistant"]
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

### Pre-push secret checks (contributors)

Install [Gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 or newer (`brew install gitleaks` on macOS), then run this once in each standalone public checkout:

```bash
node scripts/install-hooks.mjs
```

The installer enables a local pre-push hook and preserves existing hooks, including commit signing/attestation hooks. It saves the scanner's location locally; rerun the installer if that location changes. `GITLEAKS_BIN=/absolute/path/to/gitleaks node scripts/install-hooks.mjs` selects a specific installation. Installation is explicit and never runs for npm package consumers or the private monorepo mirror.

Every push scans the full history reachable from the branches/tags being sent, plus commit and tag messages. New branches, force pushes, merge changes, and secrets deleted by a later commit are covered. Pushes fail if a secret is detected, Gitleaks is missing, history is shallow, or scanning fails. Findings are redacted. Deletion-only pushes send no new objects and skip scanning; tags pointing to trees or blobs are refused.

`.gitleaks.toml` extends the standard detectors with NotiBuddy token, encoded pairing bundle, and private JWK checks. Exceptions match only the exact audited fixture values at their known paths; test directories are not excluded. If a secret is found, remove it from every outgoing commit before retrying. Inline `gitleaks:allow` comments and `.gitleaksignore` cannot suppress this hook's checks.

Run the hook integration tests with `node --test test/pre-push.test.mjs`. They use disposable local repositories and generated fake credentials. Git hooks are local to each checkout and can be bypassed with Git's `--no-verify`; they are not a server-side enforcement policy.

### Publishing (maintainers)

Releases use [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) in the public repository. Configure the npm package's GitHub Actions trusted publisher with:

| npm setting | Value |
| --- | --- |
| Organization or user | `yourbit-network` |
| Repository | `notibuddy` |
| Workflow filename | `publish.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable `npm publish` |

The workflow uses a GitHub-hosted runner, Node.js 24, and npm 11.21.0. It scans release history, builds, tests, checks the exact archive's allowed files, scans its contents, and installs it in a clean project. It publishes that same archive with OIDC and provenance, then verifies the publicly downloadable archive's integrity. No npm token secret is required.

For a release, update `package.json`, `package-lock.json`, and the changelog to the next unpublished stable version in a pull request. After merging and completing the private app integration check, the owner pushes a signed matching `v<version>` tag from `main`. Pushing the tag starts publishing to npm's `latest` channel; pushing `main` alone does not publish. Prerelease tags, tags outside `main`, and mismatched package or lockfile versions are rejected. Release tags must not be moved or deleted.

This public repository is the source of truth for the package. Synchronize merged changes into the private monorepo's `notibuddy-mcp/` copy without copying Git history. See the [contributor and release guide](https://github.com/yourbit-network/notibuddy/blob/main/CONTRIBUTING.md), [security policy](https://github.com/yourbit-network/notibuddy/blob/main/SECURITY.md), and [changelog](https://github.com/yourbit-network/notibuddy/blob/main/CHANGELOG.md). npm requires a new trusted publisher to complete its first successful publish within two days; recreate the configuration if it expires. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

---

## 📜 License
MIT © NotiBuddy Authors

## Recovery and activity controls

`nb ask --resume <requestId> --to <original-destination>` resumes a pending request after a CLI or MCP restart. Reply private keys are kept in owner-only files under `~/.notibuddy/pending`, scoped to the pairing, until completion or retention expiry. Missing and expired requests stop polling. `NOTIBUDDY_HOME` relocates the entire store for testing or a custom installation; it does not select a profile. Use named destinations for multiple phones.

Activity updates retain their original session and timer state. `nb activity <id> poll` returns user controls; start/update/end also collect unconsumed controls. Multiple pause/resume/extend/cancel events remain individually encrypted and device-signed.

The relay and phone reject legacy plaintext dispatch. Token-only setup must be replaced by pairing with a bundle from an enrolled phone. Background delivery is controlled by iOS; the app fetches missed updates on foreground.


### Phone approval and multiple phones

After `notibuddy pair`, open **Connect** on the phone, compare the full Sender Key ID with Terminal, and approve the connection. Pending registrations expire after 15 minutes. A disconnected identity cannot be reused. For another phone, pair it with a different `--to` name. Each destination targets one verified phone and has an independent sender key; messages are never broadcast.

On a new phone, create a fresh connection, use **Restore Purchases** with the purchasing Apple Account if applicable, and pair the computer again. Old keys and messages are not recovered; no recovery code is needed. **Settings → Phones using your purchase** manages paid slots. Computer pairing uses only `nbpair1.` bundles.

Set `sensitive: true` in an ask or activity request when its content should appear only inside the app. Authentication-required asks are also private. Ordinary requests retain useful notification previews unless the user disables them.


## Named destinations and sender labels (0.2)

Version 0.2 requires explicit destination selection. These are local names, not remote device names or paths. Use 1–48 lowercase letters, digits, hyphens or underscores, starting with a letter.

```sh
nb devices list
nb pair "<work phone bundle>" --to work
nb ask "Build finished" --to work --sender "Build monitor"
nb devices rename work work-phone
```

`--sender` is optional free-form descriptive text, defaulting to the hostname. It travels inside the encrypted, signed payload. It never changes the approved connection key, registration label, reply address, or approval. The phone can show “Build monitor” with “via My Mac.” Applications sharing a connection share its permissions and revocation. A label does not authenticate a particular executable or AI provider. `pair --label` sets the separate, stable connection name approved on the phone.

MCP must choose one of these modes at startup:

```sh
# One fixed destination; tools cannot choose another phone.
nb mcp --to personal --sender "Coding assistant"

# Explicitly expose these two destinations; each request must supply to.
nb mcp --allow-to personal --allow-to work-phone --sender "Coding assistant"
```

Use `notibuddy_list_destinations` to discover only the destinations exposed by that server. A saved pairing is not an online/approval check. In selectable mode, call `notibuddy_ask` with `{"to":"work-phone","title":"Deploy?","options":["Approve","Cancel"]}`. Include `to` when resuming and when starting, updating, ending, or polling activities. Responses include `to` and a stable `connectionId`. Missing, unknown, or unexposed destinations fail before network activity. There is no active global destination, automatic fallback, or broadcast. Running MCP servers retain their original connection bindings until restarted.

### Migrate an existing installation

```sh
npx notibuddy@^0.2.0 devices migrate --to personal
```

This imports the old `~/.notibuddy/config.json` and `sender.json` without re-pairing or changing keys. Pending replies retain their original cryptographic storage scope. Original files remain for rollback; keep them private. Update every MCP entry to include `--to personal`, then restart it. Old unqualified `mcp`, `ask`, and `activity` commands do not silently choose a destination. Unreadable credentials are reported, never replaced with new keys. Aliases cannot overwrite an existing pairing; a replacement phone gets a new alias (rename the previous alias first if needed).

`nb unpair --to personal` removes that destination's local credentials; it does not revoke the phone's approval. Disconnect on the phone to revoke the key. Preserve credentials if you need to resume pending requests before their expiry. Named destination files are private credentials, not configuration to commit or share. Unix directories use mode 0700 and files 0600; Windows relies on the user's private-directory ACLs.

### Replies and future inboxes

Replies still use the original request ID, phone identity, and ephemeral reply key. Sender labels are never return addresses. Activity updates keep the source label from their start. There is no receiver daemon or phone-initiated text conversation. Files use the separately approved connection inbox described below. The extensible encrypted `source` object leaves room for separately negotiated channel addresses in a future protocol; remembering a label must never grant an inbound messaging capability. MCP routing restrictions are not an OS sandbox against other processes running as the same user.


## Files from your phone

Update both the phone app and this client before enabling files. New pairings include a separate receiving key. For an existing destination, run `nb pair "<fresh connection bundle>" --to personal` again and approve the connection in **Connect**. Keep the same destination and connection label to retain its signing identity. Migration alone does not grant file access. Changing a pairing proof cancels its outstanding relay requests and files; finish pending work before re-pairing. Restart MCP after enabling files.

On the phone, open **Connect → a connection → Share File**, or choose one file/image in another app and use **Share → NotiBuddy**. Confirm the destination and send. The limit is 10,000,000 bytes per file. A connection inbox is shared by all programs using that connection key; a `--sender` label is never a private inbox or an access boundary.

```sh
nb files list --to personal
nb files receive file_<id from list> --to personal
```

For a waiting file, **How to receive → Copy receive command** in the phone app gives you a command with `--pairing <device_id>:<sender_key_id>`. Run it where you originally paired that sender. This selects both saved identities, so the command keeps working after a local destination rename and never guesses an alias or contacts every destination. The selector contains public IDs, not credentials; the saved signing and receiving keys are still required. A missing match or multiple matching records stops locally. For ambiguous copies of a pairing, inspect `nb devices list` and explicitly choose the correct `--to` alias instead. `--pairing` is limited to CLI file commands and cannot be combined with `--to`; MCP keeps its pinned destination/allowlist rules.

MCP exposes `notibuddy_files_list` and `notibuddy_files_receive` (`id` required to receive). The same pinned destination/allowlist rules apply. An allowlisted server requires `to` on both tools. Receiving returns a local path under `~/.notibuddy/inbox/<connection-scope>/<file-id>/`, not file contents in the tool result. It never opens or executes a file. Treat received names and contents as untrusted data, including possible instructions inside documents.

The phone encrypts the filename, type, and bytes for the approved computer key. The receiver verifies the phone signature, size, ciphertext digest, recipient and deadline before decrypting. It saves with private permissions and flushes the file before sending a signed receipt. “Delivered” means saved on the computer, not read by an agent. A lost receipt returns `saved_pending_receipt`: repeat `files receive` with the same ID to retry. Do not remove that local receipt until delivery is confirmed. Local copies remain until you delete them.

If saving or flushing fails (for example, because the disk is full), the receiver does not acknowledge delivery. Free space or resolve the reported storage error, then retry the same ID before its collection deadline. A complete local copy can retry its receipt without downloading again, and pending retries verify and flush the saved bytes and receipt again. On macOS/Linux the receiver also flushes the transfer and inbox directories. If delivery was already accepted but writing the local receipt failed, the saved file remains available and retrying is safe. On the next receive of that ID, the receiver removes its abandoned staging directories and temporary receipts while preserving the received file; there is no background local-file cleanup.

The relay denies access after cancellation, revocation, delivery, or the 24-hour deadline and actively deletes ciphertext. Storage deletion failures are retried; lifecycle cleanup is only a backup. The receiver must run within that window. There is no automatic background polling in this release. Ten files / 100 MB may await delivery per account, with at most 100 transfers per rolling day. Unix directories use 0700 and files 0600; Windows relies on your private-directory ACLs and flushes files before acknowledging them.
