#!/usr/bin/env node
// End-to-end test of the Studio broadcast backend with REAL ffmpeg processes and a REAL local RTMP sink:
//  - destination credentials are stored encrypted server-side and are never returned
//  - Program is ingested as many short chunk requests (nothing long-lived for a proxy to time out)
//  - ONE encode fans out to isolated per-destination relays: one destination dying leaves the other LIVE
//  - the stream keeps flowing PAST the 30s proxy_read_timeout window nginx applies to /api/organizations
//  - stopping tears everything down
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4231;
const RTMP_PORT = 19431;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-broadcast-"));
const dbPath = join(scratch, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const sinkFile = join(scratch, "sink.flv");
const SUSTAINED_SECONDS = Number(process.env.BROADCAST_TEST_SECONDS || 36);
const SECRET_KEY = "live_sekret_key_9876";

function assert(c, m) { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); }
async function api(path, { method = "GET", cookie, body, raw } = {}) {
  const headers = { "x-toasty-csrf": "1" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "application/octet-stream";
  const response = await fetch(`${BASE}${path}`, { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
  let data = {}; try { data = await response.json(); } catch (_) {}
  return { status: response.status, data, cookie: (response.headers.get("set-cookie") || "").split(";")[0] || cookie };
}
function framed(seq, media) { const head = Buffer.alloc(4); head.writeUInt32BE(seq); return Buffer.concat([head, media]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function run(cmd, args, opts = {}) { const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts }); children.push(c); return c; }
function cleanup() { for (const c of children) { try { c.kill("SIGKILL"); } catch (_) {} } }
process.on("exit", cleanup);

const server = run("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "broadcast-test-secret", RESEND_API_KEY: "" }
});
let serverOutput = ""; server.stdout.on("data", (c) => (serverOutput += c)); server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {} await sleep(100); }

  console.log("\nAuth + destination storage");
  const anon = await api("/api/organizations/creator-broadcast/destinations");
  assert(anon.status === 401, "destinations require a signed-in Studio session");
  const owner = await api("/auth/register", { method: "POST", body: { name: "Broadcast Owner", email: "bc@example.com", password: "password10chars" } });
  assert(owner.status === 201, "owner registers");
  const other = await api("/auth/register", { method: "POST", body: { name: "Other Owner", email: "bc2@example.com", password: "password10chars" } });
  const cookie = owner.cookie;

  const badUrl = await api("/api/organizations/creator-broadcast/destinations", { method: "POST", cookie, body: { destination: "x", streamUrl: "https://example.com", streamKey: SECRET_KEY } });
  assert(badUrl.status === 400, "a non-RTMP URL is rejected");
  const badName = await api("/api/organizations/creator-broadcast/destinations", { method: "POST", cookie, body: { destination: "myspace", streamUrl: "rtmps://a.b/x", streamKey: SECRET_KEY } });
  assert(badName.status === 400, "an unknown destination is rejected");
  const saveX = await api("/api/organizations/creator-broadcast/destinations", { method: "POST", cookie, body: { destination: "x", streamUrl: `rtmp://127.0.0.1:${RTMP_PORT}/live`, streamKey: SECRET_KEY } });
  assert(saveX.status === 200 && saveX.data.destination.destination === "x", "X saves");
  assert(!JSON.stringify(saveX.data).includes(SECRET_KEY), "the save response never echoes the stream key");
  const saveYt = await api("/api/organizations/creator-broadcast/destinations", { method: "POST", cookie, body: { destination: "youtube", streamUrl: "rtmp://127.0.0.1:1/live2", streamKey: "yt_dead_key_1234" } });
  assert(saveYt.status === 200, "YouTube saves (pointed at a dead port on purpose)");
  const list = await api("/api/organizations/creator-broadcast/destinations", { cookie });
  assert(list.data.destinations.length === 2 && list.data.destinations.every((d) => d.keyLast4 && !("encryptedSecret" in d)), "list shows masked connections only");
  assert(!JSON.stringify(list.data).includes(SECRET_KEY) && !JSON.stringify(list.data).includes("yt_dead_key"), "the list never contains a stream key or URL path");
  const otherList = await api("/api/organizations/creator-broadcast/destinations", { cookie: other.cookie });
  assert(otherList.data.destinations.length === 0, "another account/org cannot see these destinations");
  const otherStart = await api("/api/organizations/creator-broadcast/start", { method: "POST", cookie: other.cookie, body: { destinations: ["x"] } });
  assert(otherStart.status === 409, "another account cannot broadcast to a destination it has not connected");
  const dbRaw = readFileSync(dbPath).toString("latin1");
  assert(!dbRaw.includes(SECRET_KEY), "the stream key is not stored in plaintext in the database");

  console.log("\nStart with no connection / unknown");
  const none = await api("/api/organizations/creator-broadcast/start", { method: "POST", cookie, body: { destinations: [] } });
  assert(none.status === 400, "starting with no destinations is rejected");
  const tiktok = await api("/api/organizations/creator-broadcast/start", { method: "POST", cookie, body: { destinations: ["tiktok"] } });
  assert(tiktok.status === 409, "an unconnected destination cannot be started");

  console.log("\nSustained multistream: X (real RTMP sink) + YouTube (dead)");
  const sink = run("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-y", "-listen", "1", "-f", "flv", "-i", `rtmp://127.0.0.1:${RTMP_PORT}/live/${SECRET_KEY}`, "-c", "copy", "-f", "flv", sinkFile]);
  let sinkErr = ""; sink.stderr.on("data", (c) => (sinkErr += c));
  await sleep(800);
  const start = await api("/api/organizations/creator-broadcast/start", { method: "POST", cookie, body: { destinations: ["x", "youtube"], width: 640, height: 360, fps: 30, bitrateKbps: 1200 } });
  assert(start.status === 201 && start.data.destinations.length === 2, "broadcast starts for two destinations");
  assert(!JSON.stringify(start.data).includes(SECRET_KEY), "start response carries no secret");
  const id = start.data.id;
  const intruder = await api(`/api/organizations/creator-broadcast/${id}/status`, { cookie: other.cookie });
  assert(intruder.status === 404, "another user cannot see this broadcast");

  // Real-time WebM source, cut into ~1s chunks like MediaRecorder timeslices.
  const source = run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "150k", "-g", "300", "-c:a", "libopus", "-t", String(SUSTAINED_SECONDS), "-f", "webm", "-live", "1", "pipe:1"]);
  let pending = []; let sourceDone = false;
  source.stdout.on("data", (c) => pending.push(c)); source.on("exit", () => { sourceDone = true; });
  let seq = 0; let maxRequestMs = 0; const t0 = Date.now(); let last = null; let sawXLive = false; let sawYtError = false; let timeToXLive = null;
  while (!sourceDone || pending.length) {
    await sleep(1000);
    if (!pending.length) continue;
    const body = Buffer.concat(pending); pending = [];
    const t = Date.now();
    const r = await api(`/api/organizations/creator-broadcast/${id}/chunk`, { method: "POST", cookie, raw: framed(seq, body) });
    maxRequestMs = Math.max(maxRequestMs, Date.now() - t);
    assert(r.status === 200, `chunk ${seq} accepted`) || 0;
    seq += 1; last = r.data;
    const x = last.destinations.find((d) => d.destination === "x"); const yt = last.destinations.find((d) => d.destination === "youtube");
    if (x.state === "live" && !sawXLive) { sawXLive = true; timeToXLive = (Date.now() - t0) / 1000; }
    if (yt.state === "error") sawYtError = true;
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`  (streamed ${seq} chunks over ${elapsed.toFixed(1)}s, slowest request ${maxRequestMs}ms)`);
  assert(elapsed > 31, "the broadcast ran past the 30s proxy timeout window");
  assert(maxRequestMs < 3000, "no request is long-lived — each completes in well under the proxy timeout");
  assert(sawXLive, "X reported LIVE only once the destination was actually receiving");
  assert(timeToXLive < 8, `X went LIVE within seconds even with a LOW-bitrate, long-keyframe-interval source like a browser MediaRecorder (${timeToXLive?.toFixed(1)}s)`);
  assert(sawYtError, "YouTube failed and reported ERROR");
  const final = await api(`/api/organizations/creator-broadcast/${id}/status`, { cookie });
  assert(final.data.live === true && final.data.destinations.find((d) => d.destination === "x").state === "live", "X stayed LIVE after YouTube failed");
  assert(!JSON.stringify(final.data).includes(SECRET_KEY), "status never leaks the stream key");
  const replay = await api(`/api/organizations/creator-broadcast/${id}/chunk`, { method: "POST", cookie, raw: framed(0, Buffer.from("dup")) });
  assert(replay.status === 200 && replay.data.duplicate === true, "a retried chunk is idempotent");
  const stop = await api(`/api/organizations/creator-broadcast/${id}/stop`, { method: "POST", cookie, body: {} });
  assert(stop.status === 200, "stop succeeds");
  await sleep(2500);
  const gone = await api(`/api/organizations/creator-broadcast/${id}/status`, { cookie });
  assert(gone.status === 404, "the stopped broadcast is gone");
  const sinkBytes = statSync(sinkFile).size;
  assert(sinkBytes > 50_000, `the RTMP sink really received the Program (${sinkBytes} bytes)`);
  const probe = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", sinkFile]);
  let probeOut = ""; probe.stdout.on("data", (c) => (probeOut += c));
  await new Promise((r) => probe.on("close", r));
  assert(/video/.test(probeOut) && /audio/.test(probeOut), "what X received has both video and audio");

  console.log("\nDelete a destination");
  const del = await api("/api/organizations/creator-broadcast/destinations/youtube/delete", { method: "POST", cookie, body: {} });
  assert(del.status === 200, "a destination can be disconnected");
  const after = await api("/api/organizations/creator-broadcast/destinations", { cookie });
  assert(after.data.destinations.length === 1, "disconnected destination is gone");

  console.log("\nALL PASSED — Studio broadcast backend: secure destinations, chunked ingest, isolated multistream, sustained past proxy window.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); console.error("--- server output ---\n" + serverOutput.slice(-3000)); process.exit(1); });
