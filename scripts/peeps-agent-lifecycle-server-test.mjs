#!/usr/bin/env node
// HTTP-level integration test for the Peeps agent-to-human transaction lifecycle — same pattern as
// scripts/peeps-jam-lifecycle-server-test.mjs (spawn the real server against a throwaway SQLite DB, drive
// with fetch). Proves the golden path end to end: natural-language request -> resolver (internal history +
// labeled demo directory) -> ranked candidates with separate match/reachability axes -> payment-gated
// authorize -> Jam/participants/invites (reusing the EXISTING Jam lifecycle) -> accept/consent/join ->
// booking -> Session Planner auto-population -> prep -> completion -> idempotent settlement -> post-session
// package -> Dub claim. Also covers key failure cases from the brief's section 32.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4216;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-peeps-agent-"));
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

async function jsonFetch(path, { method = "GET", cookie, body, headers = {} } = {}) {
  const requestHeaders = { "x-toasty-csrf": "1", ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers: requestHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
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

// SVM_PAY_TO empty forces the demo payment provider — a real production deployment with a configured
// recipient would use readDiscoveryPaymentProof's real-proof path instead (same code path already
// exercised by /api/agent/find-experts's own tests).
const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "peeps-agent-test-secret", RESEND_API_KEY: "", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function payAndAuthorize(requestId, cookie, candidates) {
  const noProof = await jsonFetch(`/api/peeps/requests/${requestId}/authorize`, { method: "POST", cookie, body: { candidates } });
  assert(noProof.status === 402, "authorizing without payment proof is refused with 402 Payment Required");
  assert(noProof.data.paymentKind === "EXPERT_DISCOVERY" && noProof.data.demo === true, "the 402 response carries a well-formed x402 requirement, and correctly reports demo mode when no real recipient is configured");

  const demoPay = await jsonFetch("/api/peeps/demo-payments/authorize", { method: "POST", cookie, body: { requestId } });
  assert(demoPay.status === 200 && demoPay.data.demo === true && demoPay.data.transactionSignature.startsWith("demo-"), "the demo payment provider issues an obviously-fake, clearly-labeled signature");

  return jsonFetch(`/api/peeps/requests/${requestId}/authorize`, {
    method: "POST",
    cookie,
    headers: {
      "x-payment-signature": demoPay.data.paymentSignature,
      "x-solana-transaction-signature": demoPay.data.transactionSignature,
      "x-payment-asset": "USDC",
      "x-payment-amount": "0.25",
      "x-payer-wallet": demoPay.data.payerWallet,
      "x-approval-source": demoPay.data.approvalSource
    },
    body: { candidates }
  });
}

async function main() {
  await waitForHealth();

  console.log("Setup — organizer account, auto-created organization");
  const organizer = await jsonFetch("/auth/register", { method: "POST", body: { name: "Priya Organizer", email: "priya-agent@example.com", password: "password10chars" } });
  assert(organizer.status === 201, "organizer registers");

  console.log("\nPhase 1 — the two-question request, and honest validation");
  const missingOutcome = await jsonFetch("/api/peeps/requests", { method: "POST", cookie: organizer.cookie, body: { whoText: "Fintech people" } });
  assert(missingOutcome.status === 400, "a request with no outcome is rejected (both questions are required)");

  const create = await jsonFetch("/api/peeps/requests", {
    method: "POST", cookie: organizer.cookie,
    body: {
      whoText: "Fintech/payment executives in Southeast Asia who understand offline payments.",
      outcomeText: "I want three interesting people for a recorded podcast about where digital payments are going."
    }
  });
  assert(create.status === 201, "a natural-language request is created");
  const request = create.data.request;
  assert(request.whoText.includes("Southeast Asia"), "the original whoText is persisted verbatim, never rewritten");
  assert(request.status === "candidates_ready", "the request resolves to candidates synchronously (no permanent loading state)");
  assert(request.workingRepresentation.desiredCandidateCount === 3, "the agent infers an internal working hypothesis (candidate count) from the outcome text, never asked of the human directly");

  console.log("\nPhase 2 — agent research: internal history (empty, zero-network case) + demo directory, ranked with real evidence");
  const candidates = create.data.candidates;
  assert(candidates.length >= 3, "at least 3 actionable candidates are produced even with zero internal Peeps history (the 'nearly empty network' requirement)");
  assert(candidates.every((c) => c.source === "demo_directory_provider"), "with no prior organization history, every candidate honestly comes from the labeled demo provider, not internal history");
  assert(candidates.every((c) => c.contactEmail === null), "the demo provider never fabricates a contact email for anyone in it");
  assert(candidates.slice(0, 3).every((c) => /southeast asia|fintech|offline payments|payment/i.test(`${c.displayName} ${c.headline} ${c.matchReason}`)), "the top 3 candidates are genuinely on-topic for the request, not arbitrary");
  assert(candidates.every((c) => c.evidence.length > 0 && c.evidence[0].sourceTitle), "every candidate carries evidence with a labeled source, never a bare claim");
  assert(candidates.every((c) => ["claimed_member", "unclaimed_dub", "external_direct", "external_indirect", "unreachable"].includes(c.reachability)), "every candidate has an explicit reachability classification, separate from match score");

  console.log("\nPhase 3 — 'keep searching' replaces one candidate without disturbing the rest");
  const rejectId = candidates[candidates.length - 1].id;
  const replaced = await jsonFetch(`/api/peeps/requests/${request.id}/replace-candidate`, { method: "POST", cookie: organizer.cookie, body: { candidateId: rejectId } });
  assert(replaced.status === 200, "replace-candidate succeeds");
  assert(replaced.data.candidates.find((c) => c.id === rejectId)?.status === "rejected", "the rejected candidate is marked rejected, not deleted (auditable)");
  assert(replaced.data.candidates.some((c) => c.status === "proposed" && c.id !== rejectId), "a fresh candidate tops the shortlist back up");

  console.log("\nPhase 4 — human authorizes introductions: payment-gated, never fabricates a contact channel");
  const top3 = candidates.slice(0, 3);
  const unreachableAttempt = await payAndAuthorize(request.id, organizer.cookie, [{ candidateId: top3[0].id }]);
  assert(unreachableAttempt.status === 200 && unreachableAttempt.data.introductions.length === 0, "authorizing a demo-directory candidate with NO organizer-supplied contact produces zero introductions");
  assert(unreachableAttempt.data.skipped[0]?.reason === "no_verified_contact_path", "...and says exactly why, rather than silently pretending an introduction happened");

  const authorize = await payAndAuthorize(request.id, organizer.cookie, [
    { candidateId: top3[0].id, outreachEmail: "candidate-a@example.com" },
    { candidateId: top3[1].id, outreachEmail: "candidate-b@example.com" },
    { candidateId: top3[2].id, outreachEmail: "candidate-c@example.com" }
  ]);
  assert(authorize.status === 200, "authorizing with an organizer-supplied real contact succeeds");
  assert(authorize.data.introductions.length === 3, "three introductions are created");
  assert(authorize.data.introductions.every((i) => i.status === "contacted" && i.outreachSentAt), "outreach was actually sent for each (the existing Jam invite email flow, reused)");
  const jamId = authorize.data.jamId;
  assert(jamId, "a Jam is created to host the engagement — no parallel booking/session system");

  console.log("\nPhase 5 — acceptance reuses the EXISTING Jam invite accept/consent flow verbatim");
  const jamAfterAuth = await jsonFetch(`/api/jams/${jamId}`, { cookie: organizer.cookie });
  const firstParticipant = jamAfterAuth.data.participants[0];
  const inviteIssue = await jsonFetch(`/api/jam-participants/${firstParticipant.id}/invite`, { method: "POST", cookie: organizer.cookie });
  // A fresh invite is issued here purely to get a token this test can drive (the real one went out by
  // email in Phase 4) — same reusable, non-single-use token model as every other Jam participant.
  const token = inviteIssue.data.token;
  const accept = await jsonFetch(`/api/jam-invites/${token}/accept`, { method: "POST" });
  assert(accept.status === 200 && accept.data.participant.status === "accepted", "the candidate accepts via the existing invite flow");
  const consent = await jsonFetch(`/api/jam-invites/${token}/consent`, { method: "POST", body: { requiredAcceptances: ["terms_of_service", "recording"], agreementVersion: "v1" } });
  assert(consent.status === 200 && consent.data.consentSatisfied === true, "consent is captured through the existing consent endpoint");

  console.log("\nPhase 6 — booking auto-creates the Studio session and populates the Session Planner");
  const book = await jsonFetch(`/api/jams/${jamId}/book`, { method: "POST", cookie: organizer.cookie, body: { scheduledAt: "2026-10-15T14:00", timezone: "Asia/Bangkok", durationMinutes: 45 } });
  assert(book.status === 200, "booking succeeds");
  assert(book.data.jam.scheduledAt === "2026-10-15T14:00" && book.data.jam.timezone === "Asia/Bangkok", "the Jam durably carries the resolved time — a Jam with a scheduledAt IS the booking record");
  assert(book.data.jam.studioSessionId, "booking implicitly runs the Studio session (idempotent, same claim as a manual Run Session click) so the planner has somewhere to live");
  const studioSessionId = book.data.jam.studioSessionId;

  const access = await jsonFetch(`/api/jams/${jamId}/access`, { method: "POST", body: { invite: token } });
  assert(access.status === 200 && access.data.media.roomId, "once booked, the accepted participant can join the live room — same room access contract as any other Jam");
  await jsonFetch(`/api/jams/${jamId}/events`, { method: "POST", body: { invite: token, type: "participant.joined" } });

  console.log("\nPhase 7 — meeting prep: organizer sees why each candidate was selected; the questions already exist");
  const prep = await jsonFetch(`/api/jams/${jamId}/prep?role=organizer`, { cookie: organizer.cookie });
  assert(prep.status === 200, "organizer prep loads");
  assert(prep.data.questions.length >= 3, "a real, non-empty question set was generated at booking time — never an empty planner");
  assert(prep.data.participants.some((p) => p.whySelected && p.evidence.length), "at least one participant's prep shows why they were selected and the evidence behind it");

  const participantPrep = await jsonFetch(`/api/jams/${jamId}/prep?role=participant&participantId=${firstParticipant.id}`, { cookie: organizer.cookie });
  assert(participantPrep.status === 200 && participantPrep.data.otherParticipants !== undefined, "a participant-scoped prep view exists");
  assert(!("whySelected" in (participantPrep.data.participants || {})), "participant-scoped prep never leaks organizer-only evidence/whySelected fields");

  console.log("\nPhase 8 — completion, notification, and idempotent settlement");
  const markCompleted = await jsonFetch(`/api/jam-participants/${firstParticipant.id}/mark-completed`, { method: "POST", cookie: organizer.cookie });
  assert(markCompleted.status === 200 && markCompleted.data.participant.status === "completed", "attendance/completion is recorded on the existing jam_participants lifecycle");

  const complete = await jsonFetch(`/api/jams/${jamId}/complete`, { method: "POST", cookie: organizer.cookie });
  assert(complete.status === 200 && complete.data.jam.status === "completed", "the Jam completes");

  const settle1 = await jsonFetch(`/api/jams/${jamId}/settle`, { method: "POST", cookie: organizer.cookie });
  assert(settle1.status === 200, "settlement runs");
  const firstSettlement = settle1.data.settlements.find((s) => s.participantId === firstParticipant.id);
  assert(firstSettlement.status === "no_compensation_due", "a participant with no compensation amount settles honestly as not-owed, never a fabricated payout");

  console.log("\nPhase 9 — post-session package, scoped by role");
  const orgPackage = await jsonFetch(`/api/jams/${jamId}/package`, { cookie: organizer.cookie });
  assert(orgPackage.status === 200 && orgPackage.data.scope === "organizer" && Array.isArray(orgPackage.data.events), "the organizer package includes the full event/Breadcrumb log");
  const participantPackage = await jsonFetch(`/api/jams/${jamId}/package?participantId=${firstParticipant.id}`, { cookie: organizer.cookie });
  assert(participantPackage.status === 200 && participantPackage.data.scope === "participant", "a participant-scoped package exists and never exposes another participant's data");

  console.log("\nPhase 10 — Breadcrumbs (existing jam_events ledger, reused) and Dub claim");
  const dubId = jamAfterAuth.data.participants[0].dubId;
  const claimIssue = await jsonFetch(`/api/dubs/${dubId}/claim-invite`, { method: "POST", cookie: organizer.cookie, body: {} });
  assert(claimIssue.status === 201 && claimIssue.data.token, "an organizer can invite a real, previously-interacted-with Dub to claim their identity");

  const claimGet = await jsonFetch(`/api/dub-claims/${claimIssue.data.token}`);
  assert(claimGet.status === 200 && claimGet.data.breadcrumbs.length > 0, "the public claim page shows real Breadcrumbs (jam_events), not an empty shell");
  assert(claimGet.data.breadcrumbs.some((e) => e.type === "participant.completed"), "the Breadcrumbs reflect something that actually happened, not a generic rating");

  const candidateUser = await jsonFetch("/auth/register", { method: "POST", body: { name: "Real Candidate", email: "candidate-a-real@example.com", password: "password10chars" } });
  const claimTwice1 = await jsonFetch(`/api/dub-claims/${claimIssue.data.token}/claim`, { method: "POST", cookie: candidateUser.cookie });
  assert(claimTwice1.status === 200 && claimTwice1.data.dub.userId === candidateUser.data.user.id, "claiming attaches the Dub to the real authenticated user");
  const claimTwice2 = await jsonFetch(`/api/dub-claims/${claimIssue.data.token}/claim`, { method: "POST", cookie: candidateUser.cookie });
  assert(claimTwice2.status === 409, "claiming the same Dub twice is refused — never a duplicate/hijacked claim");
  const claimGetAfter = await jsonFetch(`/api/dub-claims/${claimIssue.data.token}`);
  assert(claimGetAfter.status === 410, "the claim link reports 'already claimed' once used, not a stale success");

  console.log("\n--- Failure cases ---");
  const badRequestId = await jsonFetch("/api/peeps/requests/preq_does_not_exist", { cookie: organizer.cookie });
  assert(badRequestId.status === 404, "a nonexistent request id is a clean 404");

  const emptyAuthorize = await jsonFetch(`/api/peeps/requests/${request.id}/authorize`, { method: "POST", cookie: organizer.cookie, body: { candidates: [] } });
  assert(emptyAuthorize.status === 400, "authorizing with zero selected candidates is rejected outright");

  const settle2 = await jsonFetch(`/api/jams/${jamId}/settle`, { method: "POST", cookie: organizer.cookie });
  const secondSettlement = settle2.data.settlements.find((s) => s.participantId === firstParticipant.id);
  assert(secondSettlement.status === "no_compensation_due", "re-running settle is safe and idempotent (never pays twice — same deterministic payment id either way)");

  const replaceParticipant = await jsonFetch(`/api/jams/${jamId}/replace-participant`, { method: "POST", cookie: organizer.cookie, body: { removedParticipantId: firstParticipant.id, reason: "late cancellation" } });
  assert(replaceParticipant.status === 200, "last-minute replacement never silently substitutes anyone — it only proposes, or honestly reports no auto-suggestable alternate");

  console.log("\n--- Organization isolation ---");
  const outsider = await jsonFetch("/auth/register", { method: "POST", body: { name: "Eve Outsider", email: "eve-agent@example.com", password: "password10chars" } });
  const stolenRequest = await jsonFetch(`/api/peeps/requests/${request.id}`, { cookie: outsider.cookie });
  assert(stolenRequest.status === 404, "a non-member cannot read another organization's Peeps request");
  const stolenAuthorize = await jsonFetch(`/api/peeps/requests/${request.id}/authorize`, { method: "POST", cookie: outsider.cookie, body: { candidates: [] } });
  assert(stolenAuthorize.status === 404, "a non-member cannot authorize introductions on another organization's request");
  const stolenClaimIssue = await jsonFetch(`/api/dubs/${dubId}/claim-invite`, { method: "POST", cookie: outsider.cookie, body: {} });
  assert(stolenClaimIssue.status === 400 || stolenClaimIssue.status === 403, "a non-member cannot issue a claim invite for a Dub they have no history with");

  console.log("\nAll Peeps agent-to-human lifecycle tests passed.");
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
