# Contributing to NotiBuddy

This repository is the source of truth for the public CLI and MCP package. Open a focused pull request against `main`; explain the behavior change and how you tested it. Report security issues through [the private reporting process](SECURITY.md).

## Local setup

Use Node.js 20 or newer, Git, and npm. Install [Gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 or newer. On macOS, `brew install gitleaks` installs the scanner.

```sh
npm ci
node scripts/install-hooks.mjs
npm run build
npm test
npm run test:release
npm run test:hooks
npm run pack:check -- --scan
```

The hook installer and hook integration tests use a POSIX shell. On Windows use Git Bash or WSL for these commands; ordinary CLI tests run natively in Windows CI. Keep Windows profiles under your private user directory; Windows access controls use ACLs rather than Unix file mode bits. Never place pairing profiles in a shared folder.

Tests need no phone or production credentials. Use the existing synthetic fixtures; do not paste a real pairing bundle. Test-vector regeneration requires the explicit `NOTIBUDDY_WRITE_TEST_VECTORS=1` opt-in and a review of fixture exceptions in `.gitleaks.toml`.

The installer preserves existing signing and attestation hooks. Maintainers sign commits with their registered signing keys. Local hooks can be bypassed, so CI independently scans history, tests the hook, and scans the packed release. Never bypass a finding to publish; investigate it and revoke any exposed credential first.

## Pull requests

Keep protocol changes compatible with released phone apps, or describe the migration before changing behavior. Add regression coverage for meaningful behavior changes. Update documentation and `CHANGELOG.md` where users or contributors need to know about the change.

CI builds and tests Linux with Node 20, 22, and 24, and macOS and Windows with Node 24. It installs the actual package archive in a temporary project and exercises its entry points. All platform checks and the independent secret/hook checks feed the required `Required checks` result. Maintainers review and merge manually; dependency updates are not automatically merged.

## Repository boundaries

Public package changes begin here, including changes developed alongside the app. The private application repository keeps a reviewed copy in `notibuddy-mcp/`; its integration tests remain outside that directory. After merging here, a maintainer synchronizes the public tracked files into that copy and runs the private integration checks.

Never push private or legacy repository branches, tags, or Git history into this repository. Only deliberately reviewed package files belong here. Do not add app sources, relay deployment files, signing identities, pairing profiles, `.npmrc`, `.env` files, or internal release notes.

## Releases

1. Submit a PR updating `package.json`, the root package versions in `package-lock.json`, and the changelog to a new unpublished stable version.
2. Merge after all required checks pass. Synchronize the private package copy and run its application integration checks.
3. From an up-to-date public `main`, create a signed annotated tag: `git tag -s v<version> -m 'Release v<version>'`. Push that tag as the repository owner.
4. Watch **Publish to npm**. It checks that the tag is on `main`, scans its history and tag message, tests the package, and checks the exact archive's file list and secret scan before publishing that archive with OIDC provenance.
5. The final step checks the public exact version, `latest`, and downloaded archive integrity. npm processing may take a few minutes. If this step fails after a successful publish, verify registry availability before taking any action. Do not republish the same version or move/delete a release tag. Fix forward with a new version when needed.

`publish.yml` is the workflow registered with npm trusted publishing; keep its name and repository identity aligned with npm. It needs no saved npm publishing token. The scanner download is version- and checksum-pinned in `scripts/install-ci-gitleaks.sh`; review both when updating it. Dependabot maintains pinned GitHub Action references weekly.
