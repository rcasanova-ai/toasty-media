# Toasty Peeps

**Peeps helps people find, trust and compensate other people.** You describe an outcome; an agent finds and qualifies the right person from evidence, pays for context, asks permission before interrupting anyone, and connects two humans in a real, consented conversation. The conversation produces evidence, the evidence improves the person's profile, and they get paid: transparently through **Solana**, or confidentially through **Zcash**.

- Production: https://toasty.media/peeps/ · seeded fallback demo: https://toasty.media/peeps/demo/
- Real-services judge path (sign-in required): https://toasty.media/peeps/app/golden-path.html
- **Run it yourself in 60 seconds, no accounts, no wallet, no secrets:** see [`peeps/README.md`](peeps/README.md)

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/rcasanova-ai/toasty-media.git
cd toasty-media
git sparse-checkout set --no-cone '/*' '!/shared/brand/toasty-media/Ricardo/' '!/shared/brand/toasty-media/Brand/' '!/assets/' '!/site/'
npm run demo        # http://127.0.0.1:4173/peeps/demo/   (Node >= 20; nothing to install)
npm test            # full Peeps suite, no network or secrets (Python 3 required)
```

| Where to look | What it is |
|---|---|
| [`peeps/README.md`](peeps/README.md) | Setup, demo walkthrough, Solana devnet and Zcash instructions, security notes, known limitations |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture and lifecycle diagram, state machines, trust boundaries |
| [`docs/SUBMISSION.md`](docs/SUBMISSION.md) | Colosseum submission write-up, with a precise real-vs-simulated disclosure |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | Three-minute demonstration script |
| [`.env.example`](.env.example) | Configuration placeholders only |

## What is real and what is not (short version)

| Capability | Status |
|---|---|
| Outcome request, discovery, ranking, authorization, outreach, booking, Jam ↔ Studio session, consent, attendance events, transcript → Breadcrumbs → Dub, Dough ledger settlement | **Real production code**, covered by integration tests |
| Solana USDC introduction payment (recipient, mint, amount, success, request-bound reference, replay and idempotency, Explorer link) | **Real on-chain verification**, proven on devnet |
| Studio recording is registered automatically as the Jam's evidence when the host's recording is finalized | **Real**, tested with a real WebM; not yet exercised with live cameras in a browser by us |
| Confidential Zcash settlement (opt-in, explicit approval, recipient-wallet confirmation, privacy-preserving receipt) | **Real, proven with a genuine shielded Orchard transfer on a local regtest chain.** Disabled by default; not run on public testnet or mainnet |
| `/peeps/demo/` | **Seeded and simulated by design**, labelled as such |
| Outreach email | Recorded, not sent, unless `RESEND_API_KEY` is configured |

Everything else on this repository is the Toasty Media website and Toasty Studio (the browser interview studio Peeps uses for Jams): `site/`, `studio/`, `js/`, `css/`, `shared/`, `docs/`.
