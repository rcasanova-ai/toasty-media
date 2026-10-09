#!/usr/bin/env node
// Integration test for confidential (shielded ZEC) settlement inside the real Peeps lifecycle.
// Real server + throwaway SQLite, driven over HTTP. Toasty holds no keys and sees no chain, so this test plays the
// two humans' WALLETS by hand: the "requester wallet" reports a payment, and the "recipient wallet" confirms what
// arrived. What it proves is the server side: obligation, explicit approval, authenticated + bound + single-shot
// recipient confirmation, duplicate/replay refusal, failure handling, Dough ledger consistency and receipt privacy.
// The genuine shielded transfer between two real regtest wallets is demonstrated separately
// (scripts/zcash-regtest-e2e.mjs); this file never claims a chain transaction happened.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const scratch = mkdtempSync(join(tmpdir(), "toasty-zec-"));
const servers = [];
let out = "";
function assert(c, m) { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); }

function start(port, extra = {}) {
  const dbPath = join(scratch, `db-${port}.sqlite`);
  const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: { ...process.env, TOASTY_RENDER_PORT: String(port), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "zec-test-secret", RESEND_API_KEY: "",
      TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "", SVM_KEYPAIR_PATH: "", PEEPS_TEST_ADAPTERS: "1",
      ZCASH_SETTLEMENT_ENABLED: "", ZCASH_NETWORK: "", ...extra }, stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (c) => (out += c)); child.stderr.on("data", (c) => (out += c));
  servers.push(child);
  return { base: `http://127.0.0.1:${port}`, dbPath };
}
async function ready(base) { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("server never came up"); }

function make(srv) {
  const api = async (path, { method = "GET", cookie, body, headers = {}, csrf = true } = {}) => {
    const h = { ...headers };
    if (csrf) h["x-toasty-csrf"] = "1";
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(`${srv.base}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch (_) {}
    return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
  };
  const db = (action, values = {}) => { const r = spawnSync("python3", [helper], { input: JSON.stringify({ action, dbPath: srv.dbPath, ...values }), encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim() ? JSON.parse(r.stdout) : {}; };
  const sql = (statement, params = []) => { const script = `import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\ncur=c.execute(sys.argv[2], json.loads(sys.argv[3]))\nc.commit()\nprint(json.dumps(cur.fetchall()))`; const r = spawnSync("python3", ["-c", script, srv.dbPath, statement, JSON.stringify(params)], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return JSON.parse(r.stdout.trim()); };
  return { api, db, sql };
}

function zoned(ms, tz) { const p = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
function dayUtc(d, h) { const t = new Date(Date.now() + d * 86400000); return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, 0); }

const ADDRESS = `uregtest1${"q7x9".repeat(30)}`;                       // shape-valid shielded unified address (regtest)
const TXID_A = "a1".repeat(32), TXID_B = "b2".repeat(32), TXID_OTHER = "c3".repeat(32);

async function main() {
  const srv = start(4236, { ZCASH_SETTLEMENT_ENABLED: "1", ZCASH_NETWORK: "regtest" });
  const off = start(4237);
  await ready(srv.base); await ready(off.base);
  const { api, db, sql } = make(srv);
  const balance = (t, id) => db("dough_get", { subjectType: t, subjectId: id }).account || { spendBalance: 0, earnedBalance: 0 };

  const requester = await api("/auth/register", { method: "POST", body: { name: "Zec Requester", email: "zec-req@example.com", password: "password10chars" } });
  const cookie = requester.cookie, userId = requester.data.user.id;
  db("dough_post", { id: "dle_seed", subjectType: "user", subjectId: userId, bucket: "spend", direction: "credit", amount: 200, kind: "funding", referenceId: "seed" });
  const outsider = await api("/auth/register", { method: "POST", body: { name: "Eve Outsider", email: "zec-eve@example.com", password: "password10chars" } });

  async function booked(label, who, dayOffset, email) {
    const created = await api("/api/peeps/requests", { method: "POST", cookie, body: { whoText: who, outcomeText: "I want 1 person for a recorded podcast about offline payments." } });
    const request = created.data.request;
    const cand = created.data.candidates.find((c) => c.source === "demo_directory_provider");
    const auth = await api(`/api/peeps/requests/${request.id}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: cand.id, outreachEmail: email }], compensationAmount: 25 } });
    if (auth.status !== 200) throw new Error(`authorize ${label}: ${auth.status} ${JSON.stringify(auth.data)}`);
    const intro = auth.data.introductions[0];
    const msgs = (await api(`/api/peeps/test-outbox?requestId=${request.id}`, { cookie })).data.messages || [];
    const token = ([...msgs].reverse().find((m) => m.introductionId === intro.id && m.purpose === "outreach")?.testPayload?.url || "").split("token=")[1];
    await api(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} });
    await api(`/api/peeps/respond/${token}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(dayOffset, 2), "Asia/Bangkok"), end: zoned(dayUtc(dayOffset, 5), "Asia/Bangkok") }] } });
    await api(`/api/peeps/requests/${request.id}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(dayOffset - 1, 20), "America/New_York"), end: zoned(dayUtc(dayOffset, 8), "America/New_York") }] } });
    const book = await api(`/api/peeps/introductions/${intro.id}/book`, { method: "POST", cookie, body: {} });
    if (book.status !== 201) throw new Error(`book ${label}: ${book.status}`);
    await api(`/api/peeps/respond/${token}/consent`, { method: "POST", body: { acceptances: ["terms_of_service", "recording"] } });
    const join = await api(`/api/peeps/respond/${token}/join`, { method: "POST", body: {} });
    return { request, token, jamId: book.data.booking.jamId, dubId: book.data.booking.candidateDubId, inviteToken: join.data.joinUrl.split("token=")[1], participantId: (await api(`/api/jams/${book.data.booking.jamId}`, { cookie })).data.participants[0].id };
  }
  async function attendAndComplete(S) {
    await api(`/api/jams/${S.jamId}/events`, { method: "POST", body: { invite: S.inviteToken, type: "participant.joined" } });
    await api(`/api/jams/${S.jamId}/artifacts`, { method: "POST", cookie, body: { artifactType: "recording", storageReference: "s3://zec-test/rec.mp4", status: "ready" } });
    await api(`/api/jams/${S.jamId}/complete`, { method: "POST", cookie, body: {} });
  }

  console.log("Setup: two real Peeps sessions (the real request -> Jam -> booking lifecycle)");
  const A = await booked("A", "Fintech payment executives in Southeast Asia offline payments", 9, "zec.guest.a@example.com");
  const B = await booked("B", "Payments product leads in Southeast Asia offline payments", 11, "zec.guest.b@example.com");
  const create = (S, body, who = cookie) => api(`/api/peeps/requests/${S.request.id}/zec-settlements`, { method: "POST", cookie: who, body });
  assert(true, "sessions booked");

  console.log("\nDisabled by default, and honest about it");
  const offApi = make(off);
  const offUser = await offApi.api("/auth/register", { method: "POST", body: { name: "Off User", email: "zec-off@example.com", password: "password10chars" } });
  assert((await offApi.api("/api/peeps/requests/preq_x/zec-settlements", { method: "POST", cookie: offUser.cookie, body: {} })).status === 503, "with ZCASH_SETTLEMENT_ENABLED unset the feature answers 503 (disabled by default)");

  console.log("\nObligation: authorization and preconditions");
  assert((await api(`/api/peeps/requests/${A.request.id}/zec-settlements`, { method: "POST", body: { participantId: A.participantId, amountZat: 1 } })).status === 401, "unauthenticated create is 401");
  assert((await create(A, { participantId: A.participantId, amountZat: 100000 }, outsider.cookie)).status === 404, "another organization can't create a settlement for this request");
  assert((await create(A, { participantId: A.participantId, amountZat: 100000 })).status === 409, "no obligation before the participant actually took part (nothing is owed yet)");
  await attendAndComplete(A); await attendAndComplete(B);
  assert((await create(A, { participantId: A.participantId, amountZat: 0 })).status === 400 && (await create(A, { participantId: A.participantId, amountZat: "lots" })).status === 400, "a non-positive or non-numeric amount is refused");
  assert((await create(A, { participantId: B.participantId, amountZat: 100000 })).status === 404, "a participant from another request can't be settled here");
  const c1 = await create(A, { participantId: A.participantId, amountZat: 100000 });
  assert(c1.status === 201 && c1.data.settlement.state === "PENDING" && /^zs_/.test(c1.data.settlement.ref) && c1.data.settlement.network === "regtest", "the obligation is created PENDING with an opaque reference, on the configured network");
  const ref = c1.data.settlement.ref;
  const c1b = await create(A, { participantId: A.participantId, amountZat: 999 });
  assert(c1b.status === 200 && c1b.data.idempotent === true && c1b.data.settlement.ref === ref && sql("SELECT COUNT(*) FROM peeps_zec_settlements WHERE jam_participant_id=?", [A.participantId])[0][0] === 1, "creating again is idempotent: one live obligation per participant");
  assert(sql("SELECT amount_zat FROM peeps_zec_settlements WHERE id=?", [ref])[0][0] === 100000, "…and the original agreed amount is untouched");
  assert((await api(`/api/peeps/requests/${A.request.id}/zec-settlements/${ref}/approve`, { method: "POST", cookie, body: { approve: true } })).status === 409, "the requester can't approve while the recipient hasn't opted in (no address to pay)");

  console.log("\nRecipient opts in (consent) with a SHIELDED address only");
  const rec = (token, action, body) => api(`/api/peeps/respond/${token}/${action}`, { method: "POST", body });
  assert((await rec(A.token, "zec-address", { address: ADDRESS })).status === 400, "opt-in without explicit consent is refused");
  assert((await rec(A.token, "zec-address", { consent: true, address: "tmQ4e8Xjk2m1aFj8w3pYQe7xH9cVn2dLzP1" })).status === 400, "a transparent address is refused: confidential means shielded");
  assert((await rec(A.token, "zec-address", { consent: true, address: "u1" + "q".repeat(60) })).status === 400, "a mainnet-format address is refused on a regtest deployment");
  assert((await rec("x".repeat(43), "zec-address", { consent: true, address: ADDRESS })).status === 404, "an invalid response token is 404");
  assert((await rec(A.token, "zec-address", { consent: true, address: ADDRESS })).status === 200, "a shielded regtest address with consent is accepted");
  assert(sql("SELECT state FROM peeps_zec_settlements WHERE id=?", [ref])[0][0] === "AWAITING_APPROVAL", "the obligation moves to AWAITING_APPROVAL");

  console.log("\nExplicit approval: nothing is paid or revealed without it");
  const base = `/api/peeps/requests/${A.request.id}/zec-settlements/${ref}`;
  assert((await api(base + "/submit", { method: "POST", cookie, body: { txid: TXID_A } })).status === 409, "a payment can't be reported before it was approved");
  assert((await api(base + "/approve", { method: "POST", cookie, body: {} })).status === 400, "approval must be explicit (approve: true)");
  assert((await api(base + "/approve", { method: "POST", cookie: outsider.cookie, body: { approve: true } })).status === 404, "another organization can't approve or read the instructions");
  const listBefore = JSON.stringify((await api(`/api/peeps/requests/${A.request.id}/zec-settlements`, { cookie })).data);
  assert(!listBefore.includes(ADDRESS) && !/peeps:zs_/.test(listBefore), "the settlement list never contains the address or memo");
  const approved = await api(base + "/approve", { method: "POST", cookie, body: { approve: true } });
  assert(approved.status === 200 && approved.data.instructions.address === ADDRESS && approved.data.instructions.memo === `peeps:${ref}` && approved.data.instructions.amountZat === 100000 && approved.data.instructions.network === "regtest", "after explicit approval the requester (only) receives the payment instructions");

  console.log("\nSubmission is a claim, not settlement");
  assert((await api(base + "/submit", { method: "POST", cookie, body: { txid: "not-a-txid" } })).status === 400, "a malformed transaction id is refused");
  const sub = await api(base + "/submit", { method: "POST", cookie, body: { txid: TXID_A } });
  assert(sub.status === 200 && sub.data.settlement.state === "SUBMITTED", "the reported payment is recorded as SUBMITTED");
  assert((await api(base + "/submit", { method: "POST", cookie, body: { txid: TXID_A } })).data.idempotent === true, "reporting it again is idempotent");
  assert(sql("SELECT compensation_status FROM jam_participants WHERE id=?", [A.participantId])[0][0] !== "paid" && !JSON.stringify(sql("SELECT submitted_txid_hash FROM peeps_zec_settlements WHERE id=?", [ref])).includes(TXID_A), "the participant is NOT paid, and only a hash of the txid is stored");
  const lifeSubmitted = (await api(`/api/peeps/requests/${A.request.id}/lifecycle`, { cookie })).data;
  assert(lifeSubmitted.state !== "paid", "the lifecycle is not 'paid' on a sender's say-so");
  const before = { payer: balance("user", userId), dub: balance("dub", A.dubId) };
  const doughTry = (await api(`/api/peeps/requests/${A.request.id}/settle`, { method: "POST", cookie, body: {} })).data.settlements[0];
  assert(doughTry.status === "settling_via_confidential_zec" && balance("user", userId).spendBalance === before.payer.spendBalance && balance("dub", A.dubId).earnedBalance === before.dub.earnedBalance, "Dough settlement defers to the in-flight ZEC obligation and moves no ledger money (got " + JSON.stringify(doughTry) + ")");

  console.log("\nRecipient confirmation: authenticated, bound, single-shot");
  const view = await api(`/api/peeps/respond/${A.token}/zec`);
  assert(view.status === 200 && view.data.settlement.state === "AWAITING_RECIPIENT_CONFIRMATION" && view.data.settlement.expect.memo === `peeps:${ref}` && view.data.settlement.expect.amountZat === 100000 && view.data.settlement.confirmationCode, "the recipient sees the obligation (state advances to AWAITING_RECIPIENT_CONFIRMATION) with what to expect and a private confirmation code");
  const code = view.data.settlement.confirmationCode;
  const good = { ref, code, memo: `peeps:${ref}`, amountZat: 100000, txid: TXID_A };
  const confirm = (token, body) => rec(token, "zec-confirm", body);
  assert((await api(`/api/peeps/requests/${A.request.id}/zec-settlements/${ref}/confirm`, { method: "POST", cookie, body: good })).status === 404, "the requester has no way to confirm on the recipient's behalf (no such route)");
  assert((await confirm("y".repeat(43), good)).status === 404, "an invalid token can't confirm");
  assert((await confirm(B.token, good)).status === 404, "ANOTHER participant's token can't confirm this obligation");
  assert((await confirm(A.token, { ...good, code: "wrong-code" })).status === 403, "a wrong confirmation code is refused");
  assert((await confirm(A.token, { ...good, memo: "peeps:zs_other" })).status === 409, "a wrong memo is refused");
  assert((await confirm(A.token, { ...good, amountZat: 99999 })).status === 409, "an underpayment is refused");
  assert((await confirm(A.token, { ...good, txid: TXID_OTHER })).status === 409, "a different transaction than the payer reported is refused");
  assert((await confirm(A.token, { ...good, txid: "zz" })).status === 400, "a malformed txid is refused");
  assert((await confirm(A.token, { ...good, ref: "zs_forged" })).status === 404, "a wrong obligation reference is refused");
  assert(sql("SELECT state FROM peeps_zec_settlements WHERE id=?", [ref])[0][0] === "AWAITING_RECIPIENT_CONFIRMATION" && sql("SELECT compensation_status FROM jam_participants WHERE id=?", [A.participantId])[0][0] !== "paid", "none of the bad confirmations changed anything");
  const verified = await confirm(A.token, good);
  assert(verified.status === 200 && verified.data.settlement.state === "VERIFIED" && verified.data.settlement.label === "VERIFIED CONFIDENTIAL SETTLEMENT", "the correct recipient confirmation makes the settlement VERIFIED");
  assert(sql("SELECT compensation_status FROM jam_participants WHERE id=?", [A.participantId])[0][0] === "paid" && sql("SELECT status, rail FROM peeps_settlements WHERE jam_participant_id=?", [A.participantId])[0].join() === "paid,zcash", "…and only then the participant is paid, on rail 'zcash'");
  assert(!sql("SELECT confirmed_txid_hash FROM peeps_zec_settlements WHERE id=?", [ref])[0][0].includes(TXID_A), "only a hash of the confirmed transaction is stored");

  console.log("\nIdempotency, replay and duplicates");
  const replay = await confirm(A.token, good);
  assert(replay.status === 200 && replay.data.idempotent === true && replay.data.settlement.state === "VERIFIED", "replaying the same confirmation is a safe no-op");
  assert((await confirm(A.token, { ...good, txid: TXID_B })).data.idempotent === true && sql("SELECT confirmed_txid_hash FROM peeps_zec_settlements WHERE id=?", [ref])[0][0] === (await import("node:crypto")).createHash("sha256").update(TXID_A).digest("hex"), "a replay with a different txid can't rewrite the verified evidence");
  assert((await api(base + "/fail", { method: "POST", cookie, body: { reason: "oops" } })).status === 409, "a VERIFIED settlement can't be failed");
  assert(sql("SELECT COUNT(*) FROM payments WHERE rail='zcash-shielded'")[0][0] === 1 && sql("SELECT COUNT(*) FROM peeps_settlements WHERE jam_participant_id=?", [A.participantId])[0][0] === 1, "one payment record and one settlement row exist");
  const createAgain = await create(A, { participantId: A.participantId, amountZat: 100000 });
  assert(createAgain.status === 409, "a paid participant can't get a new obligation");
  const doughAfter = (await api(`/api/peeps/requests/${A.request.id}/settle`, { method: "POST", cookie, body: {} })).data.settlements[0];
  assert(doughAfter.status === "already_paid" && balance("user", userId).spendBalance === before.payer.spendBalance && balance("dub", A.dubId).earnedBalance === 0 && sql("SELECT COUNT(*) FROM dough_entries WHERE kind IN ('jam_earning','peeps_settlement_out')")[0][0] === 0, "Dough settlement after ZEC is 'already_paid' and the Dough ledger is untouched (no double payment, nothing minted)");
  assert((await api(`/api/peeps/requests/${A.request.id}/lifecycle`, { cookie })).data.state === "paid", "the lifecycle reaches 'paid'");

  console.log("\nFailure, pending and retry (second participant)");
  assert((await rec(B.token, "zec-address", { consent: true, address: ADDRESS })).status === 200, "participant B opts in");
  const cB = await create(B, { participantId: B.participantId, amountZat: 50000 });
  assert(cB.status === 201 && cB.data.settlement.state === "AWAITING_APPROVAL", "B's obligation starts AWAITING_APPROVAL (recipient already opted in)");
  const refB = cB.data.settlement.ref, baseB = `/api/peeps/requests/${B.request.id}/zec-settlements/${refB}`;
  await api(baseB + "/approve", { method: "POST", cookie, body: { approve: true } });
  await api(baseB + "/submit", { method: "POST", cookie, body: { txid: TXID_B } });
  const viewB = (await api(`/api/peeps/respond/${B.token}/zec`)).data.settlement;
  assert((await confirm(A.token, { ref: refB, code: viewB.confirmationCode, memo: `peeps:${refB}`, amountZat: 50000, txid: TXID_B })).status === 404, "A's token can't confirm B's obligation even with B's code");
  assert((await confirm(B.token, { ref: refB, code: viewB.confirmationCode, memo: `peeps:${refB}`, amountZat: 50000, txid: TXID_A })).status === 409, "txid mismatch with what B's payer reported is refused");
  const recB = await api(`/api/peeps/requests/${B.request.id}/receipt`, { cookie });
  assert(recB.data.zcash.settlements[0].state === "AWAITING_RECIPIENT_CONFIRMATION" && !recB.data.zcash.settlements[0].verified, "while pending, the receipt says AWAITING_RECIPIENT_CONFIRMATION, not verified");
  const failed = await api(baseB + "/fail", { method: "POST", cookie, body: { reason: "transfer_failed" } });
  assert(failed.data.settlement.state === "FAILED", "a failed transfer is recorded FAILED");
  assert(sql("SELECT compensation_status FROM jam_participants WHERE id=?", [B.participantId])[0][0] !== "paid" && balance("dub", B.dubId).earnedBalance === 0, "…and the Dough obligation is NOT settled");
  assert((await confirm(B.token, { ref: refB, code: viewB.confirmationCode, memo: `peeps:${refB}`, amountZat: 50000, txid: TXID_B })).status === 404, "a FAILED obligation can't be confirmed later");
  const retry = await create(B, { participantId: B.participantId, amountZat: 50000 });
  assert(retry.status === 201 && retry.data.settlement.attempt === 2 && retry.data.settlement.ref !== refB, "a retry creates a fresh attempt (attempt 2) with a new reference");
  const refB2 = retry.data.settlement.ref, baseB2 = `/api/peeps/requests/${B.request.id}/zec-settlements/${refB2}`;
  await api(baseB2 + "/approve", { method: "POST", cookie, body: { approve: true } });
  await api(baseB2 + "/submit", { method: "POST", cookie, body: { txid: TXID_A } });
  const view2 = (await api(`/api/peeps/respond/${B.token}/zec`)).data.settlement;
  const dup = await confirm(B.token, { ref: refB2, code: view2.confirmationCode, memo: `peeps:${refB2}`, amountZat: 50000, txid: TXID_A });
  assert(dup.status === 409 && sql("SELECT compensation_status FROM jam_participants WHERE id=?", [B.participantId])[0][0] !== "paid", "a transaction that already settled A's obligation can't settle B's (duplicate transaction refused)");
  sql("UPDATE peeps_zec_settlements SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [refB2]);
  assert((await api(`/api/peeps/requests/${B.request.id}/zec-settlements`, { cookie })).data.settlements.some((s) => s.ref === refB2 && s.state === "FAILED" && s.failureReason === "expired"), "an abandoned obligation expires to FAILED so it can be retried");
  const dough = (await api(`/api/peeps/requests/${B.request.id}/settle`, { method: "POST", cookie, body: {} })).data.settlements[0];
  assert(dough.status === "settled_to_dough" && balance("dub", B.dubId).earnedBalance === 25, "after the ZEC attempts failed, the same participant can still be settled on the Dough ledger, exactly once");

  console.log("\nReceipt privacy and rail honesty");
  const receiptA = (await api(`/api/peeps/requests/${A.request.id}/receipt`, { cookie })).data;
  const z = receiptA.zcash.settlements[0];
  assert(z.state === "VERIFIED" && z.label === "VERIFIED CONFIDENTIAL SETTLEMENT" && z.network === "regtest" && /REGTEST/.test(z.networkLabel) && z.ref === ref, "the receipt shows VERIFIED CONFIDENTIAL SETTLEMENT, an opaque reference and the network (REGTEST)");
  const json = JSON.stringify(receiptA);
  for (const secret of [ADDRESS, "uregtest1", `peeps:${ref}`, code, TXID_A, TXID_B, "100000", "amountZat"]) assert(!json.includes(secret), `the receipt never contains "${secret.slice(0, 22)}"`);
  assert(receiptA.dough.items[0].rail === "zcash_confidential" && /not the Dough ledger/.test(receiptA.checks.find((c) => c.key === "settlement").detail) && receiptA.dough.compensationPaid === 0, "the receipt does NOT present the ZEC payout as a Dough ledger settlement");
  const receiptB = (await api(`/api/peeps/requests/${B.request.id}/receipt`, { cookie })).data;
  assert(receiptB.dough.items[0].rail === "dough_ledger" && receiptB.zcash.settlements.every((s) => s.state === "FAILED"), "a participant settled on the Dough ledger is labelled dough_ledger, and the failed ZEC attempts show FAILED");
  const lifeJson = JSON.stringify((await api(`/api/peeps/requests/${A.request.id}/lifecycle`, { cookie })).data);
  assert(!lifeJson.includes(ADDRESS) && !lifeJson.includes(TXID_A), "the lifecycle view leaks nothing either");
  assert((await api(`/api/peeps/requests/${A.request.id}/receipt`, { cookie: outsider.cookie })).status === 404, "another organization can't read the receipt");
  const unauth = await fetch(`${srv.base}/api/peeps/requests/${A.request.id}/zec-settlements`);
  assert(unauth.status === 401 || unauth.status === 403, "the settlement list requires a session");
  assert(sql("SELECT COUNT(*) FROM dough_entries WHERE kind='jam_earning'")[0][0] === 1, "across everything exactly ONE Dough settlement happened (B's), and none for A");

  console.log("\nAll Peeps confidential settlement tests passed.");
}

main().then(() => { servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(0); })
  .catch((e) => { console.error(e.message || e); console.error("--- server ---\n" + out.slice(-2500)); servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(1); });
