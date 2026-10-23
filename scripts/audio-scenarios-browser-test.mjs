#!/usr/bin/env node
// REAL-BROWSER scenarios that threaten a recording's audio while it is running, measured in the finished file:
//   the network goes offline mid-take · the microphone is switched mid-take (twice) · the microphone is lost (device
//   unplugged) and Studio must recover · all while the Studio keeps one continuous recording.
// The fake microphone plays a known programme on the default device; Chrome's other fake inputs play a beep track, so a
// successful switch is audible in the file and a silent gap is measurable.
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR, REPORT_JSON, AUDIO_PROGRAMME, RECORD_FORMAT=webm
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthProgramme } from "./lib/synth-programme.mjs";
import { analyzeFile, decodeAudio, probeFile } from "./lib/audio-file-analysis.mjs";
import { SampleStats } from "../js/audio-analysis.js";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, newStudioPage, createSession, openStudio, joinStudio, stopAndDownload, wavBytes, sleep } from "./lib/studio-browser-harness.mjs";

const assert = makeAsserter();
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-audio-scenarios-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();
const programmePath = join(scratch, "programme.wav");
if (process.env.AUDIO_PROGRAMME) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", process.env.AUDIO_PROGRAMME, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", programmePath]);
else writeFileSync(programmePath, wavBytes(synthProgramme({ seconds: 36 }).samples));
await startServers(scratch);
const browser = await launchChrome(playwright, { programmePath, chromePath });
const { ctx, page } = await newStudioPage(browser);
const report = { events: [], gaps: [] };
const timeline = [];
const mark = (label) => { timeline.push({ label, t: (Date.now() - t0) / 1000 }); console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`); };
let t0 = Date.now();

try {
  console.log("\nSetup");
  const { id: sessionId } = await createSession(page, "Audio scenarios");
  const frame = await openStudio(page, sessionId);
  await joinStudio(frame);
  const devices = await frame.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label })));
  console.log("  audio inputs:", devices.map((d) => d.label).join(" | "));
  assert(devices.length >= 3, "the browser exposes several microphones to switch between");
  const other = devices.find((d) => d.id !== "default" && !/default/i.test(d.label));

  console.log("\nRecording with interruptions");
  t0 = Date.now();
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => window.__toastyLiveSession.recording.active, null, { timeout: 15000 });
  const recKind = await frame.evaluate(() => ({ kind: window.__toastyLiveSession._programCaptureKind, mic: window.__toastyLiveSession._programCaptureMicKind }));
  report.captureKind = recKind;
  assert(recKind.mic === "webaudio", `the recorded microphone is the stable Web Audio track (${JSON.stringify(recKind)})`);
  const waitUntil = async (s) => { while ((Date.now() - t0) / 1000 < s) await sleep(200); };
  const step = async (s, label, fn) => { await waitUntil(s); mark(label); report.events.push({ at: (Date.now() - t0) / 1000, label }); await fn(); };

  await step(8, "network OFFLINE for 6 s", async () => { await ctx.setOffline(true); });
  await step(14, "network back ONLINE", async () => { await ctx.setOffline(false); });
  report.devicesBound = [await frame.evaluate(() => window.__toastyLiveSession._hostPreviewStream.getAudioTracks()[0].label)];
  const bound = async () => frame.evaluate(() => window.__toastyLiveSession._hostPreviewStream.getAudioTracks()[0].label);
  await step(18, `switch microphone to "${other.label}"`, async () => { await frame.evaluate((id) => window.__toastyLiveSession.switchHostMicrophone({ deviceId: id }), other.id); report.devicesBound.push(await bound()); });
  await step(26, "switch microphone back to the default (programme)", async () => { await frame.evaluate(() => window.__toastyLiveSession.switchHostMicrophone({ deviceId: "default" })); report.devicesBound.push(await bound()); });
  await step(32, "microphone LOST (device end event)", async () => { await frame.evaluate(() => window.__toastyLiveSession._hostPreviewStream.getAudioTracks()[0].dispatchEvent(new Event("ended"))); });
  await step(36, "check recovery", async () => {
    const state = await frame.evaluate(() => ({ live: window.__toastyLiveSession._hostPreviewStream.getAudioTracks()[0]?.readyState, rec: window.__toastyLiveSession.recording.active, recorder: window.__toastyLiveSession._masterRecorder?.fallback?.recorder?.state }));
    report.recoveryState = state;
    report.micSwaps = await frame.evaluate(() => window.__toastyLiveSession._programCaptureMicSwaps?.() ?? -1);
    assert(state.live === "live" && state.rec && state.recorder === "recording", `after the mic was lost Studio has a live microphone again and the recording is still running (${JSON.stringify(state)})`);
  });
  await waitUntil(40);
  const { last, path } = await stopAndDownload(page, frame, scratch, "scenarios-recording");
  assert(last.status === "finalized", `recording finalized (${last.as || "converted"})`);

  console.log("\nMeasuring the finished file");
  const probe = await probeFile(path);
  const whole = await analyzeFile(path);
  console.log(`  ${probe.audio.codec} ${probe.audio.sampleRate} Hz ${probe.audio.channels}ch ${probe.audio.bitrateKbps} kbps, ${probe.durationSec}s, ${whole.analysis.integratedLufs} LUFS, peak ${whole.analysis.peakDbfs} dBFS, clipped ${whole.analysis.clippedSamples}, dropouts ${whole.analysis.dropouts.length}`);
  assert(Math.abs(probe.durationSec - 40) < 3, `recording is one continuous file of the full length (${probe.durationSec}s)`);
  assert(whole.analysis.clippedSamples === 0, "no clipping anywhere in the take");

  // Per-second RMS timeline from the decoded file, so each interruption window can be inspected.
  const perSecond = [];
  let acc = [], fill = 0;
  await decodeAudio(path, probe, (chans) => {
    const mono = chans[0];
    for (let i = 0; i < mono.length; i++) { acc.push(mono[i] * mono[i]); if (acc.length === probe.audio.sampleRate) { perSecond.push(10 * Math.log10(acc.reduce((a, b) => a + b, 0) / acc.length + 1e-12)); acc = []; } }
  });
  report.perSecondRmsDbfs = perSecond.map((v) => Math.round(v * 10) / 10);
  console.log("  per-second RMS (dBFS): " + report.perSecondRmsDbfs.join(" "));

  // Digital-silence gaps at each event: find the longest zero-run in the window around the event.
  const longestGap = async (fromSec, toSec) => {
    const stats = new SampleStats(probe.audio.sampleRate, 1);
    let frames = 0;
    await decodeAudio(path, probe, (chans) => {
      const start = Math.max(0, Math.round(fromSec * probe.audio.sampleRate) - frames), end = Math.min(chans[0].length, Math.round(toSec * probe.audio.sampleRate) - frames);
      if (end > start) stats.push([chans[0].subarray(start, end)]);
      frames += chans[0].length;
    });
    const r = stats.result();
    return r.dropouts.reduce((m, d) => Math.max(m, d.durationMs), 0);
  };
  for (const ev of report.events.filter((e) => /switch|LOST|OFFLINE|ONLINE/.test(e.label))) {
    const gapMs = await longestGap(Math.max(0, ev.at - 1), ev.at + 2);
    report.gaps.push({ event: ev.label, longestDigitalSilenceMs: gapMs });
    console.log(`  around "${ev.label}" (t=${ev.at.toFixed(1)}s): longest digital silence ${gapMs} ms`);
    assert(gapMs < 250, `"${ev.label}" leaves no audible hole in the recording (${gapMs} ms)`);
  }
  // Signal must be present in every window of the take (programme pauses sit at the room-noise floor, never at silence).
  const quietSeconds = perSecond.slice(2, 38).filter((v) => v < -75).length;
  assert(quietSeconds === 0, `every second of the recording carries signal (seconds below -75 dBFS: ${quietSeconds})`);
  // (Chrome's fake inputs all play the same programme here, so the file cannot prove WHICH device was recorded; what it
  // can prove is continuity. Which device was bound is proven by the labels and swap count read from the session.)
  assert(report.devicesBound?.length >= 3 && report.devicesBound[0] !== report.devicesBound[1], `the session really bound different microphones during the take (${(report.devicesBound || []).join(" -> ")})`);
  assert(report.micSwaps >= 4, `the recorded Web Audio track was re-fed ${report.micSwaps} times (start + 2 switches + recovery) while the recorder never restarted`);
  assert(probe.audio.channels === 1, `the recording is mono, like the microphone (${probe.audio.channels} ch)`);
  if (process.env.REPORT_JSON) writeFileSync(process.env.REPORT_JSON, JSON.stringify(report, null, 2));
  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nfiles: ${scratch}\nALL PASSED — one continuous recording survived going offline, two microphone switches, and a lost microphone.`);
  await browser.close();
  process.exit(0);
} catch (error) {
  console.error(error.message || error);
  try { await page.screenshot({ path: join(scratch, "failure.png") }); console.error("screenshot:", join(scratch, "failure.png")); } catch (_) {}
  try { writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2)); } catch (_) {}
  await browser.close().catch(() => {});
  process.exit(1);
}
