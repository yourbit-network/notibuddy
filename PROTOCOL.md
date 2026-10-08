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
| Sender signing key `SS` | Sender | P-256 ECDSA | Created by `nb pair`, stored at `~/.notibuddy/sender.json` (mode 0600) |
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

`activity` payload:

```json
{ "type": "activity", "activityId": "ci-42", "title": "CI", "status": "Running tests", "step": 3, "totalSteps": 10, "timerEndsAt": 1790000900 }
```

`requiresAuth` can only make the device stricter. Device policy MAY require biometrics for every answer regardless.

### 5.2 Device verification (MUST, in this order)

1. `v == 1`, `kind == "request"`, all identifiers valid, and `deviceId` equals the device's own ID.
2. `senderKeyId` is a pinned sender.
3. `sig` verifies under that sender's key.
4. Validity window: `expiresAt > now`, `createdAt <= now + 300`, and `expiresAt - createdAt <= 86400`.
5. `requestId` has not been seen before. The device keeps seen IDs at least until `expiresAt`.
6. HPKE opens.
7. Payload `type` matches the primitive, per §5.1.

If any check fails, the device MUST NOT show the content. For an `ask`, it SHOULD send an error envelope (§7).

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

- `action` is one of the request's `options`, `"submit"` for forms, `"reply"` for text input, or `"dismiss"`.
- Free text is only ever placed in `text`, never in `action`.
- `authenticated` is true only if the user passed biometric or passcode authentication for this answer.

**Sender verification (MUST).** The `deviceId` is the paired device. `requestId` is one of the sender's pending
requests. `sig` verifies under the pinned `DS.pub`. HPKE opens with `R`. The sender accepts at most one answer per request.

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
