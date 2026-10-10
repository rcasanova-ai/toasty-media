# Toasty Peeps: Colosseum submission

**Tagline:** Peeps helps people find, trust and compensate other people. Solana powers agent-mediated transactions. Zcash enables confidential human compensation.

- Repository: https://github.com/rcasanova-ai/toasty-media (public)
- Production: https://toasty.media/peeps/ · seeded demo: https://toasty.media/peeps/demo/ · judge path (sign-in): https://toasty.media/peeps/app/golden-path.html
- Run it locally in a minute: [`peeps/README.md`](../peeps/README.md) · three-minute demo script: [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md) · architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)

## 1. Project description

Peeps is a network where an agent (or a person) states an outcome ("someone who can open institutional banking partnerships in Southeast Asia") and Peeps finds the right *human*, proves why they are right, and puts them in a real conversation. Each person has a **Dub**: an evidence-backed profile that answers an agent's questions only from claims it can back up, says "unknown" when it cannot, and asks its human instead of inventing. A real conversation (a **Jam**, run in Toasty Studio) produces **Breadcrumbs**, evidence derived from what was actually said, which improve the person's Dub for the next agent. The person is paid for their time.

## 2. Problem and solution

**Problem.** Agents can search the web but cannot reliably find the right person, judge whether keyword matches are real capability (a large crypto following is not banking access), reach them without spamming, or pay them fairly. People who have context have no way to be found by agents, be compensated, or keep payments private.

**Solution.** Qualify before interrupting (Dub-to-Dub interview, paid context unlocks), require explicit consent at each step (requester authorizes, candidate accepts, both consent to recording), derive evidence only from real interactions, and settle compensation on a rail the participants choose. The human does three things: Find my Peeps, Authorize introductions, Join Jam.

## 3. Why Solana

Peeps runs on micro-payments: fractions of a dollar to unlock context or authorize an introduction. Solana makes that economical, fast and publicly verifiable, and USDC keeps value stable. Peeps never trusts a signature a browser supplies: the server reads the transaction from the chain and checks that it succeeded, moved the configured USDC mint to the configured recipient for at least the price, carries a **request-specific Solana Pay reference** (so a public transaction can't be claimed by someone else), and that the signature was never used for another request, Dough funding or billing. The payer is read from the chain. Agents can pay a `402 Payment Required` response and continue.

## 4. Why Zcash

Compensation between people is sensitive: who was paid, how much, by whom. Zcash shielded transactions let the participant be paid without that data becoming public. In Peeps, confidential payout is optional and consent-based: the recipient opts in with a shielded address, the requester explicitly approves, the requester pays from their own wallet, and the recipient's own wallet confirms. Toasty holds no keys and cannot see the chain, so receipts carry only an opaque reference, a state and a network label, never addresses, memos, amounts in ZEC or transaction ids.

## 5. Technical architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md). Static HTML/JS front end; one Node API file; one Python SQLite helper with atomic, unique-indexed, idempotent operations; Solana read-only RPC; recipient-wallet attestation for Zcash. No dependencies to install.

## 6. Working product features (and exactly how each is verified)

| Feature | Verified how |
|---|---|
| Outcome request, discovery, ranking, authorization, outreach, booking, Jam ↔ Studio session linkage, consent, attendance events, transcript → Breadcrumbs → Dub, Dough ledger settlement | Integration tests against the real server (`npm test`, 17 suites) |
| Solana USDC introduction payment with on-chain verification | Real devnet transactions, below. Also tests against two genuine mainnet USDC transfers captured as fixtures |
| Studio recording registered automatically as the Jam's evidence | `scripts/peeps-recording-ingest-server-test.mjs` with a real WebM through the real transcode path |
| Confidential Zcash settlement | Server-side rules in `scripts/peeps-zcash-settlement-server-test.mjs`; a genuine shielded Orchard transfer on a local regtest chain via `scripts/zcash-regtest-e2e.mjs` |
| Receipt that labels ONCHAIN VERIFIED / OFFCHAIN / SIMULATED / PENDING, and explains *why* an outcome is pending | Receipt assertions in the tests above |
| Public waitlist with invitations and a beta gate | `scripts/peeps-waitlist-server-test.mjs`; deployed |
| One-command local demo with seeded data and simulated payments | `npm run demo`; verified from fresh clones |

### On-chain evidence

- **Solana devnet (two real transactions, verified by the Peeps verification code):**
  - `R2iNoDAHG1UPA36LRttRUk3Wd1G6TQsnPeaVWkr8UaudqtcxWypS27pFxRHnmAkHdRhPWRRnRaxh2SRZsdg6kpQ` ([Explorer](https://explorer.solana.com/tx/R2iNoDAHG1UPA36LRttRUk3Wd1G6TQsnPeaVWkr8UaudqtcxWypS27pFxRHnmAkHdRhPWRRnRaxh2SRZsdg6kpQ?cluster=devnet))
  - `5uu962UaVNwEoVvinwjrdtwKi9MmG7o937HdogzqyHDyExKujZhyVY123tX22c71FFaj5CEfxchqvMvbupAXWtmX` ([Explorer](https://explorer.solana.com/tx/5uu962UaVNwEoVvinwjrdtwKi9MmG7o937HdogzqyHDyExKujZhyVY123tX22c71FFaj5CEfxchqvMvbupAXWtmX?cluster=devnet))
  - Each: 0.25 devnet USDC to the configured recipient with the request's reference account; replay of the same signature returned the same event; reuse on another request was refused. These ran through a local instance of the production server code against the real devnet RPC, not through the production website (that needs a signed-in production account).
- **Zcash, regtest only (no value, not publicly verifiable):** a real Orchard-to-Orchard shielded transaction (version 5, no transparent inputs or outputs, 2 Orchard actions) between two throwaway wallets on a local Zebra + Zaino + zingo-cli chain, confirmed in block 82, 2,500,000 zatoshis with the settlement reference as memo, read back from the recipient's own wallet, and Peeps moved to VERIFIED. The chain was disposable; the transcript is produced by `scripts/zcash-regtest-e2e.mjs`, which anyone can re-run.

## 7. Reproducible demo instructions

1. `git clone` (fast sparse clone in the README), `npm run demo`, open http://127.0.0.1:4173/peeps/demo/ and click **Find my Peeps**, **Authorize introduction · $25**, **Join Jam**.
2. `npm run start:seeded` for the real-services path at `/peeps/app/golden-path.html` (local sandbox, simulated payments).
3. Solana devnet and Zcash regtest instructions: [`peeps/README.md`](../peeps/README.md) and [`scripts/zcash/README.md`](../scripts/zcash/README.md).

## 8. Known limitations (read these)

- **The demo is scripted and seeded by design.** Nothing in it is a real transaction.
- **Live Studio room:** attendance is emitted by the room page when a participant joins, and recording is registered when the host's recording finalizes. We have not exercised a live camera/microphone session end to end ourselves (it needs real devices in a browser); the server-side paths are tested, the live-media path is not.
- **Transcripts are not automatic.** Studio does not store transcripts, and a mixed recording has no speaker separation, so we do not auto-transcribe into Breadcrumbs (they need attributed speakers). The organizer uploads the transcript, and it is labelled as an organizer upload.
- **Dough ledger payouts are off-chain** and labelled so. The receipt never shows a ledger entry as a blockchain payout.
- **Zcash is regtest-proven only.** It has not run on public testnet (there is no automated faucet) or mainnet, and it is disabled by default in production. "Verified" means the recipient's wallet attested receipt, since the chain is opaque to Toasty.
- **Solana** is proven on devnet and against captured mainnet transaction structure; production is configured for devnet.
- Candidate discovery outside the network uses a labelled demo directory. Outreach email is recorded rather than sent unless a provider key is configured.
- Waitlist: deployed and tested; production persistence and email delivery status still need an admin to confirm in the live admin panel.
