# Toasty Peeps: status, audit and checklist

Last updated with the PR that introduced this file. Statements marked **verified locally** come from the automated suite (`npm test`, server tests against a real server and database in a sandbox). Statements marked **production-verified** were checked against https://toasty.media / https://render.toasty.media. Local verification is never reported as production verification.

## Journey status (the 12 steps)

| # | Step | Status |
|---|---|---|
| 1 | Describe who and what outcome | Works (verified locally). |
| 2 | Dub discovers and evaluates | Works for the Peeps network (Dubs) and a **labelled demo directory**. There is no live external discovery provider; do not describe the directory as a live search. Evaluation is a deterministic, evidence-only interview, persisted. |
| 3 | Review and authorize | Works. Refuses before charging when nobody selected is contactable; the fee is paid once per request (idempotent); the request only becomes "authorized" once an introduction exists. |
| 4 | Invitation through a legitimate path | Peeps members and past participants: account email. Others: an email the requester supplies. Demo participants: a private demo link. **No email provider is configured in production** (`RESEND_API_KEY` unset), so the requester is given the private link to send themselves and confirms; nothing is claimed delivered. Real email delivery needs the key on the render host. |
| 5 | Accept and consent | Works through the person's private link; consent is stored server-side. |
| 6 | Coordinate availability | Works (both sides' windows, first mutual time). |
| 7 | Booked through Studio | Works: one Jam linked to one Studio session; idempotent. |
| 8 | Attend | Attendance is recorded only from the room's own join event. Needs real camera/microphone; **not exercised end to end on real devices by us**. |
| 9 | End Jam triggers post-Jam workflow | Ending the Studio session (or marking the Jam complete) records the completion, evaluates the outcome and names the request so Studio can open the receipt. Verified locally. |
| 10 | Dough settles | Off-chain ledger, atomic and idempotent. Verified locally. |
| 11 | Receipt and Breadcrumbs reflect events | Receipt is generated from stored events. Outcome is "pending" with the reason when a required recording is missing. Breadcrumbs come only from a transcript with named speakers; an automatic transcript is unattributed and creates none. |
| 12 | Dub learns | Participation facts are added automatically; transcript-derived Breadcrumbs are proposals the person approves. |

## Production failures and causes

| Symptom | Cause | Fix |
|---|---|---|
| `no_contactable_candidates` / 0 authorized, N skipped | Demo-directory candidates deliberately had no contact path. | Toasty-run demo participants have an honest demo link; other candidates need a supplied email; refusal now happens before payment. |
| Request stuck at "candidates ready", fee charged | Old authorize charged first, then skipped everyone, and marked the request authorized. | Check before charging; status set only after an introduction exists; startup migration reclassifies saved candidates; re-authorizing never charges twice. |
| "Failed to fetch" | The proxy rate-limits `/api/peeps` (60 requests/min) and answers without CORS headers, which the browser reports as a network failure; the old walkthrough polled too often and replaced the page. | Slower polling, reads retry briefly, a failed refresh no longer wipes a loaded page. |
| Jam never "advanced" | Ending the session did run the workflow but nothing told the host or surfaced errors. | Session end returns the request id and whether the workflow completed; Studio opens the request outcome page. |
| Contradictory receipts | Rail labels did not say where Dough came from. | Receipt distinguishes simulated demo credit, off-chain Dough, verified on-chain, pending. |

## Networks: actual implementation status

| Network | Status |
|---|---|
| Solana (devnet) | **Implemented.** Server reads the transaction from the chain and checks success, mint, recipient, amount, a request-bound reference, and one-use signature. Two real devnet transactions verified (see `docs/SUBMISSION.md`). Request page offers "USDC on Solana" with a Solana Pay link when configured. **Production recipient/mint are not configured** (needs `SVM_PAY_TO`, `TOASTY_USDC_MINT` on the render host), so the option shows as not configured there. |
| Zcash | **Implemented for regtest only** (shielded Orchard transfer, recipient-wallet attestation). Disabled by default in production. Never verified on public testnet or mainnet. |
| Base (x402) | **Implemented, off by default** (`BASE_X402_PAY_TO`). Agents pay the introduction fee with an x402 v2 `exact` EIP-3009 USDC authorization sent as `PAYMENT-SIGNATURE`; Toasty has a facilitator verify and settle it, then re-reads the settlement from the Base RPC (success, USDC moved payer to Toasty for at least the fee, the payer's authorization nonce consumed) and only then records an on-chain-verified event. A settled-but-unconfirmed payment is stored as pending, never verified. Verified locally against fakes plus a genuine Base Sepolia receipt fixture, and the public facilitator accepted our request shape (rejected a bogus signature). **No real Base payment has been made through Toasty, and it is not configured in production.** |
| Avalanche | **Not implemented.** No code. |

## Checklist

- [x] Audit of the lifecycle, networks and production failures (this file)
- [x] Candidate contact paths, charge-before-check, stuck-request recovery
- [x] End Session to receipt; labelled receipt rails
- [x] Evaluation accounts as ordinary isolated users; judge-specific pages removed
- [x] Requester-shared private link when no email provider exists
- [x] Solana devnet payment option restored in the regular request page
- [x] Reads retry on transient network failure
- [ ] Production: sign-in, full journey and persistence verified by an authenticated account (**not done**: needs a real account; see below)
- [ ] Production: Solana devnet recipient configured and one verified payment through the website
- [ ] Production: email provider configured; real outreach delivery verified
- [x] Base x402 and Avalanche evaluated (desk research, nothing built): see `NETWORK_EVALUATION.md`. Recommendation: Base x402 later as an agent rail; keep Zcash for confidentiality; do not build eERC.

## Production verification

Checked against production without an account: static assets deployed, protected routes answer 401 without a session, the render server is healthy. Everything that needs a signed-in account (the journey, persistence across restarts, idempotency of the real ledger) is **unverified in production**. Run `node scripts/production-journey-check.mjs start --guest-email <address>` then `status` with a real account to produce that evidence.
