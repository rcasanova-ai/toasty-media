#!/usr/bin/env node
// HTTP-level integration test for the Organizations/Members/Settings/Brand-Profiles API layer — same
// pattern as scripts/session-management-server-test.mjs. Covers CRUD, role-based authorization, the
// invite flow, and — explicitly required by the brief — tenancy isolation: one organization's members,
// settings, and brand data must be completely unreachable from another organization's account.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4210;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-accounts-orgs-"));
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

function latestTokenFor(pathFragment, marker) {
  const scoped = marker ? serverOutput.slice(serverOutput.lastIndexOf(marker)) : serverOutput;
  const pattern = new RegExp(`${pathFragment}\\?token=([A-Za-z0-9_-]+)`, "g");
  let match;
  let last = null;
  while ((match = pattern.exec(scoped))) last = match[1];
  if (!last) throw new Error(`No token found in server output for ${pathFragment}`);
  return last;
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "accounts-orgs-test-secret", RESEND_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  console.log("Signup auto-creates an organization; it's readable, updatable, and has default settings");
  const owner = await jsonFetch("/auth/register", { method: "POST", body: { name: "Priya Owner", email: "priya@example.com", password: "password10chars" } });
  assert(owner.status === 201, "owner registers");
  const orgList = await jsonFetch("/api/organizations", { cookie: owner.cookie });
  assert(orgList.data.organizations.length === 1, "the owner has exactly one organization");
  const orgId = orgList.data.organizations[0].id;
  assert(orgList.data.organizations[0].role === "owner", "the auto-created membership is owner");

  const orgGet = await jsonFetch(`/api/organizations/${orgId}`, { cookie: owner.cookie });
  assert(orgGet.status === 200 && orgGet.data.organization.id === orgId, "the owner can GET their own organization");

  const orgUpdate = await jsonFetch(`/api/organizations/${orgId}/update`, { method: "POST", cookie: owner.cookie, body: { name: "Priya's Renamed Studio" } });
  assert(orgUpdate.data.organization.name === "Priya's Renamed Studio", "the owner can rename their organization");

  const planEscalation = await jsonFetch(`/api/organizations/${orgId}/update`, { method: "POST", cookie: owner.cookie, body: { name: "x", plan: "enterprise" } });
  assert(planEscalation.data.organization.plan !== "enterprise", "plan can NEVER be set through the generic update route, even by the owner — only billing confirmation can grant entitlements");

  const settingsGet = await jsonFetch(`/api/organizations/${orgId}/settings`, { cookie: owner.cookie });
  assert(settingsGet.data.settings.timezone === "UTC", "organization settings exist with sane defaults immediately after signup");

  const settingsUpdate = await jsonFetch(`/api/organizations/${orgId}/settings`, { method: "POST", cookie: owner.cookie, body: { websiteUrl: "https://priyas.studio", socialLinks: { x: "https://x.com/priya" } } });
  assert(settingsUpdate.data.settings.websiteUrl === "https://priyas.studio", "settings update persists");

  console.log("\nBrand profiles — organization-owned, reachable by their own id");
  const brandCreate = await jsonFetch(`/api/organizations/${orgId}/brand-profiles`, { method: "POST", cookie: owner.cookie, body: { name: "Launch brand", baseThemeId: "toasty", overrides: { primaryColor: "#112233" } } });
  assert(brandCreate.status === 201, "the owner can create a brand profile");
  const brandId = brandCreate.data.brandProfile.id;
  const brandUpdate = await jsonFetch(`/api/brand-profiles/${brandId}/update`, { method: "POST", cookie: owner.cookie, body: { name: "Renamed brand" } });
  assert(brandUpdate.data.brandProfile.name === "Renamed brand", "brand profile update works by its own id");

  console.log("\nInviting a member — a real account, correct role, wrong-role rejected for invite-as-owner");
  const invitedUser = await jsonFetch("/auth/register", { method: "POST", body: { name: "Sam Member", email: "sam@example.com", password: "password10chars" } });
  assert(invitedUser.status === 201, "the invitee already has their own (separate) account/organization");

  const badRoleInvite = await jsonFetch(`/api/organizations/${orgId}/members/invite`, { method: "POST", cookie: owner.cookie, body: { email: "sam@example.com", role: "owner" } });
  assert(badRoleInvite.status === 201, "an invite request with role=owner is accepted but silently downgraded, never granting ownership via invite");
  const invite = await jsonFetch(`/api/organizations/${orgId}/members`, { cookie: owner.cookie });
  assert(invite.data.pendingInvites[0].role !== "owner", "the stored pending invite's role is never 'owner'");

  const memberInvite = await jsonFetch(`/api/organizations/${orgId}/members/invite`, { method: "POST", cookie: owner.cookie, body: { email: "sam@example.com", role: "admin" } });
  assert(memberInvite.status === 201, "inviting as admin succeeds");
  const inviteToken = latestTokenFor("accept-invite.html", "to=sam@example.com");

  const wrongPersonAccept = await jsonFetch("/api/invites/accept", { method: "POST", cookie: owner.cookie, body: { token: inviteToken } });
  assert(wrongPersonAccept.status === 403, "the inviter themselves cannot accept an invite addressed to someone else's email");

  const invitedLogin = await jsonFetch("/auth/login", { method: "POST", body: { email: "sam@example.com", password: "password10chars" } });
  const accept = await jsonFetch("/api/invites/accept", { method: "POST", cookie: invitedLogin.cookie, body: { token: inviteToken } });
  assert(accept.status === 200 && accept.data.organizationId === orgId, "the correct invitee accepts and joins the organization");
  const reAccept = await jsonFetch("/api/invites/accept", { method: "POST", cookie: invitedLogin.cookie, body: { token: inviteToken } });
  assert(reAccept.status === 400, "the same invite token cannot be accepted twice");

  const membersAfterAccept = await jsonFetch(`/api/organizations/${orgId}/members`, { cookie: owner.cookie });
  assert(membersAfterAccept.data.members.length === 2, "the organization now has 2 members");
  const samMembership = membersAfterAccept.data.members.find((m) => m.userEmail === "sam@example.com");
  assert(samMembership.role === "admin", "sam joined with the invited role (admin)");

  console.log("\nRole-based authorization — an admin-role member can update the org; after a downgrade, a plain member cannot");
  const samUserId = samMembership.userId;
  const adminCanUpdate = await jsonFetch(`/api/organizations/${orgId}/update`, { method: "POST", cookie: invitedLogin.cookie, body: { name: "Updated by admin" } });
  assert(adminCanUpdate.status === 200, "an admin-role member CAN update the organization");

  const roleDowngrade = await jsonFetch(`/api/organizations/${orgId}/members/role`, { method: "POST", cookie: owner.cookie, body: { userId: samUserId, role: "member" } });
  assert(roleDowngrade.status === 200 && roleDowngrade.data.membership.role === "member", "the owner can downgrade an admin to member");

  const memberTriesUpdate = await jsonFetch(`/api/organizations/${orgId}/update`, { method: "POST", cookie: invitedLogin.cookie, body: { name: "hijacked again" } });
  assert(memberTriesUpdate.status === 403, "a plain member CANNOT update the organization (role was just downgraded)");

  const memberTriesInvite = await jsonFetch(`/api/organizations/${orgId}/members/invite`, { method: "POST", cookie: invitedLogin.cookie, body: { email: "third@example.com" } });
  assert(memberTriesInvite.status === 403, "a plain member cannot invite new members");

  console.log("\nLast-owner protection — an organization can never be left with zero owners");
  const soleOwnerDemote = await jsonFetch(`/api/organizations/${orgId}/members/role`, { method: "POST", cookie: owner.cookie, body: { userId: owner.data.user.id, role: "admin" } });
  assert(soleOwnerDemote.status === 400, "the sole owner cannot demote themselves (would leave zero owners)");
  const soleOwnerRemove = await jsonFetch(`/api/organizations/${orgId}/members/remove`, { method: "POST", cookie: owner.cookie, body: { userId: owner.data.user.id } });
  assert(soleOwnerRemove.status === 400, "an owner also cannot remove THEMSELVES via the member-removal route (must use a dedicated leave/transfer flow)");

  console.log("\n--- Tenancy isolation (explicitly required) ---");
  const outsider = await jsonFetch("/auth/register", { method: "POST", body: { name: "Eve Outsider", email: "eve@example.com", password: "password10chars" } });
  assert(outsider.status === 201, "a completely unrelated account exists");

  const stolenGet = await jsonFetch(`/api/organizations/${orgId}`, { cookie: outsider.cookie });
  assert(stolenGet.status === 404, "a non-member GETting another organization by id sees 404, not the data (and not 403, which would confirm existence)");

  const stolenSettings = await jsonFetch(`/api/organizations/${orgId}/settings`, { cookie: outsider.cookie });
  assert(stolenSettings.status === 404, "a non-member cannot read another organization's settings");

  const stolenMembers = await jsonFetch(`/api/organizations/${orgId}/members`, { cookie: outsider.cookie });
  assert(stolenMembers.status === 404, "a non-member cannot list another organization's members");

  const stolenBrand = await jsonFetch(`/api/brand-profiles/${brandId}/update`, { method: "POST", cookie: outsider.cookie, body: { name: "hijacked brand" } });
  assert(stolenBrand.status === 404, "a non-member cannot update another organization's brand profile, even knowing its id");

  const stolenInvite = await jsonFetch(`/api/organizations/${orgId}/members/invite`, { method: "POST", cookie: outsider.cookie, body: { email: "anyone@example.com" } });
  assert(stolenInvite.status === 404, "a non-member cannot invite people into another organization");

  const outsiderOrgList = await jsonFetch("/api/organizations", { cookie: outsider.cookie });
  assert(!outsiderOrgList.data.organizations.some((o) => o.id === orgId), "listing MY organizations never includes an organization I'm not a member of");

  console.log("\nAll accounts organizations server tests passed.");
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
