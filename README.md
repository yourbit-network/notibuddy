# NotiBuddy (notibuddy-mcp)

End-to-end encrypted requests and signed replies between your agents, apps or scripts and your Apple devices.

The public CLI and MCP server from **Yourbit, LLC**, published on npm as [`notibuddy`](https://www.npmjs.com/package/notibuddy). This repository contains the computer client and protocol documentation. Support: **contact@notibuddy.app**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Protocol: v1](https://img.shields.io/badge/Protocol-v1-emerald.svg)](./PROTOCOL.md)

---

## 🔒 Security & Cryptographic Invariants

NotiBuddy is designed so that **neither the relay server nor Apple Push Notification service (APNs) can read prompts, choices, code, or user responses**.

1. **HPKE (RFC 9180):** Requests use `DHKEM(P-256, HKDF-SHA256)` + `AES-256-GCM` for the addressed device. The Apple app stores its separate encryption private key in Keychain; this is a software key, not a Secure Enclave key.
2. **Device ECDSA signatures:** Replies use P-256 signing keys. The Apple app uses the Secure Enclave when available and a Keychain-protected software key otherwise. A valid signature proves possession of the paired key; it does not attest hardware storage or user authentication. Protected requests have separate authentication rules.
3. **Out-of-Band Pairing:** Public keys and device fingerprints are exchanged via out-of-band bundles (`nbpair1...`) verified with HMAC-SHA256.
4. **Content and metadata:** The relay transports encrypted message/file bodies, but it can read routing identities, primitive types, timestamps, sizes, delivery status and usage metadata. APNs tokens and connection IP addresses are also visible to the services handling them. Encryption does not make the service anonymous or hide all metadata.

The CLI stores software signing, receiving and pending-reply keys under the private local `~/.notibuddy` store. Unix permissions and Windows account ACLs protect those files; the package does not use a hardware keystore. Paired endpoints can read the content addressed to them and may retain their own copies.

Read the complete normative specification in [PROTOCOL.md](./PROTOCOL.md) and the [security policy](https://github.com/yourbit-network/notibuddy/blob/main/SECURITY.md).

---

## 🚀 Quick Start

Use the versioned `npx` commands below without a global installation. In later examples, `nb` is shorthand for `npx -y notibuddy@^0.2.6`, or the executable from a global installation of that version or a compatible newer release.

### 1. Pair with your iPhone

In the NotiBuddy iOS app, tap **Connect → Add connection → Share Setup** and AirDrop or copy the pairing string:

```bash
npx notibuddy@^0.2.6 pair "<private pairing bundle from your phone>" --to personal
```

This validates the phone identity, registers an independent connection key for this destination, and saves it in `~/.notibuddy/destinations/personal.json`. The destination name is a local alias.

If compatible NotiBuddy setup includes a one-use code, the first eligible sender can connect without another approval tap. Keep the phone app open and online; the command waits up to 45 seconds for confirmation (`--wait 0` returns immediately, maximum 60 seconds). “Waiting for NotiBuddy” means pairing is still pending. Run the same command with the same destination name to retry using the saved keys. The temporary code is used in memory and is not saved in the destination file.

If Terminal says **Phone approval required**, open **Connect**, compare the full **Sender Key ID**, and approve the connection. This is the path for legacy setup and later new senders using the same setup. One manual approval can be pending: a newer request replaces the previous one. Pending approvals expire after 15 minutes. An unchanged approved sender stays connected without another prompt.

Keep the entire setup private: anyone holding an unused code can race to connect first. Codes last at most ten minutes; expired or canceled codes grant no automatic access, though valid ordinary pairing credentials can still request manual approval. Canceling a code does not disconnect an already approved sender. Use **Connect** to disconnect a sender you do not recognize.

Use `npx notibuddy@^0.2.6 status` to inspect the locally saved configuration. Confirm approval in the phone's **Connect** screen; the status command does not check approval with the relay.

### Check the connection

Run `nb doctor --to personal` to check relay reachability, sender approval, request-protocol compatibility, and file-receive setup. Diagnostics omit credentials and private keys. The client proves possession of the selected sender key and reads only that sender's approval state. Existing saved destinations supply their public key automatically; no re-pairing is needed. New clients can check older relays through a bounded compatibility path, but authentication failures never trigger that fallback.

Library callers that construct `NotiBuddyClient` directly should include `senderPub` (the public P-256 signing point) in `NotiBuddyConfig` when calling `doctor`. A successful `registerSender` also supplies that point to the same client instance. The private signing key can remain nonextractable. If public identity is missing or mismatched, diagnostics remain unverified instead of using an unsigned lookup.

An unavailable or invalid response reports the sender as `unverified`; it does not mean the connection was removed. All checks share a 15-second timeout, including compatibility requests to older relays, and negotiated phone/Watch delivery is never downgraded by a diagnostics failure.

Ordinary requests (approvals, protected approvals, text replies, forms, and diffs) remain answerable for **three hours** by default. Set a shorter lifetime with `nb ask "Review release" --to personal --timeout 1800`, JavaScript `timeoutSeconds`, or MCP `timeout_seconds`; the supported range is 1–10,800 whole seconds. This is separate from `--wait` / `wait_seconds`, which controls how long one call waits before returning `pending` (maximum 55 seconds). Resuming or retrying keeps the original signed expiry, even if a different timeout is supplied. Activities retain their existing one-hour lifetime and timer behavior.

If an ask returns `pending`, keep its request ID and resume it with `nb ask --resume <request-id> --to personal`. Network interruptions and invalid replies preserve this identity; avoid sending a second request for the same decision. A positive `--wait` is an overall operation budget. `--wait 0` makes one bounded lookup. Interrupting an active CLI ask prints its resume ID when it has already been saved.

The client supports explicitly negotiated phone/Watch group requests with a compatible app and relay. Pairings without that negotiation continue to use v1. Set up the Watch through the iPhone app; changing configuration fields manually does not enable a Watch app.

### 2. Test via CLI

```bash
# Ask for approval:
npx notibuddy@^0.2.6 ask "Deploy v1.2 to production?" --to personal --sender "Deployment script" --options "Approve,Deny"

# Ask with custom options and Face ID required:
npx notibuddy@^0.2.6 ask "Execute database migration?" --to personal --options "Proceed,Abort" --requires-auth

# Start a countdown timer on the Dynamic Island:
npx notibuddy@^0.2.6 activity "sprint-1" start --to personal --title "Sprint Timer" --timer 25
```

### Review a text change (0.2.1+)

Save a UTF-8 JSON file named `changes.json`:

```json
{
  "filename": "src/config.ts",
  "language": "typescript",
  "original": "const retries = 2;\n",
  "modified": "const retries = 3;\n"
}
```

```bash
npx notibuddy@^0.2.6 ask "Review retry change" --to personal --diff changes.json --requires-auth --sensitive
```

The filename and source text are encrypted for the destination. Review happens on iPhone or iPad; a paired Watch hands off to its iPhone. The response uses `approve` (Apply) or `reject` (Discard). These are decisions: NotiBuddy does not change files or execute code. The caller must verify the current file still matches the reviewed original before applying an approved change.

For MCP, pass `diff: {"filename":"src/config.ts","language":"typescript","original":"const retries = 2;\n","modified":"const retries = 3;\n"}` to `notibuddy_ask`, together with `title`, `requires_auth: true`, `sensitive: true`, and the selected destination when needed. The library accepts the same `diff` object in `client.ask(...)`.

`filename` is a display name, never a file to open on the recipient. `language` is optional. Empty original or modified text supports file creation or deletion. Source text is limited to a combined **96,000 UTF-8 bytes and 20,000 lines** (each text starts at one line; each newline adds one). The CLI JSON file must be a regular file no larger than 150,000 bytes. The full encrypted request must also fit the protocol limit; JSON escaping and other fields can make a smaller diff too large. Invalid inputs fail before sending.

Do not combine a diff with choices, text input, forms, or a resume ID. If the result is pending, resume the returned ID without `--diff` or the MCP `diff` object. Source text may remain in the private pending-request store until dispatch is acknowledged, allowing the exact request to survive an interrupted send; the caller's input file remains their responsibility.

---

## 🛠️ Model Context Protocol (MCP) Setup

You can connect NotiBuddy directly to your favorite agent tools. Pairing prints an MCP configuration requiring at least the installed package version. When updating an existing configuration, change its package version to `notibuddy@^0.2.6` and restart the MCP server; preserve its destination and sender options. This version update does not require re-pairing or new keys.

### Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "notibuddy": {
      "command": "npx",
      "args": ["-y", "notibuddy@^0.2.6", "mcp", "--to", "personal", "--sender", "Coding assistant"]
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
      "args": ["-y", "notibuddy@^0.2.6", "mcp", "--to", "personal", "--sender", "Coding assistant"]
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

Contributions require the [NotiBuddy Contributor Assignment Agreement](https://github.com/yourbit-network/notibuddy/blob/main/CLA.md), based on Harmony CAA 1.0. It assigns contribution copyright to Yourbit, LLC and gives contributors a license to reuse their own work. Read [CONTRIBUTING.md](https://github.com/yourbit-network/notibuddy/blob/main/CONTRIBUTING.md) for signing and employer/third-party requirements.

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
npx notibuddy@^0.2.6 devices migrate --to personal
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
