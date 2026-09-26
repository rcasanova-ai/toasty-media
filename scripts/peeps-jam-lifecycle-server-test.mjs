#!/usr/bin/env node
// HTTP-level integration test for the Peeps <-> Studio Jam lifecycle — same pattern as
// scripts/accounts-organizations-server-test.mjs (spawn the real server against a throwaway SQLite DB,
// drive it with fetch). Proves the QA acceptance list end to end: create Jam -> add/invite participant ->
// capture consent -> confirm (rejected without consent) -> Run Session -> Run Session again (idempotent,
// including under real concurrency) -> session ends -> artifacts/AI usage appear in /results -> attendance/
// completion/payment state -> durability across a fresh fetch -> organization isolation.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4211;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-jam-lifecycle-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

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

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "jam-lifecycle-test-secret", RESEND_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  console.log("Setup — organizer account, auto-created organization");
  const organizer = await jsonFetch("/auth/register", { method: "POST", body: { name: "Priya Organizer", email: "priya@example.com", password: "password10chars" } });
  assert(organizer.status === 201, "organizer registers");
  const orgList = await jsonFetch("/api/organizations", { cookie: organizer.cookie });
  const organizationId = orgList.data.organizations[0].id;

  console.log("\nPhase 1 — create a Jam");
  const jamCreate = await jsonFetch("/api/jams", {
    method: "POST",
    cookie: organizer.cookie,
    body: {
      title: "Agent payments podcast",
      objective: "Understand trust in autonomous agent payments",
      targetParticipantCount: 1,
      compensation: { amount: 50, currency: "USD" },
      consentRequirements: ["terms_of_service", "recording", "research_participation"]
    }
  });
  assert(jamCreate.status === 201, "jam is created");
  const jam = jamCreate.data.jam;
  assert(jam.status === "draft", "a new jam starts in draft status");

  const jamListBefore = await jsonFetch(`/api/jams?organizationId=${organizationId}`, { cookie: organizer.cookie });
  assert(jamListBefore.data.jams.length === 1, "the jam appears in the organization's jam list");
  assert(jamListBefore.data.jams[0].confirmedCount === 0, "0 confirmed participants initially");

  console.log("\nPhase 2 — add and invite a participant, capture consent, confirm");
  const participantCreate = await jsonFetch(`/api/jams/${jam.id}/participants`, {
    method: "POST", cookie: organizer.cookie, body: { email: "Pat@Example.com", displayName: "Pat Participant" }
  });
  assert(participantCreate.status === 201, "a participant is added by email");
  const participant = participantCreate.data.participant;
  assert(participant.status === "candidate", "a newly added participant starts as candidate");
  assert(participant.email === "pat@example.com", "participant email is normalized to lowercase");

  const inviteIssue = await jsonFetch(`/api/jam-participants/${participant.id}/invite`, { method: "POST", cookie: organizer.cookie });
  assert(inviteIssue.status === 201, "an invite is issued");
  const token = inviteIssue.data.token;
  assert(typeof token === "string" && token.length > 10, "the raw invite token is returned to the organizer");

  const afterInvite = await jsonFetch(`/api/jams/${jam.id}`, { cookie: organizer.cookie });
  assert(afterInvite.data.participants[0].status === "invited", "participant status moves to invited");

  const inviteGet = await jsonFetch(`/api/jam-invites/${token}`);
  assert(inviteGet.status === 200 && inviteGet.data.jam.title === jam.title, "an unauthenticated participant can resolve their invite to jam details");

  const accept = await jsonFetch(`/api/jam-invites/${token}/accept`, { method: "POST" });
  assert(accept.status === 200 && accept.data.participant.status === "accepted", "participant accepts the invite");

  const confirmBeforeConsent = await jsonFetch(`/api/jam-participants/${participant.id}/confirm`, { method: "POST", cookie: organizer.cookie });
  assert(confirmBeforeConsent.status === 400, "confirming a participant is REJECTED before required consent is captured");

  const partialConsent = await jsonFetch(`/api/jam-invites/${token}/consent`, { method: "POST", body: { requiredAcceptances: ["terms_of_service"] } });
  assert(partialConsent.status === 200 && partialConsent.data.consentSatisfied === false, "submitting only some required consent keys does not satisfy requirements");
  assert(!partialConsent.data.participant.consentCapturedAt, "consentCapturedAt stays unset when requirements are only partially satisfied");

  const fullConsent = await jsonFetch(`/api/jam-invites/${token}/consent`, {
    method: "POST", body: { requiredAcceptances: ["terms_of_service", "recording", "research_participation"], agreementVersion: "v1" }
  });
  assert(fullConsent.status === 200 && fullConsent.data.consentSatisfied === true, "submitting every required consent key satisfies requirements");
  assert(fullConsent.data.participant.consentCapturedAt, "consentCapturedAt is now set");

  const confirmAfterConsent = await jsonFetch(`/api/jam-participants/${participant.id}/confirm`, { method: "POST", cookie: organizer.cookie });
  assert(confirmAfterConsent.status === 200 && confirmAfterConsent.data.participant.status === "confirmed", "confirming now succeeds");

  const jamListAfterConfirm = await jsonFetch(`/api/jams?organizationId=${organizationId}`, { cookie: organizer.cookie });
  assert(jamListAfterConfirm.data.jams[0].confirmedCount === 1, "the jam list shows 1 confirmed participant (1/1 target)");

  console.log("\nPhase 3 — Run Session is idempotent, including under real concurrency");
  const run1 = await jsonFetch(`/api/jams/${jam.id}/run-session`, { method: "POST", cookie: organizer.cookie, body: {} });
  assert(run1.status === 200 && run1.data.created === true, "Run Session creates a Studio session the first time");
  const studioSessionId = run1.data.session.id;

  const run2 = await jsonFetch(`/api/jams/${jam.id}/run-session`, { method: "POST", cookie: organizer.cookie, body: {} });
  assert(run2.data.created === false && run2.data.session.id === studioSessionId, "clicking Run Session again is a no-op that returns the SAME session");

  const jamAfterRun = await jsonFetch(`/api/jams/${jam.id}`, { cookie: organizer.cookie });
  assert(jamAfterRun.data.jam.studioSessionId === studioSessionId, "the jam durably links to the studio session (jamId <-> studioSessionId)");
  assert(jamAfterRun.data.jam.status === "running", "the jam status advances to running");

  // A second jam proves idempotency under genuinely concurrent requests, not just sequential re-clicks.
  const jam2Create = await jsonFetch("/api/jams", { method: "POST", cookie: organizer.cookie, body: { title: "Concurrent jam", targetParticipantCount: 0 } });
  const jam2 = jam2Create.data.jam;
  const concurrentRuns = await Promise.all(
    Array.from({ length: 8 }, () => jsonFetch(`/api/jams/${jam2.id}/run-session`, { method: "POST", cookie: organizer.cookie, body: {} }))
  );
  const createdCount = concurrentRuns.filter((r) => r.data.created).length;
  const sessionIds = new Set(concurrentRuns.map((r) => r.data.session?.id));
  assert(createdCount === 1, `exactly one of 8 concurrent Run Session requests actually created a session (got ${createdCount})`);
  assert(sessionIds.size === 1, `all 8 concurrent requests agree on the SAME session id (got ${sessionIds.size} distinct ids)`);

  console.log("\nPhase 4 — Studio recognizes the originating Jam (read-only)");
  const jamContext = await jsonFetch(`/api/sessions/${studioSessionId}/jam`, { cookie: organizer.cookie });
  assert(jamContext.status === 200 && jamContext.data.jam.jamId === jam.id, "Studio's session exposes read-only context back to the originating Jam");
  assert(jamContext.data.jam.consentSummary.consentCaptured === 1, "Studio's context includes a consent summary derived from Peeps state");

  console.log("\nLive room access/events — matches js/peeps-room.js's existing contract");
  const access = await jsonFetch(`/api/jams/${jam.id}/access`, { method: "POST", body: { invite: token } });
  assert(access.status === 200, "the confirmed participant can access the live room once the session is open");
  assert(access.data.capture === "private", "default capture policy (none) maps to the 'private' label the front end expects");
  assert(access.data.media.roomId && access.data.media.roomSecret, "room credentials are issued");

  const joinEvent = await jsonFetch(`/api/jams/${jam.id}/events`, { method: "POST", body: { invite: token, type: "participant.joined" } });
  assert(joinEvent.status === 201, "a participant.joined evidence event is accepted");
  for (const type of ["jam.started", "participant.left", "jam.ended", "dispute.window.opened"]) {
    const ev = await jsonFetch(`/api/jams/${jam.id}/events`, { method: "POST", body: { invite: token, type } });
    assert(ev.status === 201, `a ${type} evidence event is accepted`);
  }

  const afterJoin = await jsonFetch(`/api/jams/${jam.id}`, { cookie: organizer.cookie });
  assert(afterJoin.data.participants[0].status === "attended", "posting participant.joined marks attendance automatically");
  assert(afterJoin.data.participants[0].attendedAt, "attendedAt is stamped");

  const removedParticipantAccess = await (async () => {
    // A removed participant must lose FUTURE access even though their token is otherwise still valid.
    const p2 = await jsonFetch(`/api/jams/${jam.id}/participants`, { method: "POST", cookie: organizer.cookie, body: { email: "later-removed@example.com" } });
    const inv2 = await jsonFetch(`/api/jam-participants/${p2.data.participant.id}/invite`, { method: "POST", cookie: organizer.cookie });
    await jsonFetch(`/api/jam-participants/${p2.data.participant.id}/remove`, { method: "POST", cookie: organizer.cookie, body: { reason: "no longer needed" } });
    return jsonFetch(`/api/jams/${jam.id}/access`, { method: "POST", body: { invite: inv2.data.token } });
  })();
  assert([403, 410].includes(removedParticipantAccess.status), "a removed participant is refused live room access — their invite is revoked on removal, so this can surface as either an expired-invite (410) or blocked-participant (403) response");

  console.log("\nPhase 5 — AI usage and artifacts flow into /results, including honest empty states");
  const zeroUsageResults = await jsonFetch(`/api/jams/${jam2.id}/results`, { cookie: organizer.cookie });
  assert(zeroUsageResults.status === 200 && zeroUsageResults.data.aiUsage.totalTokens === 0, "a jam with zero AI usage renders a valid empty summary, not an error");
  assert(zeroUsageResults.data.artifacts.length === 0, "a jam with no artifacts yet renders an empty list, not an error");

  await jsonFetch(`/api/jams/${jam.id}/artifacts`, { method: "POST", cookie: organizer.cookie, body: { artifactType: "recording", status: "pending" } });
  const transcriptArtifact = await jsonFetch(`/api/jams/${jam.id}/artifacts`, { method: "POST", cookie: organizer.cookie, body: { artifactType: "transcript", status: "unavailable" } });
  assert(transcriptArtifact.status === 201, "an organizer can register a durable artifact reference");

  const resultsAfterArtifacts = await jsonFetch(`/api/jams/${jam.id}/results`, { cookie: organizer.cookie });
  assert(resultsAfterArtifacts.data.artifacts.length === 2, "both artifacts appear in /results");
  assert(resultsAfterArtifacts.data.events.length >= 6, "the full evidence/Breadcrumb event log is present (invite, consent, confirm, session-created, join, etc.)");

  console.log("\nPhase 6 — attendance, completion, payment state (and it survives a fresh fetch, not just client cache)");
  const markCompleted = await jsonFetch(`/api/jam-participants/${participant.id}/mark-completed`, { method: "POST", cookie: organizer.cookie });
  assert(markCompleted.status === 200 && markCompleted.data.participant.status === "completed", "an attended participant can be marked completed");
  await jsonFetch(`/api/jam-participants/${participant.id}/mark-eligible`, { method: "POST", cookie: organizer.cookie });
  const markPaid = await jsonFetch(`/api/jam-participants/${participant.id}/mark-paid`, { method: "POST", cookie: organizer.cookie });
  assert(markPaid.data.participant.compensationStatus === "paid", "payment eligibility then paid status is tracked");

  const reFetched = await jsonFetch(`/api/jams/${jam.id}/results`, { cookie: organizer.cookie });
  assert(reFetched.data.attendance.completed === 1, "completion count is durable across a fresh request");
  assert(reFetched.data.payment.paid === 1, "paid count is durable across a fresh request");

  console.log("\nPhase 7 — Jam completion, including reopening after completion");
  const complete = await jsonFetch(`/api/jams/${jam.id}/complete`, { method: "POST", cookie: organizer.cookie });
  assert(complete.status === 200 && complete.data.jam.status === "completed", "the jam can be marked completed");

  const reopen = await jsonFetch(`/api/jams/${jam.id}/reopen`, { method: "POST", cookie: organizer.cookie });
  assert(reopen.status === 200 && reopen.data.jam.status === "running", "a completed jam (with a live studio session) reopens to running");

  console.log("\n--- Organization isolation (explicitly required) ---");
  const outsider = await jsonFetch("/auth/register", { method: "POST", body: { name: "Eve Outsider", email: "eve@example.com", password: "password10chars" } });
  const stolenGet = await jsonFetch(`/api/jams/${jam.id}`, { cookie: outsider.cookie });
  assert(stolenGet.status === 404, "a non-member GETting another organization's jam sees 404, not the data");

  const stolenRun = await jsonFetch(`/api/jams/${jam.id}/run-session`, { method: "POST", cookie: outsider.cookie, body: {} });
  assert(stolenRun.status === 404, "a non-member cannot run a session for another organization's jam");

  const stolenResults = await jsonFetch(`/api/jams/${jam.id}/results`, { cookie: outsider.cookie });
  assert(stolenResults.status === 404, "a non-member cannot read another organization's jam results");

  const outsiderJamList = await jsonFetch(`/api/jams?organizationId=${organizationId}`, { cookie: outsider.cookie });
  assert(outsiderJamList.status === 404, "a non-member explicitly requesting another org's id by organizationId is refused, not shown an empty list that would confirm the id");

  console.log("\nAll Peeps Jam lifecycle tests passed.");
}

main()
  .then(() => { server.kill(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    console.error("\n--- server output ---\n" + serverOutput);
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
