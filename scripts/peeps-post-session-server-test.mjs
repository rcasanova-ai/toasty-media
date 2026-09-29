#!/usr/bin/env node
// HTTP-level integration test for the Peeps POST-SESSION slice (Jam completion -> Breadcrumbs -> Dub -> outcome ->
// Dough settlement -> matching). Built on the same harness as peeps-introduction-execution-server-test.mjs.
// (Original header follows.) HTTP-level integration test for the Peeps INTRODUCTION EXECUTION slice: authorized introduction ->
// contact resolution -> outreach (adapter) -> unauthenticated response page -> interested -> availability
// -> deterministic scheduling -> idempotent booking -> Jam + Studio link -> Session Planner auto-population
// -> prep -> organizer edits -> notifications -> READY FOR SESSION, plus cancel/reschedule/replacement and
// the security + failure cases from the brief. Same harness as peeps-agent-lifecycle-server-test.mjs: the
// real server against a throwaway SQLite DB, driven with fetch. PEEPS_TEST_ADAPTERS=1 with no
// RESEND_API_KEY selects the clearly-labelled TEST/DEMO outreach provider (status "simulated").
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4219;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-peeps-post-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function cookieFrom(response) {
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

async function api(path, { method = "GET", cookie, body, headers = {}, raw = false } = {}) {
  const requestHeaders = { "x-toasty-csrf": "1", ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers: requestHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return { status: response.status, text: await response.text(), type: response.headers.get("content-type") || "" };
  let data = {};
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data, cookie: cookieFrom(response) || cookie };
}

function db(action, values = {}) {
  const result = spawnSync("python3", [helper], { input: JSON.stringify({ action, dbPath, ...values }), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`db helper failed: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function sql(statement, params = []) {
  const script = `import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\nc.execute(sys.argv[2], json.loads(sys.argv[3]))\nc.commit()`;
  const result = spawnSync("python3", ["-c", script, dbPath, statement, JSON.stringify(params)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sql failed: ${result.stderr}`);
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "peeps-post-test-secret", RESEND_API_KEY: "", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "", PEEPS_TEST_ADAPTERS: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

// ---- time helpers (independent of the server's implementation) ----
function zoned(ms, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const iso = (ms) => new Date(ms).toISOString();
function dayUtc(daysFromNow, hour, minute = 0) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
}
const HOUR = 3600000;

async function payAndAuthorize(requestId, cookie, candidates, extra = {}) {
  const demoPay = await api("/api/peeps/demo-payments/authorize", { method: "POST", cookie, body: { requestId } });
  return api(`/api/peeps/requests/${requestId}/authorize`, {
    method: "POST", cookie,
    headers: { "x-payment-signature": demoPay.data.paymentSignature, "x-solana-transaction-signature": demoPay.data.transactionSignature, "x-payment-asset": "USDC", "x-payment-amount": "0.25", "x-payer-wallet": demoPay.data.payerWallet, "x-approval-source": demoPay.data.approvalSource },
    body: { candidates, ...extra }
  });
}

async function outbox(requestId, cookie) {
  return (await api(`/api/peeps/test-outbox?requestId=${requestId}`, { cookie })).data.messages || [];
}

function tokenFromOutreach(messages, introId, purposes = ["outreach", "opening", "reminder"]) {
  const message = [...messages].reverse().find((m) => m.introductionId === introId && purposes.includes(m.purpose) && m.audience === "candidate" && m.status === "simulated");
  const url = message?.testPayload?.url || "";
  return { token: url.split("token=")[1] || "", message };
}


const GUEST_EMAIL = "anong.guest@example.com";

function fund(userId, amount, ref) {
  db("dough_post", { id: `dle_test_${ref}`, subjectType: "user", subjectId: userId, bucket: "spend", direction: "credit", amount, kind: "funding", referenceId: ref });
}
function balance(subjectType, subjectId) {
  return db("dough_get", { subjectType, subjectId }).account || { spendBalance: 0, earnedBalance: 0 };
}
function count(table, where = "1=1", params = []) {
  const script = `import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\nprint(c.execute("SELECT COUNT(*) FROM "+sys.argv[2]+" WHERE "+sys.argv[3], json.loads(sys.argv[4])).fetchone()[0])`;
  return Number(spawnSync("python3", ["-c", script, dbPath, table, where, JSON.stringify(params)], { encoding: "utf8" }).stdout.trim());
}

// Runs a request through to a booked, attended session and returns everything a later step needs.
async function bookedSession({ cookie, userId, who, outcome, guestEmail, compensation, dayOffset, label }) {
  const created = await api("/api/peeps/requests", { method: "POST", cookie, body: { whoText: who, outcomeText: outcome } });
  const request = created.data.request;
  const candidate = created.data.candidates.find((c) => c.source === "demo_directory_provider") || created.data.candidates[0];
  const auth = await api(`/api/peeps/requests/${request.id}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: candidate.id, outreachEmail: guestEmail }], compensationAmount: compensation } });
  if (auth.status !== 200) throw new Error(`authorize failed for ${label}: ${auth.status} ${JSON.stringify(auth.data)}`);
  const intro = auth.data.introductions[0];
  const { token } = tokenFromOutreach(await outbox(request.id, cookie), intro.id);
  await api(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} });
  await api(`/api/peeps/respond/${token}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(dayOffset, 2), "Asia/Bangkok"), end: zoned(dayUtc(dayOffset, 5), "Asia/Bangkok") }] } });
  await api(`/api/peeps/requests/${request.id}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(dayOffset - 1, 20), "America/New_York"), end: zoned(dayUtc(dayOffset, 8), "America/New_York") }] } });
  const booked = await api(`/api/peeps/introductions/${intro.id}/book`, { method: "POST", cookie, body: {} });
  if (booked.status !== 201) throw new Error(`book failed for ${label}: ${booked.status} ${JSON.stringify(booked.data)}`);
  const consent = await api(`/api/peeps/respond/${token}/consent`, { method: "POST", body: { acceptances: ["terms_of_service", "recording"] } });
  const join = await api(`/api/peeps/respond/${token}/join`, { method: "POST", body: {} });
  const inviteToken = join.data.joinUrl.split("token=")[1];
  return { request, candidate, intro, token, inviteToken, booking: booked.data.booking, jamId: booked.data.booking.jamId, sessionId: booked.data.booking.studioSessionId, consentOk: consent.data.consentSatisfied, userId, guestName: candidate.displayName };
}

async function attend(s) {
  const r = await api(`/api/jams/${s.jamId}/events`, { method: "POST", body: { invite: s.inviteToken, type: "participant.joined" } });
  return r.status === 201;
}

async function main() {
  await waitForHealth();

  console.log("Setup — a funded requester and a booked session through the shipped introduction flow");
  const organizer = await api("/auth/register", { method: "POST", body: { name: "Priya Organizer", email: "priya-post@example.com", password: "password10chars" } });
  const cookie = organizer.cookie;
  const orgUserId = organizer.data.user.id;
  fund(orgUserId, 100, "seed-100");
  const S = await bookedSession({ cookie, userId: orgUserId, who: "Fintech/payment executives in Southeast Asia who understand offline payments.", outcome: "I want 1 person for a recorded podcast about offline payments and digital wallets.", guestEmail: GUEST_EMAIL, compensation: 25, dayOffset: 9, label: "R1" });
  assert(S.consentOk && S.booking.studioSessionId, "a booked, consented session exists (PR #103 flow preserved)");
  assert(S.request.workingRepresentation.desiredCandidateCount === 1, "the request wants exactly one guest");

  console.log("\nPhase 1 — nothing is fabricated before anything happened");
  const early = await api(`/api/peeps/requests/${S.request.id}/lifecycle`, { cookie });
  assert(early.status === 200 && early.data.completion === null && early.data.state === "booked" && early.data.stages.find((x) => x.key === "completed").status === "pending", "before the session the lifecycle is Booked with no completion");
  const reconcileEarly = await api(`/api/peeps/requests/${S.request.id}/reconcile`, { method: "POST", cookie, body: {} });
  assert(reconcileEarly.data.completion === null && count("peeps_completions") === 0, "reconciling before the Jam ran does NOT fabricate a completion");
  const emptyT = await api(`/api/jams/${S.jamId}/transcript`, { method: "POST", cookie, body: { segments: [] } });
  assert(emptyT.status === 400, "an empty transcript is refused");

  const TRANSCRIPT = [
    { speaker: "Priya Organizer", text: "Welcome to the show. Tell me about your work in offline payments." },
    { speaker: S.guestName, text: "I have spent twelve years building offline payment systems for merchants across Southeast Asia. I led our QR rollout in Indonesia. We reduced failed transactions by 40 percent after launch. I am certified as a payments professional and I will send you the merchant research report after the show." },
    { speaker: "Unknown Caller", text: "I have worked for twenty years in offline payments and I am certified in everything imaginable." },
    { speaker: S.guestName, text: "Offline payments and digital wallets across Southeast Asia work best when merchants can settle without connectivity, and interoperability between wallet operators matters for the future of digital payments." }
  ];
  const tEarly = await api(`/api/jams/${S.jamId}/transcript`, { method: "POST", cookie, body: { segments: TRANSCRIPT } });
  assert(tEarly.status === 201 && tEarly.data.transcript.source === "organizer_upload" && tEarly.data.completionRecorded === false && tEarly.data.breadcrumbsProposed === 0, "a transcript can be attached early, is recorded as an organizer upload, and does not fake a completion or attendance");
  const tAgain = await api(`/api/jams/${S.jamId}/transcript`, { method: "POST", cookie, body: { segments: TRANSCRIPT } });
  assert(tAgain.status === 200 && tAgain.data.transcript.created === false && count("peeps_transcripts") === 1, "re-submitting the same transcript is idempotent");

  console.log("\nPhase 2 — the Jam actually runs: attendance comes only from participant events");
  assert(await attend(S), "the guest joins through the existing room event flow");
  const complete = await api(`/api/jams/${S.jamId}/complete`, { method: "POST", cookie, body: {} });
  assert(complete.status === 200 && complete.data.jam.status === "completed", "the Jam is completed");
  const life = await api(`/api/peeps/requests/${S.request.id}/lifecycle`, { cookie });
  assert(life.data.completion && life.data.completion.participants[0].status === "attended" && life.data.completion.participants[0].consentCaptured === true && life.data.completion.transcriptPresent === true && life.data.completion.trigger, "completion is persisted with real attendance, consent, transcript presence and trigger");
  assert(life.data.completion.artifacts.some((a) => a.type === "transcript" && a.status === "ready") && !life.data.completion.artifacts.some((a) => a.type === "recording"), "only artifacts that exist are listed — no recording is invented");
  assert(life.data.jamId === S.jamId && life.data.studioSessionId === S.sessionId, "request -> Jam -> Studio session linkage is intact");

  console.log("\nPhase 3 — Breadcrumb candidates: evidence-backed, classed, traceable");
  const bcs = life.data.breadcrumbs;
  const kinds = new Set(bcs.map((b) => b.kind));
  for (const k of ["experience_stated", "outcome_achieved", "credential_discussed", "commitment_made", "expertise_demonstrated"]) assert(kinds.has(k), `a ${k} Breadcrumb was proposed from what was actually said`);
  assert(bcs.every((b) => b.status === "proposed"), "transcript-derived Breadcrumbs start as proposals, never as accepted evidence");
  assert(bcs.filter((b) => b.kind !== "expertise_demonstrated").every((b) => b.evidenceClass === "participant_claim") && bcs.find((b) => b.kind === "expertise_demonstrated").evidenceClass === "observed", "claims stay participant_claim; substantive topic discussion is observed — never silently 'verified' or 'ai'");
  assert(bcs.every((b) => b.evidenceClass !== "ai_suggested" && b.evidenceClass !== "verified"), "nothing is AI-suggested or verified without a human");
  const exp = bcs.find((b) => b.kind === "experience_stated" && /twelve years/.test(b.provenance.quote));
  assert(exp && exp.provenance.jamId === S.jamId && exp.provenance.transcriptId && exp.provenance.segmentIndex === 1 && exp.provenance.speaker === S.guestName && exp.provenance.method.startsWith("rule:"), "each Breadcrumb traces to the Jam, transcript, segment, speaker and method that produced it");
  assert(!bcs.some((b) => /twenty years/.test(JSON.stringify(b))), "words from an unattributed speaker are never assigned to anyone");
  assert(!bcs.some((b) => /Tell me about your work/.test(JSON.stringify(b))), "the host's words are never attributed to the guest");
  assert(life.data.verifiedFacts === 1, "attendance is recorded as one system-verified fact");
  const publicEntries = () => db("dub_entry_list", { dubIds: [S.booking.candidateDubId] }).entries.filter((e) => e.visibility === "public");
  assert(publicEntries().length === 0, "the Dub is NOT rewritten by the analysis: nothing public exists until the person approves");

  console.log("\nPhase 4 — duplicate completion callbacks and retries change nothing");
  const before = count("peeps_breadcrumbs");
  await api(`/api/jams/${S.jamId}/complete`, { method: "POST", cookie, body: {} });
  await api(`/api/sessions/${S.sessionId}/end`, { method: "POST", cookie, body: {} });
  await api(`/api/sessions/${S.sessionId}/end`, { method: "POST", cookie, body: {} });
  await Promise.all([1, 2, 3].map(() => api(`/api/peeps/requests/${S.request.id}/reconcile`, { method: "POST", cookie, body: {} })));
  assert(count("peeps_completions") === 1 && count("peeps_breadcrumbs") === before, "duplicate/concurrent completion triggers leave exactly one completion and no duplicate Breadcrumbs");
  const notifs = (await outbox(S.request.id, cookie)).filter((m) => m.purpose === "breadcrumbs_ready" && m.introductionId === S.intro.id);
  assert(notifs.length === 1, "the participant is told exactly once that Breadcrumbs are ready to review");

  console.log("\nPhase 5 — outcome: a meeting is not an outcome");
  const pending = (await api(`/api/peeps/requests/${S.request.id}/lifecycle`, { cookie })).data;
  assert(pending.state === "outcome_pending" && pending.outcome.state === "outcome_pending", "the request is outcome_pending: the session happened but the required recording doesn't exist");
  const rec = pending.outcome.criteria.find((c) => c.key === "recording_present");
  assert(rec.required && !rec.met && pending.outcome.criteria.find((c) => c.key === "participants_attended").met, "the criteria list says exactly what's met and what's missing");
  const addRec = await api(`/api/jams/${S.jamId}/artifacts`, { method: "POST", cookie, body: { artifactType: "recording", storageReference: "s3://peeps-test/session.mp4", status: "ready" } });
  assert(addRec.status === 201, "the organizer attaches a real recording reference");
  const verified = (await api(`/api/peeps/requests/${S.request.id}/reconcile`, { method: "POST", cookie, body: {} })).data;
  assert(verified.outcome.state === "outcome_verified" && verified.outcome.basis === "deterministic_evidence" && verified.state === "payment_pending", "with the evidence present the outcome verifies deterministically, and the request moves to payment_pending because compensation is owed");

  console.log("\nPhase 6 — Dough settlement: debit + credit atomically, honest when unfunded, idempotent");
  const payerBefore = balance("user", orgUserId).spendBalance;
  const outsider = await api("/auth/register", { method: "POST", body: { name: "Eve Outsider", email: "eve-post@example.com", password: "password10chars" } });
  assert((await api(`/api/peeps/requests/${S.request.id}/settle`, { method: "POST", cookie: outsider.cookie, body: {} })).status === 404, "an outsider cannot settle someone else's request");
  assert((await api(`/api/peeps/requests/${S.request.id}/settle`, { method: "POST", body: {}, headers: { "x-toasty-csrf": "1" } })).status === 401, "an unauthenticated caller cannot settle");
  assert((await api(`/api/jams/${S.jamId}/settle`, { method: "POST", cookie: outsider.cookie, body: {} })).status === 404, "the legacy settle route is equally protected");
  const [s1, s2] = await Promise.all([1, 2].map(() => api(`/api/peeps/requests/${S.request.id}/settle`, { method: "POST", cookie, body: {} })));
  const statuses = [s1, s2].map((r) => r.data.settlements[0].status).sort();
  assert(statuses.includes("settled_to_dough") && (statuses[0] === "already_paid" || statuses[1] === "already_paid" || statuses.filter((x) => x === "settled_to_dough").length === 1), "two concurrent settle calls pay exactly once");
  const payerAfter = balance("user", orgUserId).spendBalance;
  const guestDub = balance("dub", S.booking.candidateDubId).earnedBalance;
  assert(Math.abs(payerBefore - payerAfter - 25) < 0.001 && guestDub === 25, "the requester's Dough fell by exactly $25 and the guest's rose by exactly $25 — money moved, it was not minted");
  const again = await api(`/api/peeps/requests/${S.request.id}/settle`, { method: "POST", cookie, body: {} });
  assert(again.data.settlements[0].status === "already_paid" && Math.abs(balance("user", orgUserId).spendBalance - payerAfter) < 0.001 && count("dough_entries", "kind = 'jam_earning'") === 1, "retrying never moves money twice");
  const paid = (await api(`/api/peeps/requests/${S.request.id}/lifecycle`, { cookie })).data;
  assert(paid.state === "paid" && paid.settlement.status === "paid" && paid.stages.every((x) => x.status === "done"), "only after the ledger confirms does the lifecycle reach paid (Booked → Session → Completed → Outcome → Settlement all done)");
  assert(count("payments", "purpose = 'jam-participant-settlement'") === 1, "one payment record exists for the settlement");
  const lifeJson = JSON.stringify(paid);
  assert(!/solana|wallet|x402|usdc|signature/i.test(lifeJson), "no crypto implementation detail appears in the requester lifecycle");

  console.log("\nPhase 7 — unfunded requester: truthful pending state with exactly what remains");
  const poor = await api("/auth/register", { method: "POST", body: { name: "Poor Requester", email: "poor-post@example.com", password: "password10chars" } });
  fund(poor.data.user.id, 0.25, "seed-poor");
  const P = await bookedSession({ cookie: poor.cookie, userId: poor.data.user.id, who: "Fintech payments executives in Southeast Asia offline payments", outcome: "I want 1 person for a recorded podcast about offline payments.", guestEmail: "poor.guest@example.com", compensation: 10, dayOffset: 11, label: "R2" });
  assert(await attend(P), "the second session's guest attends");
  await api(`/api/jams/${P.jamId}/artifacts`, { method: "POST", cookie: poor.cookie, body: { artifactType: "recording", storageReference: "s3://peeps-test/p.mp4", status: "ready" } });
  await api(`/api/jams/${P.jamId}/complete`, { method: "POST", cookie: poor.cookie, body: {} });
  const poorSettle = await api(`/api/peeps/requests/${P.request.id}/settle`, { method: "POST", cookie: poor.cookie, body: {} });
  const ps = poorSettle.data.settlements[0];
  assert(ps.status === "payment_pending" && ps.shortfall === 10 && ps.reason === "requester_funding_required" && balance("dub", P.booking.candidateDubId).earnedBalance === 0, "an unfunded settlement stays payment_pending, states the exact shortfall, and credits the guest NOTHING");
  assert(poorSettle.data.lifecycle.state === "payment_pending" && poorSettle.data.lifecycle.settlement.remaining.reason === "requester_funding_required", "the lifecycle exposes exactly what remains required");
  const pView = await api(`/api/peeps/respond/${P.token}`);
  assert(pView.data.postSession.compensation.status === "pending" && !/dough ledger|solana|wallet/i.test(JSON.stringify(pView.data.postSession.compensation)), "the guest sees plain 'pending' compensation, not crypto details");
  fund(poor.data.user.id, 10, "seed-poor-2");
  const funded = await api(`/api/peeps/requests/${P.request.id}/settle`, { method: "POST", cookie: poor.cookie, body: {} });
  assert(funded.data.settlements[0].status === "settled_to_dough" && balance("dub", P.booking.candidateDubId).earnedBalance === 10 && funded.data.lifecycle.state === "paid", "once funded the same settlement completes, exactly once");

  console.log("\nPhase 8 — participant reviews Breadcrumbs; only approved evidence reaches the Dub");
  const view = await api(`/api/peeps/respond/${S.token}`);
  const post = view.data.postSession;
  assert(view.data.state === "completed" && post.stages.find((x) => x.key === "proposed").done && !post.stages.find((x) => x.key === "dub").done && post.compensation.status === "paid" && /held on your Dub/.test(post.compensation.message), "the participant sees: Jam completed → Breadcrumbs proposed → (not yet) Dub improved → compensation held on their Dub");
  const own = post.breadcrumbs;
  assert(own.length >= 5 && own.every((b) => b.provenance.jamId === S.jamId), "they see their own proposed Breadcrumbs with provenance");
  assert(!JSON.stringify(view.data).includes("Welcome to the show") && !JSON.stringify(view.data).includes("twenty years"), "they never see the rest of the transcript");
  const pick = (kind) => own.find((b) => b.kind === kind);
  const acceptExp = await api(`/api/peeps/respond/${S.token}/breadcrumbs/${pick("experience_stated").id}/review`, { method: "POST", body: { action: "accept" } });
  assert(acceptExp.status === 200 && acceptExp.data.breadcrumb.status === "accepted" && acceptExp.data.breadcrumb.evidenceClass === "participant_claim", "accepting keeps the claim a participant_claim (the person confirmed it, nobody verified it)");
  assert((await api(`/api/peeps/respond/${S.token}/breadcrumbs/${pick("experience_stated").id}/review`, { method: "POST", body: { action: "accept" } })).status === 200 && publicEntries().length === 1, "accepting twice is idempotent — one Dub entry");
  const corrected = await api(`/api/peeps/respond/${S.token}/breadcrumbs/${pick("outcome_achieved").id}/review`, { method: "POST", body: { action: "correct", statement: "Reduced failed offline transactions by roughly 40 percent after our QR launch." } });
  assert(corrected.data.breadcrumb.status === "corrected" && /roughly 40 percent/.test(corrected.data.breadcrumb.statement) && corrected.data.breadcrumb.originalStatement, "a correction is stored as the person's own statement, original preserved");
  const rejected = await api(`/api/peeps/respond/${S.token}/breadcrumbs/${pick("commitment_made").id}/review`, { method: "POST", body: { action: "reject" } });
  assert(rejected.data.breadcrumb.status === "rejected" && !publicEntries().some((e) => e.kind === "commitment_made"), "a rejected Breadcrumb never reaches the Dub");
  const acceptExpertise = await api(`/api/peeps/respond/${S.token}/breadcrumbs/${pick("expertise_demonstrated").id}/review`, { method: "POST", body: { action: "accept" } });
  assert(acceptExpertise.data.breadcrumb.evidenceClass === "observed", "an accepted observation stays 'observed'");
  assert(publicEntries().length === 3 && publicEntries().every((e) => ["accepted", "corrected", "verified"].length), "exactly the three approved entries are on the Dub");
  await api(`/api/jams/${S.jamId}/complete`, { method: "POST", cookie, body: {} });
  assert(((await api(`/api/peeps/respond/${S.token}`)).data.postSession.breadcrumbs.find((b) => b.id === pick("commitment_made").id).status === "rejected"), "a rejected Breadcrumb isn't resurrected by a later completion callback");

  console.log("\nPhase 9 — corroboration is the only path to 'verified'");
  const corroboratedProposed = await api(`/api/peeps/breadcrumbs/${pick("credential_discussed").id}/corroborate`, { method: "POST", cookie, body: {} });
  assert(corroboratedProposed.data.breadcrumb.status === "proposed" && corroboratedProposed.data.breadcrumb.corroborated === true && corroboratedProposed.data.breadcrumb.evidenceClass === "participant_claim", "the requester can't verify something the participant hasn't confirmed");
  const verifyExp = await api(`/api/peeps/breadcrumbs/${pick("experience_stated").id}/corroborate`, { method: "POST", cookie, body: {} });
  assert(verifyExp.data.breadcrumb.status === "verified" && verifyExp.data.breadcrumb.evidenceClass === "verified", "participant-confirmed + requester-corroborated becomes verified");
  assert((await api(`/api/peeps/breadcrumbs/${pick("commitment_made").id}/corroborate`, { method: "POST", cookie, body: {} })).status === 409, "a rejected Breadcrumb can't be corroborated");
  assert((await api(`/api/peeps/breadcrumbs/${pick("experience_stated").id}/corroborate`, { method: "POST", cookie: outsider.cookie, body: {} })).status === 404, "an outsider can't corroborate");
  const lateAccept = await api(`/api/peeps/respond/${S.token}/breadcrumbs/${pick("credential_discussed").id}/review`, { method: "POST", body: { action: "accept" } });
  assert(lateAccept.data.breadcrumb.status === "verified", "accepting something the requester already corroborated makes it verified");

  console.log("\nSecurity — privacy, ownership, isolation, malformed input");
  const otherToken = P.token;
  assert((await api(`/api/peeps/respond/${otherToken}/breadcrumbs/${pick("experience_stated").id}/review`, { method: "POST", body: { action: "reject" } })).status === 404, "another guest's token can't review this guest's Breadcrumbs");
  assert((await api(`/api/peeps/respond/${S.token}/breadcrumbs/${(await api(`/api/peeps/requests/${P.request.id}/lifecycle`, { cookie: poor.cookie })).data.breadcrumbs[0]?.id || "bc_none"}/review`, { method: "POST", body: { action: "reject" } })).status === 404, "and can't touch another Jam's Breadcrumbs (no cross-Jam leakage)");
  assert((await api(`/api/jams/${S.jamId}/transcript`, { cookie: outsider.cookie })).status === 404 && (await api(`/api/jams/${S.jamId}/transcript`, { method: "POST", cookie: outsider.cookie, body: { segments: TRANSCRIPT } })).status === 404, "the transcript can't be read or written by another organization");
  assert((await api(`/api/jams/${S.jamId}/transcript`, { headers: { "x-toasty-csrf": "" } })).status === 401, "or without a session");
  const orgTranscript = await api(`/api/jams/${S.jamId}/transcript`, { cookie });
  assert(orgTranscript.status === 200 && orgTranscript.data.transcripts[0].segments.length === 4, "members of the owning organization can read it");
  assert((await api(`/api/peeps/requests/${S.request.id}/lifecycle`, { cookie: outsider.cookie })).status === 404, "another organization can't see the request lifecycle");
  const pLife = JSON.stringify((await api(`/api/peeps/requests/${P.request.id}/lifecycle`, { cookie: poor.cookie })).data);
  assert(!pLife.includes("twelve years") && !pLife.includes(S.guestName === P.guestName ? "unreachable-name" : S.guestName + "'s"), "one Jam's lifecycle never contains another Jam's transcript content");
  for (const bad of ["..%2f..%2fetc", "bc%20bad", "%00", "a".repeat(200)]) {
    const r = await api(`/api/peeps/breadcrumbs/${bad}/corroborate`, { method: "POST", cookie, body: {} });
    assert([400, 404].includes(r.status), `malformed Breadcrumb id "${decodeURIComponent(bad).slice(0, 12)}" is refused (${r.status})`);
  }
  assert((await api(`/api/peeps/respond/${"x".repeat(43)}/breadcrumbs/bc_1/review`, { method: "POST", body: { action: "accept" } })).status === 404 && (await api("/api/peeps/respond/short/breadcrumbs/x/review", { method: "POST", body: {} })).status === 404, "malformed or unknown tokens are 404");
  const sysFact = (await db("peeps_breadcrumb_list", { jamId: S.jamId })).breadcrumbs.find((b) => b.kind === "participation");
  assert((await api(`/api/peeps/respond/${S.token}/breadcrumbs/${sysFact.id}/review`, { method: "POST", body: { action: "reject" } })).status === 409, "a system-recorded attendance fact can't be 'reviewed' away");
  const noStudioJam = await api("/api/jams", { method: "POST", cookie, body: { title: "No studio" } });
  assert((await api(`/api/jams/${noStudioJam.data.jam.id}/transcript`, { method: "POST", cookie, body: { segments: TRANSCRIPT } })).status === 409, "a transcript can't be attached to a Jam that never had a Studio session");

  console.log("\nDub claim and ownership");
  const claimIssue = await api(`/api/dubs/${S.booking.candidateDubId}/claim-invite`, { method: "POST", cookie, body: {} });
  const member = await api("/auth/register", { method: "POST", body: { name: "Anong Member", email: "anong-member-post@example.com", password: "password10chars" } });
  const claim = await api(`/api/dub-claims/${claimIssue.data.token}/claim`, { method: "POST", cookie: member.cookie });
  assert(claim.status === 200 && claim.data.doughTransferred === 25, "claiming transfers the $25 the Dub really earned");
  const myDub = await api("/api/peeps/my-dub", { cookie: member.cookie });
  assert(myDub.status === 200 && myDub.data.entries.filter((e) => e.visibility === "public").length === 4 && myDub.data.reviewed.some((b) => b.status === "verified"), "the claimed owner sees their Dub entries and review history");
  assert((await api("/api/peeps/my-dub", { cookie: outsider.cookie })).data.entries.length === 0, "another user's my-dub is empty — no cross-user leakage");
  assert((await api(`/api/peeps/my-dub/breadcrumbs/${pick("outcome_achieved").id}/review`, { method: "POST", cookie: outsider.cookie, body: { action: "reject" } })).status === 404, "a non-owner can't review someone else's Dub evidence");
  const ownerReject = await api(`/api/peeps/my-dub/breadcrumbs/${pick("outcome_achieved").id}/review`, { method: "POST", cookie: member.cookie, body: { action: "accept" } });
  assert(ownerReject.status === 200, "the claimed owner can review their own Breadcrumbs through their account");

  console.log("\nMatching — verified evidence becomes a bounded, safe signal for later requests");
  const later = await api("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Payments people who understand offline payments in Southeast Asia", outcomeText: "I want 3 guests for a recorded podcast about offline payments." } });
  const claimedCand = later.data.candidates.find((c) => c.dubId === S.booking.candidateDubId);
  assert(claimedCand && claimedCand.source === "internal_claimed_dub", "the earlier guest surfaces for a later request from the same organization");
  const evClaim = claimedCand.evidence.find((e) => e.sourceType === "peeps_breadcrumbs");
  assert(evClaim && /participant-approved Breadcrumb/.test(evClaim.claim) && evClaim.confidence === "High", "their approved + verified Breadcrumbs appear as evidence (‘has demonstrated X in previous verified interactions’)");
  const bonus = claimedCand.matchScore - 35;
  assert(bonus > 0 && bonus <= 12, `the evidence bonus is positive but capped (${bonus} ≤ 12) so one Jam can't overwhelm ranking`);
  assert(later.data.candidates.some((c) => c.source === "demo_directory_provider" && c.matchScore >= 33), "the existing ranking signals are still present alongside it");
  const laterJson = JSON.stringify(later.data);
  for (const leak of ["twelve years", "merchant research report", "40 percent", "Welcome to the show", "peeps-test/session.mp4", "certified as a payments"]) assert(!laterJson.includes(leak), `matching output never contains private session content ("${leak}")`);
  const outsiderReq = await api("/api/peeps/requests", { method: "POST", cookie: outsider.cookie, body: { whoText: "Payments people who understand offline payments in Southeast Asia", outcomeText: "I want 3 guests for a recorded podcast about offline payments." } });
  const network = outsiderReq.data.candidates.find((c) => c.dubId === S.booking.candidateDubId);
  assert(network && network.source === "peeps_network_dub" && network.evidence[0].sourceType === "peeps_breadcrumbs" && network.reachability === "claimed_member", "a DIFFERENT organization can discover them — but only because they own their Dub and approved public entries");
  assert(!JSON.stringify(outsiderReq.data).includes("twelve years") && !JSON.stringify(outsiderReq.data).includes("Priya"), "and sees nothing of the private session or the original requester");
  const unrelated = await api("/api/peeps/requests", { method: "POST", cookie: outsider.cookie, body: { whoText: "Cybersecurity incident response leads", outcomeText: "I want 1 research interview about ransomware." } });
  assert(!unrelated.data.candidates.some((c) => c.source === "peeps_network_dub"), "an unrelated request doesn't surface them");
  assert((await api(`/api/peeps/requests/${S.request.id}/lifecycle`, { cookie })).data.state === "paid", "the original request stayed paid through everything above (lifecycle is monotonic)");

  console.log("\nAll Peeps post-session tests passed.");
}

main()
  .then(() => { server.kill(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    console.error("\n--- server output ---\n" + serverOutput.slice(-4000));
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
