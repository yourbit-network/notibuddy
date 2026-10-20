# Changelog

## Unreleased

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
