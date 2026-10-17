# Security policy

Report suspected vulnerabilities privately using [GitHub's private report form](https://github.com/yourbit-network/notibuddy/security/advisories/new), or email **contact@notibuddy.app**. Do not open a public issue for an unpatched vulnerability.

Include the affected package version, operating system, impact, and a minimal reproduction using synthetic credentials. Do not send live pairing bundles, tokens, private keys, your `.notibuddy` directory, private messages, or unrelated personal information. We will coordinate investigation and disclosure with you; response times are not guaranteed.

Security fixes target the latest published `notibuddy` release. Older releases are not maintained separately. Check the [release notes](CHANGELOG.md) before upgrading.

## If a credential was exposed

Removing a Git commit or issue does not invalidate a credential. Disconnect the affected computer on the phone, remove the exposed local profile, and pair again with a fresh sender identity. Revoke any exposed npm, GitHub, or other service credentials at that service. Contact us privately if you need help identifying the affected connection.

## Trust boundaries

The public package contains the CLI, MCP server, protocol implementation, and synthetic tests. The iOS app and relay live in a separate private repository. Encryption does not protect messages from a compromised paired computer or phone. Notification visibility depends on the request's privacy settings and the user's iOS settings.

The Apple app stores its software encryption key in Keychain and uses Secure Enclave signing where available, with a software-key implementation otherwise. The CLI stores software private keys in its local private files; it does not provide a hardware-keystore guarantee. Valid signatures establish the paired key identity, not hardware attestation or biometric authentication. The relay can read routing, timing, size and service-usage metadata even when content is encrypted.

Local pre-push checks, CI secret scans, and GitHub push protection are complementary controls. Automated scanners cannot identify every secret. Never include live credentials in fixtures, reports, pull requests, or workflow logs.
