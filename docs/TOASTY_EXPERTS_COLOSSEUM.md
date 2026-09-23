# Toasty Experts Colosseum MVP

Toasty Experts is the human services layer for Toasty Studio and future AI agents. The MVP demonstrates one clear loop:

```text
Agent calls Toasty Experts -> Toasty Commerce returns x402 requirement -> agent pays 0.001 USDC on Solana using the configured x402 wallet setup -> Toasty verifies payment -> ranked experts are returned -> invitation -> accepted booking -> negotiated USDC authorization/release -> completion -> reputation/provenance
```

## Repository Audit

- Framework: static HTML, CSS, and browser JavaScript modules. No bundler is required for the current Studio surfaces.
- Frontend architecture: `studio/director.html` is the main Toasty Studio console. `studio/experts.html` is the Toasty Experts entry point surfaced by `js/brand-themes.js` as the `Expertise` Studio mode.
- Backend architecture: `scripts/render-production-server.mjs` provides a local/production Node helper for auth, Google Drive, media assets, and rendering. It delegates SQLite operations to `scripts/toasty-auth-db.py`.
- Auth: cookie session auth in `scripts/render-production-server.mjs`, backed by the `users` table in SQLite.
- Database: SQLite with additive migrations in `scripts/toasty-auth-db.py`.
- Existing AI integrations: browser-side AI production workflow scaffolding in `js/ai-production.js`; no shared server-side LLM matching layer yet.
- Production/project model: `productions` table plus browser-local production state in the Studio AI workflow.
- APIs: current server endpoints cover auth, Google Drive, media assets, rendering, and the first Toasty Experts agent endpoint: `POST /api/agent/find-experts`.
- Deployment: static site plus optional render/auth helper. See `docs/DEPLOYMENT.md`.
- Environment variables: auth/render variables include `TOASTY_RENDER_HOST`, `TOASTY_RENDER_PORT`, `TOASTY_RENDER_TOKEN`, `TOASTY_SESSION_SECRET`, `TOASTY_AUTH_DB`, Google OAuth variables, upload/render limits, and FFmpeg path.
- Branch/worktree: implementation was made on `main` with pre-existing unrelated modified files in the worktree.
- Existing Solana/x402 reference work: previous internal experiments were inspected only as technical reference. Toasty Experts does not depend on those repositories at runtime. Toasty-owned expert models, commerce policy, x402 handling, Solana adapter boundaries, payment records, and APIs live in this repository.

## Implemented MVP Surface

Primary page: `studio/experts.html`

Core module: `js/expert-network.js`

Commerce module: `js/toasty-commerce.js`

Visible flows:

- Production request form with topic, description, expertise, location, language, budget, engagement type, duration, and constraints.
- Toasty-owned x402 discovery payment for `0.001 USDC` before candidate ranking, using the configured `SVM_PAY_TO` recipient from the tested Solana/x402 setup.
- `findExperts(request)` matching over structured fictional seed profiles.
- Candidate cards with fit score, confidence signals, match explanations, verification, reputation, availability, and USDC session price.
- Invitation state via `requestExpert()`.
- Acceptance and engagement creation via `acceptEngagement()`.
- Payment authorization via `authorizePayment()`.
- Completion, devnet settlement proof, and reputation evidence via `completeEngagement()`.
- Expert directory with ten fictional experts across AI, Solana, soccer, healthcare, cybersecurity, data centers, sustainability, enterprise tech, media, and strategy.
- Expert onboarding draft flow with LinkedIn/public URL import, CV/profile text import, public-source enrichment candidates, evidence review, pricing, availability, engagement types, and verification state.
- Agent API panel documenting the minimum contracts and an x402-compatible `402 Payment Required` response shape.
- Toasty-owned agent API endpoint for x402 discovery: `POST /api/agent/find-experts`.
- Live public-web enrichment endpoint: `POST /api/experts/enrich-public`.
- Human judgment microtask settlement endpoint: `POST /api/agent/microtasks/settle`.

## Service Interface

`window.ToastyExperts` exports:

- `findExperts(request)`
- `getExpert(id)`
- `requestExpert(payload)`
- `getEngagement(id)`
- `acceptEngagement(requestId)`
- `authorizeDiscoveryPayment(request)`
- `authorizePayment(engagementId)`
- `completeEngagement(engagementId)`
- `getPaymentStatus(paymentId)`
- `createX402PaymentRequirement(action, amount)`

The browser UI uses these methods directly so the Toasty server API can preserve the same JSON contracts.

## Database Model

`scripts/toasty-auth-db.py` now migrates additive tables:

- `experts`
- `expert_topics`
- `expert_credentials`
- `expert_documents`
- `profile_evidence`
- `expert_requests`
- `engagements`
- `payments`
- `judgment_tasks`
- `judgment_responses`
- `expert_reviews`
- `agent_requests`

The schema preserves private engagement data offchain. Payment rows store payment kind, rail, x402 requirement/proof fields, network, wallets, amount, token/currency, verification status, policy decision, approval source, timestamp fields, and transaction signature.

`profile_evidence` stores onboarding and enrichment provenance: expert, field/category, proposed and normalized value, source type, source URL/title/date, discovery time, confidence, status, user edit state, approval time, and metadata. Evidence statuses are `PROPOSED`, `APPROVED`, `EDITED`, `REJECTED`, and `STALE`.

## Expert Onboarding and Evidence

The onboarding flow is:

```text
LinkedIn/CV import -> public enrichment -> expert review -> approved profile -> demonstrated expertise over time
```

This is not a background-check product. It is a profile enrichment and due-diligence evidence layer that keeps the expert in control of what becomes public.

Supported entry points:

1. Fill from LinkedIn using a public profile URL or pasted/exported profile text.
2. Upload CV, resume, profile exports, talks, papers, or public source references.
3. Start manually.

Public enrichment creates a review queue instead of directly publishing facts. Each proposed evidence item tracks proposed fact, category, source, source URL, date found, confidence, and status. The expert can keep, edit, delete, or view the source. Bulk actions are available for low-risk review, but individual review remains available.

Implemented today: Toasty retrieves known public professional URLs directly and attempts public search enrichment when available. If retrieval/search returns no reliable professional evidence, Toasty reports no findings and does not fabricate evidence.

The data model distinguishes:

- Claimed Expertise: expert-supplied, imported, or approved profile material.
- Source-Confirmed Evidence: approved claims traceable to credible public sources.
- Demonstrated Expertise: Toasty-native activity such as accepted microtasks, completed bookings, validations, ratings, and repeated topic performance.

Approved enriched evidence can support matching, but only as a capped supporting signal. A single scraped keyword should not dominate ranking.

## Human Judgment Loop

Implemented vertical slice:

```text
Agent creates judgment task
-> Toasty matches qualified contributor
-> contributor response is accepted
-> Toasty Commerce settles USDC on Solana
-> payment record stores signature and policy state
-> response becomes demonstrated expertise
-> agent can escalate to expert booking
```

Demo task:

```text
Question: Which of these three podcast titles would make you most likely to listen?
Requirements: Canadian soccer knowledge
Responses required: 5
Payment: 0.10 USDC per accepted response
Payment kind: HUMAN_JUDGMENT_SETTLEMENT
```

The settlement endpoint reuses the existing configured Solana/x402 wallet setup. It does not create a wallet or introduce a new payment architecture. It persists the task, accepted response, contributor, amount, currency, network, payer, recipient, transaction signature, verification state, and timestamps.

Roadmap: production-grade public search/provider integrations, richer fraud/spam controls for repeated microtasks, and buyer-facing trust summaries that exclude rejected/private evidence.

## Core Architecture

```text
Toasty Experts -> Toasty Commerce -> x402 -> Solana/USDC
```

Toasty Experts owns its commerce architecture. Previous internal x402/Solana experiments were used as technical reference while developing the implementation, but they are not runtime dependencies and are not part of the Colosseum product story.

## Payment Layer

Toasty Commerce uses one Solana/USDC commerce implementation with distinct payment kinds and lifecycle states. The discovery micropayment and booking settlement are not separate payment providers or separate rails; they are Toasty-owned policy states on the same x402/Solana/USDC architecture.

1. Agent discovery / candidate ranking:
   - Agent calls `findExperts()`.
   - Toasty Commerce returns `402 Payment Required`.
   - Payment instructions specify `0.001 USDC` on Solana.
   - Agent pays.
   - Toasty verifies payment.
   - Toasty returns ranked candidates.
   - Payment kind: `EXPERT_DISCOVERY`.

2. Human booking / negotiated-rate lifecycle:
   - User or agent sends an expert invitation.
   - Expert accepts or negotiates the human rate.
   - The booking payment is authorized using the configured Toasty Commerce Solana/USDC setup.
   - Payment is released after completion or disputed/refunded through the engagement lifecycle.
   - Supported payment kinds: `HUMAN_JUDGMENT_SETTLEMENT`, `BOOKING_AUTHORIZATION`, `BOOKING_SETTLEMENT`, `REFUND`, `CANCELLATION`.

The current visible demo records payment kinds separately: `EXPERT_DISCOVERY` first, then booking authorization/settlement states after the expert accepts. Private engagement data remains offchain.

Production integration steps:

1. Continue wiring paid agent endpoints around the existing Toasty Commerce x402 handling.
2. Keep private scope/deliverable data in SQLite.
3. Add server endpoints for `authorizePayment()` and `completeEngagement()` that record `BOOKING_AUTHORIZATION` and `BOOKING_SETTLEMENT` through the same Toasty Commerce rail.
4. Persist only settlement/proof data from Solana: signature, network, configured payer/recipient references when available, token mint, amount, status, payment kind, rail, policy decision, approval source, and timestamps.
5. Link to Solana Explorer for verification when a real Solana signature is present.
6. Never store private wallet keys in application code; use the already configured wallet/signing setup rather than introducing a new Toasty wallet.

## x402 Integration

The browser MVP models the discovery/access x402 flow through `createX402PaymentRequirement()`. The server MVP exposes the same flow through `POST /api/agent/find-experts`.

```json
{
  "status": 402,
  "error": "Payment Required",
  "action": "find-experts",
  "provider": "toasty-experts",
  "purpose": "expert discovery and candidate ranking",
  "accepts": [{
    "scheme": "exact",
    "network": "solana-devnet",
    "asset": "USDC",
    "amount": "0.001",
    "payTo": "<configured SVM_PAY_TO>"
  }],
  "submitProofTo": "/api/agent/payments/proof",
  "continueWith": "/api/agent/find-experts"
}
```

Toasty owns the x402 handler for this MVP. Keep it narrow: return a valid `402 Payment Required`, verify the resulting Solana/USDC proof, persist the payment record, and continue the expert discovery request.

Endpoint behavior:

1. Agent posts a JSON expert request to `/api/agent/find-experts`.
2. If payment proof is missing or invalid, Toasty returns `402 Payment Required` with the `EXPERT_DISCOVERY` requirement.
3. Agent retries with payment proof headers:
   - `x-payment-signature`
   - `x-solana-transaction-signature`
   - `x-payment-asset: USDC`
   - `x-payment-amount: 0.001`
   - `x-payer-wallet`
4. Toasty validates the proof shape, records an `EXPERT_DISCOVERY` payment, and returns ranked candidates.

The current server verification is a devnet proof adapter suitable for the Colosseum MVP scaffold. It uses the same configured pay-to wallet shape as the tested x402 prototype (`SVM_PAY_TO`) and does not create a new wallet. The next hardening step is replacing proof-shape validation with direct Solana/USDC transaction verification against that configured recipient.

## Demo Script

1. Open Toasty Studio and choose `Expertise`, or go to `studio/experts.html`.
2. Use the default brief: “I need a Canadian soccer expert for a 45-minute podcast about the growth of the Canadian Premier League.”
3. Click `Pay x402 + match`.
4. Confirm the evidence trail records an `x402 discovery` micropayment.
5. Review the top three Canadian soccer matches and their explanations.
6. Click `Invite` on a candidate.
7. Click `Expert accepts`.
8. Click `Authorize USDC`.
9. Click `Complete + settle`.
10. Confirm the evidence trail includes x402 discovery, engagement state, booking settlement lifecycle, Solana devnet signature, and reputation.

## MVP Boundaries

- Seed experts are fictional/demo people and intentionally do not claim to be real public figures.
- CV uploads in the static page are local references only.
- No private engagement data is written onchain.
- No token or speculative tokenomics are introduced.
- Human users see a normal media-friendly booking flow; Solana details appear only in payment proof.
