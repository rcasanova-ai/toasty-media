# Judge walkthrough

Two paths tell the **same story** (a requester asks for an outcome, an agent finds a person, two humans connect, evidence is created, compensation is settled):

| Path | URL | Needs | Nature |
|---|---|---|---|
| **A. Deterministic demo** | `https://toasty.media/peeps/demo/` (or `http://127.0.0.1:4173/peeps/demo/` locally) | Nothing: no account, no wallet | Seeded and simulated by design. Fastest, always works |
| **B. Real services** | `http://127.0.0.1:4173/peeps/app/golden-path.html` after `npm run start:seeded` | Node 20+, Python 3, the repo. No external accounts | Real application code and **persisted state** in a local sandbox database. Payments are simulated unless you configure Solana/Zcash below |

The production site (`https://toasty.media/peeps/app/golden-path.html`) runs the same code, but access is invitation-only and there is no public test login. Judges who want it need an invitation from the team (admin: Platform Admin → Peeps waitlist → Invite). Path B is the reproducible way and was verified click by click for this document.

## Path A: the demo (about 1 minute)

1. Open `/peeps/demo/`, click **Pitch** (top right) for the fast speed.
2. Click **Find my Peeps →** (click 1). The 7 criteria appear, then candidates are investigated: **David Reyes** is shown **NOT QUALIFIED** (community influence, no institutional evidence); **Sarah Chen** is qualified after a Dub-to-Dub interview.
3. Click **Authorize introduction · $25** (click 2). Expected: "SARAH ACCEPTED".
4. Click **Join Jam →** (click 3). A simulated Studio room runs, then results: summary, Breadcrumb, trust checks, released $25.
5. Click **See how the network grows →**. Reset any time with **Reset demo**.

Everything here is labelled simulated. No Solana or Zcash transaction in the demo is real.

## Path B: real services, step by step

### Setup (once)

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/rcasanova-ai/toasty-media.git
cd toasty-media
git sparse-checkout set --no-cone '/*' '!/shared/brand/toasty-media/Ricardo/' '!/shared/brand/toasty-media/Brand/' '!/assets/' '!/site/'
npm run start:seeded
```

It prints a **local-only login** (`judge@peeps.local` plus a generated password) with $50 of seeded sandbox Dough, and the URLs. (You can instead run `npm start`, register at `http://127.0.0.1:4173/studio/`, and fund Dough from the Dough page.) Keep this terminal open.

### Requester (you), steps 1 to 3

1. Open `http://127.0.0.1:4173/peeps/`. Click **Sign in** (top right), enter the printed email and password, click **Sign in**. Expected: the Peeps app opens (`/peeps/app/`).
2. In the left sidebar click **Judge path**. Expected: "Intent → human interaction → verified evidence", a request box pre-filled with *Fintech/payment executives in Southeast Asia…*.
3. Click **Find my Peeps →** (action 1). Expected: *"The agent evaluated 5 candidates. Nobody has been contacted."* Each candidate shows `#rank`, **QUALIFIED · n% evidence** or **EXCLUDED** with the exact criteria that are not evidenced. Open **questions and answers** under a candidate: each criterion from your request is a question, and the answer cites a stored claim with its source (a person's approved Breadcrumbs are cited, never quoted, to protect the private conversation) or says **Unknown**. This is a deterministic *evidence interview*, not an AI or live conversation: candidates with a Dub are interviewed through their own approved claims; others get a directory match explicitly labelled "not a Dub interview". Results are saved.
4. Type an email address you control in **The guest's email** (use a second inbox, or any address: in this sandbox outreach is recorded, not sent). Leave **Dough** selected, compensation **25**.
5. Click **Authorize introductions →** (action 2). Expected: *"Introductions authorized. Peeps is contacting your guest."* and an **Agent progress** card: ✓ Authorized, ✓ Guest contacted. A link *"open the guest page"* tagged **simulated outbox · test mode** appears (the sandbox's stand-in for the email).

### Guest (the second person), in a second browser tab or private window

6. Click **open the guest page**. Click **I'm interested**, **Yes, that's fine** (recording), **45 minutes**, enter a date within the next 7 days with times between 09:00 and 18:00 (your local time), click **Share my availability**. Expected: "You're all set for now".
7. Back on the **Judge path** tab, reload the page (or wait; it polls). Expected: *"Peeps booked the first time that works for both of you."* and **✓ Booked · Jam + Studio created** with the Jam id and Studio session id, plus a **3 · Join Jam →** button.
8. Guest tab: reload the guest link. Expected: "YOU'RE BOOKED" with prep. Tick the consent boxes and click **Save my consent** (expected: *✓ Consent recorded.*), then **Join the session**.

### Opening the Jam (action 3, needs real devices)

9. Requester: click **3 · Join Jam →** to open the Studio director for the session. Guest: in the Jam Lobby allow camera and microphone, tick the consent box, click **Join Jam**. The room itself records the guest's attendance. **This step requires real camera/microphone and is the only one a headless test cannot cover**: see [`LIVE_DEVICE_TEST.md`](LIVE_DEVICE_TEST.md).
   - **No camera? Recover:** the Lobby's **Join Jam** stays disabled without devices. To continue the walkthrough in the sandbox, send the same event the room sends, using the guest's invite token (the `token=` value in the Lobby URL):
     ```bash
     curl -X POST http://127.0.0.1:4174/api/jams/<JAM_ID>/events -H 'content-type: application/json' -d '{"invite":"<INVITE_TOKEN>","type":"participant.joined"}'
     ```
     This is **simulated attendance** and should be said so on camera. It works only because the guest's own invite token is the credential; there is no bypass of anyone else's account.

### Evidence, Breadcrumbs, settlement

10. Requester, **Judge path** tab, section *Capture evidence, then settle*: click **Insert a sample transcript (demo text)** (fills the box with clearly demo lines using the guest's real name; edit or replace it, or paste a real transcript as `Speaker: text` lines). Click **Complete Jam & generate Breadcrumbs**. Expected: *"Evidence captured from the real Jam."*
11. Scroll to the **Receipt**. Expected checks ✓ DONE for: Interaction occurred, Consent captured, Participant attended, Evidence generated, Breadcrumb created (4, each quoting the transcript with segment and rule), Introduction payment, Dub gained evidence. **Outcome verified** shows PENDING with the exact reason: *"A recording exists (no recording reference has been added)"*. A recording is registered automatically when the host's Studio recording is finalized (live-device test); without one the outcome honestly stays pending, and compensation can still be settled.
12. Click **Settle Dough**. Expected: Guest compensation **DOUGH: OFFCHAIN LEDGER SETTLED** (an off-chain ledger entry, never presented as a blockchain payout).

### Where Solana verification appears

At step 4, choose **USDC on Solana** instead of Dough. This needs Solana devnet configured (`.env`: `SVM_PAY_TO`, `TOASTY_USDC_MINT`, see [`peeps/README.md`](../peeps/README.md#solana-devnet-optional-real-transaction)). The page shows the recipient, mint, amount and *this request's reference*; send the payment with `scripts/devnet-pay-example.mjs`, paste the signature, click **Authorize introductions →**. The receipt then shows **ONCHAIN VERIFIED**, the signature, slot, and **View on Solana Explorer ↗** (devnet). Replaying the signature on another request is refused. Without Solana configured the option is disabled and labelled "not configured".

### Where Zcash verification appears (optional, regtest)

Requires the local regtest chain ([`scripts/zcash/README.md`](../scripts/zcash/README.md)); start the sandbox with `ZCASH_SETTLEMENT_ENABLED=1 ZCASH_NETWORK=regtest npm run start:seeded`.

13. After step 10, a card **Pay in shielded ZEC** appears. Enter an amount in zatoshis (e.g. 2500000), click **Settle confidentially in ZEC**. Expected: *"Waiting for [guest] to opt in…"*.
14. Guest: reload the guest link, click **Set up confidential payment →** (`/peeps/zec.html`). Paste the **recipient wallet's shielded regtest address**, tick the consent box, click **Opt in**. Expected: *"Waiting for the requester's approval"*.
15. Requester: reload, click **Approve shielded payment**. Expected: the address, amount and memo (`peeps:zs_…`) appear, only to you.
16. Pay **from your own wallet**: `zingo-cli … quicksend <address> <amount> "<memo>"` (command in the scripts README). Paste the transaction id into **Transaction id from your wallet** and click **I sent it**. Expected: *"Submitted. Settlement is complete only when [guest]'s own wallet confirms receipt."* Nothing is paid yet.
17. Guest: reload `/peeps/zec.html`, enter the transaction id, amount and memo **from the recipient wallet's own record**, click **Confirm my wallet received it**. Expected: **VERIFIED CONFIDENTIAL SETTLEMENT**.
18. Requester: reload. The receipt shows **ZCASH: CONFIDENTIAL SETTLEMENT VERIFIED by the recipient's own wallet · REGTEST (test network, no value)**, an opaque reference, and *"PAID VIA ZEC"* for the compensation. The receipt never contains the address, memo, ZEC amount or transaction id.

## Real versus simulated

| Item | Status |
|---|---|
| Request, discovery, ranking, authorization, guest page, scheduling, booking, Jam ↔ Studio linkage, consent, transcript → Breadcrumbs → Dub, Dough ledger, receipt, state persistence | Real application code, real persisted state |
| Outreach email | Simulated outbox (recorded, not sent) unless `RESEND_API_KEY` is set |
| Candidate evaluation | Real, persisted, evidence-only. Not a live or AI conversation (labelled) |
| Candidate directory outside the network | Labelled demo directory |
| Dough funding in the sandbox | Seeded ledger credit, not real money |
| Guest attendance | Emitted by the room when a real participant joins; **simulated** if you use the curl fallback |
| Recording | Registered automatically on real Studio finalization; absent unless a live session ran |
| Transcript | Text you upload (or the labelled sample) with named speakers. When the server has whisper configured, finalizing a real recording also stores an automatic transcript labelled `studio_auto_unattributed`; it creates no person-specific Breadcrumbs |
| Solana | Real devnet verification when configured; otherwise disabled |
| Zcash | Real shielded transfers on a local **regtest** chain only (no value; not public testnet, not mainnet) |
| `/peeps/demo/` | Fully simulated |

## If a step fails

- **Port in use:** stop whatever uses 4173/4174, or `lsof -ti tcp:4173 | xargs kill`.
- **Lost the sandbox password:** delete `.peeps-local/` and run `npm run start:seeded` again (resets all local state).
- **"Not enough Dough":** the sandbox login has $50; the introduction costs $0.25. Use `npm run start:seeded` (not `npm start`) or fund Dough.
- **Guest page "link isn't valid":** use the link shown on the Judge path page for the current request.
- **Not booked after the guest shared availability:** the guest's window must overlap 09:00-18:00 (your local time) within the next 7 days; reload the Judge path tab. The agent only books when a mutual time exists.
- **Outcome stays pending:** expected without a real recording (see step 11); it is not a failure.
- **Zcash `incorrect consensus branch id`:** the regtest chain's activation heights must match zingo's; use `scripts/zcash/regtest.mjs start`.
- **Anything else:** `Reset demo` for Path A; for Path B restart the sandbox. The deterministic demo (Path A) always works as the fallback.
