# Three-minute demonstration script

Central message: **Peeps helps people find, trust and compensate other people. Solana powers agent-mediated transactions. Zcash enables confidential human compensation.**

Set up: `npm run demo`, open http://127.0.0.1:4173/peeps/demo/ (or https://toasty.media/peeps/demo/), click **Pitch**. Everything in this part is seeded and labelled simulated, and you should say so.

## 0:00 – 0:25 The problem
> "Agents can search, but they can't tell a loud profile from real capability, can't reach the right person without spamming, and can't pay them fairly. Peeps fixes that. I'll ask for an outcome and make three clicks."

Click **Find my Peeps** (click 1). Point at the seven criteria ticking off.

## 0:25 – 1:15 Trust: David versus Sarah
> "David has a 95% keyword match and thirty thousand followers. The agent pays a quarter of a dollar for his context, shown here as x402 USDC, labelled demo, and interviews his Dub."

Show David's exclusion: community influence, no institutional banking evidence.
> "The Dub answers only from evidence. Great keywords, wrong context. Sarah has institutional capability. When her Dub has no evidence on terms, it doesn't invent an answer. It asks Sarah, and her reply becomes a self-attested claim."

Show Sarah qualified.

## 1:15 – 1:50 Consent and the human moment
Click **Authorize introduction · $25** (click 2). > "Nobody has been contacted until I authorize. Sarah accepts, the Jam is created, and the payment is committed in Dough."
Click **Join Jam** (click 3). > "Consent from both sides, recording, a context panel showing what Sarah will and won't disclose. The requester stays confidential until both approve."

## 1:50 – 2:25 Evidence and Solana (switch to the real path)
Show the results: Breadcrumb, Dub gets richer. Then open `/peeps/app/golden-path.html` receipt (local or production).
> "Here's the real path. The introduction fee was a genuine devnet USDC transaction. The server read it from Solana: right mint, right recipient, right amount, and this request's own reference, so nobody else can claim it. Replay it and it's refused. Click the Explorer link."

Open the Explorer link for `5uu962Ua…` (devnet). > "Receipt labels say ONCHAIN VERIFIED, OFFCHAIN ledger, or SIMULATED. It never pretends."

## 2:25 – 2:55 Zcash: confidential compensation
> "Paying a person is private. So settlement can be confidential. Sarah opts in with a shielded address. I explicitly approve. I pay from my own wallet. Toasty holds no keys. Sarah's own wallet confirms receipt, and only then does Peeps mark it settled."

Show the receipt line: **VERIFIED CONFIDENTIAL SETTLEMENT**, network REGTEST, opaque reference, no address, no amount, no transaction id.
> "This was a real shielded Orchard transaction on a local regtest chain, re-runnable with one script. It has not run on public testnet. We label the network on every receipt."

## 2:55 – 3:00 Close
> "Find, trust, compensate. Solana for transparent agent transactions. Zcash for confidential human compensation. Clone it and run it in a minute."

## Honest-answer cheat sheet
- *Is the demo real?* Seeded and simulated by design. The real services are in `/peeps/app/` and covered by integration tests.
- *Did you test a live camera session?* The server-side attendance, consent and recording registration are tested; we have not run live cameras end to end.
- *Is Zcash on testnet or mainnet?* Regtest only today, disabled by default in production.
- *Does Toasty custody funds?* No. Solana is read-only verification; Zcash payments are made and confirmed by the humans' own wallets.
