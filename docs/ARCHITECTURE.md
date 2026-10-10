# Toasty Peeps architecture

Zero-dependency stack: static HTML/JS (no build step), one Node server file, one Python SQLite helper.

```
                         ┌───────────────────────────── Browser (static) ─────────────────────────────┐
                         │ /peeps/demo/ (seeded, offline)   /peeps/app/* (real UI)   /peeps/waitlist/ │
                         │ /peeps/respond.html + /peeps/zec.html (candidate, token-gated, no account)  │
                         └───────────────┬───────────────────────────────────────────────────────────┘
                                         │ cookie session + CSRF header (candidates: private response token)
                          ┌──────────────▼───────────────┐        ┌───────────────────────────────┐
                          │ scripts/render-production-   │  JSON  │ scripts/toasty-auth-db.py     │
                          │ server.mjs  (HTTP API)       ├───────►│ SQLite: requests, candidates, │
                          │  · agent discovery/ranking   │        │ introductions, Jams, Dough    │
                          │  · Jam/Studio lifecycle      │        │ ledger, economic events,      │
                          │  · Dough ledger + settlement │        │ Breadcrumbs, waitlist, ZEC    │
                          │  · Solana verification       │        │ obligations (all atomic,      │
                          │  · ZEC settlement state      │        │ unique-indexed, idempotent)   │
                          └───┬───────────────┬──────────┘        └───────────────────────────────┘
                              │ read-only     │ (none: never sees a shielded chain)
                   ┌──────────▼───────┐   ┌───▼──────────────────────────────────────────┐
                   │ Solana RPC       │   │ Requester's OWN wallet pays; recipient's OWN  │
                   │ getTransaction   │   │ wallet confirms. Toasty holds no keys.        │
                   └──────────────────┘   └──────────────────────────────────────────────┘
```

## One lifecycle

1. **Outcome request** → agent ranks candidates (internal history, network Dubs with approved Breadcrumbs, labelled demo directory).
2. **Introduction fee** (0.25) paid from **Dough** or as a **USDC transaction verified on Solana** (recipient, mint, amount, success, request-bound reference, signature never reused). Stored as an idempotent *economic event*.
3. **Requester authorizes** → Jam created → outreach → candidate accepts on a private, hashed, expiring link → both sides' availability → first mutual slot booked → Studio session linked to the same Jam.
4. **Consent** is captured from the participant (never claimed by the requester). **Attendance** is emitted by the room (`participant.joined`) when the participant actually joins.
5. **Evidence**: when Studio finalizes the host's recording, it is registered on the Jam automatically; the transcript is stored with its source; **Breadcrumbs** are derived only from attributed transcript segments and reach the person's **Dub** only after they approve them.
6. **Settlement** of the participant's compensation, once, on exactly one rail:
   - **Dough ledger** (off-chain, atomic debit + credit), or
   - **Confidential shielded ZEC** (optional, below).
7. **Receipt** (`GET /api/peeps/requests/:id/receipt`) reads stored state and labels every money line: ONCHAIN VERIFIED, OFFCHAIN, SIMULATED or PENDING; ZEC shows VERIFIED CONFIDENTIAL SETTLEMENT with the network.

## Confidential settlement state machine

`PENDING` (recipient hasn't opted in) → `AWAITING_APPROVAL` (shielded address + consent given) → requester **explicitly approves** (instructions released) → `SUBMITTED` (payer's claim) → `AWAITING_RECIPIENT_CONFIRMATION` → `VERIFIED` | `FAILED` (never settles Dough; retryable; expires).

Confirmation is authenticated by the recipient's private token and bound to the obligation (opaque reference + one-time code + memo + amount + the transaction the payer reported); single-shot; one transaction can settle one obligation (partial unique index). Verified means the recipient's own wallet attested it, because the chain is deliberately opaque to Toasty.

## Trust boundaries

- Client claims (payment, consent, attendance, settlement) are never authoritative; the server verifies or derives them.
- No private keys anywhere in the browser or repo; the server only reads Solana and holds no Zcash keys.
- Waitlist rows are not accounts and grant nothing; invitation tokens are hashed, expiring, single-use. `/api/peeps/*` is gated by waitlist state (`PEEPS_BETA_REQUIRE_INVITE=1` makes the beta fully closed).
- Receipts never expose addresses, memos, ZEC amounts or transaction ids.

## Where the code is

| Concern | Location |
|---|---|
| API, lifecycle, verification, settlement | `scripts/render-production-server.mjs` (sections: Solana billing, PEEPS AGENT-TO-HUMAN TRANSACTION LIFECYCLE, PEEPS PUBLIC WAITLIST, PEEPS CONFIDENTIAL SETTLEMENT) |
| Schema and atomic operations | `scripts/toasty-auth-db.py` |
| Demo (DOM-free engine + seeds) | `peeps/demo/` |
| Judge UI | `peeps/app/golden-path.html`, `js/peeps-golden-path-page.js` |
| Tests | `scripts/peeps-*-test.mjs`, `scripts/solana-real-transaction-verification-test.mjs`, `scripts/dough-*-test.mjs` |
| Zcash regtest harness and real e2e | `scripts/zcash/`, `scripts/zcash-regtest-e2e.mjs` |
