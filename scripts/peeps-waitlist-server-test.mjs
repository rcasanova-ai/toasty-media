#!/usr/bin/env node
// Real-server regression for the Peeps private-beta waitlist: public signup, duplicate handling,
// persistence, platform-admin visibility/status/invite, and role isolation.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4231;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-peeps-waitlist-"));
const dbPath = join(scratch, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
function assert(v, m) { if (!v) throw new Error("FAILED: " + m); console.log("ok - " + m); }
function cookieFrom(r) { return (r.headers.get("set-cookie") || "").split(";")[0]; }
async function req(path, { method = "GET", cookie, body, csrf = true, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (csrf) headers["x-toasty-csrf"] = "1";
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  return { status: r.status, data, cookie: cookieFrom(r) || cookie };
}
async function waitHealth() { for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 100)); } throw new Error("server did not start"); }
function scalar(sql) {
  const r = spawnSync("python3", ["-c", `import sqlite3,sys
c=sqlite3.connect(${JSON.stringify(dbPath)})
r=c.execute(sys.argv[1]).fetchone()
print(r[0] if r else "")`, sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "peeps-waitlist-test", RESEND_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
server.stdout.on("data", (c) => { output += c; });
server.stderr.on("data", (c) => { output += c; });

async function main() {
  await waitHealth();

  // Public signup needs no session, persists, and captures source/referrer/UTM.
  const first = await req("/api/peeps/waitlist", {
    method: "POST",
    body: {
      name: "Ada Judge", email: "Ada@Example.com", company: "Colosseum", useCase: "Finding experts for my agent", consent: true,
      source: "peeps-landing", referrer: "https://www.example.org/post",
      utm: { utm_source: "newsletter", utm_campaign: "launch", utm_bogus: "dropped" }
    }
  });
  assert(first.status === 201 && first.data.status === "joined", "anonymous visitor can join the waitlist");
  assert(scalar("SELECT COUNT(*) FROM peeps_waitlist") === "1", "signup is persisted in the database");
  assert(scalar("SELECT email FROM peeps_waitlist") === "ada@example.com", "email is normalised to lowercase");
  assert(scalar("SELECT status FROM peeps_waitlist") === "waitlist", "new entries start with status waitlist");
  assert(scalar("SELECT source FROM peeps_waitlist") === "peeps-landing" && scalar("SELECT referrer FROM peeps_waitlist") === "https://www.example.org/post", "source and referrer are captured");
  const utm = JSON.parse(scalar("SELECT utm_json FROM peeps_waitlist"));
  assert(utm.utm_source === "newsletter" && utm.utm_campaign === "launch" && !("utm_bogus" in utm), "only known UTM parameters are stored");
  assert(Boolean(scalar("SELECT created_at FROM peeps_waitlist")) && Boolean(scalar("SELECT consent_at FROM peeps_waitlist")), "timestamp and consent time are recorded");

  // Duplicates (any casing) are a friendly success, never an error, and never a second row.
  const dup = await req("/api/peeps/waitlist", { method: "POST", body: { name: "Someone Else", email: "ada@EXAMPLE.com", consent: true } });
  assert(dup.status === 200 && dup.data.status === "already_on_list", "duplicate email gets a friendly already-on-list response");
  assert(scalar("SELECT COUNT(*) FROM peeps_waitlist") === "1", "duplicate does not create a second row");
  assert(scalar("SELECT name FROM peeps_waitlist") === "Ada Judge", "duplicate does not overwrite the original entry");
  assert(!JSON.stringify(dup.data).includes("Ada Judge"), "duplicate response does not leak the existing entry");

  // Validation, consent, CSRF, honeypot.
  assert((await req("/api/peeps/waitlist", { method: "POST", body: { name: "", email: "x@example.com", consent: true } })).status === 400, "name is required");
  assert((await req("/api/peeps/waitlist", { method: "POST", body: { name: "X", email: "not-an-email", consent: true } })).status === 400, "email must be valid");
  assert((await req("/api/peeps/waitlist", { method: "POST", body: { name: "X", email: "x@example.com" } })).status === 400, "consent is required");
  assert((await req("/api/peeps/waitlist", { method: "POST", csrf: false, body: { name: "X", email: "x@example.com", consent: true } })).status === 403, "signup requires the CSRF header");
  assert((await req("/api/peeps/waitlist", { method: "POST", headers: { origin: "https://evil.example" }, body: { name: "X", email: "x@example.com", consent: true } })).status === 403, "signup rejects foreign origins");
  const bot = await req("/api/peeps/waitlist", { method: "POST", body: { name: "Bot", email: "bot@example.com", consent: true, website: "http://spam" } });
  assert(bot.status === 201 && scalar("SELECT COUNT(*) FROM peeps_waitlist WHERE email='bot@example.com'") === "0", "honeypot submissions are silently dropped");
  const second = await req("/api/peeps/waitlist", { method: "POST", body: { name: "Grace Hopper", email: "grace@example.com", consent: true } });
  assert(second.status === 201 && scalar("SELECT COUNT(*) FROM peeps_waitlist") === "2", "optional company and use case may be omitted");

  // Admin visibility + isolation.
  assert((await req("/api/organizations/platform-admin/peeps-waitlist")).status === 401, "anonymous visitor cannot read the waitlist");
  const founder = await req("/auth/register", { method: "POST", body: { name: "Founder", email: "founder@example.com", password: "password10chars" } });
  assert(founder.status === 201, "founder registers (platform admin)");
  const customer = await req("/auth/register", { method: "POST", body: { name: "Customer", email: "customer@example.com", password: "password10chars" } });
  assert((await req("/api/organizations/platform-admin/peeps-waitlist", { cookie: customer.cookie })).status === 403, "normal customer cannot read the waitlist");
  assert((await req("/api/organizations/platform-admin/peeps-waitlist/status", { method: "POST", cookie: customer.cookie, body: { id: "x", status: "active" } })).status === 403, "normal customer cannot change waitlist status");
  assert((await req("/api/organizations/platform-admin/peeps-waitlist/invite", { method: "POST", cookie: customer.cookie, body: { id: "x", organizationId: "y" } })).status === 403, "normal customer cannot invite from the waitlist");

  const list = await req("/api/organizations/platform-admin/peeps-waitlist", { cookie: founder.cookie });
  assert(list.status === 200 && list.data.entries.length === 2, "platform admin sees every waitlist entry");
  const ada = list.data.entries.find((e) => e.email === "ada@example.com");
  assert(ada.name === "Ada Judge" && ada.company === "Colosseum" && ada.useCase === "Finding experts for my agent" && ada.status === "waitlist" && Boolean(ada.createdAt), "admin sees name, email, company, use case, signup date and status");
  assert(ada.utm.utm_source === "newsletter" && ada.referrer === "https://www.example.org/post", "admin sees source/referrer and UTM");

  // Status changes.
  const bad = await req("/api/organizations/platform-admin/peeps-waitlist/status", { method: "POST", cookie: founder.cookie, body: { id: ada.id, status: "banana" } });
  assert(bad.status === 400, "unknown status is rejected");
  const missing = await req("/api/organizations/platform-admin/peeps-waitlist/status", { method: "POST", cookie: founder.cookie, body: { id: "nope", status: "active" } });
  assert(missing.status === 404, "unknown entry is a 404");
  const inv = await req("/api/organizations/platform-admin/peeps-waitlist/status", { method: "POST", cookie: founder.cookie, body: { id: second.status && list.data.entries.find((e) => e.email === "grace@example.com").id, status: "invited" } });
  assert(inv.status === 200 && inv.data.entry.status === "invited" && Boolean(inv.data.entry.invitedAt), "admin can mark Waitlist → Invited");
  const act = await req("/api/organizations/platform-admin/peeps-waitlist/status", { method: "POST", cookie: founder.cookie, body: { id: inv.data.entry.id, status: "active" } });
  assert(act.status === 200 && act.data.entry.status === "active" && Boolean(act.data.entry.activatedAt), "admin can mark Invited → Active");

  // Invite reuses the organization invite pipeline; accepting flips the entry to Active.
  const orgs = await req("/api/organizations/platform-admin/organizations", { cookie: founder.cookie });
  const targetOrg = orgs.data.organizations.find((o) => o.slug === "skin-peeps") || orgs.data.organizations[0];
  const invite = await req("/api/organizations/platform-admin/peeps-waitlist/invite", { method: "POST", cookie: founder.cookie, body: { id: ada.id, organizationId: targetOrg.id, role: "member" } });
  assert(invite.status === 201 && invite.data.entry.status === "invited" && invite.data.entry.invitedOrganizationId === targetOrg.id, "admin can invite a waitlisted person into an organization");
  assert(scalar("SELECT COUNT(*) FROM organization_invites WHERE email='ada@example.com' AND status='pending'") === "1", "invite uses the existing organization_invites table");
  const token = /accept-invite\.html\?token=([A-Za-z0-9_-]+)/.exec(output)?.[1];
  assert(Boolean(token), "invite email carries an accept link");
  const adaAccount = await req("/auth/register", { method: "POST", body: { name: "Ada Judge", email: "ada@example.com", password: "password10chars" } });
  assert(adaAccount.status === 201, "invitee creates an account with the invited email");
  const accepted = await req("/api/invites/accept", { method: "POST", cookie: adaAccount.cookie, body: { token } });
  assert(accepted.status === 200 && accepted.data.organizationId === targetOrg.id, "invitee accepts the organization invite");
  assert(scalar("SELECT status FROM peeps_waitlist WHERE email='ada@example.com'") === "active", "accepting the invite moves the waitlist entry to Active");

  // Already-a-member short-circuits to Active without a second invite.
  const again = await req("/api/organizations/platform-admin/peeps-waitlist/invite", { method: "POST", cookie: founder.cookie, body: { id: ada.id, organizationId: targetOrg.id } });
  assert(again.status === 200 && again.data.alreadyMember === true && again.data.entry.status === "active", "inviting an existing member just marks them Active");
  assert(scalar("SELECT COUNT(*) FROM organization_invites WHERE email='ada@example.com'") === "1", "no duplicate invite is created for an existing member");

  console.log("Peeps waitlist server regression passed.");
}

main().then(() => { server.kill(); process.exit(0); }).catch((error) => {
  console.error(error.message);
  console.error(output.split("\n").slice(-30).join("\n"));
  server.kill();
  process.exit(1);
});
