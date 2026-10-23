#!/usr/bin/env node
// REAL-BROWSER test of the recording safety limiter (js/capture-audio-guard.js + js/limiter-worklet.js) on the same capture
// stream shape the recorder gets (video + audio), encoded by the real MediaRecorder (H.264/AAC MP4):
//   1) loud overlapping talkers (sum 1.4x full scale): unguarded recording CLIPS, guarded recording does not
//   2) normal-level audio: guarded and unguarded recordings have the same loudness and peak (transparent)
//   3) audio/video sync: the guard hop adds only a few ms (flash + beep scheduled from one clock)
//   4) fail-open: with the worklet unavailable or the guard switched off, the raw stream is recorded
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, BASE } from "./lib/studio-browser-harness.mjs";
import { analyzeFile, loadMono } from "./lib/audio-file-analysis.mjs";

const assert = makeAsserter();
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-limiter-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();
await startServers(scratch);
const browser = await launchChrome(playwright, { programmePath: join(scratch, "unused.wav"), chromePath });
const ctx = await browser.newContext({ viewport: { width: 800, height: 500 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto(`${BASE}/studio/`);

const RUN = `async ({ mode, guard, seconds }) => {
  const { guardCaptureAudio } = await import("/js/capture-audio-guard.js");
  const gen = document.createElement("canvas"); gen.width = 640; gen.height = 360; const g = gen.getContext("2d");
  const video = gen.captureStream(30).getVideoTracks()[0];
  const actx = new AudioContext({ sampleRate: 48000 });
  const dest = actx.createMediaStreamDestination(); dest.channelCount = 2;
  let audioStart = actx.currentTime + 1.0;
  if (mode === "beep") {
    const osc = actx.createOscillator(); const gain = actx.createGain(); gain.gain.value = 0; osc.frequency.value = 1000; osc.connect(gain).connect(dest); osc.start();
    for (let k = 0; k < seconds + 2; k++) { gain.gain.setValueAtTime(0.5, audioStart + k); gain.gain.setValueAtTime(0, audioStart + k + 0.12); }
  } else {
    const amp = mode === "hot" ? 0.7 : 0.2;                       // two talkers: hot sums to 1.4x full scale, normal to 0.4
    for (const f of [220, 330]) { const o = actx.createOscillator(); const gn = actx.createGain(); gn.gain.value = amp; o.frequency.value = f; o.connect(gn).connect(dest); o.start(); }
  }
  let raf = true;
  const loop = () => { const t = actx.currentTime - audioStart; const on = mode === "beep" && t >= 0 && (t % 1) < 0.12; g.fillStyle = on ? "#fff" : "#222"; g.fillRect(0, 0, 640, 360); if (raf) requestAnimationFrame(loop); };
  loop(); await actx.resume();
  const capture = new MediaStream([video, dest.stream.getAudioTracks()[0]]);
  const guarded = await guardCaptureAudio(capture, guard === "off" ? { enabled: false } : guard === "no-worklet" ? { onlyDisplayCapture: false, workletUrl: "/js/does-not-exist.js" } : { onlyDisplayCapture: false, ...(typeof guard === "object" ? guard : {}) });
  const mime = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/webm;codecs=vp9,opus"].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(guarded.stream, { mimeType: mime, audioBitsPerSecond: 160000, videoBitsPerSecond: 4000000 });
  const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(1000);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const stats = await guarded.stats();
  const stopped = new Promise((r) => (rec.onstop = r)); rec.stop(); await stopped;
  raf = false; guarded.dispose(); await actx.close();
  const buf = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { b64: btoa(bin), mime, applied: guarded.applied, reason: guarded.reason, stats };
}`;

function flashTimes(path) {
  const out = execFileSync("ffmpeg", ["-v", "fatal", "-i", path, "-an", "-vf", "scale=16:9,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], { maxBuffer: 1 << 28 }).toString();
  const frames = []; let pts = null;
  for (const line of out.split("\n")) { const p = line.match(/pts_time:([\d.]+)/); if (p) pts = Number(p[1]); const y = line.match(/YAVG=([\d.]+)/); if (y && pts != null) frames.push({ t: pts, y: Number(y[1]) }); }
  const ev = []; for (let i = 1; i < frames.length; i++) if (frames[i].y > 128 && frames[i - 1].y <= 128) ev.push(frames[i].t);
  return ev;
}
async function beepOnsets(path) {
  const { samples, sampleRate } = await loadMono(path, { seconds: 60 });
  const on = []; const win = Math.round(sampleRate * 0.002); let quiet = true;
  for (let i = 0; i + win < samples.length; i += win) { let s = 0; for (let j = 0; j < win; j++) s += samples[i + j] ** 2; const rms = Math.sqrt(s / win); if (quiet && rms > 0.1) { on.push(i / sampleRate); quiet = false; } else if (!quiet && rms < 0.02) quiet = true; }
  return on;
}
const record = async (name, args) => {
  const r = await page.evaluate(`(${RUN})(${JSON.stringify(args)})`);
  const path = join(scratch, `${name}.${/mp4/.test(r.mime) ? "mp4" : "webm"}`);
  writeFileSync(path, Buffer.from(r.b64, "base64"));
  return { ...r, path };
};

const report = {};
try {
  console.log("\nLoud overlapping talkers (sum reaches 1.4x full scale)");
  const hotRaw = await record("hot-unguarded", { mode: "hot", guard: "off", seconds: 6 });
  const hotGuard = await record("hot-guarded", { mode: "hot", guard: "on", seconds: 6 });
  const hr = (await analyzeFile(hotRaw.path)).analysis, hg = (await analyzeFile(hotGuard.path)).analysis;
  report.hot = { unguarded: hr, guarded: hg, limiter: hotGuard.stats };
  console.log(`  unguarded: peak ${hr.peakDbfs} dBFS, clipped samples ${hr.clippedSamples}, ${hr.integratedLufs} LUFS`);
  console.log(`  guarded:   peak ${hg.peakDbfs} dBFS, clipped samples ${hg.clippedSamples}, ${hg.integratedLufs} LUFS; limiter max reduction ${hotGuard.stats?.maxReductionDb?.toFixed?.(1)} dB`);
  assert(hotGuard.applied === true, "the guard started in the real browser (AudioWorklet loaded)");
  assert(hr.clippedSamples > 0 || hr.peakDbfs > -0.3, "without the guard the loud mix reaches full scale and clips in the encoder");
  assert(hg.clippedSamples === 0 && hg.peakDbfs <= -0.5, `with the guard nothing clips and peaks stay near the -2 dBFS ceiling after AAC encode/decode (${hg.peakDbfs} dBFS)`);
  assert(hotGuard.stats && hotGuard.stats.maxReductionDb < -2, `the audio thread reports the limiter acted (${hotGuard.stats?.maxReductionDb?.toFixed?.(1)} dB)`);

  console.log("\nNormal-level audio (peak about -8 dBFS) must be left alone");
  const nRaw = await record("normal-unguarded", { mode: "normal", guard: "off", seconds: 6 });
  const nGuard = await record("normal-guarded", { mode: "normal", guard: "on", seconds: 6 });
  const nr = (await analyzeFile(nRaw.path)).analysis, ng = (await analyzeFile(nGuard.path)).analysis;
  report.normal = { unguarded: nr, guarded: ng, limiter: nGuard.stats };
  console.log(`  unguarded: peak ${nr.peakDbfs} dBFS, ${nr.integratedLufs} LUFS, RMS ${nr.rmsDbfs}`);
  console.log(`  guarded:   peak ${ng.peakDbfs} dBFS, ${ng.integratedLufs} LUFS, RMS ${ng.rmsDbfs}; limiter max reduction ${nGuard.stats?.maxReductionDb}`);
  assert(Math.abs(nr.integratedLufs - ng.integratedLufs) < 0.3 && Math.abs(nr.rmsDbfs - ng.rmsDbfs) < 0.3 && Math.abs(nr.peakDbfs - ng.peakDbfs) < 0.6, `loudness and RMS are identical with and without the guard, and peaks agree within the encoder's own variation (${nr.peakDbfs} vs ${ng.peakDbfs} dBFS)`);
  assert(nGuard.stats && nGuard.stats.maxReductionDb === 0, "the limiter never acted on normal-level audio");

  console.log("\nAudio/video sync added by the guard hop (flash + beep from one clock)");
  const res = {};
  const syncVariants = process.env.LIMITER_VARIANTS ? ["off", ...JSON.parse(process.env.LIMITER_VARIANTS)] : ["off", "on"];
  for (const guardVariant of syncVariants) {
    const guard = typeof guardVariant === "object" ? JSON.stringify(guardVariant) : guardVariant;
    const r = await record(`sync-${guard.replace(/[^a-z0-9]/gi, "_")}`, { mode: "beep", guard: guardVariant, seconds: 14 });
    const flashes = flashTimes(r.path), beeps = await beepOnsets(r.path);
    const off = flashes.map((f) => (beeps.reduce((b, x) => (Math.abs(x - f) < Math.abs(b - f) ? x : b), Infinity) - f) * 1000).filter((d) => Math.abs(d) < 300);
    const mean = off.reduce((a, b) => a + b, 0) / (off.length || 1), sd = Math.sqrt(off.reduce((a, b) => a + (b - mean) ** 2, 0) / (off.length || 1));
    res[guard] = { pairs: off.length, meanMs: Math.round(mean * 10) / 10, sdMs: Math.round(sd * 10) / 10 };
    console.log(`  guard ${guard}: audio minus video ${res[guard].meanMs} ms (sd ${res[guard].sdMs}, ${off.length} events)`);
  }
  report.sync = res; report.syncAddedMs = Math.round((res.on.meanMs - res.off.meanMs) * 10) / 10;
  console.log(`  added by the guard: ${report.syncAddedMs} ms`);
  assert(res.on.pairs >= 8 && res.off.pairs >= 8, "enough flash/beep pairs to measure");
  assert(Math.abs(report.syncAddedMs) < 60, `the guard shifts audio against video by less than 60 ms (${report.syncAddedMs} ms; typically under 15 ms, up to ~50 ms seen between runs because the two audio clocks restart out of phase)`);
  assert(res.on.meanMs > -45 && res.on.meanMs < 125, `guarded audio is not early and stays inside the ITU-R BT.1359 late limit (${res.on.meanMs} ms; this generator has its own ~40 ms Web Audio baseline)`);

  console.log("\nFail-open");
  const off = await record("failopen-off", { mode: "normal", guard: "off", seconds: 3 });
  const nw = await record("failopen-noworklet", { mode: "normal", guard: "no-worklet", seconds: 3 });
  console.log(`  switched off: applied=${off.applied} (${off.reason});  worklet missing: applied=${nw.applied} (${nw.reason})`);
  assert(off.applied === false && off.reason === "disabled", "the localStorage switch disables the guard");
  const single = await page.evaluate(async () => { const { guardCaptureAudio } = await import("/js/capture-audio-guard.js"); const c = document.createElement("canvas"); const s = new MediaStream([c.captureStream(5).getVideoTracks()[0]]); const a = new AudioContext(); const d = a.createMediaStreamDestination(); s.addTrack(d.stream.getAudioTracks()[0]); const r = await guardCaptureAudio(s); a.close(); return { applied: r.applied, reason: r.reason }; });
  assert(single.applied === false && single.reason === "single-source-capture", "the Studio's single-microphone canvas recording is left alone (nothing is being mixed there)");
  assert(nw.applied === false && /failed/.test(nw.reason), "if the worklet cannot load the raw stream is recorded instead");
  assert((await analyzeFile(nw.path)).probe.audio.codec === "aac", "and that recording is still a valid MP4 with audio");

  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  if (process.env.REPORT_JSON) writeFileSync(process.env.REPORT_JSON, JSON.stringify(report, null, 2));
  console.log(`\nfiles: ${scratch}\nALL PASSED — the safety limiter prevents encoder clipping, leaves normal audio untouched, keeps sync, and fails open.`);
  await browser.close(); process.exit(0);
} catch (error) {
  console.error(error.message || error);
  try { writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2)); } catch (_) {}
  await browser.close().catch(() => {}); process.exit(1);
}
