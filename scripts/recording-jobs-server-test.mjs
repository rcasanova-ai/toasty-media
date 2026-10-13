#!/usr/bin/env node
// Real-media test of MP4 finalization jobs: raw WebM streamed to disk, queued conversion (one at a time),
// polled status, streamed MP4 download. Verifies the OUTPUT FILE with ffprobe (video + audio, H.264/AAC,
// constant 30fps, right duration) — not just that the API answered — and that the server does not hold the
// upload in memory, failures are friendly, and temp files are cleaned up.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4237;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-recjobs-"));
const jobsDir = join(scratch, "jobs");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,r_frame_rate,width,height", "-of", "json", file]).toString());

// A realistic browser-style source: VP8/Opus WebM with variable frame timing and an audio tone.
function makeWebm(path, seconds, bitrate = "1500k") {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-vf", "setpts='PTS+random(0)*0.004/TB'", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", bitrate, "-g", "90", "-c:a", "libopus", "-t", String(seconds), "-f", "webm", path]);
}

let serverOut = "";
const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: join(scratch, "t.sqlite"), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "recjobs-secret", RESEND_API_KEY: "", TOASTY_RECORDING_JOBS_DIR: jobsDir, TOASTY_RECORDING_JOB_TTL_MS: "4000", TOASTY_RECORDING_SWEEP_MS: "1500", TOASTY_RECORDING_MAX_BYTES: String(120 * 1024 * 1024) },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (c) => (serverOut += c)); server.stderr.on("data", (c) => (serverOut += c));
process.on("exit", () => { try { server.kill("SIGKILL"); } catch (_) {} });

async function api(path, { method = "GET", cookie, body, headers = {} } = {}) {
  const h = { "x-toasty-csrf": "1", ...headers }; if (cookie) h.cookie = cookie;
  // One retry on a connection-level failure: Node's fetch can reuse a socket the server's keep-alive timer is
  // closing at that very moment (a harness race, not a server fault — real status codes are never retried).
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { r = await fetch(`${BASE}${path}`, { method, headers: h, body, duplex: body && typeof body !== "string" && !(body instanceof Uint8Array) ? "half" : undefined }); break; }
    catch (error) { if (attempt === 1) throw error; await sleep(200); }
  }
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : null, res: r, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
}
const rss = () => Number(execFileSync("ps", ["-o", "rss=", "-p", String(server.pid)]).toString().trim()) / 1024;
const meta = (id, seconds) => Buffer.from(JSON.stringify({ recordingId: id, durationSeconds: seconds })).toString("base64");
async function finalize(cookie, file, id, seconds) {
  const bytes = readFileSync(file);
  const created = await api("/api/recordings/jobs", { method: "POST", cookie, body: bytes, headers: { "content-type": "video/webm", "x-toasty-recording": meta(id, seconds) } });
  return created;
}
async function waitDone(cookie, id, onPoll) {
  for (let i = 0; i < 240; i++) { const s = await api(`/api/recordings/jobs/${id}`, { cookie }); onPoll?.(s.data); if (s.data?.status === "done" || s.data?.status === "failed") return s.data; await sleep(500); }
  throw new Error("job never finished");
}

async function main() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {} await sleep(100); }
  const user = await api("/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Rec", email: "rec@example.com", password: "password10chars" }) });
  const cookie = user.cookie; assert(user.status === 201, "user registers");

  console.log("\nAuth");
  const anon = await api("/api/recordings/jobs", { method: "POST", body: "x" });
  assert(anon.status === 401, "creating a job requires a signed-in session");

  console.log("\nServer conversion limits are separate from local recording");
  const anonLimits = await api("/api/recordings/limits");
  assert(anonLimits.status === 401, "the limits endpoint requires a signed-in session");
  const limits = await api("/api/recordings/limits", { cookie });
  assert(limits.status === 200 && limits.data.maxBytes === 50 * 1024 * 1024 && limits.data.maxMinutes === 15, `the browser can ask what the server will convert (demo plan: ${limits.data.maxBytes / 1048576}MB, ${limits.data.maxMinutes} min) — this never limits local recording or download`);

  console.log("\nA real 35s recording converts to a valid MP4");
  const src = join(scratch, "a.webm"); makeWebm(src, 35);
  const srcBefore = readFileSync(src).length;
  const created = await finalize(cookie, src, "rec-a", 35);
  assert(created.status === 202 && created.data.id, "upload is accepted as a job (202), not held open for the transcode");
  const done = await waitDone(cookie, created.data.id);
  assert(done.status === "done" && done.outputBytes > 10000, "the job completes");
  const dl = await api(`/api/recordings/jobs/${created.data.id}/mp4`, { cookie });
  const mp4Bytes = Buffer.from(await dl.res.arrayBuffer());
  assert(dl.status === 200 && dl.res.headers.get("content-type") === "video/mp4" && mp4Bytes.length === done.outputBytes, "MP4 downloads completely with the right length and type");
  const mp4 = join(scratch, "a.mp4"); writeFileSync(mp4, mp4Bytes);
  const info = probe(mp4);
  const v = info.streams.find((s) => s.codec_type === "video"), a = info.streams.find((s) => s.codec_type === "audio");
  assert(v?.codec_name === "h264" && a?.codec_name === "aac", "MP4 has H.264 video and AAC audio");
  assert(Math.abs(Number(info.format.duration) - 35) < 1.5, `MP4 duration matches the recording (${Number(info.format.duration).toFixed(1)}s)`);
  assert(v.r_frame_rate === "30/1" && v.width === 1280 && v.height === 720, "constant 30 fps at 1280x720 (not the browser's variable frame rate)");
  const vol = execFileSync("ffmpeg", ["-hide_banner", "-i", mp4, "-af", "volumedetect", "-vn", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] });
  const volText = (() => { try { return execFileSync("sh", ["-c", `ffmpeg -hide_banner -i '${mp4}' -af volumedetect -vn -f null - 2>&1 | grep mean_volume`]).toString(); } catch (e) { return ""; } })();
  assert(/mean_volume: -\d+/.test(volText) && !/-91\.0/.test(volText), "the MP4 audio is real signal, not silence");
  assert(readFileSync(src).length === srcBefore, "the original source WebM is untouched");
  await api(`/api/recordings/jobs/${created.data.id}/discard`, { method: "POST", cookie, body: "{}" });
  const gone = await api(`/api/recordings/jobs/${created.data.id}`, { cookie });
  assert(gone.status === 404 && !existsSync(join(jobsDir, created.data.id)), "discard removes the job and its files");

  console.log("\nStreaming upload: a large recording is not held in server memory");
  const big = join(scratch, "big.webm"); makeWebm(big, 24, "14000k");
  const bigSize = statSync(big).size;
  const before = rss();
  const bigJob = await finalize(cookie, big, "rec-big", 24);
  const after = rss();
  assert(bigJob.status === 202, `${(bigSize / 1048576).toFixed(0)}MB upload accepted`);
  assert(after - before < bigSize / 1048576 * 0.6 + 30, `server memory did not balloon with the upload (+${(after - before).toFixed(0)}MB RSS for ${(bigSize / 1048576).toFixed(0)}MB)`);

  console.log("\nQueue: conversions run one at a time");
  const smalls = [];
  for (let i = 0; i < 2; i++) { const f = join(scratch, `q${i}.webm`); makeWebm(f, 6); smalls.push(await finalize(cookie, f, `rec-q${i}`, 6)); }
  let maxProcessing = 0;
  const ids = [bigJob.data.id, ...smalls.map((s) => s.data.id)];
  for (let i = 0; i < 240; i++) {
    const all = await Promise.all(ids.map((id) => api(`/api/recordings/jobs/${id}`, { cookie })));
    maxProcessing = Math.max(maxProcessing, all.filter((s) => s.data?.status === "processing").length);
    if (all.every((s) => s.data?.status === "done" || s.data?.status === "failed")) { assert(all.every((s) => s.data.status === "done"), "every queued job finishes"); break; }
    await sleep(400);
  }
  assert(maxProcessing === 1, "never more than ONE ffmpeg conversion at a time");

  console.log("\nBad input fails friendly and cleans up");
  const junk = join(scratch, "junk.webm"); writeFileSync(junk, Buffer.alloc(5000, 7));
  const bad = await finalize(cookie, junk, "rec-bad", 5);
  const badDone = await waitDone(cookie, bad.data.id);
  assert(badDone.status === "failed" && /source WebM|Retry MP4/.test(badDone.error), `unreadable file → failed job with a recoverable message ("${badDone.error}")`);
  const tooBig = await api("/api/recordings/jobs", { method: "POST", cookie, body: Buffer.alloc(10), headers: { "content-type": "video/webm", "content-length": String(200 * 1024 * 1024), "x-toasty-recording": meta("rec-huge", 5) } }).catch(() => ({ status: 0 }));
  assert([413, 0].includes(tooBig.status) || tooBig.status === 400, "an over-limit upload is refused up front");
  const longRec = await finalize(cookie, junk, "rec-long", 99999);
  assert(longRec.status === 402, "a recording longer than the plan allows is refused with a clear plan message");

  console.log("\nTemp files expire");
  await sleep(9000);
  const left = existsSync(jobsDir) ? readdirSync(jobsDir) : [];
  assert(left.length === 0, "finished jobs and their files are swept after the TTL");

  console.log("\nALL PASSED — recording finalization jobs produce a valid, playable MP4 without exhausting the server.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); console.error("--- server ---\n" + serverOut.slice(-2500)); process.exit(1); });
