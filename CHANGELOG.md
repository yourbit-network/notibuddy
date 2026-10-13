# Changelog

## 0.2.0 — Unreleased

- Receive phone-shared files up to 10 MB through explicit CLI/MCP destination inboxes. Authenticate and decrypt locally, save privately, then acknowledge delivery; retry lost acknowledgements without downloading twice.
- Bind a separate receiving public key into pairing approval. Existing connections require explicit re-pairing and phone approval to enable files.
- Keep filenames and content types encrypted; reject tampered files, unsafe paths, wrong recipients, and expired transfers.

- Require explicit named destinations under `~/.notibuddy/destinations`; add list, rename, and explicit legacy migration preserving keys and pending replies.
- Pin MCP to one destination or enforce an explicit allowlist with per-call selection and destination discovery. No implicit default, fallback, or broadcast.
- Add optional encrypted sender labels, defaulting to hostname, independently of the approved connection identity.
- Preserve destination-bound replies across renames/restarts and original source labels across activity updates.
- Breaking: CLI sends and MCP startup now require destination flags. Update existing MCP entries after migration; low-level legacy config helper exports are replaced by `DestinationStore`.


- Add independent CI secret scans and pre-push enforcement tests.
- Test the CLI and packaged entry points on Linux, macOS, and Windows.
- Validate and scan the exact npm archive before publishing; verify its public registry integrity afterward.
- Add grouped dependency updates, private security reporting guidance, and contribution templates.

## 0.1.1 — 2026-10-07

- Clarify phone approval and separate profiles in the quick start.
- Publish using GitHub Actions trusted publishing with npm provenance.

## 0.1.0 — 2026-10-07

- Initial public CLI and MCP package for encrypted NotiBuddy requests, replies, and live activity controls.
- Pair computers using phone-generated bundles and explicit approval on the phone.
- Preserve pending replies across computer restarts and support separate phone profiles.
