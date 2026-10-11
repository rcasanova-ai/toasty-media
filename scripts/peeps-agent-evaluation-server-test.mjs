#!/usr/bin/env node
// Persisted agent evaluation of candidates: every criterion is derived from the request, answers come ONLY from stored
// claims (or "Unknown"), excluded candidates carry an explanation, qualified ones are ranked, and the method is labelled
// honestly (a Dub evidence interview vs a directory match; never a fabricated conversation).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const scratch = mkdtempSync(join(tmpdir(), "toasty-eval-"));
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


async function main() {
  const srv = start(4248);
  await ready(srv.base);
  const { api, db, sql } = make(srv);
  const requester = await api("/auth/register", { method: "POST", body: { name: "Eval Requester", email: "eval-req@example.com", password: "password10chars" } });
  const cookie = requester.cookie;
  const outsider = await api("/auth/register", { method: "POST", body: { name: "Eve", email: "eval-eve@example.com", password: "password10chars" } });
  // A real network member: a claimed Dub with PUBLIC approved entries (and one PRIVATE entry that must never be used).
  const dana = await api("/auth/register", { method: "POST", body: { name: "Dana Network", email: "dana-net@example.com", password: "password10chars" } });
  db("dub_find_or_create", { id: "dub_eval_dana", email: "dana-net@example.com", userId: dana.data.user.id, displayName: "Dana Network" });
  const STORED = "I led our QR rollout for offline payments across Southeast Asia fintech merchants.";
  db("dub_entry_upsert", { id: "dpe_e1", dubId: "dub_eval_dana", breadcrumbId: "bc_eval_1", kind: "experience_stated", statement: STORED, evidenceClass: "verified", topics: ["offline", "payments", "qr", "southeast", "asia", "fintech"], visibility: "public" });
  db("dub_entry_upsert", { id: "dpe_e2", dubId: "dub_eval_dana", breadcrumbId: "bc_eval_2", kind: "experience_stated", statement: "PRIVATE: secretly an expert in procurement and compliance.", evidenceClass: "participant_claim", topics: ["procurement", "compliance"], visibility: "private" });

  const mk = (who, outcome, c = cookie) => api("/api/peeps/requests", { method: "POST", cookie: c, body: { whoText: who, outcomeText: outcome } });
  console.log("Request 1: offline payments in Southeast Asia");
  const r1 = await mk("Fintech payment executives in Southeast Asia who understand offline payments", "I want 3 guests for a recorded podcast about offline payments.");
  const c1 = r1.data.candidates;
  assert(r1.status === 201 && c1.length >= 3 && c1.every((c) => c.evaluation && ["qualified", "excluded"].includes(c.evaluation.verdict)), "every candidate comes back already evaluated");
  const rows = sql("SELECT COUNT(*) FROM peeps_candidate_evaluations WHERE request_id = ?", [r1.data.request.id])[0][0];
  assert(rows === c1.length, "each evaluation is persisted (one row per candidate)");
  const criteria1 = c1[0].evaluation.findings.criteria.map((f) => f.criterion);
  assert(criteria1.includes("offline") && criteria1.includes("southeast") && criteria1.includes("fintech") && !criteria1.includes("guests"), `criteria are derived from the request's own words (${criteria1.join(", ")})`);
  const dana1 = c1.find((c) => c.dubId === "dub_eval_dana");
  assert(dana1 && dana1.evaluation.mode === "dub_evidence_interview" && dana1.evaluation.verdict === "qualified", "the network member's Dub is evaluated by a Dub evidence interview and qualifies");
  const answered = dana1.evaluation.findings.criteria.filter((f) => f.answered);
  assert(answered.length >= 3 && answered.every((f) => f.answer === STORED && f.source === "Participant-approved Breadcrumb" && f.evidenceClass === "verified"), "its answers are verbatim quotes of its stored, approved claim with provenance (nothing paraphrased or invented)");
  assert(dana1.evaluation.findings.criteria.filter((f) => !f.answered).every((f) => /^Unknown/.test(f.answer)), "where it has no evidence the Dub says Unknown");
  assert(!JSON.stringify(r1.data).includes("PRIVATE: secretly"), "a private Dub entry is never read or exposed");
  assert(dana1.evaluation.findings.notAnA2AConversation === true && /evidence/i.test(dana1.evaluation.findings.modeLabel), "the method is labelled: evidence-only, not an A2A conversation");
  const dir = c1.filter((c) => c.source === "demo_directory_provider");
  assert(dir.length && dir.every((c) => c.evaluation.mode === "directory_evidence_match" && /NOT a Dub interview/.test(c.evaluation.findings.modeLabel)), "directory candidates are labelled as a directory match, explicitly NOT a Dub interview");
  assert(c1.every((c) => c.evaluation.findings.criteria.every((f) => f.answered ? Boolean(f.source) : /^Unknown/.test(f.answer))), "every answer is either sourced or Unknown");

  console.log("\nExclusion and ranking");
  const r2 = await mk("Climate finance and carbon markets advisors", "I want 1 research interview about carbon markets.");
  const all = [...c1, ...r2.data.candidates];
  const excluded = all.filter((c) => c.evaluation.verdict === "excluded");
  assert(excluded.length > 0 && all.some((c) => c.evaluation.verdict === "qualified"), "some candidates qualify and some are excluded, by evidence rather than by name");
  assert(excluded.every((c) => /Unknown: .+/.test(c.evaluation.findings.explanation) && c.evaluation.score < 0.4), "every exclusion explains exactly which criteria are unevidenced");
  for (const r of [r1, r2]) {
    const ranks = r.data.candidates.map((c) => ({ rank: c.evaluation.evaluationRank, q: c.evaluation.verdict === "qualified", s: c.evaluation.score }));
    const sorted = [...ranks].sort((a, b) => a.rank - b.rank);
    assert(sorted.every((x, i) => i === 0 || !(x.q && !sorted[i - 1].q)) && sorted.filter((x) => x.q).every((x, i, a) => i === 0 || a[i - 1].s >= x.s), "qualified candidates are ranked first, by evidence coverage");
  }
  assert(JSON.stringify(criteriaOf(r1)) !== JSON.stringify(criteriaOf(r2)), "different requests yield different criteria (nothing hardcoded)");
  function criteriaOf(r) { return r.data.candidates[0].evaluation.findings.criteria.map((f) => f.criterion); }

  console.log("\nPersistence, determinism and access");
  const again = await api(`/api/peeps/requests/${r1.data.request.id}`, { cookie });
  assert(again.data.candidates.every((c) => c.evaluation) && JSON.stringify(again.data.candidates.map((c) => [c.id, c.evaluation.verdict, c.evaluation.score])) === JSON.stringify(r1.data.candidates.map((c) => [c.id, c.evaluation.verdict, c.evaluation.score])), "re-reading the request returns the same stored evaluations");
  const twin = await mk("Fintech payment executives in Southeast Asia who understand offline payments", "I want 3 guests for a recorded podcast about offline payments.");
  assert(JSON.stringify(twin.data.candidates.map((c) => [c.displayName, c.evaluation.verdict, c.evaluation.score]).sort()) === JSON.stringify(c1.map((c) => [c.displayName, c.evaluation.verdict, c.evaluation.score]).sort()), "the same request evaluates identically (deterministic)");
  assert((await api(`/api/peeps/requests/${r1.data.request.id}`, { cookie: outsider.cookie })).status === 404, "another organization can't read the evaluations");
  const rep = await api(`/api/peeps/requests/${r1.data.request.id}/replace-candidate`, { method: "POST", cookie, body: { candidateId: c1.find((c) => c.source === "demo_directory_provider").id } });
  assert(rep.status === 200 && rep.data.candidates.every((c) => c.evaluation), "after 'keep searching' the new candidates are evaluated too");
  const receipt = (await api(`/api/peeps/requests/${r1.data.request.id}/receipt`, { cookie })).data;
  assert(Array.isArray(receipt.candidates), "the receipt endpoint still answers for a request with no introductions yet");

  console.log("\nAll agent evaluation tests passed.");
}
main().then(() => { servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(0); })
  .catch((e) => { console.error(e.message || e); console.error("--- server ---\n" + out.slice(-2500)); servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(1); });
