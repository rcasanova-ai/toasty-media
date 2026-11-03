#!/usr/bin/env node
// REAL WebRTC transport measurement through VDO.Ninja (the engine that actually captures and publishes guest voices).
// A guest publisher and a Program-Output-style viewer run in one Chrome with a known noisy programme as the microphone.
// Measured for two publisher URLs: the OLD one (proaudio only) and the CURRENT one from js/video-engine.js:
//   what echo cancellation / noise suppression / AGC the published track really has (track.getSettings() inside VDO),
//   the received audio's level, loudness, noise floor and SNR, and WebRTC loss / jitter / concealment.
// Needs internet (vdo.ninja), playwright-core, Chrome, ffmpeg.   Env: AUDIO_PROGRAMME, NOISE_DBFS (default -42),
// SECONDS (default 22), HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR, REPORT_JSON.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { synthProgramme, wavBytes } from "./lib/synth-programme.mjs";
import { analyzeFile } from "./lib/audio-file-analysis.mjs";
import { summarizeRtcAudioStats, rtcQualityVerdict } from "../js/audio-analysis.js";
import { buildGuestPublisherParams, buildVdoUrl } from "../js/video-engine.js";

const SECONDS = Number(process.env.SECONDS || 22);
const NOISE_DBFS = Number(process.env.NOISE_DBFS ?? -42);
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-audio-vdo-"));
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let playwright;
try { playwright = await import(process.env.PLAYWRIGHT_CORE || "playwright-core"); } catch { console.log("SKIPPED: playwright-core is not installed."); process.exit(0); }
const chromePath = process.env.CHROME_PATH || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chromePath) { console.log("SKIPPED: no Chrome found."); process.exit(0); }
try { await fetch("https://vdo.ninja/", { method: "HEAD", signal: AbortSignal.timeout(8000) }); } catch { console.log("SKIPPED: vdo.ninja is not reachable from here."); process.exit(0); }

// Programme = speech-like material + steady room/fan noise, so noise suppression has something real to do.
const clean = join(scratch, "clean.wav"), noisy = join(scratch, "noisy-programme.wav");
if (process.env.AUDIO_PROGRAMME) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", process.env.AUDIO_PROGRAMME, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", clean]);
else writeFileSync(clean, wavBytes(synthProgramme({ seconds: 36 }).samples));
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", clean, "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=${(10 ** (NOISE_DBFS / 20) * 1.6).toFixed(5)}:sample_rate=48000`, "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", noisy]);

const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: process.env.HEADLESS === "1",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${noisy}`, "--autoplay-policy=no-user-gesture-required", ...(process.env.HEADLESS === "1" ? ["--headless=new"] : [])] });

const RECEIVE = `async ({ seconds }) => {
  const els = [...document.querySelectorAll("video,audio")].filter((e) => e.srcObject?.getAudioTracks?.().length);
  if (!els.length) return { error: "no audio element with a stream" };
  const stream = new MediaStream([els[0].srcObject.getAudioTracks()[0]]);
  const ctx = new AudioContext({ sampleRate: 48000 });
  const src = 'class C extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice());return true}}registerProcessor("cap",C)';
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "cap"); const chunks = [];
  node.port.onmessage = (e) => chunks.push(e.data);
  ctx.createMediaStreamSource(stream).connect(node); await ctx.resume();
  const statsAt = async () => { const pcs = Object.values(window.session?.rpcs || {}).filter((r) => typeof r?.getStats === "function"); const out = []; for (const r of pcs) { try { const rep = await r.getStats(); rep.forEach((v) => out.push(v)); } catch (_) {} } return out; };
  await new Promise((r) => setTimeout(r, 3000));
  const statsStart = await statsAt();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const statsEnd = await statsAt();
  await ctx.close();
  const total = chunks.reduce((n, c) => n + c.length, 0), all = new Float32Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  let bin = ""; const u8 = new Uint8Array(all.buffer); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), stats: statsEnd, statsStart, receivedSettings: els[0].srcObject.getAudioTracks()[0].getSettings() };
}`;

async function runVariant(name, params) {
  const room = "toastyaudio" + Math.random().toString(36).slice(2, 9);
  const streamId = room + "g";
  const pubUrl = buildVdoUrl({ ...params, room, push: streamId, videodevice: undefined, audiodevice: undefined, effects: undefined, view: true });
  // Viewer built exactly like Toasty's Program Output frame (mountProgramFrame).
  const viewUrl = buildVdoUrl({ room, scene: "0", cleanoutput: "1", transparent: "1", showlabels: "1", controls: "0", proaudio: "1" });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  await ctx.grantPermissions(["camera", "microphone"]);
  const pub = await ctx.newPage(), view = await ctx.newPage();
  await pub.goto(pubUrl);
  await sleep(4000);
  await view.goto(viewUrl);
  let published = null;
  for (let i = 0; i < 40 && !published; i++) {
    await sleep(1000);
    published = await pub.evaluate(() => { try { const t = window.session?.streamSrc?.getAudioTracks?.()[0]; return t ? { ...t.getSettings(), label: t.label } : null; } catch (_) { return null; } }).catch(() => null);
  }
  let ready = false;
  for (let i = 0; i < 45 && !ready; i++) { await sleep(1000); ready = await view.evaluate(() => [...document.querySelectorAll("video,audio")].some((e) => e.srcObject?.getAudioTracks?.().length && e.srcObject.getAudioTracks()[0].readyState === "live")).catch(() => false); }
  if (!ready) { await pub.screenshot({ path: join(scratch, `${name}-pub.png`) }); await view.screenshot({ path: join(scratch, `${name}-view.png`) }); await ctx.close(); throw new Error(`variant ${name}: the viewer never received audio (screenshots in ${scratch})`); }
  const rx = await view.evaluate(`(${RECEIVE})(${JSON.stringify({ seconds: SECONDS })})`);
  await ctx.close();
  if (rx.error) throw new Error(`variant ${name}: ${rx.error}`);
  const f32 = new Float32Array(Buffer.from(rx.b64, "base64").buffer.slice(0));
  const wav = join(scratch, `received-${name}.wav`);
  writeFileSync(wav, wavBytes(f32, 48000));
  const measured = await analyzeFile(wav);
  const start = summarizeRtcAudioStats(rx.statsStart), end = summarizeRtcAudioStats(rx.stats, start);
  return { name, url: pubUrl, published, analysis: measured.analysis, rtc: end, verdict: rtcQualityVerdict(end), wav };
}

const oldParams = (() => { const { params } = buildGuestPublisherParams({ roomId: "x", guestName: "Guest" }); const { aec, denoise, autogain, ...rest } = params; return rest; })();
const newParams = buildGuestPublisherParams({ roomId: "x", guestName: "Guest" }).params;
const report = { programme: { noiseDbfs: NOISE_DBFS, file: noisy }, variants: [] };
try {
  const ref = await analyzeFile(noisy);
  report.reference = ref.analysis;
  console.log(`\nSource programme (microphone input): ${ref.analysis.integratedLufs} LUFS, noise floor ${ref.analysis.noiseFloorDbfs} dBFS, speech level ${ref.analysis.speechLevelDbfs} dBFS, SNR ~${ref.analysis.snrEstimateDb} dB`);
  for (const [name, params] of [["old-proaudio-only", oldParams], ["current-toasty", newParams]]) {
    console.log(`\nVariant: ${name}`);
    const v = await runVariant(name, params);
    report.variants.push(v);
    const p = v.published || {};
    console.log(`  published track: echoCancellation=${p.echoCancellation} noiseSuppression=${p.noiseSuppression} autoGainControl=${p.autoGainControl} channels=${p.channelCount} rate=${p.sampleRate}`);
    const a = v.analysis, i = v.rtc.inbound || {};
    console.log(`  received: ${a.integratedLufs} LUFS, peak ${a.peakDbfs} dBFS, noise floor ${a.noiseFloorDbfs} dBFS, speech ${a.speechLevelDbfs} dBFS, SNR ~${a.snrEstimateDb} dB, loudness range ${a.loudnessRangeLu} LU, clipped ${a.clippedSamples}`);
    console.log(`  WebRTC: loss ${i.packetLossPct ?? "n/a"}%  jitter ${i.jitterMs ?? "n/a"} ms  concealed ${i.concealedPct ?? "n/a"}%  verdict: ${v.verdict.state}`);
  }
  const [oldV, newV] = report.variants;
  console.log("\nAssertions");
  assert(oldV.published && newV.published, "both publishers produced an audio track whose settings could be read");
  assert(oldV.published.echoCancellation === false && oldV.published.noiseSuppression === false, "OLD URL (proaudio only): VDO published with echo cancellation OFF and noise suppression OFF");
  assert(newV.published.echoCancellation === true && newV.published.noiseSuppression === true && newV.published.autoGainControl === false, "CURRENT URL: VDO publishes with echo cancellation ON, noise suppression ON, AGC OFF");
  assert(newV.analysis.noiseFloorDbfs < oldV.analysis.noiseFloorDbfs - 3, `noise floor is lower with processing on (${oldV.analysis.noiseFloorDbfs} -> ${newV.analysis.noiseFloorDbfs} dBFS)`);
  assert(newV.analysis.snrEstimateDb > oldV.analysis.snrEstimateDb, `speech-to-noise gap improves (${oldV.analysis.snrEstimateDb} -> ${newV.analysis.snrEstimateDb} dB)`);
  assert(oldV.analysis.clippedSamples === 0 && newV.analysis.clippedSamples === 0, "no clipping introduced by transport");
  assert(newV.rtc.inbound && oldV.rtc.inbound, "WebRTC inbound audio stats were collected for both variants");
  assert(newV.rtc.inbound.packetLossPct < 2 && newV.rtc.inbound.concealedPct < 5, `WebRTC loss (${newV.rtc.inbound.packetLossPct}%) and concealment (${newV.rtc.inbound.concealedPct}%) are low on loopback, so the link itself is not the problem`);
  if (process.env.REPORT_JSON) writeFileSync(process.env.REPORT_JSON, JSON.stringify(report, null, 2));
  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nfiles: ${scratch}\nALL PASSED — VDO publishes with the processing Toasty asks for, and the received audio was measured.`);
  await browser.close(); process.exit(0);
} catch (error) {
  console.error(error.message || error);
  try { writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2)); } catch (_) {}
  await browser.close().catch(() => {}); process.exit(1);
}
