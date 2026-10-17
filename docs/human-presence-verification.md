# Human Presence Verification

Status: first functional version, **disabled by default**. This is presence assurance, not identity proof and not a deepfake detector.

**Completing a challenge does not establish authenticity.** Until a trusted liveness verifier is registered and enabled, every result is `inconclusive` and no participant is ever shown as verified.

## What works

- Server issued, randomized challenges: three steps drawn from head turns, hand gestures (finger counts, fist) and spoken phrases, at least two distinct types, 60 second expiry. Clients never choose steps, ids, nonces or timestamps.
- Camera and microphone challenge dialog in Studio (guests), the Peeps Jam lobby and the Peeps protected room. Analysis is on device only; the browser sends a few coarse numbers (motion, audio level, phrase match score), never frames, audio or transcripts.
- Server side validation: strict evidence envelope (unknown fields, raw media fields and oversize bodies are rejected), nonce check, step order check, server measured timing, atomic single use consumption (replays and concurrent replays lose), session and participant binding, per request attempt cap (5) and one live challenge at a time.
- Signed receipts: `hpr1.<payload>.<HMAC-SHA256>`, key id and rotation, 15 minute freshness, opaque subject reference, no personal or biometric data. Receipt verification endpoint (signed in callers in the owning organization only) also checks revocation.
- Host controls: request a check before or during a session for a guest in the room (Studio director page) or for a Jam participant (Peeps Jam page). Participants can decline, and declining never removes anyone. Hosts can cancel open requests.
- Status and audit: per participant status chips (`not requested`, `check requested`, `in progress`, `inconclusive`, `did not pass`, `declined`, `expired`, `verified`) and an append only audit history. `verified` is reachable only through a trusted verifier.
- Peeps integration: a completed Jam check writes a `presence.check` Jam event and a Dub Breadcrumb of kind `presence_check` (class `presence_unverified`, or `presence_verified` only for a trusted pass). It stores a receipt reference, not the receipt. It creates no Dub profile entry, so it cannot influence matching. Receipts expire; an old receipt is never current proof.
- Privacy: explicit consent before any challenge, delete my result (revokes and erases the receipt), result rows purged after `HUMAN_PRESENCE_RETENTION_DAYS` (default 30), audit rows after `HUMAN_PRESENCE_AUDIT_RETENTION_DAYS` (default 180). Tables hold no column that could store media or face templates.

## Feature flags (all default off)

| Variable | Effect |
|---|---|
| `HUMAN_PRESENCE_ENABLED=1` | Turns on the Studio feature. Without it every route returns 404 and the UI stays inert. |
| `HUMAN_PRESENCE_PEEPS_ENABLED=1` | Also enables the Jam, Dub and Breadcrumb integration (needs the flag above). |
| `HUMAN_PRESENCE_PROVIDER=<id>` | Selects a registered liveness verifier. Unknown or unset means the null verifier (always inconclusive). |
| `HUMAN_PRESENCE_RECEIPT_KEYS=kid:secret,...` | Receipt signing keys, first one signs, the rest only verify. Defaults to a key derived from `TOASTY_SESSION_SECRET`. |
| `HUMAN_PRESENCE_RETENTION_DAYS`, `HUMAN_PRESENCE_AUDIT_RETENTION_DAYS` | Retention. |

Operational note: nginx does not deploy automatically. `scripts/nginx-render.conf.example` has the new `/api/human-presence/*` block and the session sub-route additions; they must be applied on the host before enabling the flag.

## Adding a deepfake or liveness provider later

Implement `{ id, version, trusted, verify({ challenge, evidence, elapsedMs }) }` returning `{ outcome, assurance, reasonCodes, methods }` and call `registerVerifier()` from `scripts/human-presence/core.mjs`. The core downgrades any pass from a verifier without `trusted: true`, any pass on implausible timing or flagged evidence, and any error or timeout to `inconclusive`. Evidence today is only coarse self reported signals. A real provider needs a media path (for example WebRTC to the vendor, or a vendor SDK on device) that returns a vendor attested result, which is a separate, consent reviewed change. No production claim until independently evaluated and red teamed (real time face swap, synthetic speech, replay, virtual cameras, genuine users and accessibility cases).

## Known limitations

- No liveness analysis exists, so no check can ever pass. Statuses top out at `inconclusive`.
- On device signals are weak, trivially spoofable hints and are deliberately not used for any decision.
- Studio guests have no account. A guest is identified by room and participant id and must be present in the room roster; this is the existing Studio trust model. Jam participants are bound to their invite token, which is stronger.
- A browser that already holds the camera for the session (some phones) may refuse a second capture; the dialog then offers cancel and never interrupts the session.
- The camera and microphone capture path was not exercised with real devices in automated tests. The protocol, server, storage and UI states are tested.
- Virtual camera and injected media detection is limited to a self reported flag.
- Accessibility: participants can decline; hosts must have an alternative way to verify (not built).

## Tests

`node scripts/human-presence-core-test.mjs` (protocol, trust gate, receipts, status) and `node scripts/human-presence-server-test.mjs` (HTTP: flag gate, host controls, consent, expiry, replay, binding, receipts, audit, revocation, Jam integration). Both run in `npm test`.
