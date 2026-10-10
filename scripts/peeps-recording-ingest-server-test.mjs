#!/usr/bin/env node
// Studio's master-recording finalize endpoint (the same one the host's browser calls when a session ends) now registers the
// recording as the Jam's evidence by itself. This test sends a REAL WebM (generated with ffmpeg) through the REAL transcode
// path. Attendance is injected here only because a headless test has no camera; in production the room emits it.
// Needs ffmpeg; skipped (not faked) without it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const scratch = mkdtempSync(join(tmpdir(), "toasty-zec-"));
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

function zoned(ms, tz) { const p = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
function dayUtc(d, h) { const t = new Date(Date.now() + d * 86400000); return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, 0); }


const ffmpegOk = spawnSync("ffmpeg", ["-version"]).status === 0;
if (!ffmpegOk) { console.log("SKIPPED: ffmpeg is not installed, so a real WebM cannot be produced."); process.exit(0); }

async function main() {
  const srv = start(4247);
  await ready(srv.base);
  const { api, db, sql } = make(srv);
  const webm = join(scratch, "session.webm");
  const gen = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=2:r=10", "-c:v", "libvpx", "-c:a", "libopus", "-shortest", webm], { encoding: "utf8" });
  if (gen.status !== 0) { console.log("SKIPPED: this ffmpeg can't encode VP8/Opus WebM."); process.exit(0); }
  const { readFileSync } = await import("node:fs");

  const requester = await api("/auth/register", { method: "POST", body: { name: "Rec Requester", email: "rec-req@example.com", password: "password10chars" } });
  const cookie = requester.cookie, userId = requester.data.user.id;
  db("dough_post", { id: "dle_seed", subjectType: "user", subjectId: userId, bucket: "spend", direction: "credit", amount: 50, kind: "funding", referenceId: "seed" });
  const created = await api("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech payment executives in Southeast Asia offline payments", outcomeText: "I want 1 person for a recorded podcast about offline payments." } });
  const request = created.data.request;
  const cand = created.data.candidates.find((c) => c.source === "demo_directory_provider");
  const auth = await api(`/api/peeps/requests/${request.id}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: cand.id, outreachEmail: "rec.guest@example.com" }], compensationAmount: 25 } });
  const intro = auth.data.introductions[0];
  const msgs = (await api(`/api/peeps/test-outbox?requestId=${request.id}`, { cookie })).data.messages;
  const token = msgs.find((m) => m.introductionId === intro.id && m.purpose === "outreach").testPayload.url.split("token=")[1];
  await api(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} });
  await api(`/api/peeps/respond/${token}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(9, 2), "Asia/Bangkok"), end: zoned(dayUtc(9, 5), "Asia/Bangkok") }] } });
  await api(`/api/peeps/requests/${request.id}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(8, 20), "America/New_York"), end: zoned(dayUtc(9, 8), "America/New_York") }] } });
  const book = await api(`/api/peeps/introductions/${intro.id}/book`, { method: "POST", cookie, body: {} });
  const jamId = book.data.booking.jamId, sessionId = book.data.booking.studioSessionId;
  await api(`/api/peeps/respond/${token}/consent`, { method: "POST", body: { acceptances: ["terms_of_service", "recording"] } });
  const joinRes = await api(`/api/peeps/respond/${token}/join`, { method: "POST", body: {} });
  await api(`/api/jams/${jamId}/events`, { method: "POST", body: { invite: joinRes.data.joinUrl.split("token=")[1], type: "participant.joined" } });
  await api(`/api/jams/${jamId}/transcript`, { method: "POST", cookie, body: { segments: [{ speaker: "Rec Requester", text: "Welcome." }, { speaker: cand.displayName, text: "I have spent twelve years building offline payment systems across Southeast Asia." }] } });
  await api(`/api/jams/${jamId}/complete`, { method: "POST", cookie, body: {} });

  console.log("Before any recording exists");
  const before = (await api(`/api/peeps/requests/${request.id}/receipt`, { cookie })).data;
  const outcomeBefore = before.checks.find((c) => c.key === "outcome");
  assert(outcomeBefore.state === "pending" && /A recording exists/.test(outcomeBefore.detail) && /no recording reference/.test(outcomeBefore.detail), "the receipt says exactly WHY the outcome is pending (the recording), not just 'pending'");
  assert((await api(`/api/peeps/requests/${request.id}/lifecycle`, { cookie })).data.outcome.state === "outcome_pending", "the outcome is genuinely pending: nothing was fabricated to pass it");

  console.log("\nStudio finalizes the recording (the host browser's normal call)");
  const finalize = (id, sid = sessionId, c = cookie) => {
    const form = new FormData();
    form.append("manifest", JSON.stringify({ recordingId: id, kind: "master-program", sessionId: sid, durationSeconds: 2 }));
    form.append("source", new Blob([readFileSync(webm)], { type: "video/webm" }), "source.webm");
    return fetch(`${srv.base}/api/recordings/finalize`, { method: "POST", headers: { "x-toasty-csrf": "1", cookie: c }, body: form });
  };
  const r1 = await finalize("rec_peeps_1");
  assert(r1.status === 200 && r1.headers.get("content-type") === "video/mp4" && (await r1.arrayBuffer()).byteLength > 1000, "a real WebM is transcoded to an MP4 as before (existing behaviour intact)");
  const arts = sql("SELECT artifact_type, status, storage_reference FROM jam_artifacts WHERE jam_id = ? AND artifact_type = 'recording'", [jamId]);
  assert(arts.length === 1 && arts[0].join() === "recording,ready,studio-master-recording:rec_peeps_1", "the recording was registered as the Jam's evidence automatically, referencing the real recording id");
  const ev = sql("SELECT detail_json FROM jam_events WHERE jam_id = ? AND type = 'recording.finalized'", [jamId]);
  const detail = JSON.parse(ev[0][0]);
  assert(ev.length === 1 && detail.durationSeconds === 2 && detail.masterBytes > 1000 && /^[0-9a-f]{64}$/.test(detail.sha256) && detail.storedByToasty === false, "a recording.finalized event records size, duration and content hash, and says Toasty did not store the file");
  const after = (await api(`/api/peeps/requests/${request.id}/receipt`, { cookie })).data;
  assert(after.checks.find((c) => c.key === "outcome").state === "done" && (await api(`/api/peeps/requests/${request.id}/lifecycle`, { cookie })).data.outcome.state === "outcome_verified", "with the real evidence present the outcome verifies with no manual step");
  assert(after.evidence.recordingPresent === true, "the receipt shows the recording as present");

  console.log("\nIdempotency and isolation");
  const r2 = await finalize("rec_peeps_1");
  await r2.arrayBuffer();
  assert(r2.status === 200 && sql("SELECT COUNT(*) FROM jam_artifacts WHERE jam_id = ? AND artifact_type = 'recording'", [jamId])[0][0] === 1 && sql("SELECT COUNT(*) FROM jam_events WHERE jam_id = ? AND type = 'recording.finalized'", [jamId])[0][0] === 1, "finalizing the same recording again registers nothing twice");
  const outsider = await api("/auth/register", { method: "POST", body: { name: "Eve", email: "rec-eve@example.com", password: "password10chars" } });
  const r3 = await finalize("rec_peeps_2", sessionId, outsider.cookie);
  await r3.arrayBuffer();
  assert(sql("SELECT COUNT(*) FROM jam_artifacts WHERE jam_id = ? AND artifact_type = 'recording'", [jamId])[0][0] === 1, "another account can't attach a recording to this Jam by naming its session");
  const r4 = await finalize("rec_other", "ls_does_not_exist");
  await r4.arrayBuffer();
  assert(r4.status === 200 && sql("SELECT COUNT(*) FROM jam_artifacts WHERE artifact_type = 'recording'")[0][0] === 1, "a recording for a session that isn't a Peeps Jam registers nothing");

  console.log("\nAll Peeps recording-ingestion tests passed.");
}
main().then(() => { servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(0); })
  .catch((e) => { console.error(e.message || e); console.error("--- server ---\n" + out.slice(-2500)); servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(1); });
