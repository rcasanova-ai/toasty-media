#!/usr/bin/env node
// Chunk-safe recording backend: resumable per-chunk upload keyed by session/recording/participant/track/seq,
// manifest + sequence facts, async MP4/M4A finalization, crash recovery, ownership isolation.
// Uses a real server, a real SQLite DB, and real ffmpeg — chunks are byte slices of genuine WebM files,
// which is exactly what concatenated MediaRecorder timeslices are.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PORT = 4283;
const BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || `${command} exited ${code}`)));
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start");
}

async function register(email) {
  const response = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Toasty-CSRF": "1" },
    body: JSON.stringify({ name: "Chunk Tester", email, password: "password10chars" })
  });
  assert.equal(response.status, 201, await response.text());
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

const api = (cookie) => async (path, { method = "GET", json, body, headers = {} } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Cookie: cookie, "X-Toasty-CSRF": "1", ...(json ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json ? JSON.stringify(json) : body
  });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, payload, headers: response.headers };
};

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
function slice(buffer, size) {
  const out = [];
  for (let i = 0; i < buffer.length; i += size) out.push(buffer.subarray(i, i + size));
  return out;
}

async function pollRecording(call, sessionId, recordingId, accept, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await call(`/api/recordings/${sessionId}/${recordingId}`)).payload.recording;
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`recording never reached expected state; last=${JSON.stringify(last?.state)} finalization=${JSON.stringify(last?.finalization)}`);
}

const tmp = await mkdtemp(join(tmpdir(), "toasty-chunks-test-"));
let server;
try {
  server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      TOASTY_RENDER_PORT: String(PORT),
      TOASTY_AUTH_DB: join(tmp, "auth.sqlite"),
      TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"),
      TOASTY_SESSION_SECRET: "recording-chunks-test-secret",
      TOASTY_RECORDINGS_DIR: join(tmp, "recordings"),
      TOASTY_RECORDING_ABANDON_MS: "2500",
      TOASTY_RECORDING_SWEEP_MS: "500"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let serverErrors = "";
  server.stderr.on("data", (c) => { serverErrors += c; });
  await waitForHealth();

  // Real media: composed program (video+audio), isolated camera (video only), isolated mic (audio only).
  const programPath = join(tmp, "program.webm");
  const cameraPath = join(tmp, "camera.webm");
  const micPath = join(tmp, "mic.webm");
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=660:duration=2", "-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest", programPath]);
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "smptebars=size=320x180:rate=30:duration=2", "-c:v", "libvpx", "-an", cameraPath]);
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", micPath]);
  const program = await readFile(programPath);
  const camera = await readFile(cameraPath);
  const mic = await readFile(micPath);
  const programChunks = slice(program, Math.ceil(program.length / 8));
  const cameraChunks = slice(camera, Math.ceil(camera.length / 6));
  const micChunks = slice(mic, Math.ceil(mic.length / 5));

  const cookie = await register("chunks-owner@example.com");
  const call = api(cookie);
  const SESSION = "personal-session-1";
  const REC = "rec-chunks-test-1";
  const startedAt = Date.now() - 2500;
  const tracks = [
    { trackId: "program", participantId: "host", type: "program", mimeType: "video/webm;codecs=vp9,opus", codecs: { video: "vp9", audio: "opus" }, hasVideo: true, hasAudio: true, video: { width: 320, height: 180, frameRate: 30 }, startedAtMs: startedAt, source: { kind: "canvas-compositor" } },
    { trackId: "camera", participantId: "host", type: "camera", mimeType: "video/webm;codecs=vp8", codecs: { video: "vp8" }, hasVideo: true, hasAudio: false, startedAtMs: startedAt + 40, source: { kind: "local-camera", label: "FaceTime HD" } },
    { trackId: "mic", participantId: "host", type: "microphone", mimeType: "audio/webm;codecs=opus", codecs: { audio: "opus" }, hasVideo: false, hasAudio: true, startedAtMs: startedAt + 55 }
  ];

  // --- Validation & auth ---------------------------------------------------------------------------
  const anon = await fetch(`${BASE}/api/recordings`, { method: "POST", headers: { "Content-Type": "application/json", "X-Toasty-CSRF": "1" }, body: JSON.stringify({ sessionId: SESSION }) });
  assert.equal(anon.status, 401, "creating a recording requires a signed-in session");
  const noCsrf = await fetch(`${BASE}/api/recordings`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ sessionId: SESSION }) });
  assert.equal(noCsrf.status, 403, "writes require the CSRF header");
  assert.equal((await call("/api/recordings", { method: "POST", json: { sessionId: "../escape", tracks } })).status, 400, "path-traversal session id rejected");
  assert.equal((await call("/api/recordings", { method: "POST", json: { sessionId: SESSION, recordingId: "finalize", tracks } })).status, 400, "reserved recording id rejected");
  assert.equal((await call("/api/recordings", { method: "POST", json: { sessionId: SESSION, tracks: [{ ...tracks[0], type: "hologram" }] } })).status, 400, "unknown track type rejected");
  assert.equal((await call("/api/recordings", { method: "POST", json: { sessionId: SESSION, tracks: [{ ...tracks[0], participantId: "../x" }] } })).status, 400, "unsafe participant id rejected");

  // --- Create + manifest shape ---------------------------------------------------------------------
  const created = await call("/api/recordings", { method: "POST", json: { sessionId: SESSION, recordingId: REC, mode: "personal", startedAt, brandTheme: "toasty", layout: "single", participants: [{ participantId: "host", role: "host", displayName: "Ada" }], tracks } });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const manifest0 = created.payload.recording;
  assert.equal(manifest0.schemaVersion, 2);
  assert.equal(manifest0.state, "recording");
  assert.equal(manifest0.mode, "personal");
  assert.equal(manifest0.tracks.length, 3);
  const programTrack = manifest0.tracks.find((t) => t.trackId === "program");
  assert.equal(programTrack.role, "composed");
  assert.equal(programTrack.codecs.video, "vp9");
  assert.equal(manifest0.tracks.find((t) => t.trackId === "camera").role, "isolated");
  assert.equal(manifest0.tracks.find((t) => t.trackId === "camera").offsetMs, 40, "track offset is relative to recording start (sync metadata)");
  assert.equal(manifest0.tracks.find((t) => t.trackId === "mic").hasVideo, false);
  assert.equal(programTrack.final.status, "pending");

  const chunkUrl = (sid, rid, track, seq, query = "") => `/api/recordings/${sid}/${rid}/chunks/${track.participantId}/${track.trackId}/${String(seq).padStart(8, "0")}${query}`;
  const put = (track, seq, buffer, query = "") => call(chunkUrl(SESSION, REC, track, seq, query), { method: "POST", body: buffer, headers: { "Content-Type": "application/octet-stream" } });

  // --- Chunk semantics: ordering, idempotency, integrity -------------------------------------------
  const [pTrack, cTrack, mTrack] = tracks;
  assert.equal((await put(pTrack, 3, programChunks[3])).payload.duplicate, false, "out-of-order chunk accepted");
  const dup = await put(pTrack, 3, programChunks[3]);
  assert.equal(dup.status, 200);
  assert.equal(dup.payload.duplicate, true, "identical retry is acknowledged as duplicate");
  assert.equal((await put(pTrack, 3, Buffer.concat([programChunks[3], Buffer.from("x")]))).status, 409, "different bytes for an existing seq are refused");
  assert.equal((await put(pTrack, 0, programChunks[0], "?sha256=" + "0".repeat(64))).status, 422, "checksum mismatch is rejected");
  assert.equal((await put(pTrack, 0, programChunks[0], "?sha256=" + sha(programChunks[0]))).status, 200, "matching checksum accepted");
  assert.equal((await put({ ...pTrack, trackId: "nope" }, 0, programChunks[0])).status, 404, "unregistered track rejected");
  assert.equal((await put(pTrack, 1, Buffer.alloc(0))).status, 400, "empty chunk rejected");
  assert.equal((await call(`/api/recordings/${SESSION}/${REC}/chunks/host/program/abc`, { method: "POST", body: Buffer.from("a") })).status, 400, "non-numeric seq rejected");

  // --- Simulated browser refresh/crash halfway: the NEW page resumes the same recording ------------
  for (const seq of [1, 2]) await put(pTrack, seq, programChunks[seq]);
  for (let i = 0; i < 3; i += 1) await put(cTrack, i, cameraChunks[i]);
  for (let i = 0; i < 2; i += 1) await put(mTrack, i, micChunks[i]);
  const resumed = await call("/api/recordings", { method: "POST", json: { sessionId: SESSION, recordingId: REC, tracks } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.payload.resumed, true, "re-creating the same recording id resumes instead of resetting");
  const seqView = resumed.payload.recording.tracks.find((t) => t.trackId === "program").sequence;
  assert.equal(seqView.count, 4, "chunks uploaded before the crash survived");
  assert.equal(seqView.contiguousThrough, 3);
  assert.deepEqual(seqView.missingSeqs, [], "no gaps once 0-3 exist");

  // --- Finish uploads, complete, async finalize ----------------------------------------------------
  for (let seq = 4; seq < programChunks.length; seq += 1) await put(pTrack, seq, programChunks[seq]);
  for (let i = 3; i < cameraChunks.length; i += 1) await put(cTrack, i, cameraChunks[i]);
  for (let i = 2; i < micChunks.length; i += 1) await put(mTrack, i, micChunks[i]);
  const completeCall = await call(`/api/recordings/${SESSION}/${REC}/complete`, { method: "POST", json: {
    stoppedAt: startedAt + 2000,
    tracks: [
      { trackId: "program", lastSeq: programChunks.length - 1, stoppedAtMs: startedAt + 2000, durationMs: 2000 },
      { trackId: "camera", lastSeq: cameraChunks.length - 1, stoppedAtMs: startedAt + 2000, durationMs: 1960 },
      { trackId: "mic", lastSeq: micChunks.length - 1, stoppedAtMs: startedAt + 2000, durationMs: 1945 }
    ],
    markers: [{ id: "m1", offsetMs: 500, type: "take-live", label: "Intro" }]
  } });
  assert.equal(completeCall.status, 202, "complete returns 202 immediately — MP4 processing is asynchronous");
  assert.ok(["finalizing", "finalized"].includes(completeCall.payload.recording.state));
  assert.equal((await put(pTrack, 99, programChunks[0])).status, 409, "no chunks accepted after complete");
  const again = await call(`/api/recordings/${SESSION}/${REC}/complete`, { method: "POST", json: {} });
  assert.equal(again.status, 202, "complete is idempotent");

  const done = await pollRecording(call, SESSION, REC, (r) => ["finalized", "partial", "failed"].includes(r.state));
  assert.equal(done.state, "finalized", `recording finalized (${JSON.stringify(done.tracks.map((t) => t.final))}) ${serverErrors}`);
  assert.equal(done.finalization.status, "complete");
  assert.equal(done.markers[0].label, "Intro", "markers persisted in the manifest");
  for (const track of done.tracks) {
    assert.equal(track.state, "finalized", `${track.trackId} finalized`);
    assert.equal(track.sequence.missingSeqs.length, 0);
    assert.ok(track.final.bytes > 0);
  }
  assert.equal(done.tracks.find((t) => t.trackId === "program").final.file, "final.mp4");
  assert.equal(done.tracks.find((t) => t.trackId === "mic").final.file, "final.m4a");
  assert.equal(done.tracks.find((t) => t.trackId === "program").sequence.count, programChunks.length);

  // Downloads: composed MP4 + isolated tracks are real H.264/AAC files; source WebM is the exact upload.
  const probe = async (name, buffer) => {
    const path = join(tmp, name);
    await writeFile(path, buffer);
    return JSON.parse(await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", path]));
  };
  const programFile = await call(`/api/recordings/${SESSION}/${REC}/files/host/program`);
  assert.equal(programFile.status, 200);
  assert.equal(programFile.headers.get("content-type"), "video/mp4");
  const programProbe = await probe("program.mp4", programFile.payload);
  assert.equal(programProbe.streams.find((s) => s.codec_type === "video").codec_name, "h264", "program MP4 is H.264");
  assert.equal(programProbe.streams.find((s) => s.codec_type === "audio").codec_name, "aac", "program MP4 is AAC");
  const cameraProbe = await probe("camera.mp4", (await call(`/api/recordings/${SESSION}/${REC}/files/host/camera`)).payload);
  assert.equal(cameraProbe.streams.find((s) => s.codec_type === "video").codec_name, "h264");
  assert.equal(cameraProbe.streams.find((s) => s.codec_type === "audio"), undefined, "isolated camera track has no audio");
  const micProbe = await probe("mic.m4a", (await call(`/api/recordings/${SESSION}/${REC}/files/host/mic`)).payload);
  assert.equal(micProbe.streams.find((s) => s.codec_type === "audio").codec_name, "aac");
  assert.equal(micProbe.streams.find((s) => s.codec_type === "video"), undefined, "isolated mic track has no video");
  const sourceDownload = await call(`/api/recordings/${SESSION}/${REC}/files/host/program?kind=source`);
  assert.equal(sha(sourceDownload.payload), sha(program), "source WebM is the byte-exact concatenation of the uploaded chunks");

  // --- Isolation -----------------------------------------------------------------------------------
  const otherCall = api(await register("chunks-intruder@example.com"));
  assert.equal((await otherCall(`/api/recordings/${SESSION}/${REC}`)).status, 404, "another account cannot read the manifest");
  assert.equal((await otherCall(`/api/recordings/${SESSION}/${REC}/files/host/program`)).status, 404, "another account cannot download");
  assert.equal((await otherCall(chunkUrl(SESSION, REC, pTrack, 77), { method: "POST", body: Buffer.from("zz") })).status, 404, "another account cannot upload chunks");
  assert.equal((await otherCall("/api/recordings")).payload.recordings.length, 0, "another account's library is empty");
  const list = await call(`/api/recordings?sessionId=${SESSION}`);
  assert.equal(list.payload.recordings.length, 1);
  assert.equal(list.payload.recordings[0].recordingId, REC);

  // --- Gap handling: missing chunk => partial, usable prefix still becomes a file -------------------
  const GAP = "rec-gap-1";
  await call("/api/recordings", { method: "POST", json: { sessionId: SESSION, recordingId: GAP, startedAt, tracks: [tracks[0]] } });
  const putGap = (seq, buffer) => call(chunkUrl(SESSION, GAP, pTrack, seq), { method: "POST", body: buffer });
  for (const seq of [0, 1, 2, 3, 5, 6]) await putGap(seq, programChunks[seq]);
  await call(`/api/recordings/${SESSION}/${GAP}/complete`, { method: "POST", json: { tracks: [{ trackId: "program", lastSeq: 7 }] } });
  const gap = await pollRecording(call, SESSION, GAP, (r) => ["finalized", "partial", "failed"].includes(r.state));
  assert.equal(gap.state, "partial", "a missing chunk makes the recording partial, not silently 'finalized'");
  assert.deepEqual(gap.tracks[0].sequence.missingSeqs, [4]);
  assert.equal(gap.tracks[0].sequence.contiguousThrough, 3);
  assert.ok(gap.tracks[0].final.bytes > 0 || gap.tracks[0].state === "failed", "gap recording reports an honest state");

  // --- Abandoned recording (browser died, never called complete) is recovered by the sweeper --------
  const ABANDON = "rec-abandoned-1";
  await call("/api/recordings", { method: "POST", json: { sessionId: SESSION, recordingId: ABANDON, startedAt, tracks: [tracks[0]] } });
  for (let seq = 0; seq < programChunks.length; seq += 1) await call(chunkUrl(SESSION, ABANDON, pTrack, seq), { method: "POST", body: programChunks[seq] });
  const recovered = await pollRecording(call, SESSION, ABANDON, (r) => ["finalized", "partial", "failed"].includes(r.state), 30000);
  assert.equal(recovered.state, "finalized", "chunks uploaded before a crash still become an MP4 with no client involvement");
  assert.equal(recovered.stopReason, "abandoned-recovered");
  const recoveredFile = await call(`/api/recordings/${SESSION}/${ABANDON}/files/host/program`);
  assert.equal(recoveredFile.status, 200);

  // --- On disk: chunks keyed session/recording/participant/track/seq -------------------------------
  const owners = await readdir(join(tmp, "recordings"));
  assert.equal(owners.length, 1, "storage is rooted per account; the intruder never created a directory");
  const owner = (await Promise.all(owners.map(async (o) => ((await readdir(join(tmp, "recordings", o))).includes(SESSION) ? o : null)))).find(Boolean);
  const chunkDir = join(tmp, "recordings", owner, SESSION, REC, "host", "program");
  const files = await readdir(chunkDir);
  assert.ok(files.includes("00000000.chunk") && files.includes("source.webm") && files.includes("final.mp4"));

  assert.ok(!/TypeError|ReferenceError|crashed/.test(serverErrors), `server errors: ${serverErrors}`);
  console.log("ALL PASSED — chunk-safe recording: resumable keyed chunks, manifest, async MP4/M4A finalization, crash recovery, isolation.");
} finally {
  if (server) server.kill("SIGTERM");
  await rm(tmp, { recursive: true, force: true });
}
