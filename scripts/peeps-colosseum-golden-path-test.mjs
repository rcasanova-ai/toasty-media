#!/usr/bin/env node
// COMPLETE Colosseum golden-path integration test for the PRODUCTION Peeps backend:
//
//   outcome request -> agent discovery -> Solana-funded Dough -> on-chain-verified introduction payment ->
//   candidate accepts -> booking (Jam + Studio session) -> consent -> attendance -> transcript -> Jam
//   completion -> Breadcrumbs -> Dough settlement -> Dub evidence -> judge receipt (+ idempotency, replay
//   and security checks along the way).
//
// It runs the real render-production-server.mjs against a throwaway SQLite DB and its OWN fake Solana
// JSON-RPC (same technique as accounts-solana-server-test.mjs / dough-money-loop-server-test.mjs), so the
// server's real verification code path executes: recipient, token mint, amount, transaction success,
// existence, the request-bound payment reference, signature reuse and idempotency. The ONLY simulated parts
// are (a) the Solana network itself and (b) the outreach email provider (PEEPS_TEST_ADAPTERS=1, status
// "simulated"). Everything else is the production service. Each stage prints its name and any failure is
// reported as `FAILED at stage N (<name>): <what broke>` so the broken lifecycle step is obvious.
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4231 + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-colosseum-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

const RECIPIENT = "ToastyPeepsRecipientWaLLet1111111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = "SomeOtherMint1111111111111111111111111111";
const REQUESTER_WALLET = "RequesterWaLLetPubkey1111111111111111111111";
const GUEST_EMAIL = "colosseum.guest@example.com";
const COMPENSATION = 25;
const HOUR = 3600000;

let stageNumber = 0;
let stageName = "";
function stage(name) { stageNumber += 1; stageName = name; console.log(`\n[stage ${stageNumber}] ${name}`); }
function assert(condition, message) {
  if (!condition) throw new Error(`FAILED at stage ${stageNumber} (${stageName}): ${message}`);
  console.log(`  ok — ${message}`);
}

function cookieFrom(response) { return (response.headers.get("set-cookie") || "").split(";")[0]; }
async function api(path, { method = "GET", cookie, body, headers = {} } = {}) {
  const requestHeaders = { "x-toasty-csrf": "1", ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers: requestHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data, cookie: cookieFrom(response) || cookie };
}
function db(action, values = {}) {
  const result = spawnSync("python3", [helper], { input: JSON.stringify({ action, dbPath, ...values }), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`db helper failed: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}
function count(table, where = "1=1", params = []) {
  const script = `import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\nprint(c.execute("SELECT COUNT(*) FROM "+sys.argv[2]+" WHERE "+sys.argv[3], json.loads(sys.argv[4])).fetchone()[0])`;
  return Number(spawnSync("python3", ["-c", script, dbPath, table, where, JSON.stringify(params)], { encoding: "utf8" }).stdout.trim());
}
const balance = (subjectType, subjectId) => db("dough_get", { subjectType, subjectId }).account || { spendBalance: 0, earnedBalance: 0 };
async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

// ---- time helpers (independent of the server) ----
function zoned(ms, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function dayUtc(daysFromNow, hour, minute = 0) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
}

// ---- Fake Solana RPC: signature -> canned getTransaction result (null = unknown/unconfirmed) ----
const fakeTransactions = new Map();
function usdcTx({ ok = true, mint = USDC_MINT, owner = RECIPIENT, pre = 0, post = 0, references = [], payer = REQUESTER_WALLET } = {}) {
  return {
    slot: 312_000_123, blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: ok ? null : { InstructionError: [0, "Custom"] },
      preTokenBalances: [{ owner, mint, uiTokenAmount: { uiAmount: pre } }],
      postTokenBalances: [{ owner, mint, uiTokenAmount: { uiAmount: post } }]
    },
    // A real SPL transfer touches token ACCOUNTS, not the recipient's wallet address — it is deliberately
    // absent here, exactly as on mainnet. The Solana Pay reference rides along as a read-only account.
    transaction: { message: { accountKeys: [payer, "PayerTokenAccount11111111111111111111111111", "RecipientTokenAccount11111111111111111111", ...references] } }
  };
}
const fakeRpc = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const { method, params } = JSON.parse(body || "{}");
    const result = method === "getTransaction" && fakeTransactions.has(params[0]) ? fakeTransactions.get(params[0]) : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
});
let sigCounter = 0;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const newSignature = () => { sigCounter += 1; return `${B58[Math.floor(sigCounter / 58)]}${B58[sigCounter % 58]}`.padEnd(88, "5"); };

let server;
let serverOutput = "";

async function main() {
  await new Promise((resolve) => fakeRpc.listen(0, "127.0.0.1", resolve));
  server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: {
      ...process.env, TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper,
      TOASTY_SESSION_SECRET: "colosseum-golden-path-secret", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "1",
      // Real-payments configuration: with a recipient set, the demo payment provider is DISABLED.
      SVM_PAY_TO: RECIPIENT, TOASTY_EXPERTS_X402_RECIPIENT: "", TOASTY_BILLING_SOLANA_RECIPIENT: RECIPIENT,
      TOASTY_USDC_MINT: USDC_MINT, TOASTY_USDT_MINT: "", TOASTY_SOLANA_NETWORK: "solana-devnet",
      TOASTY_SOLANA_RPC_URL: `http://127.0.0.1:${fakeRpc.address().port}`, TOASTY_SOLANA_PAYER_KEYPAIR: "", SVM_KEYPAIR_PATH: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (c) => (serverOutput += c));
  server.stderr.on("data", (c) => (serverOutput += c));
  await waitForHealth();

  // ------------------------------------------------------------------------------------------------
  stage("Create requester and organization");
  const requester = await api("/auth/register", { method: "POST", body: { name: "Colosseum Requester", email: "requester-colosseum@example.com", password: "password10chars" } });
  assert(requester.status === 201 && requester.data.user?.id, "the requester registers through the real auth route");
  const cookie = requester.cookie;
  const requesterId = requester.data.user.id;
  const orgs = await api("/api/organizations", { cookie });
  const organizationId = orgs.data.organizations[0].id;
  assert(Boolean(organizationId), "registration created the requester's organization");

  // ------------------------------------------------------------------------------------------------
  stage("Fund Dough with USDC on Solana (server-verified)");
  const intent = await api("/api/peeps/dough/funding-intents", { method: "POST", cookie, body: { amount: 30, method: "crypto" } });
  assert(intent.status === 201 && intent.data.funding.recipient === RECIPIENT && intent.data.funding.tokenMint === USDC_MINT, "the funding intent names the configured recipient and USDC mint");
  const intentId = intent.data.intent.id;
  const fundWrongMint = newSignature(); fakeTransactions.set(fundWrongMint, usdcTx({ mint: OTHER_MINT, post: 30 }));
  assert((await api(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie, body: { transactionSignature: fundWrongMint } })).status === 400, "a deposit on the wrong token mint is refused");
  const fundUnder = newSignature(); fakeTransactions.set(fundUnder, usdcTx({ post: 5 }));
  assert((await api(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie, body: { transactionSignature: fundUnder } })).status === 400, "an underpaying deposit is refused");
  const fundFailed = newSignature(); fakeTransactions.set(fundFailed, usdcTx({ ok: false, post: 30 }));
  assert((await api(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie, body: { transactionSignature: fundFailed } })).status === 400, "a transaction that failed on-chain is refused");
  assert((await api(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie, body: { transactionSignature: newSignature() } })).status === 400, "a signature the chain has never seen is refused");
  assert(balance("user", requesterId).spendBalance === 0, "nothing was credited by any rejected claim");
  const fundSignature = newSignature(); fakeTransactions.set(fundSignature, usdcTx({ post: 30 }));
  const funded = await api(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie, body: { transactionSignature: fundSignature } });
  assert(funded.status === 200 && funded.data.confirmed && funded.data.amount === 30, "a real, sufficient, confirmed USDC transfer to the recipient (token-account transfer, wallet not an account key) credits $30");
  assert(balance("user", requesterId).spendBalance === 30, "the Dough ledger shows exactly $30");
  assert((await api(`/api/peeps/dough/funding-intents/${intentId}/confirm`, { method: "POST", cookie, body: { transactionSignature: fundSignature } })).data.alreadyPaid === true, "re-confirming is an idempotent no-op");
  const fundAgain = await api("/api/peeps/dough/funding-intents", { method: "POST", cookie, body: { amount: 30, method: "crypto" } });
  assert((await api(`/api/peeps/dough/funding-intents/${fundAgain.data.intent.id}/confirm`, { method: "POST", cookie, body: { transactionSignature: fundSignature } })).status === 409 && balance("user", requesterId).spendBalance === 30, "the same signature can never fund a second intent");

  // ------------------------------------------------------------------------------------------------
  stage("Create the outcome request and let the agent discover candidates");
  const created = await api("/api/peeps/requests", { method: "POST", cookie, body: { organizationId, whoText: "Fintech/payment executives in Southeast Asia who understand offline payments.", outcomeText: "I want 1 person for a recorded podcast about offline payments and digital wallets." } });
  assert(created.status === 201 && created.data.request.status === "candidates_ready", "the request is created and the agent reaches candidates_ready");
  assert(created.data.request.whoText.startsWith("Fintech/payment") && created.data.request.workingRepresentation.desiredCandidateCount === 1, "the human's words are stored verbatim and the agent inferred one guest");
  assert(created.data.candidates.length >= 3 && created.data.candidates.every((c) => typeof c.matchScore === "number" && c.evidence.length), "the agent returned ranked, evidence-bearing candidates");
  const request = created.data.request;
  const candidate = created.data.candidates.find((c) => c.source === "demo_directory_provider") || created.data.candidates[0];
  assert(candidate.status === "proposed" && Boolean(candidate.id), "a candidate is selected from the shortlist (nobody has been contacted yet)");
  assert(count("peeps_introductions", "request_id = ?", [request.id]) === 0, "no introduction exists before the human authorizes");

  // ------------------------------------------------------------------------------------------------
  stage("Authorize introductions: on-chain payment verified server-side (and every bad claim refused)");
  const requirement = (await api(`/api/peeps/requests/${request.id}/payment-requirement`, { cookie })).data.requirement;
  const accept = requirement.accepts[0];
  assert(requirement.demo === false && accept.payTo === RECIPIENT && accept.tokenMint === USDC_MINT && accept.amount === "0.250" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(accept.reference), "the payment requirement names the real recipient, mint, price and a request-bound reference");
  const reference = accept.reference;
  const authBody = { candidates: [{ candidateId: candidate.id, outreachEmail: GUEST_EMAIL }], compensationAmount: COMPENSATION };
  const proofHeaders = (sig) => ({ "x-payment-signature": sig, "x-solana-transaction-signature": sig, "x-payment-asset": "USDC", "x-payment-amount": "0.25", "x-payer-wallet": "ClientClaimedWalletThatMustBeIgnored111111111" });
  const authorizeWith = (sig, rid = request.id) => api(`/api/peeps/requests/${rid}/authorize`, { method: "POST", cookie, headers: proofHeaders(sig), body: authBody });
  const jamlessCheck = () => assert(!db("peeps_request_get_by_id", { id: request.id }).request.jamId && count("peeps_economic_events", "request_id = ?", [request.id]) === 0, "no Jam, introduction, charge or economic event was created by the refused claim");

  const demoSig = `demo-${"a".repeat(40)}`;
  const demoTry = await authorizeWith(demoSig);
  assert(demoTry.status === 402 && demoTry.data.reason === "demo_payment_disabled", "a 'demo-' signature is refused outright when real payment infrastructure is configured");
  jamlessCheck();
  const unknownTry = await authorizeWith(newSignature());
  assert(unknownTry.status === 402 && unknownTry.data.reason === "payment_not_verified", "a well-formed signature that does not exist on-chain is refused");
  jamlessCheck();
  const wrongMint = newSignature(); fakeTransactions.set(wrongMint, usdcTx({ mint: OTHER_MINT, post: 0.25, references: [reference] }));
  assert((await authorizeWith(wrongMint)).status === 402, "payment in the wrong token mint is refused");
  const wrongRecipient = newSignature(); fakeTransactions.set(wrongRecipient, usdcTx({ owner: "SomeoneElsesWallet111111111111111111111111", post: 0.25, references: [reference] }));
  assert((await authorizeWith(wrongRecipient)).status === 402, "payment to the wrong recipient is refused");
  const underpaid = newSignature(); fakeTransactions.set(underpaid, usdcTx({ post: 0.1, references: [reference] }));
  assert((await authorizeWith(underpaid)).status === 402, "an underpayment is refused");
  const failedTx = newSignature(); fakeTransactions.set(failedTx, usdcTx({ ok: false, post: 0.25, references: [reference] }));
  assert((await authorizeWith(failedTx)).status === 402, "a transaction that failed on-chain is refused");
  const noReference = newSignature(); fakeTransactions.set(noReference, usdcTx({ post: 0.25 }));
  const noRefTry = await authorizeWith(noReference);
  assert(noRefTry.status === 402 && /reference/i.test(noRefTry.data.message), "a valid payment that doesn't carry THIS request's reference can't be claimed for it (a stranger can't spend someone else's public transaction)");
  jamlessCheck();
  fakeTransactions.set(fundSignature, usdcTx({ post: 30, references: [reference] }));
  const fundingSigTry = await authorizeWith(fundSignature);
  assert(fundingSigTry.status === 409, "a transaction already spent on Dough funding can't be re-spent as the introduction payment, even if it verifies");
  jamlessCheck();

  const paySignature = newSignature();
  fakeTransactions.set(paySignature, usdcTx({ pre: 100, post: 100.25, references: [reference] }));
  const authorized = await authorizeWith(paySignature);
  assert(authorized.status === 200 && authorized.data.introductions.length === 1 && authorized.data.jamId, `the verified payment authorizes the introduction and creates the Jam (${JSON.stringify(authorized.data).slice(0, 120)})`);
  const jamId = authorized.data.jamId;
  const intro = authorized.data.introductions[0];
  const paymentView = authorized.data.payment;
  assert(paymentView.status === "onchain_verified" && paymentView.signature === paySignature && paymentView.network === "solana-devnet", "the response reports an on-chain-verified payment with the verified signature");
  assert(paymentView.payerWallet === REQUESTER_WALLET && paymentView.explorerUrl === `https://explorer.solana.com/tx/${paySignature}?cluster=devnet`, "the payer comes from the chain (not the x-payer-wallet header) and the Explorer link targets devnet");
  const event = db("peeps_economic_event_list", { requestId: request.id }).events;
  assert(event.length === 1 && event[0].transactionSignature === paySignature && event[0].status === "onchain_verified" && event[0].tokenMint === USDC_MINT && event[0].payeeWallet === RECIPIENT && event[0].verifiedAt, "the transaction reference is persisted against the Peeps economic event");
  assert(count("payments", "transaction_signature = ?", [paySignature]) === 1, "one payment record carries the signature");
  assert(balance("user", requesterId).spendBalance === 30, "paying on-chain did not touch the Dough balance");

  stage("Idempotency and replay protection on the economic event");
  const replay = await authorizeWith(paySignature);
  assert(replay.status === 200 && replay.data.introductions.length === 0 && replay.data.payment.signature === paySignature, "re-submitting the same proof is a safe replay (candidate already authorized, nothing new)");
  const secondValid = newSignature(); fakeTransactions.set(secondValid, usdcTx({ post: 0.25, references: [reference] }));
  const secondTry = await authorizeWith(secondValid);
  assert(secondTry.status === 200 && secondTry.data.payment.signature === paySignature, "a second real payment for the same request is not consumed — the original event stands");
  assert(count("peeps_economic_events", "request_id = ?", [request.id]) === 1 && count("payments", "purpose = 'peeps introduction authorization'") === 1, "still exactly one economic event and one payment record");
  const other = await api("/api/peeps/requests", { method: "POST", cookie, body: { organizationId, whoText: "Climate finance advisors", outcomeText: "I want 1 research interview about carbon markets." } });
  const otherRef = (await api(`/api/peeps/requests/${other.data.request.id}/payment-requirement`, { cookie })).data.requirement.accepts[0].reference;
  fakeTransactions.set(paySignature, usdcTx({ pre: 100, post: 100.25, references: [reference, otherRef] }));
  const crossReuse = await api(`/api/peeps/requests/${other.data.request.id}/authorize`, { method: "POST", cookie, headers: proofHeaders(paySignature), body: { candidates: [{ candidateId: other.data.candidates[0].id, outreachEmail: "carbon.guest@example.com" }] } });
  assert(crossReuse.status === 409, `one on-chain payment can't be spent on a second request (${crossReuse.status})`);
  assert(count("peeps_economic_events", "transaction_signature = ?", [paySignature]) === 1, "the signature is bound to exactly one economic event");
  const spentElsewhere = db("dough_funding_confirm", { id: fundAgain.data.intent.id, providerReference: paySignature, transactionSignature: paySignature });
  assert(spentElsewhere.error === "duplicate_reference" && balance("user", requesterId).spendBalance === 30, "and the reverse: a signature spent on a Peeps event can't later fund Dough");

  // ------------------------------------------------------------------------------------------------
  stage("Candidate is contacted and accepts (token-gated response page, no account)");
  const outbox = (await api(`/api/peeps/test-outbox?requestId=${request.id}`, { cookie })).data.messages || [];
  const outreach = outbox.find((m) => m.introductionId === intro.id && m.purpose === "outreach" && m.audience === "candidate");
  assert(outreach && outreach.status === "simulated", "the candidate was contacted via the clearly-labelled simulated provider (no real email provider in test)");
  const token = (outreach.testPayload?.url || "").split("token=")[1] || "";
  assert(token.length === 43, "the candidate's private response link carries an unguessable token");
  assert((await api(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} })).status === 200, "the candidate accepts");
  assert((await api(`/api/peeps/respond/${token}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(9, 2), "Asia/Bangkok"), end: zoned(dayUtc(9, 5), "Asia/Bangkok") }] } })).status === 200, "the candidate gives recording preference and availability");

  // ------------------------------------------------------------------------------------------------
  stage("Schedule and book: Jam + Studio session created through the real linkage");
  assert((await api(`/api/peeps/requests/${request.id}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(8, 20), "America/New_York"), end: zoned(dayUtc(9, 8), "America/New_York") }] } })).status === 200, "the requester's availability is recorded");
  const booked = await api(`/api/peeps/introductions/${intro.id}/book`, { method: "POST", cookie, body: {} });
  assert(booked.status === 201 && booked.data.booking.jamId === jamId && booked.data.booking.studioSessionId, "booking links the SAME Jam to a real Studio session");
  const sessionId = booked.data.booking.studioSessionId;
  assert((await api(`/api/peeps/introductions/${intro.id}/book`, { method: "POST", cookie, body: {} })).data.idempotent === true && count("peeps_bookings", "request_id = ?", [request.id]) === 1, "booking again is idempotent (no second booking or session)");
  const jamDetail = await api(`/api/jams/${jamId}`, { cookie });
  assert(jamDetail.data.jam.studioSessionId === sessionId && jamDetail.data.participants.length === 1, "Jam -> Studio session linkage and participant identity are intact");
  const participant = jamDetail.data.participants[0];
  assert(Number(participant.compensationAmount) === COMPENSATION, "the agreed guest compensation is on the participant");

  // ------------------------------------------------------------------------------------------------
  stage("Consent is captured from the participant (not claimed by the requester)");
  const consentBefore = db("jam_participant_get", { id: participant.id }).participant;
  assert(!consentBefore.consentCapturedAt, "before the guest acts no consent exists");
  const consent = await api(`/api/peeps/respond/${token}/consent`, { method: "POST", body: { acceptances: ["terms_of_service", "recording"] } });
  assert(consent.status === 200 && consent.data.consentSatisfied === true, "the guest accepts terms and recording through their own link");
  assert(Boolean(db("jam_participant_get", { id: participant.id }).participant.consentCapturedAt), "consent is stored server-side with a timestamp");

  // ------------------------------------------------------------------------------------------------
  stage("Humans meet: attendance is recorded from the participant's own join event");
  const joinResponse = await api(`/api/peeps/respond/${token}/join`, { method: "POST", body: {} });
  const inviteToken = joinResponse.data.joinUrl.split("token=")[1];
  assert(Boolean(inviteToken), "consent unlocked the guest's join link");
  assert(db("jam_participant_get", { id: participant.id }).participant.attendedAt === null, "no attendance exists until the guest actually joins");
  assert((await api(`/api/jams/${jamId}/events`, { method: "POST", body: { invite: inviteToken, type: "participant.joined" } })).status === 201, "the guest joins the room");
  assert(["attended", "completed"].includes(db("jam_participant_get", { id: participant.id }).participant.status), "attendance is now recorded on the participant");

  // ------------------------------------------------------------------------------------------------
  stage("Attach transcript and recording evidence");
  const TRANSCRIPT = [
    { speaker: "Colosseum Requester", text: "Welcome to the show. Tell me about your work in offline payments." },
    { speaker: candidate.displayName, text: "I have spent twelve years building offline payment systems for merchants across Southeast Asia. I led our QR rollout in Indonesia. We reduced failed transactions by 40 percent after launch." },
    { speaker: candidate.displayName, text: "Offline payments and digital wallets across Southeast Asia work best when merchants can settle without connectivity and wallet operators interoperate." }
  ];
  assert((await api(`/api/jams/${jamId}/transcript`, { method: "POST", cookie, body: { segments: [] } })).status === 400, "an empty transcript is refused");
  const transcript = await api(`/api/jams/${jamId}/transcript`, { method: "POST", cookie, body: { segments: TRANSCRIPT } });
  assert(transcript.status === 201 && transcript.data.transcript.source === "organizer_upload", "the transcript is stored and honestly labelled as an organizer upload");
  assert((await api(`/api/jams/${jamId}/artifacts`, { method: "POST", cookie, body: { artifactType: "recording", storageReference: "s3://colosseum-test/session.mp4", status: "ready" } })).status === 201, "a recording reference is attached");
  assert(count("peeps_breadcrumbs", "jam_id = ?", [jamId]) === 0 && count("peeps_completions", "jam_id = ?", [jamId]) === 0, "before completion there is no completion and no Breadcrumb (nothing is invented early)");

  // ------------------------------------------------------------------------------------------------
  stage("Complete the Jam; Breadcrumbs are generated from the stored transcript");
  const completed = await api(`/api/jams/${jamId}/complete`, { method: "POST", cookie, body: {} });
  assert(completed.status === 200 && completed.data.jam.status === "completed", "the Jam is completed");
  const life = (await api(`/api/peeps/requests/${request.id}/lifecycle`, { cookie })).data;
  assert(life.completion?.participants[0].status === "attended" && life.completion.participants[0].consentCaptured === true && life.completion.transcriptPresent === true, "completion records real attendance, consent and transcript presence");
  assert(life.jamId === jamId && life.studioSessionId === sessionId, "request -> Jam -> Studio session linkage survived completion");
  assert(life.breadcrumbs.length >= 3 && life.breadcrumbs.every((b) => b.provenance.jamId === jamId && b.provenance.transcriptId), "Breadcrumbs exist and each traces to this Jam and a stored transcript");
  assert(life.breadcrumbs.some((b) => /twelve years/.test(b.provenance.quote || "")) && !life.breadcrumbs.some((b) => /Welcome to the show/.test(JSON.stringify(b))), "they quote what the guest said and never the host's words");
  assert(life.outcome.state === "outcome_verified" && life.state === "payment_pending", "the outcome verifies deterministically and the request moves to payment_pending");

  // ------------------------------------------------------------------------------------------------
  stage("Settle Dough: exactly once, money moves (never minted)");
  const outsider = await api("/auth/register", { method: "POST", body: { name: "Eve Outsider", email: "eve-colosseum@example.com", password: "password10chars" } });
  assert((await api(`/api/peeps/requests/${request.id}/settle`, { method: "POST", cookie: outsider.cookie, body: {} })).status === 404, "an outsider can't settle the request");
  const payerBefore = balance("user", requesterId).spendBalance;
  const settled = await Promise.all([1, 2, 3].map(() => api(`/api/peeps/requests/${request.id}/settle`, { method: "POST", cookie, body: {} })));
  assert(settled.every((r) => r.status === 200) && settled.map((r) => r.data.settlements[0].status).filter((s) => s === "settled_to_dough").length === 1, "three concurrent settle calls pay exactly once");
  assert(Math.abs(payerBefore - balance("user", requesterId).spendBalance - COMPENSATION) < 0.001 && balance("dub", booked.data.booking.candidateDubId).earnedBalance === COMPENSATION, "the requester's Dough fell by $25 and the guest's Dub rose by $25");
  assert((await api(`/api/peeps/requests/${request.id}/settle`, { method: "POST", cookie, body: {} })).data.settlements[0].status === "already_paid" && count("dough_entries", "kind = 'jam_earning'") === 1, "settling again changes nothing");

  // ------------------------------------------------------------------------------------------------
  stage("Judge receipt: the final lifecycle, evidence and Solana status");
  const receiptResponse = await api(`/api/peeps/requests/${request.id}/receipt`, { cookie });
  assert(receiptResponse.status === 200, "the receipt endpoint answers for the requester");
  const receipt = receiptResponse.data;
  const checks = Object.fromEntries(receipt.checks.map((c) => [c.key, c.state]));
  for (const key of ["interaction", "consent", "attendance", "evidence", "breadcrumb", "payment", "settlement", "dub"]) assert(checks[key] === "done", `receipt check "${key}" is done (${JSON.stringify(receipt.checks.find((c) => c.key === key))})`);
  assert(receipt.lifecycleState === "paid" && receipt.jam.id === jamId && receipt.jam.studioSessionId === sessionId && receipt.jam.status === "completed", "the receipt names the Jam, the Studio session and the final lifecycle state");
  assert(receipt.candidates[0].name === candidate.displayName && receipt.participants[0].consentCapturedAt && receipt.participants[0].attendedAt, "it names the candidate with consent and attendance timestamps");
  assert(receipt.evidence.transcripts.length === 1 && receipt.evidence.transcripts[0].source === "organizer_upload" && receipt.evidence.recordingPresent, "it lists the evidence that really exists and where it came from");
  assert(receipt.breadcrumbs.total >= 3 && receipt.breadcrumbs.attendanceFacts === 1 && receipt.breadcrumbs.items.every((b) => b.provenance.jamId === jamId), "Breadcrumbs derive from this Jam's evidence");
  assert(receipt.dub.entriesFromThisJam >= 1, "the Dub gained evidence from this Jam");
  assert(receipt.dough.status === "settled" && receipt.dough.compensationPaid === COMPENSATION && receipt.dough.onchain === false && /off-chain/i.test(receipt.dough.note), "compensation is reported as settled in the Dough ledger and explicitly marked off-chain");
  const solEvent = receipt.solana.events[0];
  assert(receipt.solana.events.length === 1 && solEvent.status === "onchain_verified" && solEvent.signature === paySignature && solEvent.explorerUrl === `https://explorer.solana.com/tx/${paySignature}?cluster=devnet`, "the receipt exposes the verified introduction-payment signature and its Explorer link");
  assert(receipt.solana.doughFunding.length === 1 && receipt.solana.doughFunding[0].signature === fundSignature && receipt.solana.doughFunding[0].explorerUrl.includes(fundSignature), "it also exposes the on-chain deposit that funded the Dough");
  assert(!JSON.stringify(receipt).includes("demo-") && !JSON.stringify(receipt).includes("ClientClaimedWallet"), "no fake/demo hash and no client-claimed wallet appears anywhere");
  assert(!/@/.test(JSON.stringify(receipt.candidates)) && !JSON.stringify(receipt).includes(GUEST_EMAIL), "the receipt never leaks the guest's email");

  // ------------------------------------------------------------------------------------------------
  stage("Idempotency across the whole lifecycle");
  const snapshot = () => [count("peeps_breadcrumbs"), count("peeps_completions"), count("peeps_economic_events"), count("peeps_settlements"), count("dough_entries"), count("payments"), count("peeps_bookings"), count("peeps_introductions")].join(",");
  const before = snapshot();
  const spendBefore = balance("user", requesterId);
  const dubBefore = balance("dub", booked.data.booking.candidateDubId);
  await authorizeWith(paySignature);
  await api(`/api/jams/${jamId}/complete`, { method: "POST", cookie, body: {} });
  await api(`/api/sessions/${sessionId}/end`, { method: "POST", cookie, body: {} });
  await Promise.all([1, 2].map(() => api(`/api/peeps/requests/${request.id}/reconcile`, { method: "POST", cookie, body: {} })));
  await api(`/api/peeps/requests/${request.id}/settle`, { method: "POST", cookie, body: {} });
  await api(`/api/jams/${jamId}/settle`, { method: "POST", cookie, body: {} });
  await api(`/api/jams/${jamId}/transcript`, { method: "POST", cookie, body: { segments: TRANSCRIPT } });
  assert(snapshot() === before, `repeating authorize/complete/end/reconcile/settle/transcript changes no row counts (${before})`);
  assert(JSON.stringify(balance("user", requesterId)) === JSON.stringify(spendBefore) && JSON.stringify(balance("dub", booked.data.booking.candidateDubId)) === JSON.stringify(dubBefore), "and moves no money");
  assert((await api(`/api/peeps/requests/${request.id}/lifecycle`, { cookie })).data.state === "paid", "the lifecycle stays paid (monotonic)");

  // ------------------------------------------------------------------------------------------------
  stage("Truthful labelling: a Dough-paid authorization is reported off-chain with no signature");
  const dough = await api("/api/peeps/requests", { method: "POST", cookie, body: { organizationId, whoText: "Payments product leads in Southeast Asia", outcomeText: "I want 1 person for a recorded podcast about QR payments." } });
  const doughCandidate = dough.data.candidates.find((c) => c.source === "demo_directory_provider");
  const doughAuth = await api(`/api/peeps/requests/${dough.data.request.id}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: doughCandidate.id, outreachEmail: "dough.guest@example.com" }] } });
  assert(doughAuth.status === 200 && doughAuth.data.payment.status === "ledger_posted" && doughAuth.data.payment.signature === null && doughAuth.data.payment.explorerUrl === null, "paying with Dough is labelled ledger_posted with no signature and no Explorer link");
  assert(/off-chain/i.test(doughAuth.data.payment.label), "the label says off-chain in plain words");
  assert(Math.abs(balance("user", requesterId).spendBalance - (spendBefore.spendBalance - 0.25)) < 0.001, "exactly $0.25 Dough was spent");

  // ------------------------------------------------------------------------------------------------
  stage("Security: no client-side claim is authoritative");
  assert((await api(`/api/peeps/requests/${request.id}/receipt`, { cookie: outsider.cookie })).status === 404, "another organization can't read the receipt");
  assert((await api(`/api/peeps/requests/${request.id}/receipt`, { headers: { "x-toasty-csrf": "" } })).status === 401, "an unauthenticated caller can't read the receipt");
  assert((await api(`/api/peeps/requests/${request.id}/authorize`, { method: "POST", cookie, headers: { "x-toasty-csrf": "0" }, body: authBody })).status === 403, "CSRF protection is still enforced on authorize");
  assert((await api("/api/peeps/demo-payments/authorize", { method: "POST", cookie, body: { requestId: request.id } })).status === 409, "the demo payment provider is disabled while real payments are configured");
  const forged = await api(`/api/peeps/requests/${other.data.request.id}/authorize`, { method: "POST", cookie, headers: { ...proofHeaders(newSignature()), "x-approval-source": "ADMIN_OVERRIDE" }, body: { candidates: [{ candidateId: other.data.candidates[0].id, outreachEmail: "x@example.com" }] } });
  assert(forged.status === 402 && count("peeps_economic_events", "request_id = ?", [other.data.request.id]) === 0, "headers claiming payment/approval, with no matching on-chain transaction, authorize nothing");
  const claimedAttendance = await api(`/api/jams/${jamId}/events`, { method: "POST", cookie, body: { type: "participant.joined" } });
  assert(claimedAttendance.status >= 400, "a requester can't fabricate the guest's attendance event");

  console.log("\nAll Colosseum golden-path stages passed.");
}

main()
  .then(() => { server.kill(); fakeRpc.close(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error.message || error);
    console.error("\n--- server output (tail) ---\n" + serverOutput.slice(-3000));
    server?.kill(); fakeRpc.close(); rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
