#!/usr/bin/env node
// REAL-BROWSER test of the Toasty Clips workspace (studio/clips.html): a Studio recording from the browser library and an
// uploaded video, Moxie's suggestions, trimming, plain-English instructions, template choice, and a multi-format export whose
// downloaded files are measured.
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthProgramme, wavBytes } from "./lib/synth-programme.mjs";
import { analyzeFile } from "./lib/audio-file-analysis.mjs";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, BASE, sleep } from "./lib/studio-browser-harness.mjs";

const assert = makeAsserter();
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-clips-ui-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();
const wav = join(scratch, "speech.wav"); writeFileSync(wav, wavBytes(synthProgramme({ seconds: 36 }).samples));
const source = join(scratch, "upload.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-i", wav, "-t", "34", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", source]);
const srt = join(scratch, "talk.srt");
writeFileSync(srt, `1
00:00:03,000 --> 00:00:07,000
Host: Welcome everyone, today is about hiring.

2
00:00:09,000 --> 00:00:14,000
Guest: Honestly I think the biggest mistake is hiring for resume instead of curiosity.

3
00:00:15,000 --> 00:00:21,000
Guest: Here is the thing, the reason it fails is because nobody owns the follow up.

4
00:00:23,000 --> 00:00:27,000
Host: Wait, no way, you are kidding. That actually happened to you?!
`);
await startServers(scratch);
const browser = await launchChrome(playwright, { programmePath: wav, chromePath });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
// Keep this test offline and deterministic: no downloadable models and no picture analysis (moxie-clips-browser-test.mjs and
// moxie-models-browser-test.mjs cover those).
await ctx.addInitScript(() => { try { localStorage.setItem("toasty.moxie.prefs", JSON.stringify({ models: false, visual: false })); } catch (_) {} });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
try {
  await page.goto(`${BASE}/studio/clips.html`);
  await page.waitForSelector("#tcLibrary li");
  assert(/Renders (MP4|WEBM)/.test(await page.textContent("#tcSupport")), `the page says what it can render (${await page.textContent("#tcSupport")})`);
  assert(await page.isHidden("#tcEdit"), "the edit panel stays out of the way until there is a clip");
  assert(/No Studio recordings/.test(await page.textContent("#tcLibrary")), "an empty library says so");

  console.log("\nStudio recording from the browser library");
  const startedAt = "2026-10-23T12:00:00.000Z", t0 = Date.parse(startedAt);
  await page.evaluate(async ({ b64, startedAt, t0 }) => {
    const { saveMediaBlob } = await import("/js/media-store.js");
    const { masterMediaId, masterManifestId } = await import("/js/program-recording.js");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const id = "rec-ui-test";
    await saveMediaBlob({ id: masterMediaId(id), blob: new Blob([bytes], { type: "video/mp4" }), metadata: { kind: "master:master", recordingId: id } });
    const manifest = { recordingId: id, startedAt, durationSeconds: 34, transcript: { lines: [
      { speaker: "Host", text: "Welcome everyone, today is about hiring.", timestamp: t0 + 3000 },
      { speaker: "Guest", text: "Honestly I think the biggest mistake is hiring for resume instead of curiosity.", timestamp: t0 + 9000 },
      { speaker: "Guest", text: "Here is the thing, the reason it fails is because nobody owns the follow up.", timestamp: t0 + 15000 },
      { speaker: "Host", text: "Wait, no way, you are kidding. That actually happened to you?!", timestamp: t0 + 23000 }] } };
    await saveMediaBlob({ id: masterManifestId(id), blob: new Blob([JSON.stringify(manifest)], { type: "application/json" }), metadata: { kind: "master-manifest", recordingId: id } });
  }, { b64: readFileSync(source).toString("base64"), startedAt, t0 });
  await page.click("#tcRefresh");
  await page.waitForSelector("#tcLibrary [data-recording]");
  assert(/\d+:\d\d/.test(await page.textContent("#tcLibrary [data-recording]")), "the recording appears in the library with its date and length");
  await page.click("#tcLibrary [data-recording]");
  await page.waitForFunction(() => document.querySelector("#tcVideo").src && !document.querySelector("#tcFind").disabled);
  assert(/4 transcript lines/.test(await page.textContent("#tcTranscriptNote")), "the Studio's own live transcript came with it");
  await page.click("#tcFind");
  await page.waitForSelector("#tcClips .tc-clip");
  const found = await page.evaluate(() => window.__toastyClips.clips.map((c) => ({ start: c.start, end: c.end, title: c.title, category: c.category, score: c.score, selected: c.selected })));
  console.log("  suggestions:", found.map((c) => `${c.start}-${c.end}s ${c.category} ${c.score} "${c.title.slice(0, 40)}"`).join(" | "));
  assert(found.length >= 1 && found.every((c) => c.end > c.start && c.title && c.score > 0), `Moxie suggested ${found.length} clip(s) with titles, scores and times`);
  assert(await page.isVisible("#tcEdit"), "the first suggestion is open for editing");

  console.log("\nUpload and an imported transcript");
  await page.setInputFiles("#tcFile", source);
  await page.waitForFunction(() => window.__toastyClips.source?.name === "upload.mp4" && !document.querySelector("#tcFind").disabled);
  await page.setInputFiles("#tcTranscriptFile", srt);
  await page.waitForFunction(() => /Imported 4 lines/.test(document.querySelector("#tcTranscriptNote").textContent));
  assert(true, "an SRT transcript was imported (4 lines)");
  await page.click("#tcFind");
  await page.waitForFunction(() => document.querySelectorAll("#tcClips .tc-clip").length > 0, null, { timeout: 60000 });
  const n = await page.locator("#tcClips .tc-clip").count();
  assert(n >= 1, `Moxie found ${n} clip(s) in the uploaded video`);

  console.log("\nTrim, instruct, style");
  await page.click("#tcClips .tc-clip [data-act=edit]");
  await page.fill("#tcStart", "0:06.0"); await page.dispatchEvent("#tcStart", "change");
  await page.fill("#tcEnd", "0:16.0"); await page.dispatchEvent("#tcEnd", "change");
  let c0 = await page.evaluate(() => { const c = window.__toastyClips.clips[window.__toastyClips.active]; return { start: c.start, end: c.end }; });
  assert(c0.start === 6 && c0.end === 16, "start and end are typed in");
  await page.click("[data-nudge='end:2']");
  c0 = await page.evaluate(() => { const c = window.__toastyClips.clips[window.__toastyClips.active]; return { start: c.start, end: c.end }; });
  assert(c0.end === 18 && /12\.0 s/.test(await page.textContent("#tcLen")), "nudging the end by 2 seconds updates the length (12.0 s)");
  await page.fill("#tcInstruction", "Give this clip an energetic opening with rolling text, subtle zooms, upbeat music, and a Toasty outro. Make it vertical. Lower third for Jane Doe, CEO.");
  await page.click("#tcApply");
  const understood = await page.textContent("#tcUnderstood");
  console.log("  Moxie understood:", understood.replace(/\s+/g, " "));
  assert(/Energy Burst/.test(understood) && /rolling text/.test(understood) && /Toasty/.test(understood) && /vertical/.test(understood) && /Jane Doe/.test(understood), "Moxie reports what it understood");
  const st = await page.evaluate(() => { const c = window.__toastyClips.clips[window.__toastyClips.active]; return { tpl: c.spec.templateId, aspects: c.spec.aspects, lt: c.spec.lt, music: c.spec.musicStyle }; });
  assert(st.tpl === "energy-burst" && st.aspects.join() === "9:16" && st.lt.name === "Jane Doe" && st.music === "upbeat", "the instruction changed the template, format, lower third and music");
  assert((await page.getAttribute("[data-tpl='energy-burst']", "aria-checked")) === "true", "the template gallery shows the chosen template");
  await page.check("[data-aspect='16:9']");
  assert((await page.evaluate(() => window.__toastyClips.clips[window.__toastyClips.active].spec.aspects)).length === 2, "a second format is added");
  await page.fill("#tcTitle", "Why hiring fails");
  await sleep(800);
  const px = await page.evaluate(() => { const c = document.getElementById("tcPreview"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 40) s += d[i] + d[i + 1] + d[i + 2]; return s; });
  assert(px > 0, "the preview canvas shows the styled frame");
  await page.screenshot({ path: join(scratch, "clips-ui.png"), fullPage: true });
  const unsupported = await page.evaluate(() => { const r = window.__toastyClips; return r.clips.length; });
  await page.fill("#tcInstruction", "add a flying unicorn sticker");
  await page.click("#tcApply");
  assert(/Could not do/.test(await page.textContent("#tcUnderstood")), "an instruction Moxie cannot do is reported, not silently ignored");

  console.log("\nExport");
  await page.evaluate(() => { for (const c of window.__toastyClips.clips) c.selected = false; window.__toastyClips.clips[window.__toastyClips.active].selected = true; });
  await page.click("#tcClips .tc-clip.is-active input[data-act=select]"); await page.click("#tcClips .tc-clip.is-active input[data-act=select]");
  assert(await page.isEnabled("#tcRender"), "Render selected clips is enabled");
  await page.click("#tcRender");
  await page.waitForSelector("#tcResults a[download]", { timeout: 240000 });
  await page.waitForFunction(() => /rendered/.test(document.querySelector("#tcRenderStatus").textContent), null, { timeout: 240000 });
  const links = await page.locator("#tcResults a[download]").count();
  assert(links === 2, `two files came out of one clip in two formats (${links})`);
  const files = [];
  for (let i = 0; i < links; i++) {
    const dl = page.waitForEvent("download");
    await page.locator("#tcResults a[download]").nth(i).click();
    const d = await dl; const p = join(scratch, d.suggestedFilename()); await d.saveAs(p); files.push(p);
  }
  const dims = files.map((p) => { const v = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "json", p]).toString()).streams[0]; return `${v.width}x${v.height}`; }).sort();
  console.log("  downloaded:", files.map((f) => f.split("/").pop()).join(", "), dims.join(" + "));
  assert(dims.join() === "1080x1920,1920x1080", "the downloads are 1080x1920 and 1920x1080");
  const a = (await analyzeFile(files[0])).analysis;
  assert(a.clippedSamples === 0 && a.integratedLufs > -30, `the audio is present and clean (${a.integratedLufs} LUFS, peak ${a.peakDbfs})`);
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("toasty.clips.")).length);
  assert(stored >= 1, "clip settings are remembered for next time (settings only, never the video)");
  assert(!errors.length, `no page errors (${errors.join(" | ") || "none"})`);
  console.log(`\nfiles: ${scratch}\nALL PASSED — the Clips workspace takes a recording or upload from suggestion to downloaded, styled files.`);
  await browser.close(); process.exit(0);
} catch (error) {
  console.error(error.message || error, errors.join(" | "));
  try { await page.screenshot({ path: join(scratch, "failure.png"), fullPage: true }); } catch (_) {}
  await browser.close().catch(() => {}); process.exit(1);
}
