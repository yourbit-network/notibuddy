# Changelog

## Unreleased

## 0.2.3 — 2026-10-17

- Generate pairing's MCP configuration from the installed package version instead of the stale `^0.2.0` minimum. Keep its explicit destination and existing keys; no re-pairing is required to update an MCP configuration.
- Verify the actual pairing output from the packed, installed CLI with a synthetic intercepted relay before publishing. The check rejects a package spec that allows older releases than the tested package.
- Align the README pairing, MCP, migration and request examples with `^0.2.3`, and explain how to update existing MCP configurations without changing keys.

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
