#!/usr/bin/env node
// Event Growth layer — Session Planner, Speakers, Consent, Sponsors, Landing Pages, Audience,
// Campaign Links, AI usage detail, Post-event hooks — against the real render-production-server,
// on the CURRENT organization/tenancy architecture (organizations/memberships, not owner_user_id-only).
// Same pattern as scripts/accounts-organizations-server-test.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4218;
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
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "event-growth-test-secret", RESEND_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function registerWithOrg(email) {
  const user = await jsonFetch("/auth/register", { method: "POST", body: { name: "Ricardo", email, password: "password10chars" } });
  assertEqual(user.status, 201, `${email} registers`);
  const orgs = await jsonFetch("/api/organizations", { cookie: user.cookie });
  assertEqual(orgs.data.organizations.length, 1, `${email} has exactly one auto-created organization`);
  assertEqual(orgs.data.organizations[0].role, "owner", `${email} is owner of their default organization`);
  return { cookie: user.cookie, userId: user.data.user.id, organizationId: orgs.data.organizations[0].id };
}

async function main() {
  await waitForHealth();

  console.log("Setup — register organizer, confirm org auto-provisioning, create session");
  const organizer = await registerWithOrg("organizer-eg@example.com");

  const created = await jsonFetch("/api/sessions", { method: "POST", cookie: organizer.cookie, body: { roomId: "egtest1", title: "Q3 Product Launch", brandId: "toasty" } });
  assertEqual(created.status, 200, "session creates");
  assertEqual(created.data.session.organizationId, organizer.organizationId, "session is auto-stamped with the organizer's own organization, not client-supplied");
  const sessionId = created.data.session.id;

  console.log("\nMulti-organization session creation (Session Planner org-selector fix)");
  // The organizer belongs to two organizations: their auto-provisioned "owner" org, and a second one
  // they explicitly created (simulating a member of a second team). Planner sessions must land in
  // whichever org the dashboard's switcher had selected, not always the owner-role default.
  const secondOrg = await jsonFetch("/api/organizations", { method: "POST", cookie: organizer.cookie, body: { name: "Ricardo's Second Org" } });
  assertEqual(secondOrg.status, 201, "organizer can create a second organization");
  const secondOrgId = secondOrg.data.organization.id;
  assert(secondOrgId !== organizer.organizationId, "second organization is a distinct id from the auto-provisioned owner org");

  // The demo plan allows only 1 concurrent session per org — free org A's slot (the "created" session
  // above) before proving explicit org-A targeting still works, the same way an organizer would end one
  // session before planning the next.
  await jsonFetch(`/api/sessions/${sessionId}/end`, { method: "POST", cookie: organizer.cookie, body: {} });
  const createdInOwnerOrg = await jsonFetch("/api/sessions", { method: "POST", cookie: organizer.cookie, body: { roomId: "egtest-orga", title: "Org A session", organizationId: organizer.organizationId } });
  assertEqual(createdInOwnerOrg.status, 200, "session creates when explicitly targeting org A (the owner org)");
  assertEqual(createdInOwnerOrg.data.session.organizationId, organizer.organizationId, "explicit organizationId=A lands the session in A, not blindly defaulted");
  await jsonFetch(`/api/sessions/${createdInOwnerOrg.data.session.id}/end`, { method: "POST", cookie: organizer.cookie, body: {} });

  const createdInSecondOrg = await jsonFetch("/api/sessions", { method: "POST", cookie: organizer.cookie, body: { roomId: "egtest-orgb", title: "Org B session", organizationId: secondOrgId } });
  assertEqual(createdInSecondOrg.status, 200, "session creates when explicitly targeting org B (the second org)");
  assertEqual(createdInSecondOrg.data.session.organizationId, secondOrgId, "explicit organizationId=B lands the session in B, matching the currently-selected org, not the owner org");

  const nonMember = await registerWithOrg("non-member-eg@example.com");
  const rejectedCreate = await jsonFetch("/api/sessions", { method: "POST", cookie: nonMember.cookie, body: { roomId: "egtest-hijack", title: "Should not be allowed", organizationId: secondOrgId } });
  assertEqual(rejectedCreate.status, 404, "a non-member cannot create a session into an arbitrary organization id (404, not 403, so membership is never confirmed to a non-member)");
  assert(!rejectedCreate.data.session, "the rejected create does not return a session");

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

  console.log("\nEvery Planner session type round-trips through the SAME plan storage (no per-type system)");
  // js/session-planner-page.js's SESSION_TYPES dropdown — mirrored here rather than imported, since this
  // is a Node test file exercising the server, not a browser module. sessionType is unvalidated plan
  // metadata (server just stores whatever string is sent), so this also proves the server never
  // special-cases or rejects any of them.
  const allSessionTypes = [
    "podcast", "interview", "panel", "focus_group", "webinar", "ama", "demo", "workshop", "prerecorded",
    "research_session", "product_launch", "community_call", "investor_update", "roundtable", "other"
  ];
  for (const sessionType of allSessionTypes) {
    const typeSet = await jsonFetch(`/api/sessions/${sessionId}/plan`, { method: "POST", cookie: organizer.cookie, body: { plan: { ...planSet.data.session.plan, sessionType } } });
    assertEqual(typeSet.status, 200, `sessionType "${sessionType}" saves through the same /plan route`);
    assertEqual(typeSet.data.session.plan.sessionType, sessionType, `sessionType "${sessionType}" round-trips exactly`);
    assertEqual(typeSet.data.session.id, sessionId, `sessionType "${sessionType}" is still the SAME durable session, not a new/different one`);
  }
  // Restore the type the rest of this file's assertions (Moxie facts, etc.) expect.
  await jsonFetch(`/api/sessions/${sessionId}/plan`, { method: "POST", cookie: organizer.cookie, body: { plan: { ...planSet.data.session.plan, sessionType: "product_launch" } } });

  console.log("\nSpeaker invite -> guest profile -> consent -> tech check");
  const speakerCreate = await jsonFetch(`/api/sessions/${sessionId}/speakers`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { email: "alice@example.com", sessionRole: "Guest", displayName: "Alice Placeholder" }
  });
  assertEqual(speakerCreate.status, 201, "speaker creates");
  assertEqual(speakerCreate.data.speaker.organizationId, organizer.organizationId, "speaker is stamped with the session's own organization");
  assertEqual(speakerCreate.data.speaker.inviteStatus, "not_sent", "speaker starts not_sent");
  const speakerId = speakerCreate.data.speaker.id;

  const inviteIssue = await jsonFetch(`/api/speakers/${speakerId}/invite`, { method: "POST", cookie: organizer.cookie, body: {} });
  assertEqual(inviteIssue.status, 201, "invite issues");
  assert(typeof inviteIssue.data.token === "string" && inviteIssue.data.token.length > 20, "invite returns a high-entropy raw token to the organizer");
  assert(serverOutput.includes("speaker for Q3 Product Launch"), "a real invite email was sent through the dev-mock transport, addressed with the actual event name");
  const token = inviteIssue.data.token;

  const afterInvite = await jsonFetch(`/api/sessions/${sessionId}/speakers`, { cookie: organizer.cookie });
  assertEqual(afterInvite.data.speakers[0].inviteStatus, "sent", "invite issue updates speaker status");

  // Guest path — no cookie, no account, just the token.
  const guestRead = await jsonFetch(`/api/speaker-invites/${token}`, {});
  assertEqual(guestRead.status, 200, "guest can read invite with token alone");
  assert(!("organizationId" in guestRead.data.speaker), "guest view never exposes organizationId");
  assertEqual(guestRead.data.event.title, "Q3 Product Launch", "guest sees the real event name");

  const badToken = await jsonFetch(`/api/speaker-invites/not-a-real-token`, {});
  assertEqual(badToken.status, 404, "wrong token is rejected");

  const profileSubmit = await jsonFetch(`/api/speaker-invites/${token}/profile`, {
    method: "POST",
    body: { fields: { displayName: "Alice Chen", title: "VP Engineering", company: "Acme", bioShort: "Builds things.", links: { linkedin: "https://linkedin.com/in/alice", other: "ignored-key-should-be-dropped" }, peepsPersonId: "should-be-ignored-in-guest-mode", selectionReason: "should also be ignored" } }
  });
  assertEqual(profileSubmit.status, 200, "guest profile submission succeeds");
  assertEqual(profileSubmit.data.speaker.displayName, "Alice Chen", "profile fields persist");
  assertEqual(profileSubmit.data.speaker.peepsPersonId, null, "organizer-only Peeps-bridge fields are not guest-writable");
  assertEqual(profileSubmit.data.speaker.selectionReason, "", "selectionReason is not guest-writable either");
  assert(profileSubmit.data.speaker.profileSubmittedAt, "profile submission timestamp is set");

  const afterProfile = await jsonFetch(`/api/sessions/${sessionId}/speakers`, { cookie: organizer.cookie });
  assertEqual(afterProfile.data.speakers[0].inviteStatus, "accepted", "profile submission marks speaker accepted");

  const reReadAfterProfile = await jsonFetch(`/api/speaker-invites/${token}`, {});
  assertEqual(reReadAfterProfile.status, 200, "the same invite token still works right after profile submission (needed for tech-check + consent)");

  const techCheck = await jsonFetch(`/api/speaker-invites/${token}/tech-check`, {
    method: "POST",
    body: { cameraOk: true, micOk: true, speakerOk: false, browserSupported: true, connectionOutcome: "good", deviceLabels: ["FaceTime HD Camera"] }
  });
  assertEqual(techCheck.status, 201, "tech check records");
  assertEqual(techCheck.data.techCheck.speakerOk, false, "tech check preserves a real failure, not just happy path");

  const orgTechCheckRead = await jsonFetch(`/api/speakers/${speakerId}/tech-check`, { cookie: organizer.cookie });
  assertEqual(orgTechCheckRead.status, 200, "organizer can read a speaker's latest tech check");
  assertEqual(orgTechCheckRead.data.techCheck.speakerOk, false, "organizer sees the same real result the guest submitted");

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
  assert(serverOutput.includes("sponsor kit for Q3 Product Launch"), "a real sponsor invite email was sent through the dev-mock transport");
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
  assertEqual(landingUpsert.data.landingPage.status, "draft", "landing page starts as draft");
  const prePublish = await jsonFetch(`/api/landing-pages/q3-product-launch`, {});
  assertEqual(prePublish.status, 404, "draft landing page is not publicly visible");
  const publish = await jsonFetch(`/api/sessions/${sessionId}/landing-page/publish`, { method: "POST", cookie: organizer.cookie, body: {} });
  assertEqual(publish.data.landingPage.status, "published", "publish flips status");
  assert(publish.data.landingPage.publishedAt, "publish sets publishedAt");
  const publicPage = await jsonFetch(`/api/landing-pages/q3-product-launch`, {});
  assertEqual(publicPage.status, 200, "published landing page is publicly readable");
  assert(!("organizationId" in publicPage.data.landingPage), "public landing page never exposes organizationId");
  assert(publicPage.data.landingPage.sessionId, "public landing page does expose sessionId — the public renderer needs it to record audience events");

  const unpublish = await jsonFetch(`/api/sessions/${sessionId}/landing-page/unpublish`, { method: "POST", cookie: organizer.cookie, body: {} });
  assertEqual(unpublish.status, 200, "unpublish succeeds");
  assertEqual(unpublish.data.landingPage.status, "draft", "unpublish flips status back to draft");
  const goneFromPublic = await jsonFetch(`/api/landing-pages/q3-product-launch`, {});
  assertEqual(goneFromPublic.status, 404, "an unpublished event page is no longer publicly visible — never a fake 'published' state");
  const republish = await jsonFetch(`/api/sessions/${sessionId}/landing-page/publish`, { method: "POST", cookie: organizer.cookie, body: {} });
  assertEqual(republish.data.landingPage.status, "published", "republishing after unpublish works");

  const otherOrganizer = await registerWithOrg("other-eg@example.com");
  const otherSession = await jsonFetch("/api/sessions", { method: "POST", cookie: otherOrganizer.cookie, body: { roomId: "egtest2", title: "Different event" } });
  assert(otherSession.data.session.organizationId !== organizer.organizationId, "two independently-registered accounts land in two different organizations");
  const slugClash = await jsonFetch(`/api/sessions/${otherSession.data.session.id}/landing-page`, {
    method: "POST",
    cookie: otherOrganizer.cookie,
    body: { slug: "q3-product-launch", blocks: [] }
  });
  assertEqual(slugClash.status, 409, "landing page slug is globally unique across organizations");

  console.log("\nAudience identity + event stream");
  const identity = await jsonFetch("/api/audience/identity", {
    method: "POST",
    body: { organizationId: organizer.organizationId, anonymousId: "anon-visitor-1", displayName: "Curious Visitor" }
  });
  assertEqual(identity.status, 200, "anonymous identity upserts without auth (public endpoint)");
  const identityId = identity.data.identity.id;
  const identityAgain = await jsonFetch("/api/audience/identity", { method: "POST", body: { organizationId: organizer.organizationId, anonymousId: "anon-visitor-1", knownEmail: "visitor@example.com" } });
  assertEqual(identityAgain.data.identity.id, identityId, "same anonymousId resolves to the same identity row");
  assertEqual(identityAgain.data.identity.knownEmail, "visitor@example.com", "identity can be enriched (registers) without losing history");

  const bogusOrg = await jsonFetch("/api/audience/identity", { method: "POST", body: { organizationId: "org_does_not_exist", anonymousId: "anon-x" } });
  assertEqual(bogusOrg.status, 404, "identity upsert against a non-existent organization is rejected");

  // The public event page renderer only ever learns a session id (organizationId is deliberately never
  // exposed through /api/landing-pages/:slug) — identity/events recording must derive organizationId
  // server-side from that sessionId, exactly like every other Event Growth child row, not trust the
  // client for it.
  const identityBySession = await jsonFetch("/api/audience/identity", { method: "POST", body: { sessionId, anonymousId: "anon-visitor-session-derived" } });
  assertEqual(identityBySession.status, 200, "identity upsert works when given a sessionId instead of an organizationId");
  const identityBogusSession = await jsonFetch("/api/audience/identity", { method: "POST", body: { sessionId: "ls_does_not_exist", anonymousId: "anon-y" } });
  assertEqual(identityBogusSession.status, 404, "identity upsert against a non-existent sessionId is rejected");

  // Fired against otherSession (otherOrganizer's own session) rather than the main sessionId under test,
  // so this doesn't perturb the countsByType/uniqueVisitors assertions below.
  const eventSpoofedOrg = await jsonFetch("/api/audience/events", {
    method: "POST",
    body: { organizationId: organizer.organizationId, sessionId: otherSession.data.session.id, anonymousId: "anon-spoof-check", eventType: "PAGE_VIEW" }
  });
  assertEqual(eventSpoofedOrg.status, 201, "audience event recording ignores a client-supplied organizationId that doesn't match the session");
  assertEqual(eventSpoofedOrg.data.event.organizationId, otherOrganizer.organizationId, "the event is attributed to the session's REAL organization (otherOrganizer's), not the client-supplied (mismatched, organizer's) one — never spoofable");
  const eventBogusSession = await jsonFetch("/api/audience/events", { method: "POST", body: { sessionId: "ls_does_not_exist", anonymousId: "anon-z", eventType: "PAGE_VIEW" } });
  assertEqual(eventBogusSession.status, 404, "audience event recording against a non-existent sessionId is rejected");

  const pageView = await jsonFetch("/api/audience/events", { method: "POST", body: { organizationId: organizer.organizationId, sessionId, anonymousId: "anon-visitor-1", identityId, eventType: "PAGE_VIEW", source: "twitter", campaign: "launch-day" } });
  assertEqual(pageView.status, 201, "PAGE_VIEW event records");
  const badEvent = await jsonFetch("/api/audience/events", { method: "POST", body: { organizationId: organizer.organizationId, sessionId, eventType: "MADE_UP_EVENT" } });
  assertEqual(badEvent.status, 400, "unknown event type is rejected, not silently accepted");
  await jsonFetch("/api/audience/events", { method: "POST", body: { organizationId: organizer.organizationId, sessionId, anonymousId: "anon-visitor-1", identityId, eventType: "REGISTERED" } });
  await jsonFetch("/api/audience/events", { method: "POST", body: { organizationId: organizer.organizationId, sessionId, anonymousId: "anon-visitor-2", eventType: "PAGE_VIEW" } });

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

  const badRedirect = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, { method: "POST", cookie: organizer.cookie, body: { slug: "bad-one", destinationUrl: "javascript:alert(1)" } });
  assertEqual(badRedirect.status, 400, "a javascript: destination URL is rejected");
  const badRedirect2 = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, { method: "POST", cookie: organizer.cookie, body: { slug: "bad-two", destinationUrl: "ftp://example.com/x" } });
  assertEqual(badRedirect2.status, 400, "a non-http(s) destination URL is rejected");

  const dupSlug = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, { method: "POST", cookie: organizer.cookie, body: { slug: "ricardo-ref", campaign: "x" } });
  assertEqual(dupSlug.status, 409, "campaign link slugs are unique");

  const resolve1 = await jsonFetch(`/api/r/ricardo-ref`, {});
  assertEqual(resolve1.status, 302, "campaign link resolves as a redirect when it has a destination");
  assertEqual(resolve1.location, "https://toasty.media/o/toasty/q3-product-launch", "redirect target matches destinationUrl");
  await jsonFetch(`/api/r/ricardo-ref`, {});
  const links = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, { cookie: organizer.cookie });
  assertEqual(links.data.campaignLinks[0].clickCount, 2, "each resolve increments click_count — this is what 'Ricardo -> 42 registrations' style attribution is built from");
  assertEqual(links.data.campaignLinks[0].isActive, true, "campaign links start active");

  const sponsorLinkCreate = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, {
    method: "POST",
    cookie: organizer.cookie,
    body: { slug: "sponsor-ref", sponsorId, destinationUrl: "https://acme.example.com/promo" }
  });
  assertEqual(sponsorLinkCreate.data.campaignLink.sponsorId, sponsorId, "a campaign link can be tagged to a sponsor, for basic per-sponsor attribution");
  const sponsorLinkId = sponsorLinkCreate.data.campaignLink.id;

  const disableNoAuth = await jsonFetch(`/api/campaign-links/${sponsorLinkId}/active`, { method: "POST", body: { isActive: false } });
  assertEqual(disableNoAuth.status, 401, "disabling a campaign link requires the organizer's session");
  const disableWrongOwner = await jsonFetch(`/api/campaign-links/${sponsorLinkId}/active`, { method: "POST", cookie: otherOrganizer.cookie, body: { isActive: false } });
  assertEqual(disableWrongOwner.status, 404, "a different organizer cannot disable this session's campaign link");

  const disable = await jsonFetch(`/api/campaign-links/${sponsorLinkId}/active`, { method: "POST", cookie: organizer.cookie, body: { isActive: false } });
  assertEqual(disable.status, 200, "organizer can disable their own campaign link");
  assertEqual(disable.data.campaignLink.isActive, false, "disable flips isActive");
  const disabledResolve = await jsonFetch(`/api/r/sponsor-ref`, {});
  assertEqual(disabledResolve.status, 404, "a disabled campaign link 404s on resolve — exactly like a link that never existed");

  const reenable = await jsonFetch(`/api/campaign-links/${sponsorLinkId}/active`, { method: "POST", cookie: organizer.cookie, body: { isActive: true } });
  assertEqual(reenable.data.campaignLink.isActive, true, "re-enabling works");
  const reenabledResolve = await jsonFetch(`/api/r/sponsor-ref`, {});
  assertEqual(reenabledResolve.status, 302, "a re-enabled campaign link resolves again, with its click_count/history intact (disable is never a delete)");

  console.log("\nAI usage detail (additive to the org's real usage_counters.ai_requests, never a parallel system)");
  const usageBefore = await jsonFetch(`/api/organizations/${organizer.organizationId}/usage`, { cookie: organizer.cookie });
  const aiRequestsBefore = usageBefore.data.usage?.month?.aiRequests || 0;
  const summaryBefore = await jsonFetch(`/api/sessions/${sessionId}/ai-usage`, { cookie: organizer.cookie });
  assertEqual(summaryBefore.status, 200, "ai usage summary reads fine even with zero events recorded yet");
  assertEqual(summaryBefore.data.totalTokens, 0, "no fabricated token counts when nothing has run");
  // No BYOK credential configured for this org — the Moxie readiness-summary hook must refuse exactly
  // like /api/ai-producer/respond does, never falling back to a platform key.
  const moxieNoByok = await jsonFetch(`/api/sessions/${sessionId}/moxie/readiness-summary`, { method: "POST", cookie: organizer.cookie, body: {} });
  assertEqual(moxieNoByok.status, 402, "Moxie readiness summary refuses without an organization AI credential");
  assertEqual(moxieNoByok.data.error, "byok_required", "refusal uses the same byok_required error shape as AI Producer");
  assertEqual(
    moxieNoByok.data.message,
    "Moxie requires an AI provider. Connect your API key to enable research, production intelligence, and live assistance.",
    "refusal uses the exact canonical BYOK message, word for word"
  );
  const usageAfter = await jsonFetch(`/api/organizations/${organizer.organizationId}/usage`, { cookie: organizer.cookie });
  assertEqual(usageAfter.data.usage?.month?.aiRequests || 0, aiRequestsBefore, "a refused (no-credential) AI call never increments usage_counters.ai_requests");

  console.log("\nThe other four Moxie Event Growth hooks — same BYOK gate, same canonical message, never a platform-key fallback");
  const otherMoxieHooks = [
    { path: "moxie/speaker-briefing", body: { speakerId } },
    { path: "moxie/session-research", body: {} },
    { path: "moxie/audience-insights", body: {} },
    { path: "moxie/post-event-suggestions", body: {} }
  ];
  for (const hook of otherMoxieHooks) {
    const refusal = await jsonFetch(`/api/sessions/${sessionId}/${hook.path}`, { method: "POST", cookie: organizer.cookie, body: hook.body });
    assertEqual(refusal.status, 402, `${hook.path} refuses without an organization AI credential`);
    assertEqual(refusal.data.error, "byok_required", `${hook.path} refusal uses the byok_required error shape`);
    assertEqual(
      refusal.data.message,
      "Moxie requires an AI provider. Connect your API key to enable research, production intelligence, and live assistance.",
      `${hook.path} refusal uses the exact canonical BYOK message, word for word`
    );
  }
  const usageAfterOthers = await jsonFetch(`/api/organizations/${organizer.organizationId}/usage`, { cookie: organizer.cookie });
  assertEqual(usageAfterOthers.data.usage?.month?.aiRequests || 0, aiRequestsBefore, "none of the four refused (no-credential) hooks incremented usage_counters.ai_requests");

  const briefingBadSpeaker = await jsonFetch(`/api/sessions/${sessionId}/moxie/speaker-briefing`, { method: "POST", cookie: organizer.cookie, body: {} });
  assertEqual(briefingBadSpeaker.status, 400, "speaker briefing requires a speakerId (validated before the BYOK gate, so this isn't hidden behind a 402)");
  // organizer legitimately owns BOTH sessionId (which speakerId actually belongs to) and
  // createdInSecondOrg (org B) — proves the cross-session speaker check, not just an ownership check.
  const briefingOtherSpeaker = await jsonFetch(`/api/sessions/${createdInSecondOrg.data.session.id}/moxie/speaker-briefing`, { method: "POST", cookie: organizer.cookie, body: { speakerId } });
  assertEqual(briefingOtherSpeaker.status, 404, "speaker briefing rejects a speakerId that belongs to a different session, even one the same organizer owns");

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
  const artifactId = artifactCreate.data.artifact.id;

  const badStatus = await jsonFetch(`/api/artifacts/${artifactId}/update`, { method: "POST", cookie: organizer.cookie, body: { status: "definitely_ready" } });
  assertEqual(badStatus.status, 400, "an unknown artifact status is rejected — never a free-text fake state");
  const markProcessing = await jsonFetch(`/api/artifacts/${artifactId}/update`, { method: "POST", cookie: organizer.cookie, body: { status: "processing" } });
  assertEqual(markProcessing.data.artifact.status, "processing", "organizer can move an artifact from draft to processing");
  const markReady = await jsonFetch(`/api/artifacts/${artifactId}/update`, { method: "POST", cookie: organizer.cookie, body: { status: "ready", storageReference: "final-render-id-456" } });
  assertEqual(markReady.data.artifact.status, "ready", "organizer can mark an artifact ready once they've actually produced it");
  assertEqual(markReady.data.artifact.storageReference, "final-render-id-456", "storageReference updates alongside status");
  const stolenArtifactUpdate = await jsonFetch(`/api/artifacts/${artifactId}/update`, { method: "POST", cookie: otherOrganizer.cookie, body: { status: "ready" } });
  assertEqual(stolenArtifactUpdate.status, 404, "a different organizer cannot flip this session's artifact status");
  const noAuthArtifactUpdate = await jsonFetch(`/api/artifacts/${artifactId}/update`, { method: "POST", body: { status: "ready" } });
  assertEqual(noAuthArtifactUpdate.status, 401, "updating an artifact's status requires the organizer's session");

  console.log("\nCross-organization tenant isolation (a session/child row owned by a DIFFERENT account)");
  const stolenSpeakers = await jsonFetch(`/api/sessions/${sessionId}/speakers`, { cookie: otherOrganizer.cookie });
  assertEqual(stolenSpeakers.status, 404, "another account cannot list this session's speakers");
  const stolenSpeakerUpdate = await jsonFetch(`/api/speakers/${speakerId}/update`, { method: "POST", cookie: otherOrganizer.cookie, body: { fields: { displayName: "hijacked" } } });
  assertEqual(stolenSpeakerUpdate.status, 404, "another account cannot update this session's speaker");
  const stolenSponsorApprove = await jsonFetch(`/api/sponsors/${sponsorId}/approve`, { method: "POST", cookie: otherOrganizer.cookie, body: { approvalStatus: "approved" } });
  assertEqual(stolenSponsorApprove.status, 404, "another account cannot approve this session's sponsor");
  const stolenConsent = await jsonFetch(`/api/sessions/${sessionId}/consent`, { cookie: otherOrganizer.cookie });
  assertEqual(stolenConsent.status, 404, "another account cannot read this session's consent records");
  const stolenAudience = await jsonFetch(`/api/sessions/${sessionId}/audience/summary`, { cookie: otherOrganizer.cookie });
  assertEqual(stolenAudience.status, 404, "another account cannot read this session's audience analytics");
  const stolenCampaignLinks = await jsonFetch(`/api/sessions/${sessionId}/campaign-links`, { cookie: otherOrganizer.cookie });
  assertEqual(stolenCampaignLinks.status, 404, "another account cannot read this session's campaign links");
  const stolenArtifacts = await jsonFetch(`/api/sessions/${sessionId}/artifacts`, { cookie: otherOrganizer.cookie });
  assertEqual(stolenArtifacts.status, 404, "another account cannot read this session's post-event artifacts");
  const stolenPlan = await jsonFetch(`/api/sessions/${sessionId}/plan`, { method: "POST", cookie: otherOrganizer.cookie, body: { plan: { sessionType: "hijacked" } } });
  assertEqual(stolenPlan.status, 404, "another account cannot set this session's plan (requireOwnedSession gates before session_set_plan ever runs)");
  const planUnchanged = await jsonFetch(`/api/sessions/${sessionId}`, { cookie: organizer.cookie });
  assertEqual(planUnchanged.data.session.plan.sessionType, "product_launch", "the plan a non-owner tried to set never actually landed — the real owner's plan is untouched");

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
