# Changelog

## 0.4.4 — 2026-11-27

- **Official MCP Registry Remote Endpoint:** Declare the hosted Streamable HTTP MCP endpoint (`https://mcp.notibuddy.app/mcp`) under `remotes` alongside the local npm `stdio` package in `server.json`.
- **One-Shot Screen & Schema Ergonomics:** Place the compact built-in screen slot cheatsheet directly on top-level `screen.description`, omit redundant `layout` echoes on valid `dry_run` responses, remove top-level `anyOf` from `notibuddy_notify` input schema for broader MCP host compatibility, and support forgiving single-use `draft_id` sends.
- **Claude Directory Plugin Bundle (`v1.0.1`):** Bundle the hosted remote MCP server, explicit `icon` and `displayName` fields, and hosted-only skills and data-handling documentation in `plugins/claude-code/notibuddy-directory`.

## 0.4.3 — 2026-11-26

- **Ergonomic Custom Screens & Builder Resources:** Add flat semantic `screen.slots` for all 8 built-in certified layouts (preserving backward compatibility for `labels`/`data`), publish `notibuddy://screens/{templateId}` and `notibuddy://screens/builder` MCP resources, expose `draft_id` directly in the `notibuddy_notify` schema alongside `screen.template` / builder pointers, document `"dismiss"` as a reserved action ID, and trim repeated template cheatsheet prose from `MCP_INSTRUCTIONS`.
- **Certifier-Parity `dry_run`, Phone Preview, & Single-Use `draft_id`:** Run full structural/authoring limit checks (including the 1–3 action cap and consistent 1–6 `kpiStrip` limits across both `strict` and `auto` modes) during `dry_run: true`, return a phone-width text `preview` displaying authored semantic IDs and picker option labels, `diffViewer` excerpts, `templateSlug` metadata, and a RAM-only single-use `draft_id` handle so live sends do not repeat checked payloads and zero plaintext is stored at rest.
- **Clearer Screen Validation & Decoded Replies:** Report multi-issue screen validation diagnostics with structured `fixes` arrays (omitting raw wire slot ordinals on custom screens), name disallowed control/format characters explicitly, allow picker option label matching in `enabledWhen.equals`, preserve custom authored semantic IDs (`action.id`, `checklists[].id`, `fields[].id`) in `decoded` replies, distinguish untouched `date` fields (`value: null, touched: false`) from selected dates (`touched: true`), and include `actionLabel` in settled replies.

## 0.4.2 — 2026-11-23

- Coalesce Live Activity updates with load-scaled client pacing, debouncing, and `Retry-After` / `429` backpressure handling, eliminating redundant MCP polling and lookup overhead.
- Add RFC 6455 WebSocket keepalive pings and 90-second sender-stream resync for reliable long-lived reply sessions.
- Hint AI agents via MCP server instructions to write user-facing notification copy in the user's language.
- Update README with the square spotlight demo preview.

## 0.4.1 — 2026-11-20

- **README overhaul for GitHub & npm:** Add dark/light-safe branding, live iPhone showcase captures, an honest bidirectional ASCII trust-boundary diagram, Quick Start with `-y` on piped `npx`, an explicit 4-tool MCP manifest and routing-mode reference, contextual uncollapsed safety contracts, and collapsible operational details; migrate the npm OIDC trusted-publisher settings table to `CONTRIBUTING.md`.
- **Official agent plugin metadata & directory packaging:** Add skills-only Claude Plugin Directory bundle (`notibuddy-directory` with setup & hooks skills), vector SVG brand assets, stripped 256×256 icon, and policy/support/documentation metadata URLs.

## 0.4.0 — 2026-11-19

- **Custom Native Screens (`nb notify --screen`, `nb screen register`, MCP `notibuddy_notify({ screen })`):** Build rich, interactive native iOS screens directly from JSON using 12 composable SwiftUI blocks (`vstack`, `card`, `divider`, `heading`, `text`, `badge`, `alert`, `kpiStrip`, `keyValueList`, `checklist`, `diffViewer` with expand-all-lines gating, and `formField`) plus Face ID-protected actions. Choose from 8 ready-to-use built-in layouts or send an inline custom template — the server validates and caches only the structural layout while all text, metrics, diffs, and replies stay end-to-end encrypted.
- Detect Homebrew Cellar installations (`Cellar/notibuddy`) and suggest `brew upgrade notibuddy` in update notices and upgrade errors; document Homebrew tap installation in README.

## 0.3.3 — 2026-11-18

- **Fail-closed approval gates (`nb gate`):** Add `nb gate "<title>"` for shell scripts and CI/CD pipelines. Waits across 55-second relay windows up to `--timeout` (default 600 s) on a single signed request ID, verifies the signed reply action and optional `--requires-auth` flag (plus lowercase `"approve"` for `--diff`), and exits with deterministic codes (`0` approved, `1` operational/config error, `2` rejected/unauthenticated, `3` expired, `130`/`143` interrupted). `nb notify` keeps its existing exit-0 behavior for backward compatibility.
- **Native Claude Code permission hooks (`nb hook claude PermissionRequest`):** Forward Claude Code tool and file-edit permission prompts to iPhone or Apple Watch after a configurable `--grace` window (default 10 s, so prompts answered locally in the terminal never hit the relay). Uses hidden Lock Screen previews (`sensitive: true`) by default (`--show-preview` opts out), keeps Face ID opt-in (`--requires-auth`), escapes invisible/Trojan-Source control characters, passes oversized diffs/commands straight through instead of truncating, enforces a rolling hourly dispatch cap and stepped `402` quota circuit breaker, and fails safely to silent pass-through (`exit 0`) on any non-allow/non-deny outcome.
- **Per-client bindings (`nb bind`, `nb unbind`, `nb mcp --client <id>`):** Allow plugins and registry-installed MCP servers to start cleanly before pairing, expose server-level MCP instructions and fail-closed tool guidance, auto-bind to a sole paired destination, refuse ambiguity when multiple destinations exist until explicitly pinned by immutable `connectionId` with `nb bind --client <id> --to <name>`, and follow `nb devices rename` automatically. Bare `nb mcp` remains strict (`exit 1`). Update `server.json` to launch `notibuddy mcp --client mcp`.
- **Fast thin CLI dispatcher:** Move heavy CLI/crypto/MCP imports behind lazy loading in `dist/cli.js` so `nb --version` and skipped `nb hook` invocations complete in ~40–50 ms.
- **Official agent plugins & marketplaces:** Add canonical `plugin-src/` sources, deterministic generator/drift checker (`npm run plugins:build` / `npm run plugins:check`), and validated manifests/marketplaces for Claude Code (`.claude-plugin/marketplace.json`, `notibuddy` + opt-in `notibuddy-hooks`), Codex CLI (`.agents/plugins/marketplace.json`), Antigravity (`plugins/antigravity/notibuddy`), and Cursor (`plugins/cursor/notibuddy`).

## 0.3.2 — 2026-11-18

- **Official MCP Registry metadata:** Add `mcpName` (`io.github.yourbit-network/notibuddy`) to `package.json`, add validated `server.json`, and automate Official MCP Registry publication via GitHub Actions OIDC after npm release verification.

## 0.3.1 — 2026-11-17

- **Hibernating sender WebSocket stream:** Wait for interactive request replies over an authenticated, sender-scoped WebSocket stream (`GET /v2/sender/ws`) instead of fixed 1-second polling, keeping the stream warm across MCP tool calls and automatically falling back to adaptive polling when WebSockets are unavailable.

## 0.3.0 — 2026-11-16

- **MCP & CLI simplification:** Retire `notibuddy_ask` and `nb ask` in favor of unified `notibuddy_notify` / `nb notify` (one-way by default; interactive when `options`, `input_placeholder`, `fields`, `diff`, `requires_auth`, or `resume_id` is supplied), and merge `notibuddy_files_list` + `notibuddy_files_receive` into `notibuddy_files` (`action: "list" | "receive"`). Calling retired or guessed tools/commands returns an immediate error with the working replacement.
- **Compact MCP surface:** Trim schema prose, omit `to` from advertised tool schemas when pinned with `--to`, and return compact JSON tool results and 1-line validation errors.
- **CLI usability:** Add `--version` and per-command `--help`, validate commands before destination routing, auto-select the sole paired destination on everyday CLI commands when `--to` is omitted, add `--short-title`, `--summary`, `--fields` (on `notify`), and `--controls` (on `activity`), and allow flag values beginning with `--`.
- **Compatibility:** Sign relay HTTP requests with a new `nb2` signature input that names the sender's account, and send the sender key id as `X-Sender-Key-ID` (previously `X-Sender-ID`) on file routes. v1 reply polls are now sender-signed as well. This release needs the current NotiBuddy relay, which accepts both the old and the new format.
- **Migration:** Drop migration support for installs older than 0.2.0 and remove `nb devices migrate`. Such installs run `npx notibuddy@0.2.10 devices migrate --to <name>` once, or pair again. Installs from 0.2.0 or later are unaffected.
- Change `nb pair` to read the setup code from a hidden prompt or from stdin (`pbpaste | nb pair --to <name>`) instead of the command line, so it stays out of shell history. A code passed as an argument still works but prints a warning. Reject codes over 64 KiB.
- Pin the exact installed release (`notibuddy@<version>`) in the MCP configuration and phone setup text that pairing prints, instead of a `^` range. Update an existing MCP entry to the release you installed; no re-pairing is needed.
- Recover automatically when the phone rotates this computer's sender credentials: the client refreshes them and retries once, with no re-pairing. If refresh fails, or a fresh setup code from the same phone arrives for a rotated destination, the error says to run `nb unpair --to <name>`, add the computer in NotiBuddy, then run `nb pair --to <name>` with the new setup code.
- Add `nb doctor` checks for clock skew against the relay (reported as `clockSkewMs`, with an issue when it exceeds 60 s) and for a newer published release (reported as `newer`). Show a clear clock-fix message instead of a generic relay error when the relay rejects a request for clock skew (`CLOCK_SKEW`).
- Print a one-line update notice on stderr at most once a day for CLI commands (other than `mcp` and `doctor`), and add it once per session as an extra item in an MCP tool result. Set `NOTIBUDDY_NO_UPDATE_CHECK=1` to turn the check off. Explain a relay HTTP 426 `CLIENT_UPGRADE_REQUIRED` answer with the upgrade command.
- Add `--decline-option` (CLI) and `decline_option` (MCP, `declineOption` in the library) to mark which of `options` declines. With `--requires-auth`, only that choice may be answered without device authentication; without options, only the phone's own Reject skips it. Describe `requires_auth` as device-owner authentication (Face ID, Touch ID, passcode or an unlocked Apple Watch).
- Add a `secret` form field type for passwords and tokens: hidden on current phones and kept out of summaries. Older phones show an unknown field type as plain text.
- Advertise the validated bounds (lengths, item counts, integer ranges) in the MCP tool schemas, report the real package version from the MCP server instead of a stale `0.2.1`, and trim MCP `options` choices as the CLI does.
- Stop keeping request plaintext in the pending record on disk, and scrub it from records saved by earlier versions. A resumed request whose phone recipients changed now fails with a "send it again" message instead of silently re-sealing.
- Recover a stale file lock without manual deletion: locks record the owner's start time, so a dead or reused PID is reclaimed, and an empty crashed lock is reclaimed after 5 s. A held lock is never taken by age alone.
- Refuse redirects on file routes like every other client route, and treat a 409 `REQUEST_ID_CONFLICT` (reused request id with different content) as final with a "send it again with a new request ID" message instead of retrying.
- Run the npm publish job in a protected `npm-release` environment.

## 0.2.11 — 2026-11-09

- Add one-way encrypted informational notifications through CLI `nb notify`, MCP `notibuddy_notify`, and library `client.notify(...)`. Notifications use an `approval` envelope with `options: []`, return `status: "delivered"` immediately after dispatch without polling or storing a pending reply key, and support single-device and group delivery.
- Route `ask` calls with `options: []` (including `nb ask --options ""` and `notibuddy_ask` with `options: []`) through one-way notification delivery, reject `requiresAuth` on passive notifications, and reject empty option labels in comma-separated CLI `--options` lists.

## 0.2.10 — 2026-10-20

- Remove private temporary destination records after partial disk-full or I/O write failures. Preserve existing pairings, legacy migration files, and temporary files owned by another writer. Retry after fixing the storage problem; existing keys and connections do not need to change.
- Check existing destination and legacy migration permissions against the packed artifact, including identity preservation and recovery after partial writes. Add published-package acceptance for actual npx and generated MCP launchers on macOS, Linux and Windows.

## 0.2.9 — 2026-10-20

- Include Resume in the default timer controls so a paused timer can be resumed. Preserve explicit custom control lists and verify encrypted Pause/Resume responses.

## 0.2.8 — 2026-10-19

- Honor MCP cancellation and CLI interruption while listing or receiving encrypted files. Stop unfinished network/body reads, release the transfer lock, and keep a durable local copy when receipt confirmation is interrupted. Retry the same file ID to finish safely without downloading an already saved file again.
- Bound file response consumption by the caller’s cancellation/deadline as well as the existing per-request timeout. Keep authentication, size limits and save-before-acknowledgement unchanged.

## 0.2.7 — 2026-10-19

- Keep activity polling moving when a relay repeats an already verified response at a later sequence. Repeated controls are not emitted again, polling remains bounded, and altered responses preserve the original cursor and reply key for recovery.

## 0.2.6 — 2026-10-17

- Keep ordinary approval, text, form and diff requests answerable for three hours by default. Configure a shorter lifetime with CLI `--timeout`, MCP `timeout_seconds`, or library `timeoutSeconds`; polling still waits at most 55 seconds per call.
- Preserve the original signed deadline and saved reply keys when resuming or retrying. Existing requests keep their original expiration. Live Activity requests retain their one-hour maximum.
- **Compatibility:** three-hour requests require updated NotiBuddy app and relay support. For an older installation, explicitly select a lifetime of 3600 seconds or less; the client does not silently extend or renegotiate an existing request.

- Make automatic-pairing deadline tests deterministic across timer scheduling differences. Cover early wakeups, exact deadlines, stalled retries and cancellation without changing runtime polling or timeout behavior.

## 0.2.5 — 2026-10-17 (not published)

- The tagged release stopped at a timing-sensitive pairing test before publishing to npm. Version 0.2.6 carries its three-hour request defaults and compatibility guidance; the 0.2.5 tag remains unchanged.

## 0.2.4 — 2026-10-17

- Support short-lived, one-use pairing invitations from compatible NotiBuddy apps and relays. The first eligible sender can connect after automatic phone verification; later new senders use manual approval, and unchanged approved identities reconnect without another approval.
- Wait up to 45 seconds for automatic authorization, configurable with `pair --wait 0–60`. Report unfinished setup honestly, reuse the exact signed request while waiting, and preserve destination keys after timeouts or interruption.
- Validate invitation scope, key material, lifetime and sender/file-key bindings before saving or sending. Keep the private invitation capability in memory only; it is never stored in destination records or sent to the relay.
- Preserve legacy manual pairing and document the first-holder trust boundary, expiry and cancellation behavior. This package release does not itself enable invitations in an older app or relay.

## 0.2.3 — 2026-10-17

- Generate pairing's MCP configuration from the installed package version instead of the stale `^0.2.0` minimum. Keep its explicit destination and existing keys; no re-pairing is required to update an MCP configuration.
- Verify the actual pairing output from the packed, installed CLI with a synthetic intercepted relay before publishing. The check rejects a package spec that allows older releases than the tested package.
- Align the README pairing, MCP, migration and request examples with `^0.2.3`, and explain how to update existing MCP configurations without changing keys.
- Clarify software-key storage, conditional Secure Enclave signing and readable service metadata. Remove blanket hardware-backed/zero-knowledge marketing claims; encryption, authentication and wire behavior are unchanged.

## 0.2.2 — 2026-10-16

- Authenticate sender diagnostics with a fresh proof from the selected signing key. Existing destinations derive the public identity without rewriting credentials or requiring re-pairing; library callers supply `senderPub` or register on the same client instance. Keep bounded old-relay compatibility, with no fallback after an authentication failure.

- Make `doctor` check the selected sender directly on compatible relays, with bounded compatibility for older relays. Reject mismatched identities, invalid approval values and incomplete legacy lists; preserve the shared diagnostics timeout, cancellation and phone/Watch recipient verification.
- Add a Harmony-based contributor copyright assignment agreement for Yourbit, LLC, using Delaware law, plus hosted CLA Assistant signing-form metadata and activation records. The hosted integration is active, and `main` requires its `license/cla` status alongside the existing CI checks.

## 0.2.1 — 2026-10-14

- Align package setup and support links with `notibuddy.app`.
- Add encrypted diff review through `ask --diff <json-file>` and the library/MCP `diff` input. Filenames and original/modified text stay inside the encrypted request; the returned approval or rejection never applies or executes the changes.
- Validate diff size, line counts, labels and input modes before dispatch. Preserve durable request resume and negotiated group delivery, including the existing Watch answer restrictions.
- Make the client deadline regression deterministic while retaining checks for the overall operation budget and response-body cancellation. Runtime timeout behavior is unchanged.

## 0.2.0 — 2026-10-13

- Require explicit named destinations under `~/.notibuddy/destinations`; add destination discovery, rename, and explicit legacy migration preserving keys and pending replies. MCP can use one destination or an explicit allowlist with per-call selection; it never broadcasts or silently selects another destination.
- Add optional encrypted sender labels, defaulting to hostname. Labels do not create a new approval identity; replies remain bound to their original request and destination.
- Negotiate phone/Watch group delivery from compatible device pairing data. Verify membership and both enrollment proofs, reject rollback, and encrypt separately to each approved recipient. Existing v1 pairing stays single-device; saved v1 requests remain resumable after a v2 upgrade, with no failure-driven protocol fallback.
- Preserve resumable requests and activity controls across timeouts, interrupted dispatch, restarts and destination renames. Bound network waits and rotate activity polling so an unavailable request does not block all other controls.
- Receive phone-shared files up to 10 MB through explicit CLI/MCP inboxes. Approve a separate file-receiving public key during pairing; existing connections require re-pairing and phone approval to enable files. Resolve copied receive commands by exact pairing identities, even after a destination rename.
- Authenticate and decrypt files locally, keep filenames/content types encrypted, and acknowledge delivery only after a private durable save. Recover interrupted saves, disk-full failures, receipt updates and lost acknowledgements without downloading twice or acknowledging partial files. Reject tampering, unsafe paths, wrong recipients and expired transfers.
- Validate canonical, bounded UTF-8 pairing documents and real P-256 points before saving destination data. Preserve saved state after invalid replies and bind exported reply/error openers to a caller-supplied expected request ID.
- **Migration:** CLI sends and MCP startup require destination flags; update existing MCP entries after explicit migration. `DestinationStore` replaces the legacy configuration helper exports. Direct callers of `openReply` and `openError` must supply `expectedRequestId` from their saved request.
- Add independent CI secret scans, pre-push enforcement tests, Linux/macOS/Windows package checks, exact-archive installation/scanning and public registry integrity verification. Add dependency updates, private security reporting guidance, and contribution templates.
- Keep the release candidate compatible with the Zod 4 dependency already adopted on `main`.

## 0.1.1 — 2026-10-07

- Clarify phone approval and separate profiles in the quick start.
- Publish using GitHub Actions trusted publishing with npm provenance.

## 0.1.0 — 2026-10-07

- Initial public CLI and MCP package for encrypted NotiBuddy requests, replies, and live activity controls.
- Pair computers using phone-generated bundles and explicit approval on the phone.
- Preserve pending replies across computer restarts and support separate phone profiles.
