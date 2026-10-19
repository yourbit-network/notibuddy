# Published client acceptance

The published-client workflow installs the exact public `notibuddy@0.2.7` archive
on Linux (Node 20) and Windows (Node 24), each with a fresh temporary directory,
cache and profile. `test-vectors/published-0.2.7.json`
pins the registry archive hash, integrity and file count; it contains public
release metadata only. This lane is separate from tests of the current source.

It checks generated MCP setup, two destinations, CLI and MCP encrypted requests,
verified replies, invalid-signature recovery, and encrypted file collection with
a durable save before acknowledgement and lost-ack recovery after restart.
All simulated phone identities and files are disposable. The fixture uses a
loopback HTTP responder and never connects to the production relay or Apple.
The registry installation needs internet access; the fixture restricts fetch
in its child clients to loopback, which is not a process-wide firewall.

On Windows with Node 24 and its npm installation:

```sh
node --test scripts/tests/installed-client-acceptance.test.mjs
node scripts/check-installed-client.mjs --release test-vectors/published-0.2.7.json --output .build/windows-public-027 --expected-platform win32
```

For Linux with Node 20 or newer, use `--expected-platform linux`; for macOS,
use `--expected-platform darwin`. Unix file and directory modes must be `0600`
and `0700`. Use a new output directory for every run. The receipt records exact artifact
binding, commands, outcomes and cleanup, without private keys or file content.
On Windows, a read-only DACL walk checks the actual destination/pending-key and
received-file trees before cleanup. It permits access for the current user,
SYSTEM and local administrators; other effective allow entries fail the check.
A disposable control verifies that a private file passes and an Everyone-readable
file fails. The check reads permissions, never file contents, and does not repair
or change the application profile. This is evidence for the tested Windows
profile, not a guarantee for shared/custom directories or other Windows systems.
Signals/crash handling, v2, first-use invitations, APNs, purchases and physical
Apple-device acceptance remain outside this lane.
