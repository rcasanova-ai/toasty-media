#!/usr/bin/env node
// REAL-BROWSER loudness test. The same speech is played into Chrome as the microphone at three levels (very quiet, normal, loud),
// recorded by the actual Studio recorder, and the downloaded recording is measured with ffmpeg's EBU R128 meter. The same three
// sources (plus the real quiet recording that exposed the problem, when it is available) are then exported by Toasty Clips and the
// exported MP4s measured the same way.
//
// What it proves:
//   Studio recording  a -45 LUFS microphone is no longer recorded at -45 LUFS; a normal one is left alone; a loud one does not clip
//   Clips export      every source lands at about -16 LUFS with a true peak under -1 dBTP, and the app reports what it measured
//   Checks            a source with no audio is reported as having none; a very quiet source is reported as very quiet
// Env: ONLY=studio|clips (run half), HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR, TOASTY_QUIET_SAMPLE (the real quiet recording), STUDIO_SECONDS (default 26)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { synthProgramme, wavBytes } from "./lib/synth-programme.mjs";
import { ffmpegLoudness } from "./lib/audio-file-analysis.mjs";
import { measureLoudness } from "../js/audio-analysis.js";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, newStudioPage, createSession, openStudio, joinStudio, stopAndDownload, sleep, BASE } from "./lib/studio-browser-harness.mjs";

const assert = makeAsserter();
const SECONDS = Number(process.env.STUDIO_SECONDS || 26);
const ONLY = process.env.ONLY || "";
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-loudness-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();
await startServers(scratch);

// ---- sources -----------------------------------------------------------------------------------------------------
const programme = synthProgramme({ seconds: 36 }).samples;
const baseLufs = measureLoudness([programme], 48000).integratedLufs;
const levelled = (lufs) => { const g = 10 ** ((lufs - baseLufs) / 20), o = new Float32Array(programme.length); for (let i = 0; i < o.length; i++) o[i] = programme[i] * g; return o; };
const sources = [
  { name: "quiet", lufs: -45, clip: [4, 16] },
  { name: "normal", lufs: -23, clip: [4, 16] },
  { name: "loud", lufs: -12, clip: [4, 16] }
];
for (const s of sources) {
  s.wav = join(scratch, `mic-${s.name}.wav`);
  writeFileSync(s.wav, wavBytes(levelled(s.lufs)));
  s.mp4 = join(scratch, `source-${s.name}.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-i", s.wav, "-t", "34", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", s.mp4]);
}
const sample = process.env.TOASTY_QUIET_SAMPLE || `${homedir()}/Downloads/toastyaudiotest.mp4`;
if (existsSync(sample)) {
  const wav = join(scratch, "mic-sample.wav"), mp4 = join(scratch, "source-sample.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", sample, "-vn", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", sample, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", mp4]);
  sources.push({ name: "sample", lufs: -45.2, wav, mp4, clip: [7, 22], real: true });
}
// A source whose audio is digital silence.
const silentWav = join(scratch, "mic-silent.wav"); writeFileSync(silentWav, wavBytes(new Float32Array(48000 * 30)));
const silentMp4 = join(scratch, "source-silent.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-i", silentWav, "-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", silentMp4]);

// ---- Studio recording at each microphone level ---------------------------------------------------------------------
const studio = {};
for (const s of ONLY === "clips" ? [] : sources) {
  console.log(`\nStudio recording, microphone playing ${s.name} speech (${s.lufs} LUFS)${s.real ? " [the real recording]" : ""}`);
  const browser = await launchChrome(playwright, { programmePath: s.wav, chromePath });
  try {
    const { page } = await newStudioPage(browser);
    const session = await createSession(page, `Loudness ${s.name}`);
    const frame = await openStudio(page, session.id);
    await joinStudio(frame);
    await frame.evaluate(() => { window.__advice = []; window.__toastyLiveSession.on("recording-level", (a) => window.__advice.push(a)); });
    await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
    await frame.waitForFunction(() => window.__toastyLiveSession.recording.active, null, { timeout: 15000 });
    await sleep(SECONDS * 1000);
    const live = await frame.evaluate(() => window.__toastyLiveSession._programCaptureMic?.levelStats?.() || null);
    const { last, path } = await stopAndDownload(page, frame, scratch, `studio-${s.name}`);
    const info = await frame.evaluate(() => { const l = window.__toastyLiveSession.recording.last; return { audioLevel: l.manifest?.audioLevel || null, advice: window.__advice }; });
    const m = await ffmpegLoudness(path);
    studio[s.name] = { lufs: m.integratedLufs, tp: m.truePeakDbfs, info, live, path };
    console.log(`  recorded: ${m.integratedLufs} LUFS, true peak ${m.truePeakDbfs} dBTP; recorder gain up to ${info.audioLevel?.maxGainDb?.toFixed?.(1) ?? "n/a"} dB; advice: ${info.advice.map((a) => a.state).join(",") || "none"}`);
    assert(last.status === "finalized", "the recording finalized");
    assert(info.audioLevel && Number.isFinite(info.audioLevel.integratedLufs), `the manifest carries the measured loudness (${info.audioLevel?.integratedLufs?.toFixed?.(1)} LUFS)`);
    assert(m.truePeakDbfs <= -1.0, `true peak ${m.truePeakDbfs} dBTP after the encoder (the recorder's ceiling is -2 dBFS; AAC/Opus add up to 1 dB)`);
  } finally { await browser.close(); }
}
if (ONLY !== "clips") {
console.log("\nStudio recording results");
const q = studio.quiet, n = studio.normal, l = studio.loud;
assert(q.lufs > -34, `a very quiet microphone is no longer recorded at -45 LUFS (${q.lufs} LUFS)`);
assert(q.info.audioLevel.maxGainDb > 8, `because the recorder raised it (up to +${q.info.audioLevel.maxGainDb.toFixed(1)} dB)`);
assert(q.info.advice.some((a) => a.state === "quiet"), "and the host was told, in plain words, that the microphone is quiet");
assert(Math.abs(n.lufs - (-23)) < 4 && n.info.audioLevel.maxGainDb < 4, `a normal microphone is left essentially alone (${n.lufs} LUFS, gain up to ${n.info.audioLevel.maxGainDb.toFixed(1)} dB)`);
assert(!n.info.advice.some((a) => a.state === "quiet" || a.state === "silent"), "and produces no warning");
assert(l.info.audioLevel.maxGainDb < 1 && l.tp <= -1.0, `a loud microphone is never raised and stays under the ceiling (${l.lufs} LUFS, ${l.tp} dBTP)`);
if (studio.sample) assert(studio.sample.lufs > -32, `the real recording that exposed the problem now records at ${studio.sample.lufs} LUFS (it was -45.2)`);
}

if (ONLY === "studio") { console.log("\nALL PASSED (Studio half)"); process.exit(0); }
// ---- Clips export of each source -----------------------------------------------------------------------------------
console.log("\nToasty Clips export");
const browser = await launchChrome(playwright, { programmePath: sources[1].wav, chromePath });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
for (const s of [...sources, { name: "silent", mp4: silentMp4, clip: [2, 14], silent: true }]) {
  await page.route(`**/fixture-${s.name}.mp4`, (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: readFileSync(s.mp4) }));
}
await page.goto(`${BASE}/studio/`);
const RUN = `async ({ name, clip }) => {
  const R = await import("/js/clip-renderer.js");
  const { getTemplate } = await import("/js/clip-templates.js");
  const blob = await (await fetch("/fixture-" + name + ".mp4")).blob();
  const phases = [];
  const r = await R.renderClip({ source: blob, spec: { clip: { start: clip[0], end: clip[1] }, template: getTemplate("energy-burst"), aspect: "16:9", title: "Loudness check", lines: [], enhance: true }, onProgress: (p) => phases.push(p.phase) });
  const u = new Uint8Array(await r.blob.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return { container: r.container, audio: r.audio, b64: btoa(s), phases: [...new Set(phases)] };
}`;
const clips = {};
for (const s of [...sources, { name: "silent", clip: [2, 14], silent: true }]) {
  const t0 = Date.now();
  const r = await page.evaluate(`(${RUN})(${JSON.stringify({ name: s.name, clip: s.clip })})`);
  const path = join(scratch, `clip-${s.name}.${r.container}`);
  writeFileSync(path, Buffer.from(r.b64, "base64"));
  const m = await ffmpegLoudness(path);
  clips[s.name] = { ...m, audio: r.audio, path };
  console.log(`\n  ${s.name}: source ${r.audio.measuredBefore ? r.audio.measuredBefore.integratedLufs.toFixed(1) : "?"} LUFS -> exported ${m.integratedLufs} LUFS, true peak ${m.truePeakDbfs} dBTP (raised ${r.audio.appliedGainDb?.toFixed?.(1) ?? "n/a"} dB${r.audio.corrected ? `, corrected after a check: first pass ${r.audio.firstPass?.integratedLufs?.toFixed?.(1)} LUFS / ${r.audio.firstPass?.truePeakDbtp?.toFixed?.(1)} dBTP, predicted ${r.audio.firstPass?.predictedLufs?.toFixed?.(1)}` : ""}${r.audio.noiseReduction ? ", noise reduced" : ""}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (r.audio.messages?.length) console.log(`     the app says: ${r.audio.messages.join(" ")}`);
  if (!s.silent) {
    assert(m.integratedLufs >= -17.6 && m.integratedLufs <= -14.6, `exported at ${m.integratedLufs} LUFS (target -16 +/- 1.5)`);
    assert(m.truePeakDbfs <= -1.0, `true peak ${m.truePeakDbfs} dBTP is at or under -1 dBTP`);
    assert(r.audio.measuredAfter && Math.abs(r.audio.measuredAfter.integratedLufs - m.integratedLufs) < 0.8, `the app's own measurement of the file (${r.audio.measuredAfter?.integratedLufs?.toFixed?.(1)}) agrees with ffmpeg's (${m.integratedLufs})`);
  }
}
assert(clips.quiet.audio.warnings.includes("very-quiet") && clips.quiet.audio.measuredBefore.state === "very-quiet", "a very quiet source is reported as very quiet");
assert(clips.quiet.audio.appliedGainDb > 20, `and raised by what it needed (${clips.quiet.audio.appliedGainDb.toFixed(1)} dB), not a fixed amount`);
assert(clips.normal.audio.appliedGainDb < clips.quiet.audio.appliedGainDb - 15 && clips.loud.audio.appliedGainDb < 0, `a normal source gets far less (${clips.normal.audio.appliedGainDb.toFixed(1)} dB) and a loud one is lowered (${clips.loud.audio.appliedGainDb.toFixed(1)} dB)`);
assert(clips.silent.audio.warnings.includes("no-audio") && clips.silent.audio.ok === false, "a source with no audio is reported as having none, and the export fails the loudness check");
assert(!(clips.silent.audio.appliedGainDb > 0) && (clips.silent.integratedLufs == null || clips.silent.integratedLufs < -25), `and nothing is amplified out of silence (the export holds only the template music, ${clips.silent.integratedLufs} LUFS)`);
console.log("\nALL PASSED — Studio recordings and Clips exports are measured, brought up when too quiet, kept under the ceiling, and quiet or missing audio is reported.");
await browser.close();
process.exit(0);
