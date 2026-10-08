# Toasty Peeps golden-path demo

A self-contained, deterministic, ~45-60 second product demo of the Peeps qualification lifecycle for the Colosseum pitch.

- **URL:** `/peeps/demo/` (locally: `http://localhost:4173/peeps/demo/` via the `toasty-static` launch config)
- **Reset:** `/peeps/demo/?reset=1`, or the **Reset demo** button (top right; also at the end of the flow)
- **Needs:** a browser. No login, no API, no blockchain RPC, no LLM, no Studio backend.
- **Files:** `peeps/demo/{index.html,demo.css,demo.js,engine.js,data.js}`, test: `node scripts/peeps-demo-test.mjs`

State lives only in `localStorage` under `toasty.peeps.demo.v1`. It never reads or writes production data, Dough accounts or Dubs.

## The interaction model: three human actions

The Peeps agent does the work and you watch. You click three things:

1. **Find my Peeps** (describe the outcome)
2. **Authorize introduction · $25** (approve approaching Sarah)
3. **Join Jam**

Everything between those clicks is performed on screen by the agent, deterministically. There is no Discover/Qualify/Unlock wizard. Top bar: **Pitch / Normal** speed, **Sarah's Dub** (the profile your agent is talking to), **Ledger**, **Trust**, **Data sources**, **Reset demo** (one click, works mid-run).

## Pitch Script

| When | What the audience sees | Say |
|---|---|---|
| Start | One big outcome box, pre-filled. **Find my Peeps.** | "I tell my agent who I need. Then I watch." |
| ~3 s | Agent understands the request: 7 criteria tick off. | "It turns plain language into criteria." |
| ~3 s | Agent searches the network; David and Sarah appear in the pool. | |
| ~10 s | **David Reyes**, 94% illustrative profile match: 30,000 followers, crypto conference speaker, 8 years in Web3. Agent spends $0.25 (x402 / Solana USDC, DEMO), then interviews David's Dub. **Not qualified.** | "David wins profile search, but the Dub has no evidence of institutional banking relationships, enterprise procurement, or regulated financial-institution navigation." |
| ~20 s | **Sarah Chen**, 82% illustrative profile match. Unlock $0.25, then a full Agent ↔ Dub interview with evidence and provenance. The Dub confirms banking/payment-sector experience, procurement/compliance fluency, and asks Sarah before confirming willingness to engage. **Qualified.** | "Sarah wins qualification. The Dub does not invent willingness; it asks its human." |
| Pause | **David wins the profile search. Sarah wins the qualification.** 2 investigated, 1 qualified, 1 excluded, $0.50 purchased. | "The Dub protected Sarah's attention and preserved requester anonymity." |
| Click 2 | **Authorize introduction · $25.** Agent contacts Sarah's Dub: requester identity withheld, boundaries satisfied, rate confirmed, accepted, Jam created. | |
| Click 3 | **Sarah accepted.** "Your agents handled the qualification. Now it's worth your time to talk." **Join Jam.** | "Agents finished the machine work. Now the humans meet." |
| ~10 s | Simulated Studio session: consent from both, REC, live transcription, Moxie suggestion, Jam context panel (what Sarah will and won't discuss). Ends automatically (or press End Jam). | |
| ~6 s | Agent resumes: recording saved, transcript, insights, Breadcrumb, participation verified, $25 released, Dub updated. | |
| Results | +$25 Dough, verified Breadcrumb, "Your Dub got smarter" (62% to 68% coverage, before and after comparison for the *next* agent), recording, transcript, summary, insights, trust checks. | "The interaction produced evidence, and Sarah got paid." |
| End | **See how the network grows.** Cold-start external matches, then a non-Peep joins by link and sees **You contributed to this Jam. Claim your Dub.** | "It works before the network exists." |

Total autonomous run before the shortlist: about 35-45 s in Pitch mode. The full three-click path lands around 45-60 s depending on narration.

Reload during the autonomous run restarts that run deterministically from the top. Reload at any human pause (shortlist, ready, results, growth) keeps your place.

## What is real vs seeded vs mocked

The **Data sources** drawer in the app shows the same table.

| Area | Status |
|---|---|
| Provenance/access engine (Dub answers only from claims; Unknown; Private withheld; clarification becomes a claim) | **Real logic**, seeded evidence |
| Trust evaluator (payout hold / step-up / release) | **Real logic**, seeded inputs |
| Ledger arithmetic, idempotent unlocks, single settlement | **Real logic** |
| Sarah's Dub, candidates, Breadcrumbs, external matches | **Seeded** (fictional people) |
| Agent orchestration (investigation order, budget, approach) | **Real code**, deterministic and seeded |
| Sarah's clarification reply | **Seeded**: auto-sent after a short delay |
| Outcome interpretation | **Mocked**: deterministic, stands in for an LLM |
| Context unlock ($0.25), Jam escrow, Dough credit | **Mocked**: demo ledger entries, `mode: demo`, `settlement: none`. The rail is labelled "x402 / Solana USDC · DEMO · no on-chain settlement". No RPC or wallet is called |
| Studio room | **Mocked**: simulated Studio session, not the real protected room (that needs a live Jam, API and VDO.Ninja). Real Studio at `/studio/` is untouched (link in the demo) |
| Recording / transcript / summary | **Mocked**: scripted; nothing is captured |

The demo does not claim on-chain settlement anywhere. Every transaction is flagged **Demo transaction**.

## Architecture notes (real-service compatibility)

`engine.js` is DOM-free and holds all state transitions; `data.js` holds seeds. Each mocked capability maps to one engine function (`unlockContext`, `askDub`, `clarify`, `createJam`, `completeJam`, `evaluateTrust`, `claimDub`), so a real implementation (x402 payment, LLM interpreter, `/api/peeps/*`, Studio session) replaces one function and its seed. Wiring to live services is **not** done.

## Things that could still bite tomorrow

- **First load needs internet for fonts** (Google Fonts). Offline it falls back to system fonts: fine, slightly less polished. Open the page once beforehand.
- **Browser cache:** if you edit and redeploy, hard-refresh. Assets are versioned with `?v=`.
- **Stale state:** if a previous run left state, hit **Reset demo** before you start. Top-right reset asks for confirmation except on the last screen.
- **The autonomous run can't be skipped.** That is the point, but plan for ~45-60 s of narration. Use **Pitch** speed.
- **Reset mid-run** is safe; it cancels the run and returns to the outcome box.
- The demo lives under `peeps/`; confirm your deploy workflow publishes `peeps/demo/` (nothing has been deployed from here).
- Coverage %, match %, qualification %, and the $0.50 context spend are seeded arithmetic, not measurements; they are labelled illustrative, simulated evidence and/or profile coverage, not person scores.
