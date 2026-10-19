# Published client acceptance

The Windows workflow installs the exact public `notibuddy@0.2.6` archive into a
fresh temporary directory, cache and profile. `test-vectors/published-0.2.6.json`
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
node scripts/check-installed-client.mjs --release test-vectors/published-0.2.6.json --output .build/windows-public-026 --expected-platform win32
```

Use a new output directory for every run. The receipt records exact artifact
binding, commands, outcomes and cleanup, without private keys or file content.
This lane does not establish Windows ACL protection, signals/crash handling, v2,
first-use invitations, APNs, purchases or physical Apple-device acceptance.
