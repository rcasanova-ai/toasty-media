#!/usr/bin/env node
// HTTP-level integration test for Human Presence Verification: spawns the real server against a throwaway
// SQLite DB. Covers the flag gate, host controls, consent, challenge issue, expiry, replay protection,
// session and participant binding, signed receipts, "never verified" honesty, audit history, revocation
// and the Peeps Jam/Dub/Breadcrumb integration.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const scratch = mkdtempSync(join(tmpdir(), "toasty-hp-"));
let failures = 0;
function assert(condition, message) {
  if (!condition) { failures += 1; console.error(`  FAILED: ${message}`); throw new Error(`FAILED: ${message}`); }
  console.log(`  ok - ${message}`);
}

function start(port, env) {
  const dbPath = join(scratch, `db-${port}.sqlite`);
  const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: { ...process.env, TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", TOASTY_RENDER_PORT: String(port), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "hp-test-session-secret-0123456789", RESEND_API_KEY: "", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  return { child, dbPath, base: `http://127.0.0.1:${port}`, output: () => out };
}

function client(base) {
  return async function call(path, { method = "GET", cookie, body, csrf = true } = {}) {
    const headers = {};
    if (csrf) headers["x-toasty-csrf"] = "1";
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
  };
}

async function waitForHealth(base) {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never came up");
}

function evidenceFor(challenge, overrides = {}) {
  let t = 0;
  return {
    nonce: challenge.nonce,
    steps: challenge.steps.map((s) => { const start = t; t += 1500; return { stepId: s.stepId, type: s.type, startOffsetMs: start, endOffsetMs: t, signals: { motion: 0.5, completed: true } }; }),
    client: { video: true, audio: true },
    ...overrides
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ disabled by default
async function testDisabled() {
  console.log("Feature flag off (default)");
  const s = start(4331, {});
  try {
    await waitForHealth(s.base);
    const call = client(s.base);
    const cfg = await call("/api/human-presence/config");
    assert(cfg.status === 200 && cfg.data.enabled === false, "config reports disabled");
    const pending = await call("/api/human-presence/pending", { method: "POST", body: { roomId: "x", participantId: "y" } });
    assert(pending.status === 404, "participant routes are inert (404) while disabled");
    const host = await call("/api/sessions/abc/human-presence");
    assert(host.status === 404, "host routes are inert (404) while disabled");
  } finally { s.child.kill(); }
}

// ------------------------------------------------------------------ enabled
async function testEnabled() {
  console.log("\nStudio flow, flag on, no liveness provider");
  const s = start(4332, { HUMAN_PRESENCE_ENABLED: "1", HUMAN_PRESENCE_PEEPS_ENABLED: "1" });
  try {
    await waitForHealth(s.base);
    const call = client(s.base);
    const cfg = await call("/api/human-presence/config");
    assert(cfg.data.enabled === true && cfg.data.livenessAnalysis.active === false, "config reports enabled with no active liveness analysis");

    const host = await call("/auth/register", { method: "POST", body: { name: "Hana Host", email: "hana@example.com", password: "password10chars" } });
    const other = await call("/auth/register", { method: "POST", body: { name: "Omar Other", email: "omar@example.com", password: "password10chars" } });
    const roomId = "hproom1";
    const created = await call("/api/sessions", { method: "POST", cookie: host.cookie, body: { roomId, title: "Presence test" } });
    assert(created.status === 200, "host creates a session");
    const sessionId = created.data.session.id;
    await call("/api/presence/announce", { method: "POST", body: { roomId, participantId: "host", role: "host", displayName: "Hana" } });
    const guestAnnounce = () => call("/api/presence/announce", { method: "POST", body: { roomId, participantId: "guest-a", role: "guest", displayName: "Gus Guest" } });
    await guestAnnounce();
    await call("/api/presence/announce", { method: "POST", body: { roomId, participantId: "guest-b", role: "guest", displayName: "Bea Guest" } });
    const guestA = { roomId, participantId: "guest-a" };

    console.log("\nHost controls");
    const noAuth = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", body: { participantId: "guest-a" } });
    assert(noAuth.status === 401, "requesting verification requires a signed in host");
    const noCsrf = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", cookie: host.cookie, csrf: false, body: { participantId: "guest-a" } });
    assert(noCsrf.status === 403, "requests need the CSRF header");
    const foreign = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", cookie: other.cookie, body: { participantId: "guest-a" } });
    assert(foreign.status === 404, "another account cannot request verification in a session it does not own");
    const missing = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", cookie: host.cookie, body: { participantId: "ghost" } });
    assert(missing.status === 404, "cannot target someone who is not in the room");
    const reqA = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", cookie: host.cookie, body: { participantId: "guest-a", timing: "during", reason: "Quick check" } });
    assert(reqA.status === 201 && reqA.data.request.status === "pending", "host requests a check mid session");
    const requestId = reqA.data.request.requestId;
    const dup = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", cookie: host.cookie, body: { participantId: "guest-a" } });
    assert(dup.status === 409, "a second open request for the same guest is refused");

    console.log("\nParticipant flow: consent gate");
    const pending = await call("/api/human-presence/pending", { method: "POST", body: guestA });
    assert(pending.data.request?.requestId === requestId && pending.data.consent.points.length >= 4, "the guest sees the pending request and the consent text");
    assert(/does not (record|store)/i.test(pending.data.consent.points[1]), "consent states that media is not stored");
    const early = await call("/api/human-presence/challenge", { method: "POST", body: { ...guestA, requestId } });
    assert(early.status === 409, "no challenge is issued before consent");
    const wrongPerson = await call("/api/human-presence/consent", { method: "POST", body: { roomId, participantId: "guest-b", requestId, accepted: true } });
    assert(wrongPerson.status === 404, "another guest cannot consent on someone else's request");
    const noGuestPending = await call("/api/human-presence/pending", { method: "POST", body: { roomId, participantId: "guest-b" } });
    assert(noGuestPending.data.request === null, "other guests see nothing pending");
    const strangerPending = await call("/api/human-presence/pending", { method: "POST", body: { roomId, participantId: "never-joined" } });
    assert(strangerPending.status === 404, "someone who is not in the room cannot use the endpoints");

    const consent = await call("/api/human-presence/consent", { method: "POST", body: { ...guestA, requestId, accepted: true } });
    assert(consent.status === 200 && consent.data.status === "consented", "guest consents");

    console.log("\nChallenge issue");
    const ch1 = await call("/api/human-presence/challenge", { method: "POST", body: { ...guestA, requestId, steps: [{ type: "head_turn" }], expiresAt: "2099-01-01", nonce: "mine" } });
    assert(ch1.status === 201 && ch1.data.steps.length === 3, "server issues a three step challenge");
    assert(ch1.data.nonce !== "mine" && new Date(ch1.data.expiresAt) < new Date(Date.now() + 61_000), "client supplied steps, nonce and timestamps are ignored");
    const ch2 = await call("/api/human-presence/challenge", { method: "POST", body: { ...guestA, requestId } });
    assert(ch2.status === 429, "only one live challenge at a time");

    console.log("\nBinding and validation");
    const respondWrongParticipant = await call("/api/human-presence/respond", { method: "POST", body: { roomId, participantId: "guest-b", challengeId: ch1.data.challengeId, responseSecret: ch1.data.responseSecret, evidence: evidenceFor(ch1.data) } });
    assert(respondWrongParticipant.status === 404, "a different participant cannot answer someone else's challenge");
    // That attempt consumed (burned) the challenge; issue a fresh one.
    const stillLive = await call("/api/human-presence/respond", { method: "POST", body: { ...guestA, challengeId: ch1.data.challengeId, responseSecret: ch1.data.responseSecret, evidence: evidenceFor(ch1.data) } });
    assert(stillLive.status === 400, "a challenge touched by a mismatched participant is burned, not reusable");

    const ch3 = await call("/api/human-presence/challenge", { method: "POST", body: { ...guestA, requestId } });
    assert(ch3.status === 201, "a new challenge can be started");
    const badSecret = await call("/api/human-presence/respond", { method: "POST", body: { ...guestA, challengeId: ch3.data.challengeId, responseSecret: "x".repeat(43), evidence: evidenceFor(ch3.data) } });
    assert(badSecret.status === 400, "a wrong response secret is rejected");
    const rawMedia = await call("/api/human-presence/respond", { method: "POST", body: { ...guestA, challengeId: ch3.data.challengeId, responseSecret: ch3.data.responseSecret, evidence: { ...evidenceFor(ch3.data), frame: "data:image/png;base64,AAAA" } } });
    assert(rawMedia.status === 400, "evidence carrying raw media fields is rejected");
    // The rejected submission consumed the challenge (single use). Start again.
    const ch4 = await call("/api/human-presence/challenge", { method: "POST", body: { ...guestA, requestId } });
    assert(ch4.status === 201, "after a rejected submission a new attempt is allowed (within the attempt limit)");
    const badNonce = await call("/api/human-presence/respond", { method: "POST", body: { ...guestA, challengeId: ch4.data.challengeId, responseSecret: ch4.data.responseSecret, evidence: evidenceFor(ch4.data, { nonce: "not-the-nonce" }) } });
    assert(badNonce.status === 400, "evidence with the wrong nonce is rejected");
    const ch5 = await call("/api/human-presence/challenge", { method: "POST", body: { ...guestA, requestId } });
    assert(ch5.status === 201, "a third attempt is allowed");

    console.log("\nSuccessful completion is still inconclusive");
    await sleep(2100);
    const ok = await call("/api/human-presence/respond", { method: "POST", body: { ...guestA, challengeId: ch5.data.challengeId, responseSecret: ch5.data.responseSecret, evidence: evidenceFor(ch5.data) } });
    assert(ok.status === 200, "a well formed response is accepted");
    assert(ok.data.status === "inconclusive" && ok.data.verified === false, "the result is inconclusive and never verified");
    assert(/inconclusive/i.test(ok.data.label) && !/verified human/i.test(ok.data.label), "the label is honest");
    assert(ok.data.reasons.some((r) => /No trusted liveness analysis/.test(r)), "the reason explains that no liveness analysis is enabled");
    assert(typeof ok.data.receipt === "string" && ok.data.receipt.startsWith("hpr1."), "a signed receipt is issued");

    console.log("\nReplay protection");
    const replay = await call("/api/human-presence/respond", { method: "POST", body: { ...guestA, challengeId: ch5.data.challengeId, responseSecret: ch5.data.responseSecret, evidence: evidenceFor(ch5.data) } });
    assert(replay.status === 400, "replaying a consumed challenge is rejected");
    const concurrent = await Promise.all([1, 2, 3].map(() => call("/api/human-presence/respond", { method: "POST", body: { ...guestA, challengeId: ch5.data.challengeId, responseSecret: ch5.data.responseSecret, evidence: evidenceFor(ch5.data) } })));
    assert(concurrent.every((r) => r.status === 400), "concurrent replays all lose");
    const afterDone = await call("/api/human-presence/challenge", { method: "POST", body: { ...guestA, requestId } });
    assert(afterDone.status === 404 || afterDone.status === 409, "a completed request cannot mint more challenges");

    console.log("\nReceipt verification");
    const verify = await call("/api/human-presence/receipts/verify", { method: "POST", cookie: host.cookie, body: { receipt: ok.data.receipt } });
    assert(verify.data.valid === true && verify.data.verified === false && verify.data.outcome === "inconclusive", "the host can verify the receipt and it is not verified");
    const [p, body, mac] = ok.data.receipt.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString());
    forged.outcome = "passed";
    const forgedVerify = await call("/api/human-presence/receipts/verify", { method: "POST", cookie: host.cookie, body: { receipt: `${p}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}` } });
    assert(forgedVerify.data.valid === false && forgedVerify.data.reason === "bad_signature", "a forged receipt fails verification");
    const strangerVerify = await call("/api/human-presence/receipts/verify", { method: "POST", cookie: other.cookie, body: { receipt: ok.data.receipt } });
    assert(strangerVerify.status === 404, "an unrelated account cannot probe receipts");
    const anonVerify = await call("/api/human-presence/receipts/verify", { method: "POST", body: { receipt: ok.data.receipt } });
    assert(anonVerify.status === 401, "receipt verification requires sign in");

    console.log("\nHost status and audit history");
    const overview = await call(`/api/sessions/${sessionId}/human-presence`, { cookie: host.cookie });
    const gus = overview.data.participants.find((x) => x.participantId === "guest-a");
    assert(gus.status === "inconclusive" && gus.verified === false, "host sees the guest as inconclusive, not verified");
    const bea = overview.data.participants.find((x) => x.participantId === "guest-b");
    assert(bea.status === "not_requested", "unchecked guests show as not checked");
    const events = overview.data.audit.map((e) => e.event);
    for (const e of ["request.created", "consent.accepted", "challenge.issued", "challenge.rejected", "result.recorded"]) assert(events.includes(e), `audit history includes ${e}`);
    assert(!JSON.stringify(overview.data).includes(ok.data.receipt), "the audit and status views never expose the receipt token");
    const foreignOverview = await call(`/api/sessions/${sessionId}/human-presence`, { cookie: other.cookie });
    assert(foreignOverview.status === 404, "another account cannot read the audit history");

    console.log("\nDecline, cancel, expiry");
    const reqB = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", cookie: host.cookie, body: { participantId: "guest-b", timing: "before" } });
    assert(reqB.status === 201, "host requests a check for the second guest");
    const decline = await call("/api/human-presence/consent", { method: "POST", body: { roomId, participantId: "guest-b", requestId: reqB.data.request.requestId, accepted: false } });
    assert(decline.status === 200 && decline.data.status === "declined", "a guest can decline");
    const afterDecline = await call(`/api/sessions/${sessionId}/human-presence`, { cookie: host.cookie });
    const beaNow = afterDecline.data.participants.find((x) => x.participantId === "guest-b");
    assert(beaNow.status === "declined" && beaNow.verified === false, "a decline is recorded as declined, nothing else");
    const still = await call("/api/presence/announce", { method: "POST", body: { roomId, participantId: "guest-b", role: "guest", displayName: "Bea Guest" } });
    assert(still.status === 200, "declining never removes the guest from the room");
    const reqB2 = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", cookie: host.cookie, body: { participantId: "guest-b" } });
    const cancel = await call(`/api/sessions/${sessionId}/human-presence/cancel`, { method: "POST", cookie: host.cookie, body: { requestId: reqB2.data.request.requestId } });
    assert(cancel.data.cancelled === true, "host can cancel an open request");

    console.log("\nChallenge expiry");
    const reqExp = await call(`/api/sessions/${sessionId}/human-presence/requests`, { method: "POST", cookie: host.cookie, body: { participantId: "guest-b" } });
    await call("/api/human-presence/consent", { method: "POST", body: { roomId, participantId: "guest-b", requestId: reqExp.data.request.requestId, accepted: true } });
    const chExp = await call("/api/human-presence/challenge", { method: "POST", body: { roomId, participantId: "guest-b", requestId: reqExp.data.request.requestId } });
    // Age the challenge in the database to simulate the 60 second window passing.
    const { spawnSync } = await import("node:child_process");
    const aged = spawnSync("python3", ["-c", `import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("UPDATE presence_challenges SET expires_at='2000-01-01T00:00:00.000+00:00' WHERE id=?",(sys.argv[2],));c.commit()`, s.dbPath, chExp.data.challengeId]);
    assert(aged.status === 0, "challenge aged past its expiry");
    const late = await call("/api/human-presence/respond", { method: "POST", body: { roomId, participantId: "guest-b", challengeId: chExp.data.challengeId, responseSecret: chExp.data.responseSecret, evidence: evidenceFor(chExp.data) } });
    assert(late.status === 410, "an expired challenge is refused");

    console.log("\nSession binding");
    const roomC = "hproom2";
    const sessionC = await call("/api/sessions", { method: "POST", cookie: host.cookie, body: { roomId: roomC, title: "Second room" } });
    await call("/api/presence/announce", { method: "POST", body: { roomId: roomC, participantId: "guest-a", role: "guest", displayName: "Gus In Room Two" } });
    const crossRequest = await call("/api/human-presence/consent", { method: "POST", body: { roomId: roomC, participantId: "guest-a", requestId, accepted: true } });
    assert(crossRequest.status === 404, "the same participant id in a different session cannot use the first session's request");
    void sessionC;

    console.log("\nDeletion and revocation");
    const del = await call("/api/human-presence/delete", { method: "POST", body: { ...guestA, requestId } });
    assert(del.data.revoked === true, "the guest deletes their result");
    const verifyAfterDelete = await call("/api/human-presence/receipts/verify", { method: "POST", cookie: host.cookie, body: { receipt: ok.data.receipt } });
    assert(verifyAfterDelete.data.valid === false && verifyAfterDelete.data.reason === "revoked", "the receipt stops validating after deletion");
    const afterDel = await call(`/api/sessions/${sessionId}/human-presence`, { cookie: host.cookie });
    assert(afterDel.data.participants.find((x) => x.participantId === "guest-a").status === "not_requested", "the host no longer sees a result for the guest");

    console.log("\nStored data holds no media");
    const dump = spawnSync("python3", ["-c", `import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print([r[1] for t in ('presence_requests','presence_challenges','presence_results','presence_audit') for r in c.execute('PRAGMA table_info('+t+')')])`, s.dbPath], { encoding: "utf8" });
    assert(!/frame|image|audio_|video|embedding|template|landmark/i.test(dump.stdout), "no table has a column that could hold media or face templates");
    const rowsText = spawnSync("python3", ["-c", `import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print(c.execute("SELECT group_concat(detail_json) FROM presence_audit").fetchone()[0])`, s.dbPath], { encoding: "utf8" }).stdout;
    assert(!rowsText.includes(ch5.data.nonce) && !rowsText.includes(ch5.data.responseSecret), "audit rows hold neither the nonce nor the response secret");

    return { s, call, host, other, sessionId };
  } catch (error) {
    console.error(s.output().split("\n").slice(-20).join("\n"));
    throw error;
  }
}

// ------------------------------------------------------------------ rate limiting + Jam
async function testJam() {
  console.log("\nPeeps Jam, Dub and Breadcrumb integration");
  const s = start(4333, { HUMAN_PRESENCE_ENABLED: "1", HUMAN_PRESENCE_PEEPS_ENABLED: "1" });
  try {
    await waitForHealth(s.base);
    const call = client(s.base);
    const organizer = await call("/auth/register", { method: "POST", body: { name: "Priya Organizer", email: "priya@example.com", password: "password10chars" } });
    const rival = await call("/auth/register", { method: "POST", body: { name: "Rae Rival", email: "rae@example.com", password: "password10chars" } });
    const jam = (await call("/api/jams", { method: "POST", cookie: organizer.cookie, body: { title: "Presence jam", targetParticipantCount: 1, consentRequirements: ["terms_of_service"] } })).data.jam;
    const participant = (await call(`/api/jams/${jam.id}/participants`, { method: "POST", cookie: organizer.cookie, body: { email: "pat@example.com", displayName: "Pat" } })).data.participant;
    const token = (await call(`/api/jam-participants/${participant.id}/invite`, { method: "POST", cookie: organizer.cookie })).data.token;

    const foreign = await call(`/api/jams/${jam.id}/human-presence/requests`, { method: "POST", cookie: rival.cookie, body: { jamParticipantId: participant.id } });
    assert(foreign.status !== 201, "an organizer outside the Jam's organization cannot request a check");
    const req = await call(`/api/jams/${jam.id}/human-presence/requests`, { method: "POST", cookie: organizer.cookie, body: { jamParticipantId: participant.id, timing: "before" } });
    assert(req.status === 201, "the organizer requests a check before the session exists");
    const requestId = req.data.request.requestId;

    const badInvite = await call("/api/human-presence/pending", { method: "POST", body: { jamId: jam.id, invite: "not-a-real-token" } });
    assert(badInvite.status === 404, "an invalid invite cannot see the request");
    const pending = await call("/api/human-presence/pending", { method: "POST", body: { jamId: jam.id, invite: token } });
    assert(pending.data.request?.requestId === requestId, "the invited participant sees the request through their invite");
    const who = { jamId: jam.id, invite: token };
    assert((await call("/api/human-presence/consent", { method: "POST", body: { ...who, requestId, accepted: true } })).status === 200, "participant consents");
    const ch = await call("/api/human-presence/challenge", { method: "POST", body: { ...who, requestId } });
    assert(ch.status === 201, "participant starts the challenge");
    await sleep(2100);
    const done = await call("/api/human-presence/respond", { method: "POST", body: { ...who, challengeId: ch.data.challengeId, responseSecret: ch.data.responseSecret, evidence: evidenceFor(ch.data) } });
    assert(done.status === 200 && done.data.status === "inconclusive" && done.data.verified === false, "the Jam participant result is inconclusive, never verified");

    const overview = await call(`/api/jams/${jam.id}/human-presence`, { cookie: organizer.cookie });
    const row = overview.data.participants.find((p) => p.jamParticipantId === participant.id);
    assert(row.status === "inconclusive" && row.verified === false, "the organizer sees an inconclusive status");
    assert(overview.data.audit.some((e) => e.event === "result.recorded"), "the Jam audit history records the result");
    const detail = await call(`/api/jams/${jam.id}`, { cookie: organizer.cookie });
    void detail;
    const results = spawnSyncPy(s.dbPath, "SELECT type, detail_json FROM jam_events WHERE type='presence.check'");
    assert(results.includes("presence.check") && results.includes('"verified": false'), "a presence.check Breadcrumb event references the receipt and is not verified");
    assert(!results.includes(done.data.receipt), "the Breadcrumb carries a receipt reference, not the receipt token");
    const crumbs = spawnSyncPy(s.dbPath, "SELECT kind, evidence_class, status FROM peeps_breadcrumbs WHERE kind='presence_check'");
    assert(crumbs.includes("presence_unverified"), "the Dub Breadcrumb is classed presence_unverified");
    const entries = spawnSyncPy(s.dbPath, "SELECT count(*) FROM dub_profile_entries WHERE kind='presence_check'");
    assert(entries.trim() === "[(0,)]", "no Dub profile evidence entry is created, so presence cannot boost matching");
  } catch (error) {
    console.error(s.output().split("\n").slice(-20).join("\n"));
    throw error;
  } finally { s.child.kill(); }
}

import { spawnSync } from "node:child_process";
function spawnSyncPy(dbPath, sql) {
  const r = spawnSync("python3", ["-c", `import sqlite3,sys;c=sqlite3.connect(sys.argv[1])
try:
  print(c.execute(sys.argv[2]).fetchall())
except Exception as e:
  print('error',e)`, dbPath, sql], { encoding: "utf8" });
  return r.stdout;
}

// ------------------------------------------------------------------ a trusted provider is the only path to verified
async function testProviderGate() {
  console.log("\nUnknown provider names fall back to inconclusive");
  const s = start(4334, { HUMAN_PRESENCE_ENABLED: "1", HUMAN_PRESENCE_PROVIDER: "totally-real-detector" });
  try {
    await waitForHealth(s.base);
    const call = client(s.base);
    const cfg = await call("/api/human-presence/config");
    assert(cfg.data.livenessAnalysis.active === false, "an unregistered provider name does not activate liveness analysis");
  } finally { s.child.kill(); }
}

// ------------------------------------------------------------------ admin only test mode
async function testAdminOnly() {
  console.log("\nAdmin only test mode");
  for (const [port, env, expectNonAdmin] of [[4335, {}, 404], [4336, { HUMAN_PRESENCE_ADMIN_ONLY: "0" }, 201]]) {
    const s = start(port, { HUMAN_PRESENCE_ENABLED: "1", ...env });
    try {
      await waitForHealth(s.base);
      const call = client(s.base);
      const admin = await call("/auth/register", { method: "POST", body: { name: "Founder", email: "founder@example.com", password: "password10chars" } });
      const user = await call("/auth/register", { method: "POST", body: { name: "Regular", email: "regular@example.com", password: "password10chars" } });
      const mk = async (who, roomId) => {
        const created = await call("/api/sessions", { method: "POST", cookie: who.cookie, body: { roomId, title: roomId } });
        await call("/api/presence/announce", { method: "POST", body: { roomId, participantId: "guest-x", role: "guest", displayName: "G" } });
        return created.data.session.id;
      };
      const adminSid = await mk(admin, `hpadmin${port}`);
      const userSid = await mk(user, `hpuser${port}`);
      const cfg = await call("/api/human-presence/config");
      assert(cfg.data.adminOnly === (expectNonAdmin === 404), `config reports adminOnly=${expectNonAdmin === 404}`);
      const a = await call(`/api/sessions/${adminSid}/human-presence/requests`, { method: "POST", cookie: admin.cookie, body: { participantId: "guest-x" } });
      assert(a.status === 201, "a platform admin can request a check");
      const u = await call(`/api/sessions/${userSid}/human-presence/requests`, { method: "POST", cookie: user.cookie, body: { participantId: "guest-x" } });
      assert(u.status === expectNonAdmin, `a regular account gets ${expectNonAdmin} for its own session`);
      const read = await call(`/api/sessions/${userSid}/human-presence`, { cookie: user.cookie });
      assert(read.status === (expectNonAdmin === 404 ? 404 : 200), "regular account reads follow the same gate");
    } finally { s.child.kill(); }
  }
}

try {
  await testDisabled();
  const ctx = await testEnabled();
  ctx.s.child.kill();
  await testJam();
  await testProviderGate();
  await testAdminOnly();
  console.log("\nAll human presence server checks passed.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 100);
}
