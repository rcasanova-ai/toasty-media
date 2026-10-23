#!/usr/bin/env node
// A/V SYNC measurement of the Studio's canvas recording path. A canvas flashes white while a 1 kHz beep plays, both
// scheduled from the SAME audio clock once per second. The stream goes through the real createProgramCanvasCapture and
// the real MediaRecorder (MP4 H.264/AAC where supported). In the finished file, flash frames (video PTS) and beep onsets
// (audio) are located and their offset measured. The recording hop that is under test is compared against the old direct
// microphone-clone path, so any latency added by the stable Web Audio track shows up as a difference between the two.
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, BASE, sleep } from "./lib/studio-browser-harness.mjs";
import { loadMono } from "./lib/audio-file-analysis.mjs";

const assert = makeAsserter();
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-av-sync-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();
await startServers(scratch);
const browser = await launchChrome(playwright, { programmePath: join(scratch, "unused.wav"), chromePath, extraArgs: [] });
const ctx = await browser.newContext({ viewport: { width: 800, height: 500 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto(`${BASE}/studio/`);

const RUN = `async ({ variant, seconds }) => {
  const { createProgramCanvasCapture } = await import("/js/program-canvas-capture.js");
  const gen = document.createElement("canvas"); gen.width = 640; gen.height = 360;
  const g = gen.getContext("2d");
  const camVideo = gen.captureStream(30).getVideoTracks()[0];
  const actx = new AudioContext({ sampleRate: 48000 });
  const dest = actx.createMediaStreamDestination(); dest.channelCount = 1;
  const osc = actx.createOscillator(); const gain = actx.createGain(); gain.gain.value = 0;
  osc.frequency.value = 1000; osc.connect(gain).connect(dest); osc.start(); await actx.resume();
  const audioStart = actx.currentTime + 1.0;
  for (let k = 0; k < seconds + 2; k++) { gain.gain.setValueAtTime(0.5, audioStart + k); gain.gain.setValueAtTime(0, audioStart + k + 0.12); }
  let raf = true;
  const loop = () => { const t = actx.currentTime - audioStart; const on = t >= 0 && (t % 1) < 0.12; g.fillStyle = on ? "#fff" : "#000"; g.fillRect(0, 0, 640, 360); if (raf) requestAnimationFrame(loop); };
  loop();
  const mic = dest.stream.getAudioTracks()[0];
  const camStream = new MediaStream([camVideo]);
  const cap = createProgramCanvasCapture({ getCamera: () => camStream, getScreen: () => null, getMicTrack: () => mic, ...(variant === "clone" ? { AudioContextImpl: null } : {}), ...(variant.startsWith("webaudio:") ? { micLatencyHint: variant.split(":")[1] === "interactive" || variant.split(":")[1] === "balanced" || variant.split(":")[1] === "playback" ? variant.split(":")[1] : Number(variant.split(":")[1]) } : {}) });
  const mime = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/webm;codecs=vp9,opus"].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(cap.stream, { mimeType: mime, audioBitsPerSecond: 160000, videoBitsPerSecond: 6000000 });
  const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(1000);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const stopped = new Promise((r) => (rec.onstop = r)); rec.stop(); await stopped;
  raf = false; cap.dispose(); osc.stop(); await actx.close();
  const blob = new Blob(chunks, { type: mime }); const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { b64: btoa(bin), mime, micKind: cap.mic.kind };
}`;

// Flash times from video PTS (frames whose mean luma jumps high), beep onsets from the audio envelope.
function flashTimes(path) {
  const out = execFileSync("ffmpeg", ["-v", "fatal", "-i", path, "-an", "-vf", "scale=16:9,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], { maxBuffer: 1 << 28 }).toString();
  const frames = []; let pts = null;
  for (const line of out.split("\n")) { const p = line.match(/pts_time:([\d.]+)/); if (p) pts = Number(p[1]); const y = line.match(/YAVG=([\d.]+)/); if (y && pts != null) frames.push({ t: pts, y: Number(y[1]) }); }
  const events = [];
  for (let i = 1; i < frames.length; i++) if (frames[i].y > 128 && frames[i - 1].y <= 128) events.push(frames[i].t);
  return events;
}
async function beepOnsets(path) {
  const { samples, sampleRate } = await loadMono(path, { seconds: 60 });
  const onsets = [], durations = []; const win = Math.round(sampleRate * 0.002); let quiet = true;
  for (let i = 0; i + win < samples.length; i += win) {
    let s = 0; for (let j = 0; j < win; j++) s += samples[i + j] * samples[i + j];
    const rms = Math.sqrt(s / win);
    if (quiet && rms > 0.1) { onsets.push(i / sampleRate); quiet = false; } else if (!quiet && rms < 0.02) { quiet = true; durations.push((i / sampleRate - onsets[onsets.length - 1]) * 1000); }
  }
  beepOnsets.lastDurations = durations;
  return onsets;
}

const result = {};
try {
  const VARIANTS = (process.env.SYNC_VARIANTS || "clone,webaudio").split(",");
  for (const variant of VARIANTS) {
    console.log(`\nVariant: ${variant}`);
    const r = await page.evaluate(`(${RUN})(${JSON.stringify({ variant, seconds: 14 })})`);
    const path = join(scratch, `sync-${variant}.${/mp4/.test(r.mime) ? "mp4" : "webm"}`);
    writeFileSync(path, Buffer.from(r.b64, "base64"));
    const flashes = flashTimes(path), beeps = await beepOnsets(path);
    const durs = [...beepOnsets.lastDurations]; const durMean = durs.reduce((a, b) => a + b, 0) / (durs.length || 1);
    // Pair each flash with the nearest beep onset.
    const offsets = flashes.map((f) => { const b = beeps.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity); return (b - f) * 1000; }).filter((d) => Math.abs(d) < 300);
    const mean = offsets.reduce((a, b) => a + b, 0) / (offsets.length || 1);
    const sd = Math.sqrt(offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / (offsets.length || 1));
    result[variant] = { mime: r.mime, micKind: r.micKind, flashes: flashes.length, beeps: beeps.length, meanOffsetMs: Math.round(mean * 10) / 10, sdMs: Math.round(sd * 10) / 10, beepMs: Math.round(durMean), beepMinMs: Math.round(Math.min(...durs)), beepMaxMs: Math.round(Math.max(...durs)), offsets: offsets.map((o) => Math.round(o)) };
    console.log(`  ${r.mime}  mic path: ${r.micKind}  flashes ${flashes.length}  beeps ${beeps.length}`);
    console.log(`  audio minus video offset: mean ${result[variant].meanOffsetMs} ms, sd ${result[variant].sdMs} ms; beep length ${result[variant].beepMinMs}-${result[variant].beepMaxMs} ms (expect ~120)   (per event: ${result[variant].offsets.join(", ")})`);
    assert(offsets.length >= 8, `${variant}: enough flash/beep pairs were found to measure (${offsets.length})`);
  }
  result.addedLatencyMs = Math.round((result.webaudio.meanOffsetMs - result.clone.meanOffsetMs) * 10) / 10;
  for (const k of Object.keys(result)) if (k.startsWith("webaudio:")) console.log(`  ${k}: audio minus video ${result[k].meanOffsetMs} ms`);
  console.log(`\nStable Web Audio track vs the previous direct clone: ${result.addedLatencyMs} ms (positive = audio later)`);
  assert(result.webaudio.micKind === "webaudio" && result.clone.micKind === "clone", "both code paths were really exercised");
  // Broadcast tolerance (EBU R37 / ITU BT.1359): audio up to ~40 ms early or ~60 ms late is not noticeable. The generator draws
  // each flash on the next animation frame, so measurements carry about +/-10 ms of source skew.
  assert(result.webaudio.meanOffsetMs > -40 && result.webaudio.meanOffsetMs < 60, `stable-track recording keeps audio within broadcast tolerance of video (${result.webaudio.meanOffsetMs} ms)`);
  assert(Math.abs(result.webaudio.meanOffsetMs) <= Math.abs(result.clone.meanOffsetMs) + 15, `and is no further from video than the previous direct path (${result.webaudio.meanOffsetMs} vs ${result.clone.meanOffsetMs} ms)`);
  assert(result.webaudio.sdMs < 25, `offset is steady across the take, no drift (sd ${result.webaudio.sdMs} ms)`);
  assert(result.webaudio.beepMaxMs - result.webaudio.beepMinMs <= 12, `no glitches: every beep is the same length (${result.webaudio.beepMinMs}-${result.webaudio.beepMaxMs} ms)`);
  writeFileSync(join(scratch, "report.json"), JSON.stringify(result, null, 2));
  if (process.env.REPORT_JSON) writeFileSync(process.env.REPORT_JSON, JSON.stringify(result, null, 2));
  console.log(`\nfiles: ${scratch}\nALL PASSED — recording sync measured on the real canvas capture path.`);
  await browser.close(); process.exit(0);
} catch (error) {
  console.error(error.message || error);
  try { writeFileSync(join(scratch, "report.json"), JSON.stringify(result, null, 2)); } catch (_) {}
  await browser.close().catch(() => {}); process.exit(1);
}
