#!/usr/bin/env node
// Event Growth layer — Session Planner, Speakers, Consent, Sponsors, Landing Pages, Audience,
// Campaign Links, BYOK usage, Post-event hooks — against the real render-production-server.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4209;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-event-growth-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function jsonFetch(path, { method = "GET", cookie, body } = {}) {
  const headers = { "x-toasty-csrf": "1" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual"
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data, cookie: cookieFrom(response) || cookie, location: response.headers.get("location") };
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "event-growth-test-secret" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  const organizer = await jsonFetch("/auth/register", { method: "POST", body: { name: "Ricardo", email: "organizer-eg@example.com", password: "password10chars" } });
  assert(organizer.status === 201, "organizer registers");
  const ownerUserId = organizer.data.user.id;

  const created = await jsonFetch("/api/sessions", { method: "POST", cookie: organizer.cookie, body: { roomId: "egtest1", title: "Q3 Product Launch", brandId: "toasty" } });
  assert(created.status === 200, "session creates");
  const sessionId = created.data.session.id;

  console.log("\nSession Planner");
  const planSet = await jsonFetch(`/api/sessions/${sessionId}/plan`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { plan: { sessionType: "product_launch", deliveryMode: "live", wizardStep: "speakers", registrationRequired: true } }
  });
  assertEqual(planSet.status, 200, "plan saves");
  assertEqual(planSet.data.session.plan.sessionType, "product_launch", "plan round-trips");
  const planReread = await jsonFetch(`/api/sessions/${sessionId}`, { cookie: organizer.cookie });
  assertEqual(planReread.data.session.plan.wizardStep, "speakers", "plan survives GET");

  console.log("\nSpeaker invite -> guest profile -> consent -> tech check");
  const speakerCreate = await jsonFetch(`/api/sessions/${sessionId}/speakers`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { email: "alice@example.com", sessionRole: "Guest", displayName: "Alice Placeholder" }
  });
  assertEqual(speakerCreate.status, 201, "speaker creates");
  assertEqual(speakerCreate.data.speaker.inviteStatus, "not_sent", "speaker starts not_sent");
  const speakerId = speakerCreate.data.speaker.id;

  const inviteIssue = await jsonFetch(`/api/speakers/${speakerId}/invite`, { method: "POST", cookie: organizer.cookie, body: {} });
  assertEqual(inviteIssue.status, 201, "invite issues");
  assert(typeof inviteIssue.data.token === "string" && inviteIssue.data.token.length > 20, "invite returns a high-entropy raw token");
  const token = inviteIssue.data.token;

  const afterInvite = await jsonFetch(`/api/sessions/${sessionId}/speakers`, { cookie: organizer.cookie });
  assertEqual(afterInvite.data.speakers[0].inviteStatus, "sent", "invite issue updates speaker status");

  // Guest path — no cookie, no account, just the token.
  const guestRead = await jsonFetch(`/api/speaker-invites/${token}`, {});
  assertEqual(guestRead.status, 200, "guest can read invite with token alone");
  assert(!("ownerUserId" in guestRead.data.speaker), "guest view never exposes organizer's ownerUserId");

  const badToken = await jsonFetch(`/api/speaker-invites/not-a-real-token`, {});
  assertEqual(badToken.status, 404, "wrong token is rejected");

  const profileSubmit = await jsonFetch(`/api/speaker-invites/${token}/profile`, {
    method: "POST",
    body: { fields: { displayName: "Alice Chen", title: "VP Engineering", company: "Acme", bioShort: "Builds things.", links: { linkedin: "https://linkedin.com/in/alice", other: "ignored-key-should-be-dropped" }, peepsUserId: "should-be-ignored-in-guest-mode" } }
  });
  assertEqual(profileSubmit.status, 200, "guest profile submission succeeds");
  assertEqual(profileSubmit.data.speaker.displayName, "Alice Chen", "profile fields persist");
  assertEqual(profileSubmit.data.speaker.peepsUserId, null, "organizer-only fields are not guest-writable");
  assert(profileSubmit.data.speaker.profileSubmittedAt, "profile submission timestamp is set");

  const afterProfile = await jsonFetch(`/api/sessions/${sessionId}/speakers`, { cookie: organizer.cookie });
  assertEqual(afterProfile.data.speakers[0].inviteStatus, "accepted", "profile submission marks speaker accepted");

  // Same token, still live: profile submission must NOT consume it — the guest needs it again for
  // tech-check and consent in the same visit.
  const reReadAfterProfile = await jsonFetch(`/api/speaker-invites/${token}`, {});
  assertEqual(reReadAfterProfile.status, 200, "the same invite token still works right after profile submission");

  const techCheck = await jsonFetch(`/api/speaker-invites/${token}/tech-check`, {
    method: "POST",
    body: { cameraOk: true, micOk: true, speakerOk: false, browserSupported: true, connectionOutcome: "good", deviceLabels: ["FaceTime HD Camera"] }
  });
  assertEqual(techCheck.status, 201, "tech check records");
  assertEqual(techCheck.data.techCheck.speakerOk, false, "tech check preserves a real failure, not just happy path");

  const consentMissing = await jsonFetch(`/api/speaker-invites/${token}/consent`, { method: "POST", body: { requiredAcceptances: [] } });
  assertEqual(consentMissing.status, 400, "empty required acceptances is rejected");

  const consentSubmit = await jsonFetch(`/api/speaker-invites/${token}/consent`, {
    method: "POST",
    body: {
      requiredAcceptances: ["terms_of_service", "privacy_policy", "recording", "distribution_replay"],
      optionalPermissions: ["promotional_clips"]
    }
  });
  assertEqual(consentSubmit.status, 201, "consent records");
  assertEqual(consentSubmit.data.consentRecord.participantType, "speaker", "consent tagged to speaker participant type");
  assertEqual(consentSubmit.data.consentRecord.requiredAcceptances.length, 4, "all required acceptances stored");
  assert(!consentSubmit.data.consentRecord.optionalPermissions.includes("marketing_communications"), "optional permissions stay separate, not bundled");

  // Consent is the last step of the guest flow — THIS is where the token finally gets consumed.
  const reuseToken = await jsonFetch(`/api/speaker-invites/${token}/profile`, { method: "POST", body: { fields: { displayName: "Should not land" } } });
  assertEqual(reuseToken.status, 410, "invite token is consumed once the full guest flow (profile -> tech check -> consent) completes");

  const consentList = await jsonFetch(`/api/sessions/${sessionId}/consent`, { cookie: organizer.cookie });
  assertEqual(consentList.data.consentRecords.length, 1, "organizer can list consent records for the session");

  console.log("\nSponsors + sponsor moments");
  const sponsorCreate = await jsonFetch(`/api/sessions/${sessionId}/sponsors`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { companyName: "Acme Corp", contactName: "Sam", contactEmail: "sam@acme.com" }
  });
  assertEqual(sponsorCreate.status, 201, "sponsor creates");
  assertEqual(sponsorCreate.data.sponsor.approvalStatus, "pending", "sponsor starts pending approval");
  const sponsorId = sponsorCreate.data.sponsor.id;

  const sponsorInvite = await jsonFetch(`/api/sponsors/${sponsorId}/invite`, { method: "POST", cookie: organizer.cookie, body: {} });
  const sponsorToken = sponsorInvite.data.token;
  const sponsorKit = await jsonFetch(`/api/sponsor-invites/${sponsorToken}/kit`, {
    method: "POST",
    body: { fields: { website: "https://acme.com", promoCode: "TOASTY20", talkingPoints: "Fast, cheap, reliable.", doNotSay: "Never say guaranteed returns." } }
  });
  assertEqual(sponsorKit.status, 200, "sponsor kit submission succeeds");
  assertEqual(sponsorKit.data.sponsor.promoCode, "TOASTY20", "sponsor kit fields persist");

  const sponsorApprove = await jsonFetch(`/api/sponsors/${sponsorId}/approve`, { method: "POST", cookie: organizer.cookie, body: { approvalStatus: "approved" } });
  assertEqual(sponsorApprove.data.sponsor.approvalStatus, "approved", "host/producer approval persists");

  const momentCreate = await jsonFetch(`/api/sessions/${sessionId}/sponsor-moments`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { sponsorId, label: "Acme mid-roll", startOffsetSeconds: 1080, treatment: "host_read" }
  });
  assertEqual(momentCreate.status, 201, "sponsor moment creates");
  const momentId = momentCreate.data.sponsorMoment.id;
  const momentOnScreen = await jsonFetch(`/api/sponsor-moments/${momentId}/status`, { method: "POST", cookie: organizer.cookie, body: { status: "on_screen" } });
  assertEqual(momentOnScreen.data.sponsorMoment.status, "on_screen", "Host 'put sponsor on screen' control persists");

  console.log("\nLanding page");
  const landingUpsert = await jsonFetch(`/api/sessions/${sessionId}/landing-page`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { slug: "q3-product-launch", blocks: [{ type: "hero", content: { title: "Q3 Launch" } }, { type: "not_a_real_block", content: {} }, { type: "sponsors", content: {} }] }
  });
  assertEqual(landingUpsert.status, 200, "landing page upserts");
  assertEqual(landingUpsert.data.landingPage.blocks.length, 2, "unknown block types are dropped, not stored");
  const prePublish = await jsonFetch(`/api/landing-pages/q3-product-launch`, {});
  assertEqual(prePublish.status, 404, "unpublished landing page is not publicly visible");
  const publish = await jsonFetch(`/api/sessions/${sessionId}/landing-page/publish`, { method: "POST", cookie: organizer.cookie, body: {} });
  assert(publish.data.landingPage.publishedAt, "publish sets publishedAt");
  const publicPage = await jsonFetch(`/api/landing-pages/q3-product-launch`, {});
  assertEqual(publicPage.status, 200, "published landing page is publicly readable");
  assert(!("ownerUserId" in publicPage.data.landingPage), "public landing page never exposes ownerUserId");

  const otherOrganizer = await jsonFetch("/auth/register", { method: "POST", body: { name: "Other", email: "other-eg@example.com", password: "password10chars" } });
  const otherSession = await jsonFetch("/api/sessions", { method: "POST", cookie: otherOrganizer.cookie, body: { roomId: "egtest2", title: "Different event" } });
  const slugClash = await jsonFetch(`/api/sessions/${otherSession.data.session.id}/landing-page`, {
    method: "POST",
    cookie: otherOrganizer.cookie,
    body: { slug: "q3-product-launch", blocks: [] }
  });
  assertEqual(slugClash.status, 409, "landing page slug is globally unique across tenants");

  console.log("\nAudience identity + event stream");
  const identity = await jsonFetch("/api/audience/identity", {
    method: "POST",
    body: { ownerUserId, anonymousId: "anon-visitor-1", displayName: "Curious Visitor" }
  });
  assertEqual(identity.status, 200, "anonymous identity upserts without auth (public endpoint)");
  const identityId = identity.data.identity.id;
  const identityAgain = await jsonFetch("/api/audience/identity", { method: "POST", body: { ownerUserId, anonymousId: "anon-visitor-1", knownEmail: "visitor@example.com" } });
  assertEqual(identityAgain.data.identity.id, identityId, "same anonymousId resolves to the same identity row");
  assertEqual(identityAgain.data.identity.knownEmail, "visitor@example.com", "identity can be enriched (registers) without losing history");

  const pageView = await jsonFetch("/api/audience/events", { method: "POST", body: { ownerUserId, sessionId, anonymousId: "anon-visitor-1", identityId, eventType: "PAGE_VIEW", source: "twitter", campaign: "launch-day" } });
  assertEqual(pageView.status, 201, "PAGE_VIEW event records");
  const badEvent = await jsonFetch("/api/audience/events", { method: "POST", body: { ownerUserId, sessionId, eventType: "MADE_UP_EVENT" } });
  assertEqual(badEvent.status, 400, "unknown event type is rejected, not silently accepted");
  await jsonFetch("/api/audience/events", { method: "POST", body: { ownerUserId, sessionId, anonymousId: "anon-visitor-1", identityId, eventType: "REGISTERED" } });
  await jsonFetch("/api/audience/events", { method: "POST", body: { ownerUserId, sessionId, anonymousId: "anon-visitor-2", eventType: "PAGE_VIEW" } });

  const summary = await jsonFetch(`/api/sessions/${sessionId}/audience/summary`, { cookie: organizer.cookie });
  assertEqual(summary.data.countsByType.PAGE_VIEW, 2, "summary counts by event type");
  assertEqual(summary.data.uniqueVisitors, 2, "summary counts unique visitors, not raw events");

  const eventsNoAuth = await jsonFetch(`/api/sessions/${sessionId}/audience/events`, {});
  assertEqual(eventsNoAuth.status, 401, "reading audience analytics requires the organizer's session");

  console.log("\nCampaign links");
  const linkCreate = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { slug: "ricardo-ref", campaign: "launch-day", source: "newsletter", destinationUrl: "https://toasty.media/o/toasty/q3-product-launch" }
  });
  assertEqual(linkCreate.status, 201, "campaign link creates");
  assertEqual(linkCreate.data.campaignLink.clickCount, 0, "campaign link starts at zero clicks");

  const dupSlug = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, { method: "POST", cookie: organizer.cookie, body: { slug: "ricardo-ref", campaign: "x" } });
  assertEqual(dupSlug.status, 409, "campaign link slugs are unique");

  const resolve1 = await jsonFetch(`/api/r/ricardo-ref`, {});
  assertEqual(resolve1.status, 302, "campaign link resolves as a redirect when it has a destination");
  assertEqual(resolve1.location, "https://toasty.media/o/toasty/q3-product-launch", "redirect target matches destinationUrl");
  await jsonFetch(`/api/r/ricardo-ref`, {});
  const links = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, { cookie: organizer.cookie });
  assertEqual(links.data.campaignLinks[0].clickCount, 2, "each resolve increments click_count — this is what 'Ricardo -> 42 registrations' style attribution is built from");

  console.log("\nBYOK usage telemetry (feature = the way this gets fed, not a public write route)");
  const noPublicWrite = await jsonFetch(`/api/sessions/${sessionId}/ai-usage`, { cookie: organizer.cookie });
  assertEqual(noPublicWrite.status, 200, "usage summary reads fine even with zero events recorded yet");
  assertEqual(noPublicWrite.data.totalTokens, 0, "no fabricated token counts when nothing has run");

  console.log("\nPost-event content hooks");
  const artifactCreate = await jsonFetch(`/api/sessions/${sessionId}/artifacts`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { artifactType: "clip", sourceMomentRef: "18:32-19:10", campaign: "launch-day", storageReference: "media-asset-id-123" }
  });
  assertEqual(artifactCreate.status, 201, "post-event artifact creates");
  assertEqual(artifactCreate.data.artifact.status, "draft", "artifact starts as draft, not fabricated as ready");
  const badArtifact = await jsonFetch(`/api/sessions/${sessionId}/artifacts`, { method: "POST", cookie: organizer.cookie, body: { artifactType: "not_a_real_type" } });
  assertEqual(badArtifact.status, 400, "unknown artifact type is rejected");
  const artifactList = await jsonFetch(`/api/sessions/${sessionId}/artifacts`, { cookie: organizer.cookie });
  assertEqual(artifactList.data.artifacts.length, 1, "artifacts list for the session");

  console.log("\nTenant isolation");
  const stolenSpeakers = await jsonFetch(`/api/sessions/${sessionId}/speakers`, { cookie: otherOrganizer.cookie });
  assertEqual(stolenSpeakers.status, 404, "another account cannot list this session's speakers");
  const stolenSponsorApprove = await jsonFetch(`/api/sponsors/${sponsorId}/approve`, { method: "POST", cookie: otherOrganizer.cookie, body: { approvalStatus: "approved" } });
  assertEqual(stolenSponsorApprove.status, 404, "another account cannot approve this session's sponsor");
  const stolenConsent = await jsonFetch(`/api/sessions/${sessionId}/consent`, { cookie: otherOrganizer.cookie });
  assertEqual(stolenConsent.status, 404, "another account cannot read this session's consent records");

  console.log("\nAll Event Growth server tests passed.");
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
