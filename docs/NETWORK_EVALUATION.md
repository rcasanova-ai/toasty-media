# Network evaluation: Base x402 and Avalanche privacy

Desk research on public documentation, **not** an implementation. Nothing here exists in the code today (see `PEEPS_STATUS.md`). Sources were read through search summaries and should be re-checked against the primary documents before building.

## Base x402 (agent payments)

**What it is.** x402 reuses HTTP 402. A server replies with payment requirements; the client signs an authorization and retries with it in a header; a *facilitator* verifies and submits the transfer. On Base the `exact` scheme uses USDC's EIP-3009 `transferWithAuthorization` (from, to, value, validAfter, validBefore, random nonce), so the payer needs no gas and the facilitator broadcasts. Base mainnet is `eip155:8453`; USDC has 6 decimals. Sources: [x402 explainer](https://eco.com/support/en/articles/14839402-x402-protocol-explained), [Fireblocks x402 concepts](https://developers.fireblocks.com/docs/x402-concepts.md), canonical reference at github.com/coinbase/x402.

**Fit for Peeps.** Good for **agents** paying the introduction fee: Peeps already answers `402 Payment Required` with a requirement and accepts a proof. A Base rail would be a second `accepts` entry beside Solana.

**What would be needed.** A receiving address on Base Sepolia for testing; a facilitator (self-run, or a hosted one such as Circle's, which one source says covers Base: confirm on Circle's site); server-side verification through the facilitator's verify/settle calls, then an independent read of the settlement transaction before recording anything; replay protection through the EIP-3009 nonce plus our existing one-use signature table; a new rail label (for example `x402-base-usdc`) on the receipt.

**Risks.** Sources disagree on protocol version (v1 body vs v2 headers); the facilitator is a trust dependency; we must never mark a payment verified from the client's header alone (same rule as Solana).

**Recommendation.** Build it **after** Solana devnet verification is configured and proven in production, as an agent-only rail. Not for human compensation.

## Avalanche privacy (eERC)

**What it is.** Ava Labs' Encrypted ERC keeps **balances and transfer amounts** encrypted using zk-SNARKs and homomorphic/ElGamal-style encryption, while **senders, receivers and timestamps stay public**. Standalone mode creates a private-from-birth token; converter mode wraps an existing ERC-20. A confidential transfer costs roughly 947,000 gas (about 15x a plain ERC-20 transfer). Docs say it runs on C-Chain/L1s and other EVM chains, including Base. Sources: [Avalanche eERC docs](https://docs.avax.network/integrations/encrypted-erc), [eERC vs ERC-20](https://docs.avax.network/academy/blockchain/encrypted-erc/03-encrypted-tokens/02-comparison), [deployment modes](https://docs.avax.network/academy/blockchain/encrypted-erc/04-usability-eerc/01-deployments-mode).

**Fit for Peeps.** What Peeps wants to protect is *who was paid, how much, by whom*. eERC hides the amount but not the parties, so it is a weaker privacy guarantee than Zcash shielded transfers, which hide addresses, amounts and memo.

**Recommendation.** Do not build. Keep **Zcash as the confidential settlement option**. Revisit eERC only if EVM-native, amount-only confidentiality with an auditor key becomes a requirement (it would also work on Base).

## Order of work

1. Solana devnet recipient and mint configured on the render host; one verified payment through the website.
2. Real email delivery (`RESEND_API_KEY`).
3. Base x402 as an agent rail.
4. Zcash: public testnet verification before any wider use.
