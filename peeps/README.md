# Toasty Peeps

**Human context, agent-accessible.** You tell an agent the outcome you want ("a fintech operator who understands offline payments, for a recorded podcast"). The agent finds candidates, checks them against what they have actually done, pays for context, asks permission before interrupting anyone, and only then puts two humans in a real conversation. That conversation produces evidence, the evidence updates the person's profile, and the person gets paid.

> **Judges: you can run the whole story in one minute with no accounts, no wallet and no network.**
> See [Quick start](#quick-start-60-seconds) and [Demo walkthrough](#demo-walkthrough-davidsarah).

- Live demo: https://toasty.media/peeps/demo/
- Source: this repository (`peeps/`, `js/peeps-*`, `scripts/render-production-server.mjs`, `scripts/toasty-auth-db.py`)

## What Peeps does

| Idea | Meaning |
|---|---|
| **Dub** | A person's evidence-backed profile. A Dub answers an agent's questions only from claims it can back up. It says "unknown" when it has no evidence and asks its human instead of inventing an answer. |
| **Jam** | A real, consented conversation between humans, run in Toasty Studio. |
| **Breadcrumb** | A piece of evidence derived from what was actually said in a Jam (with the transcript segment it came from). People approve what reaches their Dub. |
| **Dough** | The human-facing balance (USD-denominated ledger). People never have to touch a wallet to use Peeps. Crypto is the settlement rail underneath. |
| **x402 / USDC** | An agent can pay for context per request. On Solana, the server verifies that payment on-chain. |

The human does three things: **Find my Peeps → Authorize introductions → Join Jam.** The agent does discovery, qualification, outreach and scheduling.

## Why Solana

Peeps is built on micro-payments: a fraction of a dollar to unlock context, a few dollars to authorize an introduction. That only works if payment is cheap, fast and verifiable by anyone.

- **Cost and speed.** Sub-cent fees and confirmed in seconds, so a $0.25 context unlock is economical and an agent can pay inline.
- **USDC.** Stable-value settlement; Peeps verifies the right mint, recipient and amount.
- **Verifiable by the server, not trusted from the browser.** Peeps reads the transaction from the chain and binds it to the request with a [Solana Pay](https://docs.solanapay.com/) `reference` account, so a public transaction cannot be claimed by someone else.
- **x402-style agent payments.** An agent (not just a human) can pay a `402 Payment Required` response and continue.

What is verified on-chain today (devnet-tested, same code path for mainnet): the transaction exists and succeeded; it moved the **configured USDC mint** to the **configured recipient** for **at least the price**; it carries the **request-specific reference**; the **signature has never been used** for another request, Dough funding or billing; the payer is read from the chain. A genuine devnet transaction verified this way is described under [Solana devnet](#solana-devnet-optional-real-transaction).

## Architecture

```
 Browser (static HTML/JS, no build step)         Local/production API (one Node file + Python SQLite helper)
 ───────────────────────────────────────         ──────────────────────────────────────────────────────────
 /peeps/demo/        seeded, deterministic        scripts/render-production-server.mjs   HTTP API, auth, Peeps lifecycle,
                     engine.js (DOM-free)                                                Dough ledger, Solana verification
 /peeps/app/         real product UI  ───────────▶ scripts/toasty-auth-db.py            SQLite schema + atomic ledger/idempotency
 /peeps/app/golden-path.html  judge path          Solana RPC (read-only getTransaction)   only when a recipient is configured
 /peeps/waitlist/    public waitlist
```

- **Zero dependencies.** Node ≥ 20 and Python 3 (stdlib `sqlite3`). There is nothing to `npm install` for the app or the tests.
- **`peeps/demo/`** is a self-contained, deterministic walkthrough (seeded people, scripted agent, simulated payments). It never touches the API or a chain.
- **`peeps/app/`** is the production UI over the real services: requests and candidate ranking, Dough (funding, spend, settlement, withdrawals), introductions and outreach, booking, Jam ↔ Studio session linkage, consent, attendance, transcripts, Breadcrumbs, Dub updates.
- **Idempotency everywhere money moves.** Settlement is one atomic ledger transaction (debit + credit), unique per participant; economic events are unique per request; transaction signatures are globally unique.
- Details: [`docs/PEEPS_DEMO.md`](../docs/PEEPS_DEMO.md).

## Prerequisites

- Node.js **20 or newer** (`node -v`)
- Python **3.9 or newer** (`python3 -V`) for the API sandbox only; the demo does not need it
- macOS or Linux (Windows: use WSL)
- Optional, for the Solana devnet walkthrough: a throwaway devnet wallet and the `solana`/`spl-token` CLI or `@solana/web3.js`

## Quick start (60 seconds)

```bash
git clone https://github.com/rcasanova-ai/toasty-media.git
cd toasty-media
npm run demo
```

Open **http://127.0.0.1:4173/peeps/demo/**. No install step, no `.env`, no login, no network calls to Toasty.

(`npm run demo` is `node scripts/dev.mjs --static-only`; if you prefer not to use npm, run that command directly.)

To also run the real product UI against a **local sandbox API** (own throwaway database, simulated payments, emails recorded not sent):

```bash
npm run start:seeded
```

It prints a local-only login and then serves:

| URL | What |
|---|---|
| http://127.0.0.1:4173/peeps/demo/ | Seeded David/Sarah demo |
| http://127.0.0.1:4173/peeps/app/golden-path.html | The same lifecycle on the real services (sign in with the printed login) |
| http://127.0.0.1:4173/peeps/waitlist/ | Public waitlist form |

## Environment configuration

None is required. Defaults: simulated payments, test email adapter, a database under `./.peeps-local/` (git-ignored).
To change anything, copy the template and edit it (it only contains placeholders):

```bash
cp .env.example .env
```

The key variables (all optional) are documented in [`.env.example`](../.env.example): Solana devnet recipient/mint/RPC, Resend email key, closed-beta switch. **Never commit `.env` or any keypair.**

## Demo walkthrough (David/Sarah)

`/peeps/demo/` runs the scenario deterministically (about 50 seconds autonomous at Pitch speed, plus your three clicks). Use **Reset demo** any time.

1. **Find my Peeps (click 1).** One box, pre-filled: *"A Solana payments startup needs someone who can open institutional banking and fintech partnerships in Southeast Asia."* The agent turns it into criteria and searches a pool of 8 people.
2. **David Reyes: 95% keyword match.** A Web3 founder with a 30k-follower community. The agent pays **$0.25** for context (shown as **x402 / USDC · DEMO**) and interviews David's **Dub**. The Dub answers only from evidence: strong community influence, but **no demonstrated institutional capability**. **Excluded**: strong keywords, wrong context.
3. **Sarah Chen.** The agent unlocks her context and runs a **Dub-to-Dub qualification**. On the terms question the Dub has no evidence, so it **asks Sarah**; her reply becomes a self-attested claim. **Qualified, 94%.**
4. **Shortlist.** "I found 3 people worth your time." Nobody has been contacted yet: the person's attention is protected until the requester authorizes.
5. **Authorize introductions · $75 (click 2).** The agent contacts each Dub: boundaries satisfied, rate confirmed, accepted, **Jam created**, funds reserved in **Dough**.
6. **Join Jam (click 3).** A simulated Studio session: **consent from both sides**, recording indicator, live transcription, Jam context panel (what Sarah will and won't discuss).
7. **Results.** Recording, transcript, insights, a verified **Breadcrumb**, participation verified, **$25 released**, and Sarah's Dub improves (before/after profile coverage for the *next* agent).
8. **Network growth.** A non-Peep who joined by link sees *"You contributed to this Jam. Claim your Dub."*

### Simulated vs real (the demo never blurs this)

| In `/peeps/demo/` | Status |
|---|---|
| People, Dubs, candidates, Breadcrumbs | **Seeded** (fictional) |
| Provenance/access logic, trust evaluator, ledger arithmetic, idempotent unlocks | **Real code**, seeded inputs |
| Outcome interpretation (stands in for an LLM) | **Mocked**, deterministic |
| Context unlock, escrow, Dough credit | **Simulated**: marked `Demo transaction`, `mode: demo`, no RPC or wallet is ever called |
| Studio room, recording, transcript | **Simulated** |

**No transaction shown in the demo is a real Solana transaction.** Real, verifiable transactions only exist in the production UI/API (`/peeps/app/`), where every payment line is labelled **ONCHAIN VERIFIED**, **OFFCHAIN** (ledger), **SIMULATED** or **PENDING**, and a transaction signature or Explorer link is only ever shown for a payment the server verified on-chain.

The same lifecycle on the real services (request → discovery → authorization/payment → guest accepts → booking → Jam + Studio session → consent → attendance → transcript → Breadcrumbs → Dough settlement → Dub update → receipt) is `/peeps/app/golden-path.html`, exercised end to end by `scripts/peeps-colosseum-golden-path-test.mjs`.

## Testing

```bash
npm test                      # the full Peeps suite (sequential; ~5-10 minutes; no network or secrets)
npm run test:demo             # just the demo engine
npm run test:golden-path      # the complete lifecycle + Solana verification (fake Solana RPC)
node scripts/run-peeps-tests.mjs waitlist   # any subset by name
```

The Solana tests use a fake JSON-RPC server for failure cases (wrong mint, wrong recipient, underpayment, failed transaction, replay, missing reference) **and two genuine mainnet USDC transfers** captured in `scripts/fixtures/`, so verification is proven against real transaction structure, not only synthetic fixtures.

## Solana devnet (optional real transaction)

Use a throwaway devnet wallet. Never use a mainnet key.

1. Get devnet SOL (`solana airdrop 1 --url devnet`) and devnet USDC from https://faucet.circle.com. Create the recipient's USDC token account if needed (`spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <RECIPIENT> --url devnet --fee-payer <your keypair>`).
2. Put the recipient in `.env` (this turns the simulated payment provider **off** and real verification **on**):
   ```
   SVM_PAY_TO=<recipient devnet wallet address>
   TOASTY_SOLANA_NETWORK=solana-devnet
   TOASTY_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
   ```
3. `npm run start:seeded`, open `/peeps/app/golden-path.html`, run **Find my Peeps**, choose **USDC on Solana**. The page shows the recipient, mint, amount and this request's `reference`.
4. Send the payment (includes the reference as a read-only account):
   ```bash
   npm install --no-save @solana/web3.js @solana/spl-token
   SOLANA_KEYPAIR=<path to your throwaway devnet keypair> node scripts/devnet-pay-example.mjs <recipient> <usdcMint> <reference> 0.25
   ```
5. Paste the printed signature into the page and authorize. The server re-reads the transaction from devnet and verifies it. The receipt then shows the signature and a Solana Explorer link. Reusing the signature on another request is refused.

## Security and privacy architecture

- **No client claim is authoritative.** Payment, consent, attendance and settlement are established server-side. A browser-supplied signature is only a claim until the server verifies it on-chain.
- **No private keys in the browser or the repository.** The server only *reads* the chain. The optional helper script reads your local keypair in your own process.
- **Consent and confidentiality.** Candidates are contacted only after the requester authorizes; guests give consent on their own link before they can join; Breadcrumbs reach a Dub only after the person approves them; receipts never include guests' emails.
- **Auth.** Cookie sessions with CSRF header and origin allow-list, per-route rate limits, org-scoped authorization, token-gated guest pages (unguessable, hashed, expiring).
- **Replay and idempotency.** Signatures are globally unique across Peeps events, Dough funding and billing; economic events and settlements are single-shot; repeated API calls change nothing.
- **Waitlist.** Waitlisting is not an account and grants no access; invitation tokens are hashed, expiring and single-use; waitlist data is visible to platform admins only.
- **Local sandbox isolation.** The local runner binds to `127.0.0.1`, serves no dotfiles, and uses a throwaway database.

## Known limitations

- The demo is scripted and seeded by design. Its outcome interpreter is deterministic, not an LLM.
- Candidate discovery outside the network uses a labelled demo directory, not live external search.
- Outreach email is recorded, not sent, unless you configure `RESEND_API_KEY`.
- Studio (the live room, built on VDO.Ninja) needs camera/microphone and is not part of the offline demo; the demo simulates it.
- Guest compensation settles in the **Dough ledger (off-chain)**; it reaches a chain only through the withdrawal path, which needs a funded server keypair.
- Transcripts are uploaded by the organizer (Studio does not store them), so Breadcrumbs derive from an organizer upload and are labelled as such.
- **Zcash:** confidential settlement is **not implemented**. Any "Zcash · shielded" text in static pages is labelled SIMULATED.
- Solana verification is proven on devnet and against captured mainnet transaction structure; production is configured for devnet unless you change the environment.
