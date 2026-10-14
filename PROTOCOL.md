# NotiBuddy Protocol v1

Status: **draft**. This document is normative for `notibuddy-mcp` and for the NotiBuddy iOS app.
Anything not written here is not a guarantee.

The key words MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

## 1. Goals and threat model

NotiBuddy lets a program on your computer (the **sender**, usually an AI agent) ask you something on your
phone (the **device**) and get a trustworthy answer back. Messages pass through a hosted **relay**.

| Party | Trusted for | Not trusted for |
|---|---|---|
| Device (your iPhone) | Showing requests, holding device keys, producing answers | n/a |
| Sender (this package, on your machine) | Holding the sender key and reply keys, verifying answers | n/a |
| Relay (hosted by NotiBuddy) | Availability, auth, quotas, routing | **Confidentiality or integrity of content** |
| Apple Push Notification service | Delivery | **Confidentiality of content** |

Guarantees, assuming the device and sender machine are not compromised:

1. **Confidentiality.** The relay and APNs never see request content (title, message, options, form fields) or answers.
2. **Request authenticity.** The device only shows requests signed by a sender key that the user paired out of band.
   A malicious relay cannot inject prompts.
3. **Answer authenticity.** The sender only accepts answers signed by the paired device key. A malicious relay, or
   anyone who steals the bearer token, cannot forge an "approve".
4. **Binding.** Ciphertexts are bound to their request ID, device, sender, primitive, and validity window, so they
   cannot be swapped, re-targeted, or replayed.

Non-goals (visible to the relay): request IDs, primitive type, timestamps, ciphertext sizes, device and sender key IDs,
APNs tokens, IP addresses, and the timing of answers.

> **A sender that skips verification can always "approve" itself.** Guarantee 3 protects the sender from everyone else,
> not from itself. Any system that consumes approvals on behalf of a third party MUST verify the device signature itself.

## 2. Primitives

| Purpose | Algorithm |
|---|---|
| Public-key encryption | HPKE (RFC 9180), mode `base`, `DHKEM(P-256, HKDF-SHA256)` (0x0010), `HKDF-SHA256` (0x0001), `AES-256-GCM` (0x0002), single-shot (sequence 0) |
| Signatures | ECDSA P-256 with SHA-256. Signatures are encoded as raw `r ‖ s` (64 bytes, IEEE P1363) |
| Pairing MAC | HMAC-SHA256 |
| Fingerprints | SHA-256 |

**Encodings.** Binary values are **base64url without padding** (`b64u`). Public keys are uncompressed SEC1 points
(65 bytes, leading `0x04`). Timestamps are integer Unix **seconds**.

**Identifiers.** `requestId`, `deviceId`, `senderKeyId`, `primitive`, and error `code` MUST match `^[A-Za-z0-9_-]{1,64}$`.
That rule keeps header strings unambiguous.

## 3. Keys

| Key | Holder | Type | Notes |
|---|---|---|---|
| Device encryption key `DE` | Device | P-256 key agreement | Usable without biometrics, so the notification service extension can decrypt in the background. SHOULD live in the Secure Enclave |
| Device signing key `DS` | Device | P-256 ECDSA | SHOULD live in the Secure Enclave. SHOULD require user presence for approvals |
| Sender signing key `SS` | Sender | P-256 ECDSA | Created per destination by `nb pair --to <name>`, stored in `~/.notibuddy/destinations/<name>.json` (mode 0600; legacy imports preserve the existing key) |
| Reply key `R` | Sender | P-256 key agreement | Fresh per request. Kept until the request expires |

Key IDs:

```
deviceId    = "dev_" + hex(SHA-256(DE.pub ‖ DS.pub))[0:24]
senderKeyId = "snd_" + hex(SHA-256(SS.pub))[0:24]
```

Because the device ID is derived from its keys, a party that knows the ID can check that the keys match it. The relay
MUST reject a device registration whose `deviceId` does not match its keys.

## 4. Pairing

Pairing has to move the device's public keys to the sender, and the sender's public key to the device, without trusting
the relay. It uses an out-of-band channel (AirDrop, Messages, copy and paste) plus a single-use secret.

### 4.1 Pairing bundle (device → sender, out of band)

The device creates a random 32-byte `pairSecret` and shows the user this bundle:

```
nbpair1.<b64u(UTF-8 JSON)>
```

```json
{
  "v": 1,
  "relay": "https://relay.example",
  "token": "nb_snd_live_…",
  "device": { "id": "dev_…", "encPub": "<b64u>", "sigPub": "<b64u>", "name": "Diego's iPhone" },
  "pairSecret": "<b64u 32 bytes>"
}
```

The sender MUST check that `device.id` matches the keys (§3) before saving the bundle.

The client accepts at most 32,768 input characters (including surrounding copy/paste whitespace) and 16,384 decoded JSON bytes. The outer data and 32-byte pairing secret use canonical unpadded Base64URL; JSON must be valid UTF-8. Both public keys must be canonical 65-byte uncompressed points on P-256, not merely strings of the right length. The sender token has the form `nb_snd_` followed by 1–256 ASCII letters, digits, underscores or hyphens; device/user credentials are not pairing tokens. Relay URLs are limited to 2,048 characters before and after normalization. An optional device name is at most 256 UTF-8 bytes and contains no C0/C1 controls.

Pairing accepts only the fields shown above plus negotiated `requestProtocol` (1 or 2) and `minimumRecipientGeneration` (a nonnegative safe integer, only for protocol 2). Unknown root/device fields fail closed so clients cannot silently ignore an unsupported setup contract. HTTPS is required except for local development on `localhost`, `127.0.0.1` or `[::1]`; credentials, queries and fragments are rejected. `parsePairingBundle` and direct `DestinationStore.prepare` calls share validation and snapshot the bundle before asynchronous key work. Invalid data must not create or overwrite a destination. Existing destination opens also check the stored public-key points, without deleting invalid records.

### 4.2 Sender registration (sender → relay → device)

The sender creates `SS`, then calls `POST /v1/senders`:

```json
{ "senderKeyId": "snd_…", "senderPub": "<b64u>", "label": "claude-code@macbook", "mac": "<b64u>", "createdAt": 1738800000, "nonce": "<random UUID>", "sig": "<b64u P1363 signature>" }
```

```
mac = HMAC-SHA256(pairSecret,
        UTF-8("nb1|sender|" + deviceId + "|" + senderKeyId) ‖ 0x00 ‖ senderPub ‖ 0x00 ‖ UTF-8(label))
```

The relay also requires a sender-key ownership signature for both initial registration and updates. Sign the UTF-8 JSON array (compact `JSON.stringify` encoding) `['nb1', 'sender-registration', realm, senderKeyId, senderPub, label, mac, createdAt, nonce]` with SS using ECDSA P-256/SHA-256. `realm` is the bearer token after removing its `nb_snd_`, `nb_dev_`, or `nb_usr_` prefix. `createdAt` is integer Unix seconds within 120 seconds of the relay; `nonce` is a fresh 16–80 character identifier. The relay retains nonces for 240 seconds. An exact retry returns success while that registration remains current; a superseded retry cannot roll it back. Upgrade sender clients before requiring this proof on the relay. Existing request signatures and stored registrations are unchanged.

`label` MUST be 1–64 bytes of UTF-8 and MUST NOT contain control characters.

The device fetches `GET /v1/senders`. For each entry it MUST:
- recompute and check the MAC in constant time;
- check that `senderKeyId` matches `senderPub`;
- only then pin the sender, showing the label to the user.

After pinning one sender, the device MUST rotate `pairSecret`, so a bundle pairs exactly one sender.
The sender MUST delete `pairSecret` from disk once registration succeeds.

The relay never sees `pairSecret`, so it cannot register its own sender key.

## 5. Request envelope (sender → device)

```json
{
  "v": 1,
  "kind": "request",
  "requestId": "req_…",
  "deviceId": "dev_…",
  "senderKeyId": "snd_…",
  "primitive": "approval",
  "createdAt": 1790000000,
  "expiresAt": 1790000300,
  "enc": "<b64u 65 bytes>",
  "ct":  "<b64u>",
  "sig": "<b64u 64 bytes>"
}
```

**Header.** All parties build this string and use it as the HPKE AAD:

```
header = "nb1|request|" + requestId + "|" + deviceId + "|" + senderKeyId + "|" + primitive
         + "|" + createdAt + "|" + expiresAt
```

**Encryption.**

```
(enc, ct) = HPKE.SealBase(pkR = DE.pub, info = "notibuddy/v1/request", aad = UTF-8(header), pt = UTF-8(JSON payload))
```

**Signature.**

```
sig = ECDSA-Sign(SS, UTF-8(header) ‖ 0x00 ‖ enc ‖ ct)
```

The sender MUST encrypt a separate envelope for each target device.

### 5.1 Primitives and payloads

| `primitive` | Payload `type` | Expects an answer |
|---|---|---|
| `approval` | `ask` | yes |
| `text_input` | `ask` | yes |
| `form` | `ask` | yes |
| `diff` | `ask` | yes |
| `activity_start`, `activity_update`, `activity_end` | `activity` | no |

`ask` payload:

```json
{
  "type": "ask",
  "replyPub": "<b64u R.pub>",
  "title": "Deploy v1.4 to production?",
  "message": "optional longer text",
  "options": ["Approve", "Deny"],
  "inputPlaceholder": "optional",
  "fields": [ { "id": "env", "type": "picker", "label": "Environment", "options": [{"id":"stg","label":"Staging"}] } ],
  "requiresAuth": true
}
```

For `diff`, the encrypted `ask` payload instead includes flat `filename`, optional `language`, `original`, and `modified` fields. These are not a nested `diff` object on the wire. `filename` is display-only; no recipient reads or writes that path. Default action IDs are `reject` (Discard) and `approve` (Apply). Approval is a decision, not execution or file mutation. An applying caller must still check that the current source matches the reviewed original.

The 0.2.1 high-level client accepts these fields as `diff: {filename, language?, original, modified}` and excludes form fields, choices, text input and resume IDs from a new diff request. It requires valid Unicode source totaling at most 96,000 UTF-8 bytes and 20,000 lines (one initial line per text plus each LF). Filename is nonblank and at most 512 UTF-8 bytes; language is at most 40 UTF-8 bytes; neither label may contain control or format characters. The CLI reads a regular UTF-8 JSON file bounded to 150,000 bytes. The existing ciphertext limit still applies to the entire serialized request, including JSON escaping and authentication overhead. Resume uses the saved request ID and original ciphertext without resupplying the diff. These plaintext limits are enforced by the client, not by a relay that cannot decrypt it.

`activity` payload:

```json
{ "type": "activity", "activityId": "ci-42", "title": "CI", "status": "Running tests", "step": 3, "totalSteps": 10, "timerEndsAt": 1790000900 }
```

`requiresAuth` can only make the device stricter. Device policy MAY require biometrics for every answer regardless.

### 5.2 Device verification (MUST, before displaying content)

1. `v == 1`, `kind == "request"`, all identifiers valid, and `deviceId` equals the device's own ID.
2. `senderKeyId` is a pinned sender.
3. Binary fields use canonical unpadded Base64URL: decoding and re-encoding MUST reproduce the original value, including unused low bits. `enc` is a valid 65-byte uncompressed P-256 point, `sig` is 64 bytes, and `ct` is 16–150,000 decoded bytes (including the 16-byte GCM tag). Validate lengths before allocating decoded data. `sig` verifies under that sender's key.
4. Timestamps are nonnegative safe integers (at most 9,007,199,254,740,991). Validity window: `expiresAt > now`, `createdAt <= now + 120`, and `0 < expiresAt - createdAt <= 3600`. A delayed fetch is allowed while the signed request remains unexpired; the device MUST NOT apply a fresh-arrival lower bound to `createdAt`.
5. `requestId` has not been seen before. The device keeps seen IDs at least until `expiresAt`.
6. HPKE opens.
7. Payload `type` matches the primitive, per §5.1.

If any check fails, the device MUST NOT show the content. For an `ask`, it SHOULD send an error envelope (§7).

The relay applies an additional ingestion-time rule: `abs(createdAt - edgeNow) <= 120` and `expiresAt <= edgeNow + 3600`, alongside the same lifetime and encoding bounds. This does not impose a 120-second delivery deadline on requests already accepted. The maximum UTF-8 JSON plaintext is 149,984 bytes; count encoded bytes, not characters. Pairing proof inputs consumed by the device also require canonical Base64URL with a 32-byte secret/MAC and valid 65-byte public keys. These request rules do not replace the separate reply lifetime checks.

### 5.3 Plaintext routing consistency

Authenticated routing fields remain authoritative after decryption. Any plaintext `requestId`, `request_id`, or `relayRequestId` must match the outer delivery's `requestId`. Any plaintext `senderId`, `sender_id`, `senderKeyId`, or `sender_key_id` must match the authenticated sender. A supplied ordinary payload `primitive` must match the outer primitive; it cannot change an approval into a form or activity. Ordinary requests cannot introduce an `activityId`, and a supplied `sessionId` must equal their request ID.

For activities, the outer `activity_start/update/end` is the operation and the inner `timer`/`stepper` is the display primitive. The start's `activityId` equals its outer request ID; updates/endings keep that stable activity ID and use a fresh outer delivery ID. A supplied `action` must agree with the outer operation. Activity IDs use the same 1–64 ASCII identifier rules as request IDs. In group delivery, the plaintext activity/session ID must also match the signed outer `sessionId`. Sender labels never change this routing or session ownership.

Native compatibility parsing also accepts legacy flat content or an object-valued nested `payload`, including omitted legacy `type` fields. Present routing fields at either level must still agree; malformed or conflicting values fail instead of falling back. A nested activity's root `primitive`, when present, names the outer operation, while its payload names the display primitive. Provided authenticated timestamps take precedence over nested timestamps. This compatibility does not permit unauthenticated transport and does not require an extra plaintext `v`: current `AskPayload` and `ActivityPayload` have no such field.

## 6. Reply envelope (device → sender)

```json
{ "v": 1, "kind": "reply", "requestId": "req_…", "deviceId": "dev_…", "createdAt": 1790000042,
  "enc": "<b64u>", "ct": "<b64u>", "sig": "<b64u>" }
```

```
header = "nb1|reply|" + requestId + "|" + deviceId + "|" + createdAt
(enc, ct) = HPKE.SealBase(pkR = replyPub, info = "notibuddy/v1/reply", aad = UTF-8(header), pt = UTF-8(JSON answer))
sig = ECDSA-Sign(DS, UTF-8(header) ‖ 0x00 ‖ enc ‖ ct)
```

Answer payload:

```json
{ "action": "Approve", "text": "optional free text", "values": { "env": "stg" }, "authenticated": true }
```

- `action` is one of the request's `options`, `"submit"` for forms, `"reply"` for text input, `"approve"`/`"reject"` for default diff actions, or `"dismiss"`.
- Free text is only ever placed in `text`, never in `action`.
- `authenticated` is true only if the user passed biometric or passcode authentication for this answer.

**Sender verification (MUST).** The `deviceId` is the paired device. `requestId` is one of the sender's pending
requests. `sig` verifies under the pinned `DS.pub`. HPKE opens with `R`. The sender accepts at most one answer per request.

The exported `openReply` and `openError` helpers require `expectedRequestId` from the caller's saved request, alongside the pinned device ID/key. Do not derive the expected ID from the received envelope. This is a required argument for direct library users in 0.2.0; older calls that omit it fail closed. The helpers verify wire structure, binding and signatures (and decrypt/validate answers for replies). They do not own pending-request storage: direct callers must enforce the original request lifetime and single-answer/terminal-state policy. `NotiBuddyClient` supplies those checks for CLI/MCP callers and preserves resumable state on an invalid response.

## 7. Error envelope (device → sender)

Used when the device cannot or will not show a request. Errors are signed but not encrypted.

```json
{ "v": 1, "kind": "error", "requestId": "req_…", "deviceId": "dev_…", "createdAt": 1790000042,
  "code": "undecryptable", "sig": "<b64u>" }
```

```
header = "nb1|error|" + requestId + "|" + deviceId + "|" + createdAt + "|" + code
sig    = ECDSA-Sign(DS, UTF-8(header) ‖ 0x00)
```

Codes: `undecryptable`, `bad_signature`, `unknown_sender`, `expired`, `replayed`, `unsupported`, `wrong_device`.

## 8. Relay API

All calls use `Authorization: Bearer <token>`. Tokens in query strings MUST be rejected.

| Method | Path | Caller | Purpose |
|---|---|---|---|
| `POST` | `/v1/devices` | device | Register `{deviceId, encPub, sigPub, apnsToken?, pushToStartToken?, pushEnvironment}` |
| `POST` | `/v1/senders` | sender | Register a sender (§4.2) |
| `GET`  | `/v1/senders` | device | List sender registrations to verify and pin |
| `POST` | `/v1/requests` | sender | Submit a request envelope. Responses: `202 {requestId, seq}`, `400`, `402` quota, `404` unknown device, `409` duplicate |
| `GET`  | `/v1/requests/{id}` | device | Fetch a request envelope |
| `POST` | `/v1/replies` | device | Submit a reply or error envelope |
| `GET`  | `/v1/replies/{id}?wait=0..25` | sender | Long-poll for the answer. Responses: `200` envelope, `204` not yet, `404`, `410` expired |

### 8.1 Relay checks

The relay can't read content. It enforces the following:

- Authentication and per-account isolation.
- Shape validation per §5–§7.
- Size limits: request `ct` ≤ 32 KiB, reply `ct` ≤ 16 KiB, request body ≤ 64 KiB.
- `enc` is a valid 65-byte point and `sig` is 64 bytes.
- The validity window per §5.2, step 4.
- `deviceId` is registered and matches its keys.
- `senderKeyId` is registered.
- `requestId` is unique.
- Quotas and rate limits.
- **Device signature verification on replies and errors.** This is defense in depth: senders MUST still verify.

**Retention.** The relay deletes request and reply envelopes no later than 10 minutes after `expiresAt`.

**Push.** APNs alerts carry no content:

```json
{ "aps": { "alert": { "title": "NotiBuddy", "body": "New request" }, "mutable-content": 1, "category": "NB_APPROVAL" },
  "nb": { "requestId": "req_…" } }
```

The notification service extension fetches the envelope, verifies and decrypts it, and rewrites the visible notification.
Live Activity pushes carry generic content state only. The widget reads the authenticated snapshot already committed to the shared App Group database; no private display content or encrypted envelope is embedded in the ActivityKit push.

## 9. Versioning

Any change to headers, HPKE parameters, `info` strings, or signature inputs requires a new `v` and a new `nb<N>` header
prefix. Receivers MUST reject versions they do not know.

## 10. Test vectors

`test-vectors/v1.json` contains fixed keys and envelopes produced by the TypeScript implementation.
`test-vectors/v1-swift-reply.json` contains a reply produced by the iOS implementation.
Every implementation MUST pass both files.

## Device management and recovery

All device mutations additionally carry `X-Device-ID`, `X-Device-Timestamp` (Unix seconds), `X-Device-Nonce` (16–80 URL-safe characters), and `X-Device-Signature`. Sign UTF-8 `nb1|http|METHOD|route|timestamp|nonce|bodySHA256hex` with DS. `route` includes the query and excludes the `/v1` prefix. Nonces are single-use, and timestamps allow at most 120 seconds of skew. First enrollment verifies the supplied keys and derived ID; after enrollment, only an enrolled device can authorize changes. Share credentials only after enrollment succeeds.

`GET /v1/requests?deviceId=...` lists pending delivery IDs in sequence order for foreground recovery. `GET /v1/replies/:id` returns 204 only for a pending unanswered request; 404 means missing and 410 means terminal/expired.

Activity payloads include an encrypted stable `activityId`, `action`, `primitive` (`timer` or `stepper`), monotonically increasing `revision`, and `replyPub`. Each start/update/end has a unique outer request ID. The phone renders `timerEndsAt` as `targetTimestamp` and routes replies to the current delivery ID. Activity replies are an ordered stream of signed reply envelopes, read with `afterSeq`; ordinary asks still permit exactly one reply. Duplicate activity signatures are idempotent. `seq` is relay metadata and is not covered by the device signature.

### Durable device responses

The phone persists a completed signed/encrypted reply before attempting delivery. Retries send the identical inner envelope with fresh signed HTTP headers and a fresh nonce. After verifying device authorization and the inner signature, the relay returns the original `seq` for an exact duplicate, including during post-expiry retention. A different answer to a resolved ordinary ask remains a `409` conflict; activity deliveries continue to allow distinct signed events.

For a new reply, the request must still be pending and unexpired. Its signed `createdAt` must be at least the request's `createdAt - 120`, no later than the current time plus 120 seconds, and strictly before the request's `expiresAt`. This permits offline delivery of a previously signed answer during the request lifetime. The outer HTTP timestamp and one-use nonce still enforce fresh device authorization on every attempt. Requests and their receipts are retained for ten minutes after expiration; no new mutation is accepted after expiration. A relay acknowledgement confirms durable relay receipt, not agent consumption.

Queued activity responses retain their original delivery ID even when a newer revision arrives. They are sent in FIFO order per stable session. Legacy action retries follow the same request-lifetime rule in milliseconds and compare every original action-envelope field against a stored receipt.

The device authenticates both the sender's pairing MAC and the envelope signature before decrypting. Plaintext-marker compatibility is not supported on the wire. Reply private keys are stored locally until successful authenticated decryption or retention expiry.

### Device allocation after a plan change

The relay retains registered keys when an entitlement expires or is revoked, but suspends excess delivery slots. Explicit device preferences rank first, followed by original enrollment time and device ID. Eligibility is checked at request time as well as during billing updates and alarms. Suspended devices cannot receive new dispatches, fetch their request content, submit responses, or register activity tokens. Their signatures remain valid for device management and purchase synchronization.

`POST /v1/devices/activate` accepts `{ "deviceId": "dev_…", "replacingDeviceId": "dev_…" }` and requires a registered device's signed HTTP request. The optional replacement releases an active slot in the same atomic operation; an unpaired sender cannot select devices. A successful selection becomes preferred for future downgrades. Upgrading does not silently reactivate previously suspended devices. Device listing exposes `active` and `preference`; billing status distinguishes active `currentDevices` from total `registeredDevices`.


### Durable Live Activity rendering

The start delivery's outer request ID is the stable activity ID. Each update/end has a new outer delivery ID and keeps that stable ID inside the encrypted payload. The notification extension verifies the sender, decrypts the delivery, and atomically commits both its snapshot and an opaque render receipt. End receipts remain queued even after private terminal content is erased.

`POST /v1/device/activity-ready` is a signed device request with `{ "deliveryId": "act_…", "activityId": "act_…", "revision": 2, "action": "update" }`. The relay checks the registered device, sender, delivery primitive, increasing revision, and terminal state. Exact retries succeed; stale or mismatched revisions cannot overwrite later state. A device may register its ActivityKit token before or after the receipt arrives. The relay keeps the latest pending revision, retries temporary APNs failures through its alarm, and deletes invalid tokens only if they still match the failed attempt.

The extension attempts only its own activity's receipt, with a four-second deadline; foreground execution drains and retries pending receipts. A push contains generic `content-state` plus an increasing timestamp. The widget reads the shared snapshot once per rendered surface; missing, provisional, or expired storage disables inline actions. An end receipt triggers an ActivityKit `end` event and removes the activity token after APNs acceptance. Apple controls whether/when pushes and extension execution occur; queued acknowledgements cannot guarantee delivery while the device has no execution opportunity.

Opaque activity bindings and tokens are retained for at most one additional hour after the latest acknowledged delivery expires. This permits a delayed receipt for a still-valid snapshot to advance the revision. Retention never permits stale content pushes. Request ciphertext still follows the existing ten-minute post-expiry retention; removing a device also removes its activity routing.

Rollout: deploy the relay endpoints before shipping the phone app, notification extension, and widget together. Older clients continue their foreground behavior but do not produce background render receipts.


### Activity inactivity expiry

Each activity snapshot expires one hour after its delivery is created. Send an update before that deadline to extend the active session; polling does not extend it. MCP polling reports `expired` after this deadline, and updates/end operations require a new start instead of reviving an expired activity. A fresh start gets a new stable wire ID even if the caller reuses its friendly activity name. The phone rejects a new revision for an expired verified snapshot whether or not its housekeeping pass has already marked the session terminal. Routing retention exists only for delayed acknowledgements of snapshots that were saved while valid.


## Client configuration and descriptive source labels (package 0.2)

Named destinations are local configuration and do not change the v1 cryptographic envelope. Each v2 destination record contains a stable UUID `connectionId`, the existing relay/token/device configuration, and that connection's sender key pair. Aliases are never authentication identities. CLI/MCP must explicitly select a destination; a server with an allowlist must enforce it before dispatch and polling. Request and activity reply state stays scoped to the original relay, account credential, phone identity and sender key. Renames do not change that scope; another pairing cannot resume those replies.

Ask and activity plaintext MAY include `source: {"label":"Build monitor"}`. This object is encrypted and covered by the request signature. Its label is descriptive metadata supplied by the approved connection, not proof of an independently approved application. It MUST NOT override `senderKeyId`, the registered pairing label/MAC, device identity, or response keys. Labels are trimmed, 1–100 UTF-16 code units, and contain no Unicode control (Cc) or format (Cf) characters. Older phones may ignore the object; new phones should show it alongside the approved connection. Malformed labels should fall back to connection identity. Activity updates retain the label from the activity's start.

The optional `source` object is extensible, but this version defines no return-channel field or phone-initiated message capability. A future channel requires a stable opaque ID, advertised receiving capability and appropriate encryption keys, bound to the approved connection. Neither a label nor a historical request constitutes a routable inbox or authorization to execute incoming instructions.


## File receiving capability and transfers (0.2)

File-capable sender registrations add `fileEncPub` (uncompressed P-256 ECDH SEC1, base64url) and `fileDeviceId`. They use a versioned proof:

```
HMAC-SHA256(pairSecret,
 UTF8("nb2|sender|" + deviceId + "|" + senderKeyId) || 0 || senderPubBytes || 0 || UTF8(label) || 0 || fileEncPubBytes)
```

The registration ownership signature covers compact JSON `['nb2','sender-registration',realm,senderKeyId,senderPub,label,mac,createdAt,nonce,fileDeviceId,fileEncPub]`. Both new fields must be present. The phone validates the MAC, key point, and matching device ID; approval submits the exact proof and both fields. Changing any proof field requires approval again and cancels waiting files. Legacy nb1 registrations still send requests but have no file permission. The receiving private key is persisted before registration; it is separate from ECDSA and ephemeral reply keys.

Each phone-originated transfer has an immutable manifest:

```
{v:1,id:"file_<32 lowercase hex>",deviceId,senderKeyId,fileEncPub,
 createdAt,expiresAt,size,cipherSize,enc,sha256,sig}
```

Times are Unix seconds. `expiresAt=createdAt+86400`; retries never extend it. The relay caps its effective deadline at its own receipt time plus 24 hours to tolerate small phone clock skew; status responses return that effective `expiresAt`. `size` is the original file byte count (0–10,000,000). Encrypted plaintext is a four-byte unsigned big-endian metadata length, UTF-8 JSON `{name,type}` (at most 4096 bytes), then the original bytes. `cipherSize` is at most `size+4116`. Filenames and MIME types never appear in the manifest or relay database.

HPKE uses DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, fresh encapsulation per file, info `notibuddy/file/v1`, and AAD:

```
nb1|file|id|deviceId|senderKeyId|fileEncPub|createdAt|expiresAt|size
```

`sha256` is lowercase hex SHA-256 of the raw HPKE ciphertext. `sig` is phone ECDSA P-256/SHA-256, raw P1363 base64url, over UTF-8 `AAD|enc|cipherSize|sha256`. The receiver authenticates the enrolled phone, exact recipient key, manifest fields, deadline, ciphertext length/digest and HPKE tag before exposing plaintext.

All `/v1/files` operations require the existing realm bearer token **and** a fresh identity HTTP signature over the existing `nb1|http|METHOD|/files...|timestamp|nonce|bodySHA256` format. Device requests use the existing X-Device headers. Receivers use `X-Sender-ID`, `X-Sender-Timestamp`, `X-Sender-Nonce`, `X-Sender-Signature`; only currently approved file-capable senders may read their own inbox. A token alone grants no file access. Queries are not accepted.

- `POST /v1/files`: signed device binary upload, base64url JSON manifest in `X-File-Manifest`. Server reserves immutable ID, quotas and deadline before writing private object storage. Stable retries return current state; an in-progress upload returns 409.
- `GET /v1/files`: signed device sees its outgoing statuses; signed receiver sees its own inbox. No decrypted names or types.
- `GET /v1/files/:id`: signed recipient receives raw ciphertext and `X-File-Manifest`, `Cache-Control: no-store`.
- `POST /v1/files/:id/ack`: signed recipient sends `{sha256}` **only after** authentication, decryption and durable local save. The relay makes the transfer unreadable and immediately attempts deletion. Repeating a matching receipt is idempotent.
- `DELETE /v1/files/:id`: signed originating device cancels. The full signed manifest can be supplied as a JSON body to cancel an upload that has not reached the relay yet. Already delivered content cannot be recalled.

Terminal states cannot reopen on upload retries. Expired/cancelled/revoked files cannot be downloaded, even if deletion is delayed. Alarm-driven cleanup retries object-store failures and retains an opaque deletion queue after account deletion. No public object URLs or CDN caching. Terminal routing receipts expire after the original deadline plus 24 hours, subject to completing deletion. Received local files belong to the user and are not automatically erased.

## Experimental group delivery (v2)

The package supports a primary destination and its independently keyed companion when the pairing document explicitly selects `requestProtocol: 2`. CLI/MCP defaults to v1 for existing pairings. V2 discovery, encryption, dispatch, replies, and durable resume are integrated; this source branch does not imply a published package or released Watch app. The relay rollout remains gated until native clients and push support are ready.

`verifyRecipients` checks discovery against the phone identity pinned by pairing. It verifies the independent parent/child enrollment signatures, account binding, key-derived device IDs, generation, and companion capabilities. Enrollment expiry is a deadline to enroll, not a lifetime for approved membership. The relay remains authoritative for roster absence/revocation; a first-time client cannot independently detect an older valid roster. The API does not accept a different primary identity.

`RecipientStore` persists a non-expiring generation/fingerprint checkpoint under `~/.notibuddy/recipients`. Before sending, pass the saved checkpoint into verification and durably remember the verified result. A lower generation or different roster at the same generation fails. Storage errors preserve the previous checkpoint and stop progress; no silent reset. The scope follows the cryptographic destination through alias/label changes. To resume a pending request, retain its original discovery proofs and signed request alongside its existing response key; do not substitute newly enrolled keys for a saved request's recipients.

`sealGroupRequest` encrypts separately for each verified recipient with HPKE info `notibuddy/v2/request`. The authenticated data is the exact per-recipient header:

```text
nb2|request|requestId|primaryDeviceId|recipientDeviceId|senderKeyId|primitive|createdAt|expiresAt|generation|sessionId|revision|sortedRecipientIdsCommaSeparated
```

Each delivery signs UTF-8 header, a zero byte, its 65-byte encapsulated point, and ciphertext. One request holds all deliveries, with one quota charge and terminal state at the relay. Initial sessions use the request ID and revision 1; activity updates/end use new request IDs, the original session ID, and increasing revisions. Existing v1 signature bytes are unchanged.

A response or control signs this header:

```text
nb2|replyOrControl|requestId|parentDeviceId|respondingDeviceId|generation|responseId|createdAt|sortedPeerReceiptIdsCommaSeparated
```

After UTF-8 header and a zero byte, append the sender ciphertext and each peer receipt in order. Each contributes its 65-byte encapsulated point, a four-byte unsigned big-endian ciphertext length, and ciphertext. Encrypt the sender response with info `notibuddy/v2/reply` and authenticated data `header|sender`. Encrypt each peer receipt with info `notibuddy/v2/receipt` and authenticated data `header|receipt|peerDeviceId`.

`openGroupResponse` validates the exact wire shape, original request/parent/generation, addressed actor, permitted capability, signature over **all** ciphertexts, and the decrypted answer shape before returning an answer. A Watch cannot return a terminal form or diff answer; it hands these requests off to its paired iPhone. It verifies the actor against the saved request's recipient snapshot. Request and response/control IDs are deduplication identities, not display labels.

Fields use canonical unpadded base64url and integers within JavaScript's safe range. A request has one or two recipients; a response has at most one peer receipt. Ciphertexts are 16–150,000 bytes, total v2 mutation bodies are at most 512 KiB, and request lifetime is at most one hour. The public, relay, and Swift implementations share `test-vectors/group-delivery-v2.json` for signature compatibility. That fixture contains synthetic ciphertext; separate randomized tests exercise HPKE round trips and wrong-key/recipient rejection.


### Negotiation, HTTP reads, and durable retries

A version-one pairing bundle may include `requestProtocol: 2` and a nonnegative integer `minimumRecipientGeneration`. Unknown protocol values and invalid generation fields fail before pairing. Re-sharing setup for the same pinned identity can upgrade the destination without replacing sender keys. Older setup data cannot downgrade it. A discovery/transport failure never silently sends v1 content from a v2-configured destination. Existing pending requests and activity sessions retain their original protocol until completion.

V2 discovery and reply reads require `X-Sender-Key-ID`, `X-Sender-Timestamp`, `X-Sender-Nonce`, and `X-Sender-Signature`. They use the relay's existing HTTP canonical bytes:

```text
nb1|http|METHOD|exactPathAndQuery|timestamp|nonce|sha256HexOfExactBody
```

The bearer token selects the account separately; enrollment proofs bind the child to that account and the pinned primary. Do not add a token hash to these existing signature bytes. For v2 the signed path keeps `/v2`; v1 routes sign the path after the relay removes `/v1`.

Before dispatch, the client durably saves one record containing the response private key, exact encrypted request envelope, protocol, and original recipient proofs. The private record also retains the plaintext payload while dispatch is unconfirmed so an explicit `RECIPIENTS_CHANGED` rejection can be re-encrypted to freshly verified keys. Acknowledgement removes that retry payload. A membership rejection permits one bounded discovery/re-encryption retry using the same logical ID and original expiry. A lost acknowledgement retries the original envelope; it never substitutes newly discovered keys for an already accepted request.

A positive `wait_seconds` bounds the whole ask operation, including discovery, dispatch, fetch headers, response bytes, and polling. Zero performs one bounded lookup without waiting for a future reply. Cancellation aborts active network reads and preserves persisted state. Invalid signatures, payloads, or sequences return a pending result with the original request ID and preserve the key. Only authenticated/decrypted answers or definitive terminal/rejection outcomes discard it.

Activity operations serialize per activity across local processes. Ambiguous dispatch must settle before a later revision is sent. Polling checks the newest snapshot first, then rotates through bounded older history. Missing/corrupt old keys, invalid replies, or slow history yield warnings while other requests can progress. Sequence and signature checks occur before actions are returned; expired/ended sessions cannot be extended by polling.

Pending files are atomic, fsynced, private on Unix, and scoped by canonical relay URL plus the cryptographic pairing. Known legacy trailing-slash scopes migrate without generating new keys. Records are retained through request expiry plus ten minutes; pruning runs when the store is opened. Stale temporary files older than 24 hours are removed on that same local maintenance path. These files contain sensitive local state; they are not a cloud backup or a claim of hardware-backed sender-key storage.
