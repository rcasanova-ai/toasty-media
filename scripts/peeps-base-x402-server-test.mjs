#!/usr/bin/env node
// Base x402 rail for the introduction fee. The Peeps server runs for real; the facilitator and the Base RPC are local
// fakes (no network, no funds). The receipt parser is exercised on a GENUINE Base Sepolia settlement receipt
// (scripts/fixtures/base-sepolia-x402-settlement.json). Where a test needs an underlying receipt that pays the full fee,
// the fixture's Transfer amount is patched and that is called out as synthetic. This proves the server logic; it is not
// evidence that a real payment on Base was made.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const fixture = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/base-sepolia-x402-settlement.json"), "utf8")).receipt;
const FIX_HASH = "0x0d719a78a34fd8e4403350067080f61ccccdeaa9c63e99fc3c7d196bcfdf3af4";
const usdc = fixture.logs.find((l) => l.topics[0].startsWith("0xddf252ad")).address.toLowerCase();
const transferLog = fixture.logs.find((l) => l.topics[0].startsWith("0xddf252ad"));
const authLog = fixture.logs.find((l) => l.topics[0].startsWith("0x98de5035"));
const unpad = (t) => `0x${t.slice(26)}`;
const PAYER = unpad(transferLog.topics[1]);
const PAY_TO = unpad(transferLog.topics[2]);
const NONCE = authLog.topics[2];
const synthetic = (hash, atomic) => ({ ...fixture, transactionHash: hash, logs: fixture.logs.map((l) => (l === transferLog ? { ...l, data: `0x${BigInt(atomic).toString(16).padStart(64, "0")}` } : l)) });

// ---- fakes ----
const state = { facilitator: { verify: { isValid: true }, settleHash: FIX_HASH, calls: [] }, rpc: { mode: "real", hash: FIX_HASH } };
const serve = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => ok(s)); });
const body = (req) => new Promise((ok) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => ok(d ? JSON.parse(d) : {})); });
const facilitator = await serve(async (req, res) => {
  const b = await body(req);
  state.facilitator.calls.push(req.url);
  res.setHeader("content-type", "application/json");
  if (req.url === "/verify") return res.end(JSON.stringify(state.facilitator.verify));
  if (req.url === "/settle") return res.end(JSON.stringify({ success: true, transaction: state.facilitator.settleHash, network: "eip155:84532", payer: b.paymentPayload.payload.authorization.from }));
  res.statusCode = 404; res.end("{}");
});
const rpc = await serve(async (req, res) => {
  const b = await body(req); res.setHeader("content-type", "application/json");
  if (b.method === "eth_getBlockByNumber") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { timestamp: "0x6ace455c" } }));
  if (b.method !== "eth_getTransactionReceipt") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
  const { mode, hash } = state.rpc;
  const result = mode === "null" ? null : mode === "real" ? fixture : mode === "failed" ? { ...fixture, status: "0x0" } : synthetic(hash, 250000);
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
});

const scratch = mkdtempSync(join(tmpdir(), "toasty-basex-"));
const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: "4791", TOASTY_AUTH_DB: join(scratch, "db.sqlite"), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "bx-secret", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "",
  BASE_X402_PAY_TO: PAY_TO, BASE_X402_USDC: usdc, BASE_X402_NETWORK: "eip155:84532", BASE_X402_FACILITATOR_URL: `http://127.0.0.1:${facilitator.address().port}`, BASE_X402_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, BASE_X402_RECEIPT_ATTEMPTS: "2", BASE_X402_RECEIPT_DELAY_MS: "20" }, stdio: "ignore" });
const base = "http://127.0.0.1:4791";
const call = async (path, { method = "GET", cookie, body: b, headers = {} } = {}) => { const r = await fetch(base + path, { method, headers: { "x-toasty-csrf": "1", ...headers, ...(cookie ? { cookie } : {}), ...(b !== undefined ? { "content-type": "application/json" } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); let data = {}; try { data = await r.json(); } catch (_) {} return { status: r.status, data, headers: r.headers, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
const payment = (over = {}, authOver = {}) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:84532" }, payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: PAYER, to: PAY_TO, value: "250000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: NONCE, ...authOver }, ...over } })).toString("base64");
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const reg = await call("/auth/register", { method: "POST", body: { name: "Agent Owner", email: "agent-owner@example.com", password: "password10chars" } });
  const cookie = reg.cookie;
  const make = async () => { const c = await call("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech/payment executives in Southeast Asia who understand offline payments", outcomeText: "I want 1 person for a recorded podcast about offline payments." } }); return { rid: c.data.request.id, demo: c.data.candidates.find((x) => x.reachability === "demo_participant") }; };
  const authorize = (rid, demo, header) => call(`/api/peeps/requests/${rid}/authorize`, { method: "POST", cookie, headers: header ? { "payment-signature": header } : {}, body: { candidates: [{ candidateId: demo.id }] } });
  const settles = () => state.facilitator.calls.filter((u) => u === "/settle").length;

  console.log("Requirement advertises Base per x402 v2");
  const a = await make();
  const req = (await call(`/api/peeps/requests/${a.rid}/payment-requirement`, { cookie })).data.requirement;
  const entry = req.accepts.find((x) => String(x.network).startsWith("eip155"));
  assert(entry && entry.scheme === "exact" && entry.amount === "250000" && entry.asset === usdc && entry.payTo === PAY_TO && entry.extra.name === "USDC" && entry.extra.assetTransferMethod === "eip3009", "an exact/eip3009 entry with the atomic fee, USDC asset and Toasty's address");
  assert(req.x402Version === 2 && req.resource.url.includes(a.rid), "v2 envelope with the resource");

  console.log("\nBad payments are refused before anything is settled");
  for (const [label, header] of [["pays someone else", payment({}, { to: "0x000000000000000000000000000000000000dEaD" })], ["pays less than the fee", payment({}, { value: "1000" })], ["expired", payment({}, { validBefore: "1" })], ["wrong version", Buffer.from(JSON.stringify({ x402Version: 1, payload: {} })).toString("base64")], ["not base64 json", "%%%"]]) {
    const r = await authorize(a.rid, a.demo, header);
    assert(r.status === 402 && settles() === 0, `${label}: 402 and the facilitator was never asked to settle`);
  }
  state.facilitator.verify = { isValid: false, invalidReason: "invalid_signature" };
  const invalid = await authorize(a.rid, a.demo, payment());
  assert(invalid.status === 402 && /not valid/.test(invalid.data.message) && settles() === 0, "facilitator says invalid: refused, not settled");
  state.facilitator.verify = { isValid: true };

  console.log("\nSettlement is re-checked on-chain, never taken on the facilitator's word");
  state.rpc.mode = "real"; // the GENUINE fixture receipt pays 0.006 USDC, less than the 0.25 fee
  const underpaid = await authorize(a.rid, a.demo, payment());
  assert(underpaid.status === 402 && /did not move enough USDC/.test(underpaid.data.message), "a real receipt that moved too little USDC is refused");
  assert((await call(`/api/peeps/requests/${a.rid}`, { cookie })).data.introductions.length === 0, "nothing was authorized");
  state.rpc.mode = "failed";
  assert((await authorize(a.rid, a.demo, payment())).status === 402, "a failed on-chain transaction is refused");
  state.rpc.mode = "synthetic"; state.rpc.hash = FIX_HASH;
  const ok = await authorize(a.rid, a.demo, payment());
  assert(ok.status === 200 && ok.data.introductions.length === 1, "SYNTHETIC receipt that pays the full fee: introduction authorized");
  assert(ok.data.payment.status === "onchain_verified" && ok.data.payment.rail === "x402-base-usdc" && ok.data.payment.signature === FIX_HASH && ok.data.payment.explorerUrl === `https://sepolia.basescan.org/tx/${FIX_HASH}` && /Base/.test(ok.data.payment.label), "event is on-chain verified on the Base rail with a Base explorer link");
  assert(ok.data.payment.payerWallet === PAYER && ok.data.payment.payeeWallet === PAY_TO && ok.data.payment.network === "eip155:84532", "payer and payee are the chain's, not the client's claim");
  const dough = (await call("/api/peeps/dough", { cookie })).data.account.spendBalance;
  assert(dough === 0, "the Dough ledger was not touched");

  console.log("\nIdempotency and replay");
  const before = settles();
  const replay = await authorize(a.rid, a.demo, payment());
  assert(replay.status === 200 && settles() === before, "the same request paid again is a replay: no second settlement");
  const rec = (await call(`/api/peeps/requests/${a.rid}/receipt`, { cookie })).data;
  assert(rec.solana.events.length === 1 && rec.solana.events[0].rail === "x402-base-usdc", "exactly one economic event on the receipt");
  const b = await make();
  const reused = await authorize(b.rid, b.demo, payment());
  assert(reused.status === 409, "the same settlement transaction cannot pay a second request");

  console.log("\nSettled but not yet confirmed: pending, never verified");
  const c = await make();
  const PENDING_HASH = `0x${"ab".repeat(32)}`;
  state.facilitator.settleHash = PENDING_HASH; state.rpc.mode = "null"; state.rpc.hash = PENDING_HASH;
  const settledBefore = settles();
  const pend = await authorize(c.rid, c.demo, payment());
  assert(pend.status === 202 && pend.data.pendingTransaction === PENDING_HASH && settles() === settledBefore + 1, "202 pending with the real tx hash");
  const pendReceipt = (await call(`/api/peeps/requests/${c.rid}/receipt`, { cookie })).data;
  const pendEvent = pendReceipt.solana.events[0];
  assert(pendEvent.status === "onchain_pending" && pendEvent.signature === null && /Pending/.test(pendEvent.label), "the receipt shows PENDING, with no verified signature or explorer link");
  assert((await call(`/api/peeps/requests/${c.rid}`, { cookie })).data.introductions.length === 0, "nothing is authorized while pending");
  state.rpc.mode = "synthetic";
  const settledMid = settles();
  const done = await authorize(c.rid, c.demo, null);
  assert(done.status === 200 && done.data.introductions.length === 1 && settles() === settledMid, "once the chain confirms, a retry promotes it and authorizes, without settling again");
  const final = (await call(`/api/peeps/requests/${c.rid}/receipt`, { cookie })).data.solana.events[0];
  assert(final.status === "onchain_verified" && final.signature === PENDING_HASH, "now verified with the transaction hash");
  console.log("\nPASS (fakes for facilitator and RPC; the receipt parser ran on genuine Base Sepolia data)");
} finally { child.kill(); facilitator.close(); rpc.close(); }
