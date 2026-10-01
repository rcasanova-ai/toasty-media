#!/usr/bin/env node
// Personal Recording Mode, end to end without a browser:
//   - compositor: skins, layouts, overlays, CTA/end screen, Moxie program-state mapping (pure model + fake 2D ctx)
//   - uploader: durable queue, retry/backoff, crash -> resume
//   - PersonalRecordingSession: camera + mic + composed program as three tracks through the REAL server,
//     async MP4/M4A finalization, refresh/crash recovery.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PORT = 4284;
const BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// ---- Browser fakes (installed before the modules under test are imported) ----------------------------
class FakeTrack {
  constructor(kind, label) { this.kind = kind; this.label = label; this.readyState = "live"; }
  getSettings() { return this.kind === "video" ? { width: 1280, height: 720, frameRate: 30 } : { sampleRate: 48000 }; }
  stop() { this.readyState = "ended"; }
}
class FakeMediaStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  addTrack(t) { this.tracks.push(t); }
}
const media = { program: [], camera: [], microphone: [] };
const recorders = [];
class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || (stream.getVideoTracks().length ? "video/webm;codecs=vp8,opus" : "audio/webm;codecs=opus");
    this.state = "inactive";
    this.handlers = { dataavailable: [], stop: [], error: [] };
    const hasV = stream.getVideoTracks().length > 0;
    const hasA = stream.getAudioTracks().length > 0;
    this.kind = hasV && hasA ? "program" : hasV ? "camera" : "microphone";
    if (this.kind === "camera") this.mimeType = "video/webm;codecs=vp8";
    this.cursor = 0;
    recorders.push(this);
  }
  addEventListener(type, fn, opts) { this.handlers[type].push({ fn, once: opts?.once }); }
  _emit(type, event) {
    for (const h of [...this.handlers[type]]) { h.fn(event); if (h.once) this.handlers[type].splice(this.handlers[type].indexOf(h), 1); }
  }
  _next() {
    const slices = media[this.kind];
    if (this.cursor < slices.length) this._emit("dataavailable", { data: new Blob([slices[this.cursor++]]) });
  }
  start(slice) { this.state = "recording"; this.timer = setInterval(() => this._next(), Math.max(15, slice / 50)); }
  halt() { clearInterval(this.timer); this.state = "inactive"; } // simulated crash: no stop event, no final slice
  stop() {
    clearInterval(this.timer);
    while (this.cursor < media[this.kind].length) this._next();
    this.state = "inactive";
    setTimeout(() => this._emit("stop", {}), 5);
  }
}
globalThis.MediaStream = FakeMediaStream;
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.window = globalThis;
Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getUserMedia: async () => { throw new Error("replaced per test"); } }, userAgent: "personal-recording-test" }, configurable: true });
globalThis.HTMLCanvasElement = class {};
globalThis.HTMLCanvasElement.prototype.captureStream = () => new FakeMediaStream([new FakeTrack("video", "canvas")]);

const {
  PersonalLayout, buildCompositionModel, renderProgramFrame, computeFrameLayout, resolveCompositorTheme,
  ProgramCompositor, tickerOffset, parsePadding, PROGRAM_RESOLUTIONS
} = await import("../js/program-compositor.js");
const { BRAND_THEMES } = await import("../js/brand-themes.js");
const { PersonalRecordingSession, PersonalRecordingState, compositorStateFromProgram } = await import("../js/personal-recording.js");
const { RecordingApiClient, ChunkUploader, MemoryChunkStore, recoverInterruptedRecording, recallActiveRecording } = await import("../js/recording-uploader.js");
const { LocalIsolatedRecorder } = await import("../js/recording.js");

function fakeCtx() {
  const calls = [];
  const state = {};
  const ctx = new Proxy({}, {
    get(_, prop) {
      if (prop === "calls") return calls;
      if (prop === "measureText") return (text) => ({ width: String(text).length * 9 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => ({ addColorStop() {} });
      if (prop in state) return state[prop];
      return (...args) => { calls.push([prop, ...args]); };
    },
    set(_, prop, value) { state[prop] = value; calls.push(["set:" + prop, value]); return true; }
  });
  return ctx;
}
const texts = (ctx) => ctx.calls.filter((c) => c[0] === "fillText").map((c) => c[1]);

// ---- Compositor: skins, layouts, overlays, CTA ---------------------------------------------------------
{
  const toasty = resolveCompositorTheme("toasty");
  const eight = resolveCompositorTheme("8alta");
  assert.notEqual(toasty.colors.primary, eight.colors.primary, "skins resolve to different brand colors");
  assert.equal(toasty.colors.primary, BRAND_THEMES.toasty.vars["--brand-primary"], "skin colors come from the same BRAND_THEMES vars as live Program Output");
  assert.equal(resolveCompositorTheme("not-a-real-skin").id, "toasty", "unknown skin falls back to the default");

  assert.deepEqual(parsePadding("6% 12%", 1000, 500), { top: 30, right: 120, bottom: 30, left: 120 });
  const single = computeFrameLayout({ layout: PersonalLayout.SINGLE, width: 1280, height: 720, hasAsset: false });
  assert.ok(single.camera.w < 1280 && single.camera.h < 720, "Framed layout floats the camera on the branded canvas");
  assert.equal(Math.round(single.camera.w / single.camera.h * 100), 178, "camera frame stays 16:9");
  const full = computeFrameLayout({ layout: PersonalLayout.FULLBLEED, width: 1280, height: 720, hasAsset: false });
  assert.deepEqual([full.camera.x, full.camera.y, full.camera.w, full.camera.h], [0, 0, 1280, 720]);
  const noAssetFallback = computeFrameLayout({ layout: PersonalLayout.ASSET_SPEAKER, width: 1280, height: 720, hasAsset: false });
  assert.equal(noAssetFallback.layout, PersonalLayout.SINGLE, "asset layouts fall back to Framed until an asset is live");
  const pip = computeFrameLayout({ layout: PersonalLayout.ASSET_SPEAKER_PIP, width: 1920, height: 1080, hasAsset: true });
  assert.ok(pip.asset && pip.camera.w < pip.asset.w / 3, "PiP layout: asset large, speaker small");
  const split = computeFrameLayout({ layout: PersonalLayout.ASSET_SPEAKER, width: 1280, height: 720, hasAsset: true });
  assert.ok(split.asset.x < split.camera.x, "asset left, speaker right");

  const asset = { id: "a1", status: "live", title: "Colosseum Q3 results", preview: { title: "Colosseum Q3 results", sourceName: "Reuters", excerpt: "Revenue up", imageUrl: null }, media: { kind: "card" } };
  const endCard = { headline: "THANKS FOR WATCHING", message: "Follow along", website: "toasty.media", socials: { x: "@toasty", linkedin: "toasty" }, showQr: false, qrImage: "" };
  const base = { brandTheme: "toasty", participants: [{ participantId: "host", role: "host", displayName: "Ada Lovelace", title: "Founder", company: "Analytical", onProgram: true }], endCard };

  const live = buildCompositionModel({ ...base, scene: "live" }, { width: 1280, height: 720, now: 1000 });
  assert.ok(live.cameraVisible && live.lowerThird, "live scene shows camera + name plate");
  assert.equal(live.lowerThird.name, "Ada Lovelace");
  assert.equal(live.lowerThird.secondary, "Analytical — Founder", "name plate uses the shared lower-third formatter");
  assert.equal(buildCompositionModel({ ...base, lowerThird: { visible: false } }).lowerThird, null, "name plate can be hidden");
  assert.ok(buildCompositionModel({ ...base, asset, layout: PersonalLayout.ASSET_SPEAKER_PIP }).asset, "asset card appears when Moxie/producer puts one live");
  assert.equal(buildCompositionModel({ ...base, asset: { ...asset, status: "removed" } }).asset, null);
  const withTicker = buildCompositionModel({ ...base, ticker: { enabled: true, text: "Breaking", speed: 16 } }, { tickerStartedMs: 0, now: 0 });
  assert.equal(withTicker.ticker.text, "Breaking");
  assert.ok(tickerOffset({ nowMs: 4000, startedMs: 0, speed: 16, viewportWidth: 1280, textWidth: 200 }) < 1280, "ticker scrolls");

  const ending = buildCompositionModel({ ...base, scene: "ending" });
  assert.equal(ending.endCard.headline, "THANKS FOR WATCHING");
  assert.equal(ending.endCard.website, "toasty.media");
  assert.deepEqual(ending.endCard.socials.map(([l]) => l), ["X", "LinkedIn"], "CTA/end screen carries the same social model as Program Output");
  assert.equal(ending.cameraVisible, false, "end screen replaces the picture");
  assert.equal(buildCompositionModel({ ...base, scene: "brb" }).card.kicker, "Be right back");
  assert.equal(buildCompositionModel({ ...base, scene: "holding", sessionTitle: "My Show" }).card.subtitle, "My Show");

  const ctx = fakeCtx();
  renderProgramFrame(ctx, ending, {});
  assert.ok(texts(ctx).includes("THANKS FOR WATCHING") && texts(ctx).includes("toasty.media"), "end screen is drawn");
  const ctx2 = fakeCtx();
  renderProgramFrame(ctx2, live, { video: { videoWidth: 1280, videoHeight: 720 } });
  assert.ok(ctx2.calls.some((c) => c[0] === "drawImage"), "camera frame is drawn");
  assert.ok(texts(ctx2).includes("Ada Lovelace"), "name plate is drawn");

  assert.equal(buildCompositionModel({ ...base, brandTheme: "8alta" }).watermark, "Powered by Toasty Studio", "client skins keep the Toasty attribution");
  assert.equal(buildCompositionModel(base).watermark, null, "native Toasty skin has no watermark");

  // Moxie / producer compatibility: canonical program state in -> compositor state out.
  const mapped = compositorStateFromProgram({ scene: "ending", asset, ticker: { enabled: true, text: "Hi", speed: 20 }, endCard, brandTheme: "8alta", topic: "AI" }, { brandTheme: "toasty", lockBrand: true });
  assert.equal(mapped.scene, "ending");
  assert.equal(mapped.asset.id, "a1");
  assert.equal(mapped.brandTheme, "toasty", "a locked brand is never overridden by the program state");
  assert.equal(mapped.endCard.website, "toasty.media");
  assert.equal(compositorStateFromProgram({ asset: { ...asset, status: "removed" } }).asset, null);

  // Real ProgramCompositor on a fake canvas draws frames from state updates.
  const canvas = { width: 0, height: 0, getContext: () => fakeCtx(), captureStream: (fps) => ({ fps }) };
  let tick;
  const compositor = new ProgramCompositor({ canvas, resolution: "1080p", documentImpl: { createElement: () => ({ play: async () => {} }) }, tickerFactory: (fps, cb) => { tick = cb; return { stop() { tick = null; } }; }, nowImpl: () => 0 });
  assert.deepEqual([canvas.width, canvas.height], [PROGRAM_RESOLUTIONS["1080p"].width, PROGRAM_RESOLUTIONS["1080p"].height]);
  compositor.start();
  tick(); tick();
  assert.ok(compositor.framesDrawn >= 3, "compositor keeps drawing on its ticker");
  compositor.setState({ scene: "ending", endCard });
  assert.equal(compositor.drawFrame().scene, "ending");
  assert.equal(compositor.captureStream().fps, 30);
  compositor.stop();
  assert.equal(tick, null, "stop() halts the ticker");
}

// ---- Server + real media for the transport/session tests ----------------------------------------------
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}
const tmp = await mkdtemp(join(tmpdir(), "toasty-personal-test-"));
let server;
try {
  server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: join(tmp, "auth.sqlite"),
      TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "personal-recording-test",
      TOASTY_RECORDINGS_DIR: join(tmp, "recordings")
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let serverErrors = ""; server.stderr.on("data", (c) => { serverErrors += c; });
  for (let i = 0; i < 60; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }

  const reg = await fetch(`${BASE}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json", "X-Toasty-CSRF": "1" }, body: JSON.stringify({ name: "Ada", email: "ada-personal@example.com", password: "password10chars" }) });
  assert.equal(reg.status, 201);
  const cookie = (reg.headers.get("set-cookie") || "").split(";")[0];
  const net = { offline: false, chunkPosts: 0, failChunksLeft: 0 };
  const fetchImpl = async (url, init = {}) => {
    const isChunk = /\/chunks\//.test(url);
    if (isChunk && (net.offline || net.failChunksLeft > 0)) { if (net.failChunksLeft > 0) net.failChunksLeft -= 1; throw new TypeError("offline"); }
    if (isChunk) net.chunkPosts += 1;
    return fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } });
  };
  const api = new RecordingApiClient({ endpoint: BASE, fetchImpl });

  const program = join(tmp, "p.webm"), camera = join(tmp, "c.webm"), mic = join(tmp, "m.webm");
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=660:duration=2", "-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest", program]);
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "smptebars=size=320x180:rate=30:duration=2", "-c:v", "libvpx", "-an", camera]);
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", mic]);
  const slice = (buf, n) => { const size = Math.ceil(buf.length / n); const out = []; for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size)); return out; };
  media.program = slice(await readFile(program), 8);
  media.camera = slice(await readFile(camera), 6);
  media.microphone = slice(await readFile(mic), 5);

  // ---- Uploader: durable queue, retries, resume ---------------------------------------------------------
  {
    const store = new MemoryChunkStore();
    const REC = "rec-uploader-1";
    await api.createRecording({ sessionId: "up-session", recordingId: REC, startedAt: Date.now(), tracks: [{ trackId: "t1", participantId: "host", type: "camera", mimeType: "video/webm", hasVideo: true, hasAudio: false }] });
    const uploader = new ChunkUploader({ api, store, sessionId: "up-session", recordingId: REC, retryBaseMs: 20, retryMaxMs: 60 });
    net.offline = true;
    await uploader.enqueue({ participantId: "host", trackId: "t1", seq: 0, blob: new Blob([media.camera[0]]) });
    await uploader.enqueue({ participantId: "host", trackId: "t1", seq: 1, blob: new Blob([media.camera[1]]) });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(store.size, 2, "chunks stay in the durable queue while offline — nothing is lost");
    assert.ok(uploader.stats().lastError, "uploader reports it is struggling");
    assert.equal((await api.getRecording("up-session", REC)).recording.tracks[0].sequence.count, 0);

    // "Crash": the page and its uploader vanish; only the durable store survives.
    uploader.close();
    net.offline = false;
    const next = new ChunkUploader({ api, store, sessionId: "up-session", recordingId: REC, retryBaseMs: 20 });
    assert.equal(await next.resumePending(), 2, "a fresh page finds the un-acked chunks");
    const flushed = await next.flush({ timeoutMs: 10000 });
    assert.ok(flushed.ok);
    assert.equal(store.size, 0, "acknowledged chunks leave the queue");
    assert.equal((await api.getRecording("up-session", REC)).recording.tracks[0].sequence.count, 2);

    // transient failures retry with backoff and still land
    net.failChunksLeft = 2;
    await next.enqueue({ participantId: "host", trackId: "t1", seq: 2, blob: new Blob([media.camera[2]]) });
    await next.flush({ timeoutMs: 10000 });
    assert.equal((await api.getRecording("up-session", REC)).recording.tracks[0].sequence.count, 3, "retried chunk uploaded");
    // a permanent rejection (unknown track) is reported, not retried forever
    await next.enqueue({ participantId: "host", trackId: "ghost", seq: 0, blob: new Blob(["x"]) });
    const bad = await next.flush({ timeoutMs: 10000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.failed[0].status, 404);
    next.close();
  }

  // ---- LocalIsolatedRecorder streaming mode -------------------------------------------------------------
  {
    const got = { audio: 0, video: 0 };
    const rec = new LocalIsolatedRecorder({ role: "host", roomId: "r", chunkSinks: { audio: () => { got.audio += 1; }, video: () => { got.video += 1; } }, timesliceMs: 1000 });
    const stream = new FakeMediaStream([new FakeTrack("audio", "mic"), new FakeTrack("video", "cam")]);
    await rec.start({ stream });
    await new Promise((r) => setTimeout(r, 100));
    const out = await rec.stop();
    assert.equal(out.streamed, true);
    assert.equal(out.audioBlob, null, "streamed recorder never accumulates a blob");
    assert.ok(got.audio >= 1 && got.video >= 1, "chunks went to sinks");
    assert.ok(stream.getTracks().every((t) => t.readyState === "live"), "a shared stream is not stopped by the recorder");
  }

  // ---- PersonalRecordingSession through the real server --------------------------------------------------
  const storage = (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const getUserMedia = async (constraints) => {
    assert.ok(constraints.audio && constraints.video, "asks for camera and microphone");
    return new FakeMediaStream([new FakeTrack("audio", "Mic"), new FakeTrack("video", "Cam")]);
  };
  const makeCanvas = () => ({ width: 0, height: 0, getContext: () => fakeCtx(), captureStream: () => new FakeMediaStream([new FakeTrack("video", "program-canvas")]) });
  const FakeCompositor = class extends ProgramCompositor {
    constructor(options) { super({ ...options, canvas: makeCanvas(), documentImpl: { createElement: () => ({ play: async () => {} }) }, tickerFactory: () => ({ stop() {} }) }); }
  };
  const session = (extra = {}) => new PersonalRecordingSession({
    api, store: new MemoryChunkStore(), storage, sessionId: "personal-test", participant: { displayName: "Ada", title: "Founder" },
    brandTheme: "8alta", layout: PersonalLayout.SINGLE, getUserMedia, CompositorImpl: FakeCompositor, AudioContextImpl: null,
    timesliceMs: 1000, uploaderOptions: { retryBaseMs: 20, retryMaxMs: 60 }, ...extra
  });

  // Happy path
  {
    const s = session();
    const started = await s.start();
    assert.equal(s.state, PersonalRecordingState.RECORDING);
    assert.ok(recallActiveRecording(storage), "an in-progress pointer is stored for crash recovery");
    s.setProgramState({ scene: "ending" });
    s.setProgramState({ layout: PersonalLayout.FULLBLEED });
    s.addMarker("manual", "Intro done");
    await new Promise((r) => setTimeout(r, 400));
    const stopped = await s.stop();
    assert.ok(stopped.recording, "stop() returns after completion is requested (finalization continues server-side)");
    assert.equal(recallActiveRecording(storage), null, "pointer cleared once completed");
    const manifest = await s.waitForFinalization({ timeoutMs: 60000, pollMs: 300 });
    assert.equal(manifest.state, "finalized", JSON.stringify(manifest.tracks.map((t) => t.final)) + serverErrors);
    assert.equal(manifest.mode, "personal");
    assert.equal(manifest.brandTheme, "8alta");
    assert.deepEqual(manifest.tracks.map((t) => t.trackId).sort(), ["camera", "microphone", "program"]);
    const byId = Object.fromEntries(manifest.tracks.map((t) => [t.trackId, t]));
    assert.equal(byId.program.role, "composed");
    assert.equal(byId.program.hasVideo && byId.program.hasAudio, true);
    assert.equal(byId.camera.hasAudio, false, "camera is an isolated video-only track");
    assert.equal(byId.microphone.hasVideo, false, "microphone is an isolated audio-only track");
    assert.ok(byId.program.final.file === "final.mp4" && byId.camera.final.file === "final.mp4" && byId.microphone.final.file === "final.m4a");
    assert.ok(byId.camera.offsetMs >= 0 && byId.microphone.offsetMs >= 0, "per-track sync offsets recorded");
    assert.equal(byId.program.sequence.missingSeqs.length, 0);
    assert.equal(manifest.markers[0].label, "Intro done");
    assert.ok(manifest.metadata.timeline.some((e) => e.type === "scene" && e.scene === "ending"), "scene changes are logged in the manifest timeline");
    const programFile = await api.downloadTrack("personal-test", started.recordingId, "host", "program");
    assert.ok(programFile.size > 1000, "composed program MP4 downloadable");
  }

  // Refresh/crash mid-recording: queued + already-uploaded chunks both survive and the MP4 still gets made
  {
    const crashStore = new MemoryChunkStore();
    const s = session({ store: crashStore });
    net.failChunksLeft = 4; // the first few uploads fail: chunks sit in the durable queue
    const started = await s.start();
    await new Promise((r) => setTimeout(r, 250));
    // CRASH: page dies. No stop(), no complete(), recorders just stop emitting.
    clearInterval(s._activityTimer);
    recorders.forEach((r) => r.halt());
    s.uploader.close();
    const emitted = Object.fromEntries(Object.entries(s.seqCounters));
    assert.ok(emitted.program > 0, "some chunks were produced before the crash");
    net.failChunksLeft = 0;

    const recovered = await recoverInterruptedRecording({ api, store: crashStore, storage, retryBaseMs: 20, retryMaxMs: 60 });
    assert.ok(recovered?.recovered, "next page load finishes the interrupted recording");
    assert.equal(crashStore.size, 0, "all queued chunks were uploaded during recovery");
    assert.equal(recallActiveRecording(storage), null);
    let manifest;
    for (let i = 0; i < 200; i += 1) {
      manifest = (await api.getRecording("personal-test", started.recordingId)).recording;
      if (["finalized", "partial", "failed"].includes(manifest.state)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(["finalized", "partial"].includes(manifest.state), `recovered recording produced files (state=${manifest.state}) ${serverErrors}`);
    assert.equal(manifest.tracks.find((t) => t.trackId === "program").sequence.count, emitted.program, "every chunk emitted before the crash reached the server");
    assert.ok(manifest.tracks.find((t) => t.trackId === "program").final.bytes > 0);
  }

  // Offline at stop: nothing is discarded, the session reports it is recoverable
  {
    const offStore = new MemoryChunkStore();
    const s = session({ store: offStore });
    await s.start();
    await new Promise((r) => setTimeout(r, 200));
    net.offline = true;
    const result = await s.stop({ flushTimeoutMs: 400 });
    assert.equal(result.recoverable, true, "stop while offline is recoverable, not lost");
    assert.ok(offStore.size > 0, "un-uploaded chunks remain in the durable queue");
    assert.ok(recallActiveRecording(storage), "pointer kept so the next load can finish it");
    net.offline = false;
    const recovered = await recoverInterruptedRecording({ api, store: offStore, storage, retryBaseMs: 20, retryMaxMs: 60 });
    assert.ok(recovered.recovered);
    assert.equal(offStore.size, 0);
  }

  assert.ok(!/TypeError|ReferenceError|crashed/.test(serverErrors), `server errors: ${serverErrors}`);
  console.log("ALL PASSED — Personal Recording: compositor (skins/layouts/overlays/CTA/Moxie state), durable uploader, three-track session, crash recovery.");
} finally {
  if (server) server.kill("SIGTERM");
  await rm(tmp, { recursive: true, force: true });
}
process.exit(0);
