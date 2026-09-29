#!/usr/bin/env node
// HTTP-level integration test for the complete Dough money loop — funding, spending, earning, unclaimed-
// Dub transfer, and withdrawal, all through the real HTTP routes (never calling python actions directly,
// unlike scripts/dough-ledger-test.mjs's pure-ledger unit test). Runs its own fake Solana RPC (same
// pattern as scripts/accounts-solana-server-test.mjs) so crypto funding is verified for real, not mocked
// away — wrong recipient, underpayment, and a reused signature are all genuinely exercised.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4217;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-dough-loop-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

const RECIPIENT = "ToastyDoughRecipientWaLLet1111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYER = "SomeCustomerWaLLetAddress1111111111111111";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function jsonFetch(path, { method = "GET", cookie, body } = {}) {
  const headers = { "x-toasty-csrf": "1" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data, cookie: cookieFrom(response) || cookie };
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

// ---- Fake Solana RPC — signature -> canned getTransaction result, exactly like accounts-solana-server-test.mjs ----
const fakeTransactions = new Map();
function tokenTx({ ok = true, mint = USDC_MINT, owner = RECIPIENT, preAmount = 0, postAmount = 0 } = {}) {
  return {
    meta: {
      err: ok ? null : { InstructionError: [0, "Custom"] },
      preTokenBalances: [{ owner, mint, uiTokenAmount: { uiAmount: preAmount } }],
      postTokenBalances: [{ owner, mint, uiTokenAmount: { uiAmount: postAmount } }]
    },
    transaction: { message: { accountKeys: [PAYER, RECIPIENT] } }
  };
}
const fakeRpc = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const { method, params } = JSON.parse(body || "{}");
    if (method !== "getTransaction") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      return;
    }
    const [signature] = params;
    const result = fakeTransactions.has(signature) ? fakeTransactions.get(signature) : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
});

async function main() {
  await new Promise((resolve) => fakeRpc.listen(0, "127.0.0.1", resolve));
  const rpcPort = fakeRpc.address().port;

  const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: {
      ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper,
      TOASTY_SESSION_SECRET: "dough-loop-test-secret", RESEND_API_KEY: "",
      TOASTY_BILLING_SOLANA_RECIPIENT: RECIPIENT, TOASTY_SOLANA_RPC_URL: `http://127.0.0.1:${rpcPort}`,
      TOASTY_USDC_MINT: USDC_MINT, TOASTY_USDT_MINT: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "",
      SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "", TOASTY_SOLANA_PAYER_KEYPAIR: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  server.stdout.on("data", (c) => (serverOutput += c));
  server.stderr.on("data", (c) => (serverOutput += c));

  try {
    await waitForHealth();

    const user = await jsonFetch("/auth/register", { method: "POST", body: { name: "Money Loop User", email: "moneyloop@example.com", password: "password10chars" } });
    assert(user.status === 201, "user registers");

    console.log("\n--- Funding: fiat with no provider configured is honest, never fabricates a credit ---");
    const fiatIntent = await jsonFetch("/api/peeps/dough/funding-intents", { method: "POST", cookie: user.cookie, body: { amount: 50, method: "fiat" } });
    assert(fiatIntent.status === 201 && fiatIntent.data.requiresProvider === true, "fiat funding with no Stripe key configured is flagged as unavailable, not silently credited");
    const balanceAfterFiatAttempt = await jsonFetch("/api/peeps/dough", { cookie: user.cookie });
    assert(balanceAfterFiatAttempt.data.account.spendBalance === 0, "no money was credited for an unconfigured fiat provider");

    console.log("\n--- Funding: crypto — malformed amounts rejected before touching Solana at all ---");
    const badAmount = await jsonFetch("/api/peeps/dough/funding-intents", { method: "POST", cookie: user.cookie, body: { amount: "not-a-number", method: "crypto" } });
    assert(badAmount.status === 400, "a non-numeric funding amount is rejected");
    const nanAmount = await jsonFetch("/api/peeps/dough/funding-intents", { method: "POST", cookie: user.cookie, body: { amount: NaN, method: "crypto" } });
    assert(nanAmount.status === 400, "NaN is rejected");
    const infAmount = await jsonFetch("/api/peeps/dough/funding-intents", { method: "POST", cookie: user.cookie, body: { amount: Infinity, method: "crypto" } });
    assert(infAmount.status === 400, "Infinity is rejected");
    const negAmount = await jsonFetch("/api/peeps/dough/funding-intents", { method: "POST", cookie: user.cookie, body: { amount: -10, method: "crypto" } });
    assert(negAmount.status === 400, "a negative funding amount is rejected");

    console.log("\n--- Funding: crypto — real anti-fraud checks against the (fake) Solana RPC ---");
    const cryptoIntent = await jsonFetch("/api/peeps/dough/funding-intents", { method: "POST", cookie: user.cookie, body: { amount: 20, method: "crypto" } });
    assert(cryptoIntent.status === 201 && cryptoIntent.data.funding.recipient === RECIPIENT, "a crypto funding intent carries the real configured recipient wallet");
    const intentId = cryptoIntent.data.intent.id;

    const sigUnderpay = "1".repeat(88);
    fakeTransactions.set(sigUnderpay, tokenTx({ preAmount: 0, postAmount: 10 })); // pays 10, owes 20
    const underpay = await jsonFetch(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie: user.cookie, body: { transactionSignature: sigUnderpay } });
    assert(underpay.status === 400, "an underpaying transaction is rejected");

    const sigWrongMint = "2".repeat(88);
    fakeTransactions.set(sigWrongMint, tokenTx({ mint: "SomeOtherMint1111111111111111111111111111", preAmount: 0, postAmount: 20 }));
    const wrongMint = await jsonFetch(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie: user.cookie, body: { transactionSignature: sigWrongMint } });
    assert(wrongMint.status === 400, "a payment on the wrong token mint is rejected");

    const sigValid = "3".repeat(88);
    fakeTransactions.set(sigValid, tokenTx({ preAmount: 0, postAmount: 20 }));
    const confirmed = await jsonFetch(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie: user.cookie, body: { transactionSignature: sigValid } });
    assert(confirmed.status === 200 && confirmed.data.confirmed === true && confirmed.data.amount === 20, "a genuinely valid, sufficient on-chain payment confirms and credits the exact amount");

    const balanceAfterFund = await jsonFetch("/api/peeps/dough", { cookie: user.cookie });
    assert(balanceAfterFund.data.account.spendBalance === 20, "spend balance reflects the real confirmed funding, nothing more");

    console.log("\n--- Funding: the SAME on-chain signature can never fund twice ---");
    const reuseSignature = await jsonFetch(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie: user.cookie, body: { transactionSignature: sigValid } });
    assert(reuseSignature.status === 200 && reuseSignature.data.alreadyPaid === true, "confirming an already-paid intent again is a safe idempotent no-op");

    const secondIntent = await jsonFetch("/api/peeps/dough/funding-intents", { method: "POST", cookie: user.cookie, body: { amount: 5, method: "crypto" } });
    const reuseOnDifferentIntent = await jsonFetch(`/api/peeps/dough/funding-intents/${secondIntent.data.intent.id}/confirm`, { method: "POST", cookie: user.cookie, body: { transactionSignature: sigValid } });
    assert(reuseOnDifferentIntent.status === 409, "the SAME transaction signature cannot be reused to fund a completely different intent");
    const balanceAfterReuseAttempt = await jsonFetch("/api/peeps/dough", { cookie: user.cookie });
    assert(balanceAfterReuseAttempt.data.account.spendBalance === 20, "the reuse attempt credited nothing — balance unchanged");

    console.log("\n--- Spending: introduction authorization debits Dough directly, no wallet ever involved ---");
    const orgList = await jsonFetch("/api/organizations", { cookie: user.cookie });
    const organizationId = orgList.data.organizations[0].id;
    const request1 = await jsonFetch("/api/peeps/requests", { method: "POST", cookie: user.cookie, body: { organizationId, whoText: "Fintech operators in Southeast Asia", outcomeText: "Three guests for a podcast about payments." } });
    const candidate1 = request1.data.candidates[0];
    const authorize1 = await jsonFetch(`/api/peeps/requests/${request1.data.request.id}/authorize`, { method: "POST", cookie: user.cookie, body: { candidates: [{ candidateId: candidate1.id, outreachEmail: "candidate1@example.com" }], compensationAmount: 10 } });
    assert(authorize1.status === 200 && authorize1.data.introductions.length === 1, "authorizing with Dough funded succeeds with no wallet/x402 language surfaced");
    const balanceAfterSpend = await jsonFetch("/api/peeps/dough", { cookie: user.cookie });
    assert(Math.abs(balanceAfterSpend.data.account.spendBalance - 19.75) < 0.001, "exactly $0.25 was debited from spend balance for the introduction");

    console.log("\n--- Spending: insufficient balance is an honest, human-readable failure — never a raw wallet demand ---");
    const poorUser = await jsonFetch("/auth/register", { method: "POST", body: { name: "Never Funded User", email: "neverfunded@example.com", password: "password10chars" } });
    const poorOrgList = await jsonFetch("/api/organizations", { cookie: poorUser.cookie });
    const poorRequest = await jsonFetch("/api/peeps/requests", { method: "POST", cookie: poorUser.cookie, body: { organizationId: poorOrgList.data.organizations[0].id, whoText: "Fintech operators", outcomeText: "A guest for a podcast." } });
    const poorCandidate = poorRequest.data.candidates[0];
    const insufficientResult = await jsonFetch(`/api/peeps/requests/${poorRequest.data.request.id}/authorize`, { method: "POST", cookie: poorUser.cookie, body: { candidates: [{ candidateId: poorCandidate.id, outreachEmail: "poor-candidate@example.com" }] } });
    assert(insufficientResult.status === 402, "a never-funded account is refused with 402, not a 500 or a silent no-op");
    assert(insufficientResult.data.doughShortfall !== undefined, "the response carries a structured, human-readable Dough shortfall — not a bare wallet-signing demand");
    assert(insufficientResult.data.doughShortfall.available === 0 && insufficientResult.data.doughShortfall.required === 0.25, "the shortfall states exactly what's needed and exactly what's available");
    assert(typeof insufficientResult.data.message === "string" && insufficientResult.data.message.includes("Dough"), "the message is plain-language, mentioning Dough by name");
    assert(insufficientResult.data.fundUrl === "/peeps/app/dough.html", "the response points the human straight at where to add funds");

    console.log("\n--- Earning: a compensated, completed Jam credits Dough — for an UNCLAIMED participant, to their Dub ---");
    const jamId = authorize1.data.jamId;
    const jamDetail = await jsonFetch(`/api/jams/${jamId}`, { cookie: user.cookie });
    const participant = jamDetail.data.participants[0];
    assert(participant.compensationAmount === 10, "the compensation amount set at authorize time is really on the participant");
    await jsonFetch(`/api/jam-participants/${participant.id}/mark-attended`, { method: "POST", cookie: user.cookie });
    await jsonFetch(`/api/jam-participants/${participant.id}/mark-completed`, { method: "POST", cookie: user.cookie });
    const settle1 = await jsonFetch(`/api/jams/${jamId}/settle`, { method: "POST", cookie: user.cookie });
    assert(settle1.data.settlements[0].status === "settled_to_dough" && settle1.data.settlements[0].amount === 10, "settlement credits the real compensation amount to Dough, not a hardcoded $0");

    console.log("\n--- Earning: duplicate settlement never double-pays ---");
    const settle2 = await jsonFetch(`/api/jams/${jamId}/settle`, { method: "POST", cookie: user.cookie });
    assert(settle2.data.settlements[0].status === "already_paid", "settling the same Jam twice recognizes the participant is already paid and does nothing further");

    console.log("\n--- Unclaimed Dub -> claim: the earned $10 transfers exactly once, to the real claimant only ---");
    const claimIssue = await jsonFetch(`/api/dubs/${participant.dubId}/claim-invite`, { method: "POST", cookie: user.cookie, body: { organizationId } });
    assert(claimIssue.status === 201, "a claim invite can be issued for the now-compensated Dub");
    const jane = await jsonFetch("/auth/register", { method: "POST", body: { name: "Jane Candidate", email: "jane-real@example.com", password: "password10chars" } });
    const claim = await jsonFetch(`/api/dub-claims/${claimIssue.data.token}/claim`, { method: "POST", cookie: jane.cookie });
    assert(claim.status === 200 && claim.data.doughTransferred === 10, "claiming transfers exactly the $10 the Dub actually earned");
    const janeBalance = await jsonFetch("/api/peeps/dough", { cookie: jane.cookie });
    assert(janeBalance.data.account.earnedBalance === 10, "the $10 now shows up in Jane's own earned Dough");

    const eve = await jsonFetch("/auth/register", { method: "POST", body: { name: "Eve Attacker", email: "eve-dough@example.com", password: "password10chars" } });
    const stolenClaim = await jsonFetch(`/api/dub-claims/${claimIssue.data.token}/claim`, { method: "POST", cookie: eve.cookie });
    assert(stolenClaim.status === 409, "a second account can never claim the same Dub and steal its earnings");
    const eveBalance = await jsonFetch("/api/peeps/dough", { cookie: eve.cookie });
    assert(eveBalance.data.account.earnedBalance === 0, "the attacker's own account gained nothing");

    console.log("\n--- Withdrawal: insufficient earnings honestly rejected ---");
    const overWithdraw = await jsonFetch("/api/peeps/dough/withdrawals", { method: "POST", cookie: jane.cookie, body: { amount: 500, method: "bank", destination: "jane-bank-ref-001" } });
    assert(overWithdraw.status === 409, "withdrawing more than earned is rejected");

    console.log("\n--- Withdrawal: reserved on request, duplicate double-click never double-reserves ---");
    const withdraw1 = await jsonFetch("/api/peeps/dough/withdrawals", { method: "POST", cookie: jane.cookie, body: { amount: 10, method: "bank", destination: "jane-bank-ref-001" } });
    assert(withdraw1.status === 201 && withdraw1.data.payoutStatus === "requested", "a valid withdrawal is reserved and requested");
    const janeBalanceAfterWithdraw = await jsonFetch("/api/peeps/dough", { cookie: jane.cookie });
    assert(janeBalanceAfterWithdraw.data.account.earnedBalance === 0, "the withdrawn amount is reserved out of the earned balance immediately");

    const withdrawRetry = await jsonFetch("/api/peeps/dough/withdrawals", { method: "POST", cookie: jane.cookie, body: { amount: 10, method: "bank", destination: "jane-bank-ref-001" } });
    assert(withdrawRetry.status === 200 && withdrawRetry.data.deduplicated === true && withdrawRetry.data.withdrawal.id === withdraw1.data.withdrawal.id, "an identical retry (double-click/network retry) is recognized as the SAME request, not a second reservation");

    console.log("\n--- Withdrawal: only a platform admin can drive the state machine ---");
    // `user` was the very first account registered against this fresh database, so it auto-bootstrapped
    // as the platform admin (same mechanism scripts/platform-admin-test.mjs verifies) — no separate
    // promotion path needed. `jane` is an ordinary later account.
    const nonAdminStatusUpdate = await jsonFetch(`/api/organizations/platform-admin/dough-withdrawals/${withdraw1.data.withdrawal.id}/status`, { method: "POST", cookie: jane.cookie, body: { status: "failed" } });
    assert(nonAdminStatusUpdate.status === 403, "a non-platform-admin cannot drive the withdrawal state machine");

    console.log("\n--- Withdrawal: a failed payout refunds exactly once ---");
    const markProcessing = await jsonFetch(`/api/organizations/platform-admin/dough-withdrawals/${withdraw1.data.withdrawal.id}/status`, { method: "POST", cookie: user.cookie, body: { status: "processing" } });
    assert(markProcessing.status === 200 && markProcessing.data.status === "processing", "a platform admin can move a withdrawal into processing");
    const markFailed = await jsonFetch(`/api/organizations/platform-admin/dough-withdrawals/${withdraw1.data.withdrawal.id}/status`, { method: "POST", cookie: user.cookie, body: { status: "failed" } });
    assert(markFailed.status === 200 && markFailed.data.refunded === true, "moving a withdrawal to failed refunds the reserved Dough");
    const janeBalanceAfterRefund = await jsonFetch("/api/peeps/dough", { cookie: jane.cookie });
    assert(janeBalanceAfterRefund.data.account.earnedBalance === 10, "the $10 reservation is back in Jane's earned balance");
    const markFailedAgain = await jsonFetch(`/api/organizations/platform-admin/dough-withdrawals/${withdraw1.data.withdrawal.id}/status`, { method: "POST", cookie: user.cookie, body: { status: "failed" } });
    assert(markFailedAgain.status === 409, "a terminal state cannot be re-entered — the refund can never fire twice");
    const janeBalanceAfterSecondAttempt = await jsonFetch("/api/peeps/dough", { cookie: jane.cookie });
    assert(janeBalanceAfterSecondAttempt.data.account.earnedBalance === 10, "balance is still exactly $10, not $20 — no double refund");

    console.log("\n--- Withdrawal: a successful payout reaches a clean final state ---");
    const withdraw2 = await jsonFetch("/api/peeps/dough/withdrawals", { method: "POST", cookie: jane.cookie, body: { amount: 10, method: "bank", destination: "jane-bank-ref-002" } });
    assert(withdraw2.status === 201, "Jane can withdraw the refunded amount again");
    const markPaid = await jsonFetch(`/api/organizations/platform-admin/dough-withdrawals/${withdraw2.data.withdrawal.id}/status`, { method: "POST", cookie: user.cookie, body: { status: "paid", providerReference: "manual-bank-transfer-001" } });
    assert(markPaid.status === 200 && markPaid.data.status === "paid" && markPaid.data.refunded === false, "a successful payout reaches 'paid' with no refund triggered");

    console.log("\nAll Dough money loop tests passed.");
  } catch (error) {
    console.error("\n--- server output ---\n" + serverOutput);
    throw error;
  } finally {
    server.kill();
  }
}

main()
  .then(() => { fakeRpc.close(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    fakeRpc.close();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
