#!/usr/bin/env node
// A deployment with NO email provider (like production today): a candidate the requester supplied an email for can still
// be invited. Peeps hands the requester the private link to send themselves, keeps the introduction at ready_for_outreach
// (nothing is claimed sent), and only moves on after the requester confirms. Delivery is never claimed.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "toasty-share-"));
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: "4771", TOASTY_AUTH_DB: join(scratch, "db.sqlite"), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "share-secret", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "" }, stdio: "ignore" });
const base = "http://127.0.0.1:4771";
const call = async (path, { method = "GET", cookie, body } = {}) => { const r = await fetch(base + path, { method, headers: { "x-toasty-csrf": "1", ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); let data = {}; try { data = await r.json(); } catch (_) {} return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const reg = await call("/auth/register", { method: "POST", body: { name: "Sharer", email: "sharer@example.com", password: "password10chars" } });
  const cookie = reg.cookie;
  await call("/api/peeps/dough/demo-credit", { method: "POST", cookie, body: {} });
  const created = await call("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech/payment executives in Southeast Asia who understand offline payments", outcomeText: "I want 1 person for a recorded podcast about offline payments." } });
  const rid = created.data.request.id;
  const indirect = created.data.candidates.find((c) => c.reachability === "external_indirect");
  const auth = await call(`/api/peeps/requests/${rid}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: indirect.id, outreachEmail: "someone-i-know@example.com" }] } });
  const intro = auth.data.introductions[0];
  assert(auth.status === 200 && intro.status === "ready_for_outreach" && !intro.outreachSentAt, "authorized, but NOT marked as sent");
  assert((await call(`/api/peeps/requests/${rid}`, { cookie })).data.request.status === "introductions_authorized", "the request advances once an introduction exists");
  let view = (await call(`/api/peeps/introductions/${intro.id}`, { cookie })).data;
  assert(view.contact.blocked === "provider_unavailable" && /\/peeps\/respond\.html\?token=/.test(view.contact.shareUrl || ""), "the requester gets the private link to send themselves");
  assert(!view.messages.some((m) => m.status === "sent"), "nothing is claimed delivered");
  const token = new URL(view.contact.shareUrl).searchParams.get("token");
  assert((await call(`/api/peeps/respond/${token}`)).status === 200, "the link is a valid private response link");
  const shared = await call(`/api/peeps/introductions/${intro.id}/shared`, { method: "POST", cookie, body: {} });
  assert(shared.status === 200 && shared.data.introduction.status === "outreach_sent", "after the requester confirms, the introduction waits for the person's reply");
  view = (await call(`/api/peeps/introductions/${intro.id}`, { cookie })).data;
  const msg = view.messages.find((m) => m.audience === "candidate");
  assert(msg.providerKind === "manual_share" && msg.status === "manual" && /yourself/.test(msg.statusLabel || msg.label || JSON.stringify(msg)) && view.contact.shareUrl === null, "recorded as a manual share (not as sent mail) and the link is no longer offered");
  assert((await call(`/api/peeps/introductions/${intro.id}/shared`, { method: "POST", cookie, body: {} })).status === 409, "confirming twice is refused");
  assert((await call(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} })).status === 200, "the person can accept through the link");
  const other = await call("/auth/register", { method: "POST", body: { name: "Other", email: "other-share@example.com", password: "password10chars" } });
  assert([403, 404].includes((await call(`/api/peeps/introductions/${intro.id}/shared`, { method: "POST", cookie: other.cookie, body: {} })).status), "another user cannot confirm it");
  console.log("\nPASS");
} finally { child.kill(); }
