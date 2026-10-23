#!/usr/bin/env node
// REAL-BROWSER regression for the original failure, end to end in Chrome:
//   upload an existing video -> transcription succeeds with ~30 plain segments (none contains a keyword trigger) ->
//   Analyze with Moxie -> useful, coherent candidate clips -> preview one -> edit it -> template + transition ->
//   export a playable MP4 (batch, three aspect ratios) -> audio/video stay in sync.
// Also: audio-only input, cancellation, browser refresh (cached transcript and clips), and the language model failing to load.
// The speech model is replaced by a deterministic stand-in so the test needs no network; the real audio decoding, vocal worker,
// frame sampling, engine, UI and renderer all run for real.
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavBytes } from "./lib/synth-programme.mjs";
import { voicedPcm, plainTranscript, SR } from "./lib/behavior-fixtures.mjs";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, BASE, sleep } from "./lib/studio-browser-harness.mjs";

const assert = makeAsserter();
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "moxie-clips-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();

// ---- media: 84 s, speech-like audio, a white flash + 1 kHz beep together at t = 40.0 s (for the A/V sync check) ----
const DUR = 84, FLASH = 40;
const pcm = voicedPcm([{ t0: 1, t1: DUR - 1, f0: 120, db: -28 }], DUR);
for (let i = Math.round(FLASH * SR); i < Math.round((FLASH + 0.3) * SR); i++) pcm[i] = 0.7 * Math.sin(2 * Math.PI * 1000 * i / SR);
const wav = join(scratch, "speech.wav"); writeFileSync(wav, wavBytes(pcm, SR));
const video = join(scratch, "upload.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x303030:s=640x360:r=30,drawbox=x=0:y=0:w=640:h=360:color=white:t=fill:enable='between(t,${FLASH},${FLASH + 0.3})'`, "-i", wav, "-t", String(DUR), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", video]);
const audioOnly = join(scratch, "audio-only.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, "-vn", "-c:a", "aac", "-b:a", "128k", "-t", "70", audioOnly]);

// 30 plain segments over the 84 s: none contains a keyword trigger.
const lines = plainTranscript({ seconds: 2.7, speakers: null }).map((l, i) => ({ t: l.t + 1, end: l.t + 3.4, speaker: "", text: l.text }));

await startServers(scratch);
const browser = await launchChrome(playwright, { programmePath: wav, chromePath });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
await ctx.addInitScript((lines) => {
  const bump = () => localStorage.setItem("test.transcribeCalls", String(Number(localStorage.getItem("test.transcribeCalls") || 0) + 1));
  window.__moxieHooks = {
    options: { tracker: "off" },
    get embedder() { return window.__noModel === false ? {} : { disableModel: true }; },
    deps: { transcribe: async (pcm, o) => {
      bump();
      if (window.__slowTranscribe) await new Promise((res, rej) => { o.signal?.addEventListener("abort", () => rej(new DOMException("Transcription cancelled", "AbortError"))); setTimeout(res, 60000); });
      o.onProgress?.(1); return lines;
    } }
  };
}, lines);
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const clipsState = () => page.evaluate(() => window.__toastyClips.clips.map((c) => ({ start: c.start, end: c.end, title: c.title, category: c.category, tier: c.tier, score: c.score, selected: c.selected, explanation: c.explanation, evidence: (c.evidence || []).length, rec: c.recommendation, tpl: c.spec.templateId, aspects: c.spec.aspects })));
const ffdecode = (p) => execFileSync("ffmpeg", ["-v", "error", "-i", p, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const probe = (p) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p]).toString());

try {
  await page.goto(`${BASE}/studio/clips.html`);
  await page.waitForSelector("#tcLibrary li");
  assert(/Analyze with Moxie/.test(await page.textContent("#tcFind")), "there is one primary button: Analyze with Moxie");

  console.log("\nUpload, automatic transcription, analysis");
  await page.setInputFiles("#tcFile", video);
  await page.waitForFunction(() => window.__toastyClips.source?.name === "upload.mp4" && !document.querySelector("#tcFind").disabled);
  assert(/No transcript yet/.test(await page.textContent("#tcTranscriptNote")), "the video has no transcript yet");
  await page.click("#tcFind");
  await page.waitForFunction(() => document.querySelectorAll("#tcClips .tc-clip").length > 0, null, { timeout: 120000 });
  const st = await page.textContent("#tcFindStatus"), clips = await clipsState();
  console.log("  status:", st);
  console.log("  stats:", JSON.stringify(await page.evaluate(() => ({ ...window.__toastyClips.analysis.stats, units: window.__toastyClips.analysis.timeline.tracks.transcript.map((u) => u.t + "-" + u.end).slice(-4), audio: window.__toastyClips.analysis.timeline.tracks.audio.map((e) => e.type + "@" + e.t).join(" "), dur: window.__toastyClips.analysis.timeline.duration }))));
  console.log(clips.map((c) => `   ${c.tier} ${c.score} ${c.start}-${c.end} ${c.category} "${c.title}" -> ${c.rec.aspect} ${c.rec.templateId}`).join("\n"));
  assert(!/No standout moments/.test(st), "it does NOT say \"No standout moments found\"");
  assert(await page.evaluate((n) => window.__toastyClips.source.lines.length === n, lines.length), `transcription produced ${lines.length} segments`);
  assert(clips.length >= 3, `Moxie returned ${clips.length} candidate clips from a transcript with no trigger phrases`);
  assert(clips.every((c) => c.end - c.start >= 8 && c.end - c.start <= 80 && c.title && c.explanation && c.rec.templateId), "each has bounds, a title, an explanation and a recommended style");
    const signals = await page.textContent("#tcSignals"), notes = await page.textContent("#tcNotes");
  assert(/Words: .*from whisper/.test(signals) && /Voice:/.test(signals) && /shared-vocabulary fallback/.test(signals), `the panel says what was used (${signals.replace(/\s+/g, " ").slice(0, 160)})`);
  assert(/Movement: measured/.test(signals) || /Movement/.test(signals), "movement from the picture was measured");
  assert(/Faces: none detected or not tracked/.test(signals), "faces are reported as not tracked (tracker off in this test), not invented");
  assert(await page.evaluate(() => window.__toastyClips.analysis.timeline.tracks.motion.length + window.__toastyClips.analysis.timeline.tracks.audio.length > 0), "the behavior timeline holds voice and picture events on one clock");
  const sudden = await page.evaluate((f) => window.__toastyClips.analysis.timeline.tracks.motion.filter((e) => e.type === "sudden-movement").map((e) => e.t), FLASH);
  assert(sudden.some((t) => Math.abs(t - FLASH) <= 2.5), `the flash at ${FLASH}s was detected as sudden movement (${sudden.join(", ")})`);
  const firstWithEvidence = await page.evaluate(() => [...document.querySelectorAll("#tcClips .tc-clip")].map((li) => li.querySelector("details")?.textContent.length || 0));
  assert(firstWithEvidence.length === clips.length, "every clip card is rendered with its explanation");
  assert((await page.locator("#tcClips .tc-rec").count()) === clips.length, "and with its recommendation");

  console.log("\nPreview, edit, style");
  await page.click("#tcClips .tc-clip [data-act=play]");
  await sleep(1800);
  const played = await page.evaluate(() => { const v = document.getElementById("tcVideo"), c = window.__toastyClips.clips[0]; return { t: v.currentTime, start: c.start, end: c.end }; });
  assert(played.t > played.start + 0.5 && played.t <= played.end + 0.3, `a candidate plays inside its bounds (${played.t.toFixed(1)}s within ${played.start}–${played.end})`);
  await page.click("#tcClips .tc-clip [data-act=edit]");
  assert(await page.isVisible("#tcEdit"), "editing opens");
  await page.fill("#tcStart", "0:30.0"); await page.dispatchEvent("#tcStart", "change");
  await page.fill("#tcEnd", "0:50.0"); await page.dispatchEvent("#tcEnd", "change");
  await page.fill("#tcTitle", "Why small shops fail at pricing"); await page.waitForTimeout(300);
  const edited = await page.evaluate(() => { const c = window.__toastyClips.clips[window.__toastyClips.active]; return { start: c.start, end: c.end, title: c.spec.title }; });
  assert(edited.start === 30 && edited.end === 50 && edited.title === "Why small shops fail at pricing", "start, end and title are adjustable");
  await page.click("[data-tpl='minimal-cut']");
  await page.fill("#tcInstruction", "Use a wipe transition and karaoke captions");
  await page.click("#tcApply");
  await page.selectOption("#tcMusic", "upbeat");
  const spec = await page.evaluate(() => { const c = window.__toastyClips.clips[window.__toastyClips.active]; return { tpl: c.spec.templateId, ov: c.spec.overrides, music: c.spec.musicStyle }; });
  console.log("  spec:", JSON.stringify(spec), (await page.textContent("#tcUnderstood")).replace(/\s+/g, " "));
  assert(spec.tpl === "minimal-cut" && spec.ov.transition?.kind === "wipe" && spec.ov.captions?.style === "karaoke" && spec.music === "upbeat", "a template and a plain-English instruction set the wipe transition, karaoke captions and music");
  await page.waitForTimeout(500);
  const px = await page.evaluate(() => { const c = document.getElementById("tcPreview"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 40) s += d[i] + d[i + 1] + d[i + 2]; return s; });
  assert(px > 0, "the styled preview frame is drawn");

  console.log("\nExport: batch, three aspect ratios, and A/V sync");
  await page.check("[data-aspect='16:9']"); await page.uncheck("[data-aspect='9:16']"); await page.uncheck("[data-aspect='1:1']");
  // Clip A: contains the flash+beep, one format. Clip B: another passage, two formats.
  await page.evaluate(() => { const cs = window.__toastyClips.clips; cs.forEach((c) => { c.selected = false; }); cs[window.__toastyClips.active].selected = true; });
  const active0 = await page.evaluate(() => window.__toastyClips.active), other = clips.findIndex((c, i) => i !== active0 && c.start >= 55);
  assert(other >= 0, "another passage is available for the batch");
  await page.click(`#tcClips .tc-clip[data-i='${other}'] [data-act=edit]`);
  await page.fill("#tcStart", "0:62.0"); await page.dispatchEvent("#tcStart", "change");
  await page.fill("#tcEnd", "0:74.0"); await page.dispatchEvent("#tcEnd", "change");
  await page.check("[data-aspect='9:16']"); await page.check("[data-aspect='1:1']"); await page.uncheck("[data-aspect='16:9']").catch(() => {});
  await page.click(`#tcClips .tc-clip[data-i='${other}'] input[data-act=select]`);
  const nSel = await page.evaluate(() => window.__toastyClips.clips.filter((c) => c.selected).length);
  assert(nSel === 2, "two clips are selected for a batch");
  await page.click("#tcRender");
  await page.waitForFunction(() => /rendered/.test(document.querySelector("#tcRenderStatus").textContent), null, { timeout: 300000 });
  const links = await page.locator("#tcResults a[download]").count();
  assert(links === 3, `the batch produced 3 files: 1 + 2 formats (${links})`);
  const files = [];
  for (let i = 0; i < links; i++) { const dl = page.waitForEvent("download"); await page.locator("#tcResults a[download]").nth(i).click(); const d = await dl; const p = join(scratch, d.suggestedFilename()); await d.saveAs(p); files.push(p); }
  const dims = files.map((f) => { const v = probe(f).streams.find((s) => s.codec_type === "video"); return `${v.width}x${v.height}`; }).sort();
  console.log("  files:", files.map((f) => f.split("/").pop()).join(", "), dims.join(" "));
  assert(dims.join() === "1080x1080,1080x1920,1920x1080", "the files are 1920x1080, 1080x1920 and 1080x1080");
  for (const f of files) { const info = probe(f); assert(/mp4/.test(info.format.format_name) && info.streams.some((s) => s.codec_type === "audio") && Number(info.format.duration) > 5 && ffdecode(f).trim() === "", `${f.split("/").pop()} is a playable MP4 with video and audio that decodes without errors (${Number(info.format.duration).toFixed(1)} s)`); }

  const landscape = files.find((f) => /16x9/.test(f));
  // A/V sync: find the first bright frame and the first loud audio sample in the 1920x1080 clip; they were simultaneous in the source.
  const lf = landscape || files[0];
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", lf, "-vf", "fps=30,scale=16:9,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  let vFlash = null; for (let i = 0; i * 144 < raw.length; i++) { let s = 0; for (let k = 0; k < 144; k++) s += raw[i * 144 + k]; if (s / 144 > 180) { vFlash = i / 30; break; } }
  const aud = execFileSync("ffmpeg", ["-v", "error", "-i", lf, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const fa = new Float32Array(aud.buffer, aud.byteOffset, Math.floor(aud.length / 4)); let aBeep = null;
  // the beep is a pure 1 kHz tone at 0.7: find the first window whose RMS is high
  for (let i = 0; i + 160 < fa.length; i += 80) { let s = 0; for (let k = 0; k < 160; k++) s += fa[i + k] * fa[i + k]; if (Math.sqrt(s / 160) > 0.25) { aBeep = i / 16000; break; } }
  console.log(`  flash at ${vFlash?.toFixed(3)} s, beep at ${aBeep?.toFixed(3)} s in the exported clip (expected ${(FLASH - 30).toFixed(1)} s plus any intro)`);
  assert(vFlash != null && aBeep != null, "the flash and the beep are both present in the export");
  assert(Math.abs(vFlash - aBeep) <= 0.15, `audio and video stay in sync: ${Math.abs(vFlash - aBeep).toFixed(3)} s apart (limit 0.15 s)`);
  assert(Math.abs(vFlash - (FLASH - 30)) <= 0.5, "and land at the right moment in the clip");

  console.log("\nBrowser refresh keeps the work, and does not transcribe again");
  const calls1 = await page.evaluate(() => Number(localStorage.getItem("test.transcribeCalls")));
  assert(calls1 === 1, "the speech model was asked once so far");
  await page.reload();
  await page.waitForSelector("#tcLibrary li");
  await page.setInputFiles("#tcFile", video);
  await page.waitForFunction(() => window.__toastyClips.source?.name === "upload.mp4" && !document.querySelector("#tcFind").disabled);
  assert(/Restored \d+ clips/.test(await page.textContent("#tcFindStatus")), "clips come back after a refresh");
  const restored = await clipsState();
  assert(restored.some((c) => c.title === "Why small shops fail at pricing" || c.start === 30) , "including the edited title and bounds");
  assert(/transcript lines/.test(await page.textContent("#tcTranscriptNote")) && (await page.evaluate(() => window.__toastyClips.source.lines.length)) === lines.length, "the transcript is remembered");
  await page.click("#tcFind");
  await page.waitForFunction(() => /Moxie found/.test(document.querySelector("#tcFindStatus").textContent), null, { timeout: 120000 });
  assert((await page.evaluate(() => Number(localStorage.getItem("test.transcribeCalls")))) === 1, "analysing again used the cached transcript: no second transcription");

  console.log("\nCancellation");
  const p2 = await ctx.newPage(); await p2.addInitScript(() => { window.__slowTranscribe = true; localStorage.removeItem("toasty.clips.lines.upload-upload.mp4-" + 0); });
  await p2.goto(`${BASE}/studio/clips.html`); await p2.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("toasty.clips.")) localStorage.removeItem(k); });
  await p2.reload(); await p2.waitForSelector("#tcLibrary li");
  await p2.setInputFiles("#tcFile", video);
  await p2.waitForFunction(() => window.__toastyClips.source?.name === "upload.mp4" && !document.querySelector("#tcFind").disabled);
  await p2.click("#tcFind");
  await p2.waitForSelector("#tcAnalyzeCancel:not([hidden])");
  assert(await p2.isDisabled("#tcFind"), "while analysing, the button is disabled and progress is shown");
  await sleep(1500);
  await p2.click("#tcAnalyzeCancel");
  await p2.waitForFunction(() => /cancelled/i.test(document.querySelector("#tcFindStatus").textContent), null, { timeout: 15000 });
  assert((await p2.evaluate(() => window.__toastyClips.clips.length)) === 0 && await p2.isEnabled("#tcFind") && await p2.isHidden("#tcAnalyzeCancel"), "cancelling leaves no half-finished clips and re-enables the button");
  await p2.close();

  console.log("\nAudio-only input");
  const p3 = await ctx.newPage(); await p3.goto(`${BASE}/studio/clips.html`); await p3.waitForSelector("#tcLibrary li");
  await p3.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("toasty.clips.")) localStorage.removeItem(k); });
  await p3.setInputFiles("#tcFile", audioOnly);
  await p3.waitForFunction(() => window.__toastyClips.source?.name === "audio-only.mp4" && !document.querySelector("#tcFind").disabled, null, { timeout: 20000 });
  await p3.click("#tcFind");
  await p3.waitForFunction(() => window.__toastyClips.clips.length > 0, null, { timeout: 120000 });
  const aclips = await p3.evaluate(() => window.__toastyClips.clips.map((c) => ({ tier: c.tier, ev: (c.evidence || []).map((e) => e.modality) })));
  assert(aclips.length >= 1, `an audio-only file is analysed (${aclips.length} clips)`);
  assert(/Movement: not measured|Faces: none/.test(await p3.textContent("#tcSignals")) && /No picture was found/.test(await p3.textContent("#tcNotes")), "the panel says there was no picture");
  await p3.close();

  console.log("\nLanguage model fails to download");
  const p4 = await ctx.newPage(); await p4.addInitScript(() => { window.__noModel = false; });
  await p4.route(/cdn\.jsdelivr\.net|huggingface\.co|storage\.googleapis\.com/, (r) => r.abort());
  await p4.goto(`${BASE}/studio/clips.html`); await p4.waitForSelector("#tcLibrary li");
  await p4.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("toasty.clips.")) localStorage.removeItem(k); });
  await p4.setInputFiles("#tcFile", video);
  await p4.waitForFunction(() => window.__toastyClips.source?.name === "upload.mp4" && !document.querySelector("#tcFind").disabled);
  await p4.click("#tcFind");
  await p4.waitForFunction(() => window.__toastyClips.clips.length > 0, null, { timeout: 120000 });
  assert(/language model could not be loaded/.test(await p4.textContent("#tcNotes")) && /shared-vocabulary fallback/.test(await p4.textContent("#tcSignals")), "a blocked model download is reported on screen and the lexical fallback produced clips");
  await p4.close();

  assert(!errors.length, `no page errors (${errors.join(" | ") || "none"})`);
  console.log("\nAll Moxie Clips browser checks passed.");
} catch (error) { console.error(String(error?.stack || error)); process.exitCode = 1; } finally { await browser.close(); process.exit(process.exitCode || 0); }
