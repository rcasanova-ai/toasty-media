# Human Presence Verification (scaffold)

Status: experimental, disabled by default. This is presence assurance, not identity proof or a definitive deepfake detector.

## Shared protocol v0
Challenge issuance: server generates cryptographically random challenge ID, nonce, action and expiration (60 seconds). Actions: head turn, finger count, spoken phrase. Never allow clients to select the challenge or supply their own timestamps.

Client captures consent, media permissions and challenge response. Do not upload or store raw biometric media by default. A server-side verifier validates challenge binding, expiry, replay protection, participant/session binding and evidence provenance. Client-reported success is **never** sufficient for a pass.

Result: `passed | failed | inconclusive`; include methods, assurance level, issuedAt, expiresAt, verifier version, nonce hash and signed receipt ID. Until a trusted liveness verifier is integrated, every result must be `inconclusive`.

## Integration
Studio: optional host-triggered challenge, participant consent, status UI, re-challenge on media source changes. Never interrupt recording or auto-ban on inconclusive results.

Peeps: Jam participant verification, explicit consent, attach short-lived receipt reference as a Breadcrumb to a Dub. Never reuse an old receipt as current liveness proof.

## Security and privacy
Rate limit challenges; authenticate all endpoints; bind challenge to authenticated session and participant; expire and atomically consume nonce; audit events; redact personal data; allow revocation and deletion; define retention policy. Avoid persistent face templates. Account for virtual cameras, injected media, accessibility alternatives and false positives.

## Next implementation milestone
Add server challenge and verification endpoints, persistence and replay tests, feature flag, minimal participant challenge UI, then connect a vetted active-liveness vendor/model and red-team with real-time face swap, synthetic speech, replay and genuine users. No production claims before independent evaluation.
