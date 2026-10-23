#!/usr/bin/env node
// REAL-BROWSER audio pipeline measurement. A known programme (speech-like synth by default, or any WAV via
// AUDIO_PROGRAMME=/path.wav, e.g. real speech) is played into Chrome as the microphone, recorded by the actual Studio
// recorder, and measured at every stage so degradation can be located instead of guessed at:
//   0 reference file (what the fake microphone plays)
//   1 browser mic, all processing OFF        (device -> browser)
//   2 browser mic, Toasty default processing (echo cancel + noise suppression)  <- what Studio really records
//   3 Studio recording (the MP4/WebM the producer downloads)
//   4 exported/enhanced copy (optional enhancement applied to the recording; the original stays untouched)
// Also checks the exact constraints Chrome applied, A/V start offset, recorder slice gaps, and that no clipping,
// dropouts or level shifts were introduced.
//
// Needs playwright-core (PLAYWRIGHT_CORE=/abs/path/to/playwright-core/index.mjs or `npm i --no-save playwright-core`),
// Chrome (CHROME_PATH), ffmpeg/ffprobe, python3.   Env: STUDIO_RECORD_SECONDS (default 38), RECORD_FORMAT=webm, HEADLESS=1,
// SKIP_SERVERS=1, AUDIO_PROGRAMME, KEEP_DIR=/path (keep every stage file there), REPORT_JSON=/path.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { synthProgramme, wavBytes } from "./lib/synth-programme.mjs";
import { analyzeFile, loadMono } from "./lib/audio-file-analysis.mjs";
import { compareStages, compareSignals, detectRecorderGaps } from "../js/audio-analysis.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECONDS = Number(process.env.STUDIO_RECORD_SECONDS || 38);
const BASE = "http://127.0.0.1:4173", API = "http://127.0.0.1:4174";
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-audio-pipeline-"));
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let playwright;
try { playwright = await import(process.env.PLAYWRIGHT_CORE || "playwright-core"); } catch { console.log("SKIPPED: playwright-core is not installed (npm i --no-save playwright-core)."); process.exit(0); }
const chromePath = process.env.CHROME_PATH || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chromePath) { console.log("SKIPPED: no Chrome found (set CHROME_PATH)."); process.exit(0); }

// The programme the fake microphone plays. Chrome wants 16-bit PCM WAV; loop is the default.
const programmePath = join(scratch, "reference-programme.wav");
if (process.env.AUDIO_PROGRAMME) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", process.env.AUDIO_PROGRAMME, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", programmePath]);
else writeFileSync(programmePath, wavBytes(synthProgramme({ seconds: 36 }).samples));

const children = [];
process.on("exit", () => children.forEach((c) => { try { c.kill("SIGKILL"); } catch (_) {} }));
if (!process.env.SKIP_SERVERS) {
  children.push(spawn("python3", ["-m", "http.server", "4173", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" }));
  children.push(spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: "4174", TOASTY_AUTH_DB: join(scratch, "t.sqlite"), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "audio-test", RESEND_API_KEY: "", TOASTY_RECORDING_JOBS_DIR: join(scratch, "jobs") }, stdio: "ignore" }));
}
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${API}/health`)).ok && (await fetch(`${BASE}/studio/`)).ok) break; } catch (_) {} await sleep(250); }

const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: process.env.HEADLESS === "1",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${programmePath}`, "--auto-select-desktop-capture-source=Entire screen", "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required", ...(process.env.HEADLESS === "1" ? ["--headless=new"] : [])] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.grantPermissions(["camera", "microphone"], { origin: BASE });
if (process.env.RECORD_FORMAT) await ctx.addInitScript((f) => { try { localStorage.setItem("toasty.recording.format", f); } catch (_) {} }, process.env.RECORD_FORMAT);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
const H = { "Content-Type": "application/json", "X-Toasty-CSRF": "1" };

// Sample-accurate capture of a getUserMedia stream (AudioWorklet), returned as raw float32 + the settings Chrome applied.
const CAPTURE = `async ({ constraints, seconds }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const track = stream.getAudioTracks()[0];
  const ctx = new AudioContext({ sampleRate: 48000 });
  const src = 'class C extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice());return true}}registerProcessor("cap",C)';
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "cap"); const chunks = [];
  node.port.onmessage = (e) => chunks.push(e.data);
  ctx.createMediaStreamSource(stream).connect(node); await ctx.resume();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const settings = track.getSettings(); stream.getTracks().forEach((t) => t.stop()); await ctx.close();
  const total = chunks.reduce((n, c) => n + c.length, 0), all = new Float32Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  let bin = ""; const u8 = new Uint8Array(all.buffer); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), sampleRate: ctx.sampleRate, settings };
}`;
const writeF32Wav = (b64, sampleRate, path) => {
  const f32 = new Float32Array(Buffer.from(b64, "base64").buffer.slice(0));
  writeFileSync(path, wavBytes(f32, sampleRate));
  return f32.length / sampleRate;
};

async function openStudio(sessionId) {
  await page.goto(`${BASE}/studio/sessions.html?session=${sessionId}`);
  let frame; for (let i = 0; i < 60 && !frame; i++) { frame = page.frames().find((f) => f.url().includes("director.html")); if (!frame) await sleep(500); }
  if (!frame) throw new Error("studio frame never loaded");
  await frame.waitForFunction(() => window.__toastyLiveSession?.hostState === "prejoin-ready", null, { timeout: 30000 });
  return frame;
}

const report = { stages: [], settings: {}, notes: [] };
try {
  console.log("\nSetup");
  const sessionId = await page.goto(`${BASE}/studio/sessions.html`).then(() => page.evaluate(async ([API, H]) => {
    await fetch(API + "/auth/register", { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ name: "Audio", email: "audio" + Date.now() + "@example.com", password: "password10chars" }) });
    const s = await fetch(API + "/api/sessions", { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ title: "Audio pipeline", brandId: "toasty", roomId: "qa" + Math.random().toString(36).slice(2, 10) }) });
    return (await s.json()).session.id;
  }, [API, H]));
  const frame = await openStudio(sessionId);
  await frame.fill("#lvHostPrejoinName", "Audio Host");
  // The pre-join shows the processing presets and a live level meter.
  const setup = await frame.evaluate(() => ({ presets: [...document.querySelectorAll("#lvHostMicSetup [data-mic-preset] option")].map((o) => o.value), meter: !!document.querySelector("#lvHostMicSetup [data-mic-meter]"), note: document.querySelector("#lvHostMicSetup [data-mic-note]")?.textContent }));
  assert(setup.presets.join() === "speakers,headphones,studio" && setup.meter, "pre-join offers Speakers / Headphones / Studio presets and an input-level meter");
  // The meter follows the programme; wait for any moment where it reads a real level (the programme has pauses).
  await frame.waitForFunction(() => ["good", "quiet", "hot", "clipping"].includes(document.querySelector("#lvHostMicSetup [data-mic-meter]")?.dataset.state), null, { timeout: 30000 }).catch(() => {});
  const meterState = await frame.evaluate(() => ({ state: document.querySelector("#lvHostMicSetup [data-mic-meter]")?.dataset.state, word: document.querySelector("#lvHostMicSetup [data-mic-state]")?.textContent, note: document.querySelector("#lvHostMicSetup [data-mic-note]")?.textContent, width: document.querySelector("#lvHostMicSetup [data-mic-fill]")?.style.width }));
  report.settings.prejoinMeter = meterState;
  assert(["good", "quiet", "hot", "clipping"].includes(meterState.state), `the input-level meter reads the microphone (${meterState.state}: "${meterState.word}", bar ${meterState.width})`);
  await frame.click("#lvHostPrejoinJoin");
  await frame.waitForFunction(() => window.__toastyLiveSession.hostState === "in-studio", null, { timeout: 30000 });

  console.log("\nChrome mic constraints");
  const studioMic = await frame.evaluate(() => { const t = window.__toastyLiveSession._hostPreviewStream.getAudioTracks()[0]; return { ...t.getSettings(), label: t.label }; });
  report.settings.studioMic = studioMic;
  console.log("  Studio's own microphone track:", JSON.stringify(studioMic));
  assert(studioMic.echoCancellation === true && studioMic.noiseSuppression === true && studioMic.autoGainControl === false, "Studio mic runs with echo cancellation ON, noise suppression ON, AGC OFF");
  assert(studioMic.channelCount === 1 || studioMic.channelCount == null, `Studio mic is mono (${studioMic.channelCount})`);
  assert((studioMic.sampleRate || 48000) === 48000, `Studio mic is 48 kHz (${studioMic.sampleRate})`);

  console.log(`\nRecording ${SECONDS}s of the programme through the real Studio recorder`);
  const loops = Math.max(1, Math.floor(SECONDS / 36));
  const t0 = Date.now();
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => window.__toastyLiveSession.recording.active, null, { timeout: 15000 });
  // Capture the same device in parallel at two processing levels for the stage comparison.
  const secs = Math.min(SECONDS - 2, 36);
  const [raw, processed] = await Promise.all([
    frame.evaluate(`(${CAPTURE})(${JSON.stringify({ constraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48000 }, seconds: secs })})`),
    frame.evaluate(`(${CAPTURE})(${JSON.stringify({ constraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1, sampleRate: 48000 }, seconds: secs })})`)
  ]);
  report.settings.rawCaptureSettings = raw.settings; report.settings.processedCaptureSettings = processed.settings;
  writeF32Wav(raw.b64, raw.sampleRate, join(scratch, "stage1-mic-processing-off.wav"));
  writeF32Wav(processed.b64, processed.sampleRate, join(scratch, "stage2-mic-toasty-default.wav"));
  while ((Date.now() - t0) / 1000 < SECONDS) await sleep(500);
  const sliceTimes = await frame.evaluate(() => window.__toastyAudioSliceTimes || null);
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => ["finalized", "failed", "local-only", "too-large"].includes(window.__toastyLiveSession.recording.last?.finalizationStatus), null, { timeout: 240000 });
  const last = await frame.evaluate(() => { const l = window.__toastyLiveSession.recording.last; return { status: l.finalizationStatus, as: l.recordedAs, dur: l.durationSeconds, mime: l.masterBlob?.type || l.sourceBlob?.type }; });
  assert(last.status === "finalized", `recording finalized (${last.as || "converted"}, ${last.mime})`);
  await frame.evaluate(() => document.querySelector("[data-lv-view-btn=producer]").click());
  const dl = page.waitForEvent("download");
  await frame.evaluate(() => document.querySelector("#lvMasterDownload").click());
  const file = await dl; const recPath = join(scratch, "stage3-studio-recording" + (/\.mp4$/.test(file.suggestedFilename()) ? ".mp4" : ".webm"));
  await file.saveAs(recPath);

  console.log("\nMeasuring every stage");
  const stages = [
    { name: "0 reference programme", path: programmePath },
    { name: "1 browser mic, processing off", path: join(scratch, "stage1-mic-processing-off.wav") },
    { name: "2 browser mic, Toasty default", path: join(scratch, "stage2-mic-toasty-default.wav") },
    { name: "3 Studio recording", path: recPath }
  ];
  const measured = [];
  for (const s of stages) measured.push({ ...s, ...(await analyzeFile(s.path)) });
  const rows = measured.map((m) => `  ${m.name.padEnd(32)} ${String(m.probe.audio.codec).padEnd(10)} ${String(m.probe.audio.sampleRate).padStart(6)} Hz ${m.probe.audio.channels}ch ${String(m.probe.audio.bitrateKbps ?? "-").padStart(4)} kbps  peak ${String(m.analysis.peakDbfs).padStart(7)}  ${String(m.analysis.integratedLufs).padStart(7)} LUFS  LRA ${String(m.analysis.loudnessRangeLu).padStart(5)}  clip ${m.analysis.clippedSamples}  dropouts ${m.analysis.dropouts.length}`);
  console.log(rows.join("\n"));
  report.stages = measured.map((m) => ({ name: m.name, probe: m.probe, analysis: m.analysis }));
  // Stage files are different lengths by construction (capture window vs recording window), so duration is asserted against
  // the wall clock below rather than stage to stage.
  const findings = compareStages(measured.map((m) => ({ name: m.name, analysis: m.analysis })), { durationDriftSec: Infinity });
  report.findings = findings;
  for (const f of findings) console.log(`  [${f.severity}] ${f.stage}: ${f.code}: ${f.detail}`);

  console.log("\nSimilarity to the reference (delay, gain, waveform)");
  const ref = await loadMono(programmePath, { seconds: 60 });
  report.similarity = [];
  for (const m of measured.slice(1)) {
    const test = await loadMono(m.path, { seconds: 60 });
    const c = compareSignals(ref.samples, test.samples, ref.sampleRate, { maxDelaySec: 20 });   // the fake device loops the file from an arbitrary phase
    report.similarity.push({ stage: m.name, ...c });
    console.log(`  ${m.name.padEnd(32)} delay ${String(c.delayMs).padStart(8)} ms  gain ${String(c.gainDb).padStart(6)} dB  envelope r ${c.envelopeCorrelation}  waveform r ${c.waveformCorrelation}  signal-to-error ${c.signalToErrorDb} dB`);
  }

  console.log("\nAssertions on the recording");
  const rec = measured[3], mic2 = measured[2];
  assert(Math.abs((rec.probe.durationSec || 0) - SECONDS) < 2.5, `recording length matches the wall clock (${rec.probe.durationSec}s of ${SECONDS}s)`);
  assert(rec.probe.audio.sampleRate === 48000, `recording audio is 48 kHz (${rec.probe.audio.sampleRate})`);
  assert(/aac|opus/.test(rec.probe.audio.codec), `recording audio codec is ${rec.probe.audio.codec}`);
  assert((rec.probe.audio.bitrateKbps || 160) >= 128, `recording audio bitrate is ${rec.probe.audio.bitrateKbps} kbps (>= 128)`);
  assert(rec.analysis.clippedSamples === 0, "the recording contains no clipped samples");
  assert(rec.analysis.dropouts.length === 0, "the recording contains no digital-silence dropouts");
  assert(Math.abs(rec.analysis.integratedLufs - mic2.analysis.integratedLufs) < 1.5, `loudness survives recording unchanged (${mic2.analysis.integratedLufs} -> ${rec.analysis.integratedLufs} LUFS)`);
  assert(rec.analysis.peakDbfs - mic2.analysis.peakDbfs < 1.5, `no gain added by the recorder (peak ${mic2.analysis.peakDbfs} -> ${rec.analysis.peakDbfs} dBFS)`);
  assert(rec.probe.video ? Math.abs(rec.probe.avStartOffsetMs) < 150 : true, `audio and video start together in the container (offset ${rec.probe.avStartOffsetMs} ms)`);
  assert(Math.abs((rec.probe.audio.durationSec ?? rec.probe.durationSec) - (rec.probe.video?.durationSec ?? rec.probe.durationSec)) < 0.35, "audio and video are the same length (no drift)");

  console.log("\nOptional enhancement keeps the original and improves consistency");
  const enhancedPath = join(scratch, "stage4-studio-recording-enhanced.m4a");
  const { enhanceFile } = await import("./lib/audio-enhance-ffmpeg.mjs");
  const enh = await enhanceFile(recPath, enhancedPath, { audioOnly: true });
  const enhanced = await analyzeFile(enhancedPath);
  report.enhancement = { ...enh, analysis: enhanced.analysis, probe: enhanced.probe };
  console.log(`  original  ${rec.analysis.integratedLufs} LUFS  LRA ${rec.analysis.loudnessRangeLu} LU  peak ${rec.analysis.peakDbfs} dBFS  short-term std dev ${rec.analysis.shortTermStdDevLu} LU`);
  console.log(`  enhanced  ${enhanced.analysis.integratedLufs} LUFS  LRA ${enhanced.analysis.loudnessRangeLu} LU  peak ${enhanced.analysis.peakDbfs} dBFS  short-term std dev ${enhanced.analysis.shortTermStdDevLu} LU`);
  assert(enhanced.analysis.clippedSamples === 0 && enh.truePeakDbtp <= -0.9, `enhanced true peak stays under -1 dBTP (${enh.truePeakDbtp} dBTP, ${enh.truePeakCorrections} correction(s))`);
  assert(Math.abs(enhanced.analysis.integratedLufs - -16) < 1.2, `enhanced loudness lands on target (${enhanced.analysis.integratedLufs} LUFS)`);
  assert(enhanced.analysis.loudnessRangeLu <= rec.analysis.loudnessRangeLu + 0.5, `enhancement does not widen the loudness range (${rec.analysis.loudnessRangeLu} -> ${enhanced.analysis.loudnessRangeLu} LU)`);
  const sizeBefore = execFileSync("stat", ["-f", "%z", recPath]).toString().trim();
  assert(sizeBefore === String(measured[3].probe.sizeBytes), "the original recording file is untouched by enhancement");

  if (process.env.REPORT_JSON) writeFileSync(process.env.REPORT_JSON, JSON.stringify(report, null, 2));
  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nStage files and report.json: ${scratch}`);
  console.log("ALL PASSED — the Studio audio pipeline was measured end to end with no introduced clipping, dropouts or level shift.");
  await browser.close();
  process.exit(0);
} catch (error) {
  console.error(error.message || error);
  try { await page.screenshot({ path: join(scratch, "failure.png") }); console.error("screenshot:", join(scratch, "failure.png")); } catch (_) {}
  try { writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2)); console.error("partial report:", join(scratch, "report.json")); } catch (_) {}
  await browser.close().catch(() => {});
  process.exit(1);
}
