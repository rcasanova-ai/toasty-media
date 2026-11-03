# AGENTS.md — Agent Cooperation & Development Guidelines

This document provides conventions, operational protocols, and architectural guardrails for autonomous and semi-autonomous coding agents (e.g., Claude, Codex, Jules, Gemini) contributing to the `rcasanova-ai/toasty-media` repository.

---

## 1. Multi-Agent Ecosystem & Boundaries

- **Active Agents:** Multiple AI agents (Claude, Codex, Jules) work concurrently on this repository.
- **Branch Isolation:**
  - Never push directly to `main`.
  - Always work within designated feature branches (e.g., `feat/*`, `fix/*`, `codex/*`, `cursor/*`).
  - Do not rebase, force-push, or modify branches owned by another active agent session without coordination.
- **Production Code Guardrails:**
  - During audit passes or forensic reviews, **do not touch production code**. Propose findings and documentation separately.
  - Production deployments are triggered strictly via designated GitHub Actions or explicit human approvals.

---

## 2. Architecture & Design Principles

Refer to `docs/ARCHITECTURE.md` and `docs/CODEX-CLAUDE-STUDIO-HANDOFF.md` for in-depth system designs.

- **Zero-Dependency Core:**
  - Node.js (>=20) and Python 3 (3.10+) standard libraries only for core runtime and test suites.
  - Do not introduce third-party npm or PyPI dependencies without architectural sign-off.
- **Fail-Closed Security & Financial Rails:**
  - Solana USDC and Zcash shielded settlements require strict cryptographic verification server-side.
  - Never trust client headers (`x-payer-wallet`, client hashes).
  - Replay and double-spend protection must remain strictly enforced and tested across state transitions.
- **Truthful Labelling & Disclosures:**
  - Differentiate clearly between real production code, on-chain verified state, and demo/seeded fixtures (`/peeps/demo/`).
  - Never synthesize mock fixtures (e.g., soundboard audio, fake transactions) to pass tests.

---

## 3. Running & Verifying Tests

Before opening a pull request or submitting code, run the relevant test suite:

### A. Peeps Core & Integration Tests
```bash
# Syntax and compilation check
python3 -m py_compile scripts/toasty-auth-db.py
node --check scripts/render-production-server.mjs

# Fast unit / demo verification
node scripts/peeps-demo-test.mjs
node scripts/peeps-fit-engine-test.mjs
node scripts/peeps-auth-gate-test.mjs

# Golden Path integration test (runs end-to-end simulated lifecycle)
node scripts/peeps-colosseum-golden-path-test.mjs

# Solana on-chain transaction verification
node scripts/solana-real-transaction-verification-test.mjs

# Dough & Zcash settlement tests
node scripts/dough-ledger-test.mjs
node scripts/peeps-zcash-settlement-server-test.mjs
```

### B. Full Test Runner
To run individual tests via the test runner without timeout risk:
```bash
node scripts/run-peeps-tests.mjs <test-name>
```

---

## 4. Pull Requests & Code Review Standards

1. Keep pull requests scoped to a single logical feature, fix, or audit artifact.
2. Ensure automated tests pass locally before proposing changes.
3. Link PRs to relevant tracking issues or roadmap tickets.
4. Respect existing code style: plain ES modules (`.mjs`), minimal external dependencies, and explicit error handling.
