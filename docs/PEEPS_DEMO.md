# Toasty Peeps golden-path demo

A self-contained, deterministic, ~4-minute product demo of the full Peeps lifecycle.

- **URL:** `/peeps/demo/` (locally: `http://localhost:4173/peeps/demo/` via the `toasty-static` launch config)
- **Reset:** `/peeps/demo/?reset=1`, or the **Reset demo** button (top right; also at the end of the flow)
- **Needs:** a browser. No login, no API, no blockchain RPC, no LLM, no Studio backend.
- **Files:** `peeps/demo/{index.html,demo.css,demo.js,engine.js,data.js}`, test: `node scripts/peeps-demo-test.mjs`

State lives only in `localStorage` under `toasty.peeps.demo.v1`. It never reads or writes production data, Dough accounts or Dubs.

## 4-minute script

The lifecycle rail at the top lights up as you go. Every screen has one primary button; **Continue / Skip** (bottom right) completes the current step automatically if you need to catch up.

| # | Screen | Do | Say |
|---|---|---|---|
| 0 | Overview | **Begin the demo** | "Agents do the qualifying, humans do the talking. Three layers: agent, human, value." |
| 1 | Your Dub | Click tabs: Boundaries, Availability & pricing ($15/$25), Evidence, **Knowledge & access**. | "This is Sarah's Dub. Not a clone: every claim has provenance and an access policy. Private stays private." |
| 2 | Outcome | **Interpret request** then **Find my Peeps** | "Plain language becomes structured criteria. Note *No crypto* is an exclusion." |
| 3 | Discovery | **Unlock contextual profile · $0.25** on Sarah, then **Authorize** | "8 candidates, locked. David looks perfect on keywords (95%). Unlock is a $0.25 microprice; no wallet UX." |
| 4 | Dub ↔ Dub | **Start interview**; it pauses at *Unknown* → **Ask Sarah** → **YES** | "The agent interviews the Dub first. Sarah hasn't been bothered yet. When the Dub lacks evidence it says so, then asks Sarah. Her answer becomes persistent, self-attested context." |
| 5 | Matches | watch the count-up → **Request introductions** | "8 investigated, $2.00 spent, 3 qualified, 5 excluded. David excluded: recent work primarily crypto." |
| 6 | Permission (Sarah) | **Accept**, then **Create the Jam** | "Only now does anything about her get disclosed: what she permits." |
| 7 | Jam | **Join Jam** | "Agents are done. This is entering the human layer." |
| 8 | Studio | **I consent · Start recording**; ~13 s of captions; **End Jam** | "Consent, recording, live transcription, Moxie suggests a question." |
| 9 | Post-Jam | watch: +$25 → Breadcrumb → Dub 62% → 68% | "Payment, a verified Breadcrumb, a richer Dub. Recording, transcript, summary below." Open **Trust** (top bar) and try the scenarios. |
| 10 | Growth | **Yes, I'm interested** → **Simulate: Jam completed** → **Claim my Dub** | "Peeps works before the network exists. A non-Peep joins with a link, then claims their Dub with the Jam as first Breadcrumb." |

Optional, in Dub ↔ Dub after the clarification: *Ask: What was the round size?* shows a **Private** answer (no content, no sources leaked).

## What is real vs seeded vs mocked

The **Data sources** drawer in the app shows the same table.

| Area | Status |
|---|---|
| Provenance/access engine (Dub answers only from claims; Unknown; Private withheld; clarification becomes a claim) | **Real logic**, seeded evidence |
| Trust evaluator (payout hold / step-up / release) | **Real logic**, seeded inputs |
| Ledger arithmetic, idempotent unlocks, single settlement | **Real logic** |
| Sarah's Dub, candidates, Breadcrumbs, external matches | **Seeded** (fictional people) |
| Outcome interpretation | **Mocked**: deterministic, stands in for an LLM |
| Context unlock ($0.25), Jam escrow, Dough credit | **Mocked**: demo ledger entries, `mode: demo`, `settlement: none`. The rail is labelled "x402 / Solana USDC · DEMO · no on-chain settlement". No RPC or wallet is called |
| Studio room | **Mocked**: simulated UI. Real Studio at `/studio/` is untouched (link in the demo) |
| Recording / transcript / summary | **Mocked**: scripted; nothing is captured |

The demo does not claim on-chain settlement anywhere. Every transaction is flagged **Demo transaction**.

## Architecture notes (real-service compatibility)

`engine.js` is DOM-free and holds all state transitions; `data.js` holds seeds. Each mocked capability maps to one engine function (`unlockContext`, `askDub`, `clarify`, `createJam`, `completeJam`, `evaluateTrust`, `claimDub`), so a real implementation (x402 payment, LLM interpreter, `/api/peeps/*`, Studio session) replaces one function and its seed. Wiring to live services is **not** done.

## Things that could still bite tomorrow

- **First load needs internet for fonts** (Google Fonts). Offline it falls back to system fonts: fine, slightly less polished. Open the page once beforehand.
- **Browser cache:** if you edit and redeploy, hard-refresh. Assets are versioned with `?v=`.
- **Stale state:** if a previous run left state, hit **Reset demo** before you start. Top-right reset asks for confirmation except on the last screen.
- **Don't double-click fast** during interview playback; it is animated (~15 s). Use Continue to skip.
- The demo lives under `peeps/`; confirm your deploy workflow publishes `peeps/demo/` (nothing has been deployed from here).
- Coverage %, match %, and the $2.00 total are seeded arithmetic, not measurements; coverage is labelled as profile coverage, not a person score.
