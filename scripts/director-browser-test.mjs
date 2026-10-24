#!/usr/bin/env node
// REAL-BROWSER, REAL-VIDEO end-to-end test of Make My Video and the Automatic Director.
//
//   Part A  the page: upload -> analysis -> pick a style -> plain-English instruction -> Make My Video -> preview -> revisions
//           (supported, and one that cannot be done) -> export -> cancel. The manual Clips workspace still works.
//   Part B  the engine: the same interview rendered in all three styles at 16:9, 9:16 and 1:1 with the browser's own encoder, then every
//           exported file is measured from its pixels and samples: typography on screen exactly when planned, crops and zooms where the
//           plan put them, transitions that blend or sweep and never go black, graphics, audio/video sync, loudness and peaks,
//           speech intelligibility under the music, music beat and sound-accent timing, and that the three styles really look different.
//
// Fixtures: with macOS `say` the interview is spoken by two real text-to-speech voices (real speech, exact transcript timing).
// Without it (CI) a synthetic speech-like programme stands in, and the report says so.
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR, QUICK=1 (fewer renders), NO_TTS=1
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, BASE, sleep } from "./lib/studio-browser-harness.mjs";
import { analyzeFile } from "./lib/audio-file-analysis.mjs";
import { buildInterviewMedia, buildBrollClip, HEAD } from "./lib/director-media.mjs";
import * as F from "./lib/director-fixtures.mjs";
import * as V from "./lib/director-verify.mjs";
import { frameState } from "../js/director/frame-state.js";
import { cropWindow } from "../js/director/framing.js";

const assert = makeAsserter();
const soft = (cond, msg) => { console.log(`  ${cond ? "ok" : "NOTE"} — ${msg}`); return cond; };
const QUICK = process.env.QUICK === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;      // e.g. ONLY=sound,broll to run just those parts
const want = (part) => !ONLY || ONLY.has(part);
const VERIFY_ONLY = Boolean(process.env.VERIFY_ONLY);      // re-measure the files and plans a previous run kept in KEEP_DIR (no browser, no rendering)
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-director-"));
const playwright = VERIFY_ONLY ? null : await loadPlaywright();
const chromePath = VERIFY_ONLY ? null : findChrome();
const report = { tts: false, outputs: [], audio: [], limitations: [] };

console.log("Building the interview fixture");
const media = await buildInterviewMedia(join(scratch, "media"));
report.tts = media.tts;
console.log(`  ${media.tts ? `real speech: macOS text-to-speech voices ${JSON.stringify(media.voices)}` : "SYNTHETIC speech-like audio (no text-to-speech available): intelligibility numbers below are for synthetic speech"}; ${media.total.toFixed(1)} s, ${media.lines.length} lines`);
const picture = F.pictureFromLines(media.lines, media.total);
const silentVideo = join(scratch, "media", "interview-silent.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", media.video, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-shortest", silentVideo]);
const broll = buildBrollClip(join(scratch, "media"));

let browser = null, ctx = null, page = null; const errors = [];
const save = async (promise, name) => { const dl = await promise; const p = join(scratch, name); await dl.saveAs(p); return p; };
const clean = (s) => s.replace(/\s+/g, " ").trim();
await (async () => {})();
if (!VERIFY_ONLY) {
await startServers(scratch);
browser = await launchChrome(playwright, { programmePath: media.wav, chromePath });
ctx = await browser.newContext({ viewport: { width: 1360, height: 1100 }, acceptDownloads: true });
await ctx.addInitScript(({ lines, picture }) => {
  // The speech model and the face tracker are replaced by deterministic stand-ins so the test needs no network. The real audio
  // decoding, vocal worker, language analysis, planner, renderer and encoder all run for real.
  window.__moxieHooks = {
    options: { tracker: "off" },
    embedder: { disableModel: true },
    deps: {
      transcribe: async (pcm, o) => { o?.onProgress?.(1); return lines; },
      sampleVideo: async () => ({ samples: picture.map((s) => ({ ...s })), caps: { face: true, motion: true, hands: false, pose: false }, notes: [] })
    }
  };
}, { lines: media.lines, picture });
page = await ctx.newPage();
page.on("pageerror", (e) => { errors.push(String(e)); console.log("[pageerror]", String(e).slice(0, 300)); });
await page.route("**/fixture-interview.mp4", (r) => r.fulfill({ status: 200, contentType: "video/mp4", body: readFileSync(media.video) }));
await page.route("**/fixture-silent.mp4", (r) => r.fulfill({ status: 200, contentType: "video/mp4", body: readFileSync(silentVideo) }));
await page.route("**/fixture-broll.mp4", (r) => r.fulfill({ status: 200, contentType: "video/mp4", body: readFileSync(broll) }));
await page.goto(`${BASE}/studio/clips.html`);
await page.waitForSelector("#mmv");


// =====================================================================================================================
console.log("\nPart A: Make My Video, in the page");
if (want("ui")) {
assert(await page.isVisible("#mmvMake") && /Make My Video/.test(await page.textContent("#mmvMake")), "an obvious Make My Video button is on the Toasty Clips page");
assert(await page.isDisabled("#mmvMake"), "it is disabled until a recording is chosen");
assert((await page.locator("#mmvStyles [data-style]").count()) === 3 && /Clean Professional/.test(await page.textContent("#mmvStyles")) && /High Energy/.test(await page.textContent("#mmvStyles")) && /Cinematic/.test(await page.textContent("#mmvStyles")), "step 2 offers Clean Professional, High Energy and Cinematic");
assert(await page.isVisible("#mmvInstruction"), "step 3 is an optional plain-English instruction box");
assert(!(await page.locator("canvas[class*=timeline], .timeline, [data-timeline]").count()), "no timeline to open");

await page.setInputFiles("#mmvFile", media.video);
await page.waitForFunction(() => window.__toastyClips?.source?.name === "interview.mp4" && document.getElementById("mmvMake") && !document.getElementById("mmvMake").disabled, null, { timeout: 30000 });
assert(/interview\.mp4/.test(await page.textContent("#mmvSource")), "step 1: the uploaded recording is shown");
await page.click("#mmvStyles [data-style=energy]");
assert((await page.getAttribute("#mmvStyles [data-style=energy]", "aria-checked")) === "true", "step 2: High Energy is selected");
await page.fill("#mmvInstruction", "Make a punchy 40-second vertical video. Add a filter that looks like a VHS tape.");
const t0 = Date.now();
await page.click("#mmvMake");
await page.waitForFunction(() => /Moxie|Reading|Watching|Listening|Transcrib|Understanding|Choosing|Looking|Finding|deciding/i.test(document.getElementById("mmvStatus").textContent), null, { timeout: 20000 });
assert(!(await page.isHidden("#mmvCancel")) && !(await page.isHidden("#mmvProgress")), "while Moxie works, progress is shown and the job can be cancelled");
await page.waitForSelector("#mmvVideos video", { timeout: 360000 });
const wallA = (Date.now() - t0) / 1000;
await page.waitForFunction(() => /Done/.test(document.getElementById("mmvStatus").textContent), null, { timeout: 30000 });
const reply = clean(await page.textContent("#mmvReply"));
console.log("  Moxie understood:", reply);
assert(/Style: High Energy/.test(reply) && /9:16/.test(reply) && /40 seconds/.test(reply), "it understood the style, the vertical format and the 40 seconds");
assert(/Could not do: Visual filters/.test(reply), "and said plainly that a VHS filter cannot be done, instead of pretending");
const stA = await page.evaluate(() => { const d = window.__toastyDirector, p = d.results[0].plan; return { style: p.style, aspect: p.aspect, total: p.timeline.total, content: p.timeline.content, stats: p.stats, auto: d.results[0].audio, w: d.results[0].width, h: d.results[0].height, n: d.results.length }; });
console.log(`  first video: ${stA.style} ${stA.aspect}, ${stA.total.toFixed(1)} s, ${stA.stats.segments} shots, ${stA.stats.punchIns} zooms; made in ${wallA.toFixed(0)} s (analysis + edit + real-time render + audio check)`);
assert(stA.style === "energy" && stA.aspect === "9:16" && stA.w === 1080 && stA.h === 1920, "the result is a 1080x1920 High Energy video");
assert(stA.content <= 40 * 1.15, `it is about 40 seconds of footage (${stA.content.toFixed(1)} s, from ${media.total.toFixed(1)} s of recording)`);
const vid = await page.evaluate(async () => { const v = document.querySelector("#mmvVideos video"); await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener("loadedmetadata", r, { once: true }))); return { w: v.videoWidth, h: v.videoHeight, d: v.duration }; });
assert(vid.w === 1080 && vid.h === 1920, `the preview player shows the finished video (${vid.w}x${vid.h})`);
assert(/LUFS/.test(await page.textContent("#mmvVideos")), "the measured loudness of the export is shown under the video");
assert((await page.locator("#mmvDecisions li").count()) > 6 && /punch in|emphasize word|remove dead air/.test(await page.textContent("#mmvDecisions")), "“Why Moxie edited it this way” lists the decisions and their reasons");
assert((await page.locator("#tcClips li").count()) >= 1 && (await page.locator("#tcRender").count()) === 1, "the manual Clips workspace is intact: analysed moments are listed and manual rendering is still there");

console.log("\n  Revision: “Less zooming.”");
const zoomsBefore = stA.stats.punchIns, zoomAmtBefore = stA.stats.zoomAmount;
await page.fill("#mmvRevision", "Less zooming.");
await page.click("#mmvRevise");
assert(/Zoom: reduced by half/.test(clean(await page.textContent("#mmvRevisionReply"))), "it reports what it changed");
await page.waitForFunction(() => /Done/.test(document.getElementById("mmvStatus").textContent) && window.__toastyDirector.edit.settings.params.zoom === 0.5 && !window.__toastyDirector.busy, null, { timeout: 360000 });
const zs = await page.evaluate(() => window.__toastyDirector.results[0].plan.stats);
assert(zs.punchIns <= zoomsBefore && zs.zoomAmount < zoomAmtBefore * 0.75, `the revised render has less zooming (${zoomsBefore} zooms -> ${zs.punchIns}, total zoom ${zoomAmtBefore.toFixed(2)} -> ${zs.zoomAmount.toFixed(2)})`);

console.log("\n  Revision: “Remove the music.” and “Make the captions bigger.”");
const capBefore = await page.evaluate(() => window.__toastyDirector.results[0].plan.captions.size);
await page.fill("#mmvRevision", "Remove the music. Make the captions bigger.");
await page.click("#mmvRevise");
await page.waitForFunction(() => window.__toastyDirector.edit.settings.params.music === false && window.__toastyDirector.edit.settings.params.captionScale === 1.3 && !window.__toastyDirector.busy && /Done/.test(document.getElementById("mmvStatus").textContent), null, { timeout: 360000 });
const rev2 = await page.evaluate(() => { const r = window.__toastyDirector.results[0]; return { music: r.plan.audio.music, cap: r.plan.captions.size, zoom: window.__toastyDirector.edit.settings.params.zoom }; });
assert(rev2.music === null && Math.abs(rev2.cap / capBefore - 1.3) < 0.02 && rev2.zoom === 0.5, "both changes are in the plan, and the earlier revision is kept");

console.log("\n  Revision that cannot be executed");
const urlBefore = await page.getAttribute("#mmvVideos video", "src");
await page.fill("#mmvRevision", "Make me look ten years younger");
await page.click("#mmvRevise");
await sleep(600);
assert(/Could not do: Retouching people is not supported/.test(clean(await page.textContent("#mmvRevisionReply"))), "it says it cannot do that");
assert((await page.getAttribute("#mmvVideos video", "src")) === urlBefore && /Nothing was changed/.test(await page.textContent("#mmvStatus")), "and nothing was re-rendered or changed");

console.log("\n  Export");
const exportPath = await Promise.all([save(page.waitForEvent("download"), "export-from-page.bin"), page.click("#mmvVideos [data-export]")]).then(([p]) => p);
const info = V.probe(exportPath), ev = info.streams.find((s) => s.codec_type === "video"), ea = info.streams.find((s) => s.codec_type === "audio");
assert(ev.width === 1080 && ev.height === 1920 && ea && V.decodeErrors(exportPath) === "", `the exported file is a playable ${ev.codec_name}/${ea.codec_name} ${ev.width}x${ev.height} video with audio (${(statSync(exportPath).size / 1048576).toFixed(1)} MB)`);
const expAudio = await analyzeFile(exportPath);
assert(expAudio.analysis.integratedLufs > -17.5 && expAudio.analysis.integratedLufs < -14.5 && expAudio.analysis.peakDbfs <= -1 && expAudio.analysis.clippedSamples === 0, `its audio measures ${expAudio.analysis.integratedLufs} LUFS (target -16), peak ${expAudio.analysis.peakDbfs} dBFS, no clipping`);

console.log("\n  Cancel");
await page.click("#mmvMake");
await page.waitForFunction(() => /Rendering|deciding|Moxie/.test(document.getElementById("mmvStatus").textContent) && !document.getElementById("mmvCancel").hidden, null, { timeout: 60000 });
await sleep(2500);
await page.click("#mmvCancel");
await page.waitForFunction(() => /Cancelled/.test(document.getElementById("mmvStatus").textContent) && !window.__toastyDirector.busy, null, { timeout: 30000 });
assert(await page.isEnabled("#mmvMake") && await page.isHidden("#mmvCancel"), "cancelling stops the render and gives the button back");
assert(errors.length === 0, `no page errors in Part A (${errors.length})`);
}

}

// =====================================================================================================================
console.log("\nPart B: the engine, rendered for real");
if (!VERIFY_ONLY) await page.evaluate(({ lines, picture, total }) => {
  window.__job = async ({ style, aspect, params = {}, silent = false, verify = true, clips = [], brollTags = null, name }) => {
    const D = await import("/js/director/index.js"), { loadImage } = await import("/js/clip-renderer.js"), { decodeMono16k } = await import("/js/clip-analysis.js");
    const real = await (await fetch("/fixture-interview.mp4")).blob(), blob = silent ? await (await fetch("/fixture-silent.mp4")).blob() : real;
    const logo = await loadImage("/shared/brand/toasty-media/ToastyMediaStudio.png");
    const dec = await decodeMono16k(real);
    const brollFiles = brollTags ? [{ id: "b1", name: "hiring-team.mp4", blob: await (await fetch("/fixture-broll.mp4")).blob(), duration: 6, tags: brollTags }] : [];
    const session = await D.openSession({ blob, decoded: dec, name: "interview.mp4", analysis: { lines, picture, clips, notes: [] }, width: 1280, height: 720, duration: total, brollFiles });
    const edit = D.makeEdit(session, { style, aspect, params });
    const res = await D.renderEdit(session, edit, { logo, verifyAudio: verify });
    const r = res[0], a = document.createElement("a"); a.href = URL.createObjectURL(r.blob); a.download = `${name}.${r.container}`; document.body.appendChild(a); a.click(); a.remove();
    return { plan: edit.plans[0], audio: r.audio, container: r.container, diag: r.diagnostics, width: r.width, height: r.height };
  };
}, { lines: media.lines, picture, total: media.total });
const moments = F.momentsFromLines(media.lines);

async function render(job) {
  const t = Date.now();
  if (VERIFY_ONLY) { const kept = JSON.parse(readFileSync(join(scratch, `${job.name}.plan.json`), "utf8")); return { ...kept, file: join(scratch, `${job.name}.out`), wall: kept.wall, job }; }
  const [file, out] = await Promise.all([save(page.waitForEvent("download", { timeout: 600000 }), `${job.name}.out`), page.evaluate((j) => window.__job(j), job)]);
  const wall = (Date.now() - t) / 1000;
  writeFileSync(join(scratch, `${job.name}.plan.json`), JSON.stringify({ plan: out.plan, audio: out.audio, container: out.container, diag: out.diag, width: out.width, height: out.height, wall }));
  return { ...out, file, wall, job };
}

const outs = {};
const ASPECTS = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] };
const matrix = !want("matrix") ? [] : QUICK ? [["clean", "16:9"], ["energy", "9:16"], ["cinematic", "1:1"]] : ["clean", "energy", "cinematic"].flatMap((s) => ["16:9", "9:16", "1:1"].map((a) => [s, a]));
for (const [style, aspect] of matrix) {
  console.log(`\nRender ${style} ${aspect}`);
  const o = await render({ style, aspect, name: `${style}-${aspect.replace(":", "x")}`, clips: moments });
  outs[`${style}/${aspect}`] = o;
  const p = o.plan, info = V.probe(o.file), v = info.streams.find((s) => s.codec_type === "video"), a = info.streams.find((s) => s.codec_type === "audio");
  const [W, H] = ASPECTS[aspect], dur = Number(info.format.duration);
  console.log(`  ${v.codec_name} ${v.width}x${v.height} + ${a?.codec_name}  ${dur.toFixed(2)} s (plan ${p.timeline.total.toFixed(2)} s)  rendered in ${o.wall.toFixed(0)} s  ${p.stats.segments} shots, ${p.stats.punchIns} zooms, ${p.stats.keyPhrases} key phrases, ${p.stats.graphics} graphics, ${p.stats.transitions} transitions, ${p.stats.soundAccents} accents`);
  assert(v.width === W && v.height === H && a, `${style} ${aspect}: ${W}x${H} with an audio track`);
  assert(Math.abs(dur - p.timeline.total) < 0.8, `the length matches the plan (${dur.toFixed(2)} s of ${p.timeline.total.toFixed(2)} s)`);
  assert(V.decodeErrors(o.file) === "", "the file decodes without errors");
  const an = (await analyzeFile(o.file)).analysis;
  report.audio.push({ style, aspect, lufs: an.integratedLufs, peak: an.peakDbfs, clipped: an.clippedSamples, snr: an.snrEstimateDb, corrected: o.audio.corrected, gain: o.audio.appliedGainDb });
  assert(Math.abs(an.integratedLufs + 16) <= 1.5 && an.peakDbfs <= -1.0 && an.clippedSamples === 0, `audio ${an.integratedLufs} LUFS (target -16 ±1.5), peak ${an.peakDbfs} dBFS, ${an.clippedSamples} clipped samples${o.audio.corrected ? " (corrected after the first measurement)" : ""}`);
  assert(an.silenceRatio < 0.6 && an.dropouts.length === 0, `no dropouts, and the audio is not mostly silence (${an.silenceRatio})`);
  report.outputs.push({ style, aspect, file: o.file, seconds: dur, segments: p.stats.segments, wall: o.wall });
}

// ---------------------------------------------------------------------------------------------------------------------
function verify(key) {
  const [style, aspect] = key.split("/"), o = outs[key]; if (!o) return;
  const p = o.plan, [W, H] = p.size, intro = p.timeline.intro, content = p.timeline.content, m = Math.min(W, H), landscape = W > H;
  console.log(`\nVerify ${style} ${aspect}`);
  const F5 = V.frames(o.file, 5, 640, W, H);
  // -- no black or broken frames
  let black = 0, flash = 0; for (let k = 0; k < F5.count; k++) { const L = V.meanLuma(F5.frame(k)); if (L < 8) black++; if (V.isFlashFrame(F5.frame(k))) flash++; }
  assert(black === 0, `no black frames in ${F5.count} sampled frames`);
  // -- captions are on screen when planned
  const cap = p.captions; const cs = cap.size * m * (landscape ? 1.35 : 1.1) / H, yb = (cap.style === "cinema" ? (landscape ? 0.8 : 0.74) : cap.style === "kinetic" ? (landscape ? 0.74 : 0.66) : (landscape ? 0.86 : 0.78));
  const zone = [0.04, yb - cs * 1.7, 0.96, yb + cs * 1.7];
  let agree = 0, tested = 0; const onsetErr = [];
  for (let k = 0; k < F5.count; k++) {
    const T = k / 5, st = frameState(p, T); if (st.phase !== "content" || st.transition || st.typography.length || st.graphics.some((g) => g.kind !== "accent" && g.kind !== "bug") || V.isFlashFrame(F5.frame(k))) continue;
    const near = cap.chunks.some((c) => Math.abs(intro + c.start - T) < 0.3 || Math.abs(intro + c.end - T) < 0.3); if (near) continue;
    const planned = Boolean(st.captions), measured = V.count(F5.frame(k), zone, V.isText) >= 18;
    tested++; if (planned === measured) agree++;
  }
  assert(tested > 20 && agree / tested >= 0.9, `captions: on screen exactly when planned in ${(100 * agree / tested).toFixed(0)}% of ${tested} checked moments (needs 90%)`);
  // onsets: only chunks that follow a gap (the previous caption is gone), so "first frame with text" really is this chunk appearing
  cap.chunks.forEach((c, i) => {
    const prevEnd = i ? cap.chunks[i - 1].end : -9; if (c.start - prevEnd < 0.7) return;
    const t0 = intro + c.start, k0 = Math.round((t0 - 0.5) * 5); if (k0 < 0 || frameState(p, t0 - 0.5).transition) return;
    if (V.count(F5.frame(k0), zone, V.isText) >= 18) return;                       // something else is there
    let first = null; for (let T = t0 - 0.4; T <= t0 + 0.9; T += 0.2) { const k = Math.round(T * 5); if (k < F5.count && V.count(F5.frame(k), zone, V.isText) >= 18) { first = T; break; } }
    if (first != null) onsetErr.push(first - t0);
  });
  onsetErr.sort((a, b) => a - b); const med = onsetErr.length ? onsetErr[Math.floor(onsetErr.length / 2)] : null;
  if (onsetErr.length >= 3) assert(Math.abs(med) <= 0.3, `caption onsets land within ${Math.abs(med).toFixed(2)} s of the planned time (median over ${onsetErr.length} captions that follow a gap)`);
  else soft(false, `only ${onsetErr.length} captions follow a gap in this edit, so onset timing rests on the ${tested}-moment presence check above`);
  // -- key phrases and graphics
  const top = [0.03, landscape ? 0.05 : 0.04, 0.97, landscape ? 0.34 : 0.3];
  for (const kp of p.typography.slice(0, 3)) {
    const inside = intro + (kp.start + kp.end) / 2, before = intro + kp.start - 0.8, after = intro + kp.end + 0.5;
    const n = (T) => V.count(V.at(F5, T), top, V.isText);
    assert(n(inside) >= 40 && n(before) < 18 && n(after) < 18, `key phrase “${kp.text}” (${kp.variant}) is on screen ${kp.start.toFixed(1)}-${kp.end.toFixed(1)} s and not before or after (${n(before)} / ${n(inside)} / ${n(after)} text pixels)`);
  }
  for (const g of p.graphics.filter((x) => x.kind === "stat-callout")) {
    const rect = landscape ? [0.52, 0.22, 0.96, 0.5] : [0.15, 0.2, 0.85, 0.48];
    const inside = intro + g.start + 1.2, before = intro + g.start - 0.9, after = intro + g.end + 0.5;
    const n = (T) => V.count(V.at(F5, T), rect, V.isText);
    assert(n(inside) >= 40 && n(before) < 20 && n(after) < 20, `callout “${g.value}” is drawn only while planned (${n(before)} / ${n(inside)} / ${n(after)})`);
  }
  for (const g of p.graphics.filter((x) => x.kind === "diagram")) { const inside = intro + g.end - 1.2; assert(V.count(V.at(F5, inside), top, V.isAccentLoose) > 30, `the step diagram (${g.steps.length} steps) is drawn at ${g.start.toFixed(1)}-${g.end.toFixed(1)} s`); }
  const lt = p.graphics.find((x) => x.kind === "lower-third");
  if (lt) {
    const y0 = landscape ? 0.64 : 0.56, rect = [m * 0.036 / W, y0 - 0.005, m * 0.06 / W, y0 + 0.12 * m / H + 0.005];       // the lower third's accent bar
    const n = (T) => V.count(V.at(F5, T), rect, V.isAccentLoose);
    assert(n(intro + (lt.start + lt.end) / 2) >= 40 && n(intro + lt.end + 1.5) < 8, `the lower third (“${lt.name}”) appears while planned and goes away (${n(intro + (lt.start + lt.end) / 2)} accent-bar pixels, then ${n(intro + lt.end + 1.5)})`);
  }
  // -- crops, zooms and framing: where the people are in the output versus where the plan put the camera
  let checked = 0, good = 0;
  const people = [["Maya", V.isBlueHead], ["Jordan", V.isOliveHead]], hs = 0.22 * 720;
  for (let c = 0.8; c < content - 0.5; c += 1.3) {
    const st = frameState(p, intro + c); if (st.transition || st.phase !== "content") continue; const k = Math.round((intro + c) * 5); const fr = F5.frame(k); if (V.isFlashFrame(fr)) continue;
    const win = cropWindow({ srcW: 1280, srcH: 720, outW: W, outH: H, zoom: st.camera.scale, fx: st.camera.fx, fy: st.camera.fy });
    for (const [who, pred] of people) {
      const cx = HEAD[who].x * 1280, cy = 0.42 * 720, ex = [(cx - hs - win.x) / win.w, (cy - hs / 2 - win.y) / win.h, (cx + hs - win.x) / win.w, (cy + hs / 2 + 6 + 0.7 * hs - win.y) / win.h];
      const vis = [Math.max(0, ex[0]), Math.max(0, ex[1]), Math.min(1, ex[2]), Math.min(1, ex[3])], area = Math.max(0, vis[2] - vis[0]) * Math.max(0, vis[3] - vis[1]);
      const got = V.bbox(fr, pred, 40);
      if (area < 0.01) { checked++; if (!got || got.n < 120) good++; continue; }
      if (area < 0.04) continue;
      checked++; if (got && Math.abs(got.x0 - vis[0]) < 0.05 && Math.abs(got.x1 - vis[2]) < 0.05 && Math.abs(got.y0 - vis[1]) < 0.05 && Math.abs(got.y1 - vis[3]) < 0.05) good++;
    }
  }
  assert(checked >= 8 && good / checked >= 0.88, `crops and zooms: each person is where the plan's camera puts them in ${good} of ${checked} checks (${(100 * good / checked).toFixed(0)}%)`);
  if (!landscape || style === "energy") {
    let spk = 0, spkOk = 0;
    for (let c = 1; c < content - 1; c += 1.1) { const st = frameState(p, intro + c); if (st.transition) continue; const src = st.srcTime, line = media.lines.find((l) => src >= l.t + 0.1 && src <= l.end - 0.1); if (!line) continue; const fr = V.at(F5, intro + c); if (V.isFlashFrame(fr)) continue; spk++;
      const want = line.speaker === "Maya" ? V.isBlueHead : V.isOliveHead, other = line.speaker === "Maya" ? V.isOliveHead : V.isBlueHead; const mine = V.count(fr, [0, 0, 1, 1], want), theirs = V.count(fr, [0, 0, 1, 1], other);
      if (landscape ? mine > 200 : mine > theirs * 3 + 100) spkOk++; }
    assert(spk >= 8 && spkOk / spk >= 0.85, `${landscape ? "the speaker is in frame" : "the vertical crop follows whoever is speaking"} in ${spkOk} of ${spk} moments`);
  }
  // -- zoom depth: the head is larger during a punch-in than just before it
  for (const pu of p.punches.slice(0, 2)) {
    const mid = intro + pu.at + pu.dur / 2, pre = intro + Math.max(0.2, pu.at - 0.4), sm = frameState(p, mid), sp = frameState(p, pre);
    if (sp.transition || sp.seg !== sm.seg) continue;
    const pred = sm.camera.fx > 0.5 ? V.isOliveHead : V.isBlueHead, a = V.bbox(V.at(F5, mid), pred, 40), b = V.bbox(V.at(F5, pre), pred, 40);     // the person the camera is on
    if (a && b) assert((a.x1 - a.x0) > (b.x1 - b.x0) * 1.03, `punch-in at ${pu.at.toFixed(1)} s (“${pu.word}”): the framed speaker is ${(((a.x1 - a.x0) / (b.x1 - b.x0) - 1) * 100).toFixed(0)}% larger than just before`);
  }
  // -- transitions
  const cuts = p.cuts.filter((c) => c.kind !== "hard").slice(0, 3);
  for (const cut of cuts) {
    const from = Math.max(0, intro + cut.at - 0.2), dur = cut.dur + 0.5, G = V.frames(o.file, 30, 320, W, H, { from, dur });
    let dark = 0, accentCol = false; for (let k = 0; k < G.count; k++) { const f = G.frame(k); if (V.meanLuma(f) < 8) dark++; if (cut.kind === "wipe" || cut.kind === "push") for (let x = 0; x < f.w && !accentCol; x++) { let n = 0; for (let y = 0; y < f.h; y++) { const i = (y * f.w + x) * 3; if (V.isAccentLoose(f.data[i], f.data[i + 1], f.data[i + 2])) n++; } if (n > f.h * 0.75) accentCol = true; } }
    const A = V.at(G, intro + cut.at - 0.04), M = V.at(G, intro + cut.at + cut.dur / 2), B = V.at(G, intro + cut.at + cut.dur + 0.12);
    let ok = dark === 0, what = `${G.count} frames, none black`;
    if (cut.kind === "wipe" || cut.kind === "push") { ok = ok && accentCol; what += `, the ${cut.kind} edge is visible`; }
    else if (cut.kind === "flash") { const before = V.meanLuma(V.at(G, intro + cut.at - 0.1)), peak = Math.max(...Array.from({ length: 6 }, (_, i) => V.meanLuma(V.at(G, intro + cut.at + i * 0.03)))); ok = ok && peak > before * 1.2; what += `, brightness ${before.toFixed(0)} -> ${peak.toFixed(0)}`; }
    else { const fit = V.blendFit(M, A, B, [0, 0.3, 1, landscape ? 0.66 : 0.6]); const blended = fit.flat || (fit.alpha > 0.08 && fit.alpha < 0.95 && fit.r2 > 0.8); ok = ok && blended; what += fit.flat ? ", outgoing and incoming shots are alike" : `, the middle frame is a ${(fit.alpha * 100).toFixed(0)}/${(100 - fit.alpha * 100).toFixed(0)} blend of the two shots (R² ${fit.r2.toFixed(2)})`; }
    assert(ok, `${cut.kind} transition at ${cut.at.toFixed(1)} s renders correctly: ${what}`);
  }
  if (style === "cinematic") { const f = V.at(F5, intro + content / 2); assert(V.meanLuma({ ...f, data: f.data.subarray(0, 640 * Math.floor(f.h * 0.07) * 3) }) < 6, "cinematic: letterbox bars are black at the top and bottom"); }
  if (style === "energy") assert(V.count(V.at(F5, intro + content / 2), [0, 0, 0.14, 0.12], V.isAccentLoose) > 3 || V.count(V.at(F5, intro + content / 2 + 0.2), [0, 0, 0.14, 0.12], V.isAccentLoose) > 3, "energy: the animated corner accents are drawn");
  // -- intro and outro cards
  if (p.intro) assert(V.count(V.at(F5, p.intro.seconds * 0.55), [0, 0, 1, 1], V.isText) > 150, `the intro card shows the title “${p.intro.title}”`);
  if (p.outro) assert(V.count(V.at(F5, intro + content + p.outro.seconds * 0.8), [0, 0, 1, 1], (r, g, b) => V.isText(r, g, b) || V.isAccentLoose(r, g, b) || (r > 180 && g > 120 && b > 90)) > 300, "the end card is drawn");
  // -- audio/video sync and where the cut footage lands
  const seg = p.segments.find((s) => media.flashT >= s.srcStart && media.flashT < s.srcEnd);
  if (seg) {
    const expect = intro + seg.outStart + (media.flashT - seg.srcStart), G = V.frames(o.file, 30, 160, W, H, { from: Math.max(0, expect - 0.8), dur: 1.8 });
    let vFlash = null; for (let k = 0; k < G.count; k++) if (V.isFlashFrame(G.frame(k))) { vFlash = G.from + k / 30; break; }
    const au = V.pcm(o.file, { sampleRate: 16000, from: Math.max(0, expect - 0.8), seconds: 1.8 }); let aBeep = null;
    for (let i = 0; i + 160 < au.length; i += 80) { let s = 0, re = 0, im = 0; for (let k = 0; k < 160; k++) { const x = au[i + k]; s += x * x; re += x * Math.cos(2 * Math.PI * 1000 * k / 16000); im += x * Math.sin(2 * Math.PI * 1000 * k / 16000); } if (Math.sqrt(s / 160) > 0.08 && ((re * re + im * im) * 2 / 160) / (s + 1e-12) > 0.75) { aBeep = Math.max(0, expect - 0.8) + i / 16000; break; } }
    console.log(`  sync mark: planned ${expect.toFixed(3)} s, flash ${vFlash?.toFixed(3)} s, beep ${aBeep?.toFixed(3)} s`);
    assert(vFlash != null && aBeep != null && Math.abs(vFlash - aBeep) <= 0.15, `audio and video stay in sync through the cuts: flash and beep ${Math.abs(vFlash - aBeep).toFixed(3)} s apart (limit 0.15)`);
    assert(Math.abs(vFlash - expect) <= 0.3, `and the footage lands where the plan says (${(vFlash - expect).toFixed(3)} s off)`);
  } else soft(false, "the sync mark was edited out of this plan, so sync is checked in the other renders");
  // -- speech stays intelligible under the music
  const band = "highpass=f=300,lowpass=f=3400", shots = V.alignShots({ ref: V.pcm(media.wav, { sampleRate: 16000, filter: band }), out: V.pcm(o.file, { sampleRate: 16000, filter: band }), plan: p });
  const corrs = shots.map((q) => q.c).sort((x, y) => x - y), shifts = shots.map((q) => Math.abs(q.shift)).sort((x, y) => x - y), medC = corrs[Math.floor(corrs.length / 2)], medS = shifts[Math.floor(shifts.length / 2)], maxS = shifts[shifts.length - 1];
  console.log(`  per-shot voice match: median correlation ${medC.toFixed(3)} (lowest ${corrs[0].toFixed(3)}); audio offset from the plan: median ${medS} ms, worst ${maxS} ms`);
  assert(medC >= 0.85 && corrs[0] >= (media.tts ? 0.6 : 0.4), `speech stays intelligible under the music and accents: the voice-band level pattern of every shot matches the original voice (median correlation ${medC.toFixed(3)}, lowest ${corrs[0].toFixed(3)} over ${shots.length} shots)${media.tts ? "" : " [synthetic speech]"}`);
  assert(medS <= 60 && maxS <= 160, `every shot's audio sits where the plan put it: median ${medS} ms, worst ${maxS} ms`);
  report.sync = report.sync || []; report.sync.push({ style, aspect, medianCorrelation: +medC.toFixed(3), lowestCorrelation: +corrs[0].toFixed(3), medianOffsetMs: medS, worstOffsetMs: maxS });
  if (p.audio.music && o.diag?.mixer) assert(o.diag.mixer.minDuckDb <= p.audio.music.duckDb + 3, `the music was ducked ${Math.abs(o.diag.mixer.minDuckDb).toFixed(1)} dB under the voice (setting ${p.audio.music.duckDb} dB)`);
  assert(o.audio.measuredAfter && Math.abs(o.audio.measuredAfter.integratedLufs + 16) <= 1.5, "the export loudness check inside the app agrees with the file measurement");
}
for (const key of Object.keys(outs)) verify(key);

// ---------------------------------------------------------------------------------------------------------------------
console.log("\nThe three styles look different");
{
  const aspect = outs["clean/16:9"] && outs["energy/16:9"] && outs["cinematic/16:9"] ? "16:9" : "9:16";
  const keys = ["clean", "energy", "cinematic"].map((s) => `${s}/${aspect}`).filter((k) => outs[k]);
  if (keys.length === 3) {
    const Fs = keys.map((k) => V.frames(outs[k].file, 2, 480, ...outs[k].plan.size)), n = Math.min(...Fs.map((f) => f.count));
    const D = (a, b) => { let s = 0, c = 0; for (let k = 4; k < n - 4; k++) { s += V.diff(Fs[a].frame(k), Fs[b].frame(k)); c++; } return s / c; };
    const pair = { "clean vs energy": D(0, 1), "clean vs cinematic": D(0, 2), "energy vs cinematic": D(1, 2) };
    console.log("  mean frame difference:", Object.entries(pair).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", "));
    assert(Object.values(pair).every((v) => v > 6), "every pair of styles differs frame by frame");
    const sig = keys.map((k) => ({ k, cuts: outs[k].plan.stats.segments, zooms: outs[k].plan.stats.punchIns, trans: [...new Set(outs[k].plan.cuts.filter((c) => c.kind !== "hard").map((c) => c.kind))].join("/"), cap: outs[k].plan.captions.style, music: outs[k].plan.audio.music?.style, accents: outs[k].plan.stats.soundAccents, dur: outs[k].plan.timeline.total.toFixed(0) }));
    for (const s of sig) console.log(`  ${s.k}: ${s.cuts} shots, ${s.zooms} zooms, transitions ${s.trans || "none"}, ${s.cap} captions, ${s.music} music, ${s.accents} accents, ${s.dur} s`);
    assert(new Set(sig.map((s) => s.cap)).size === 3 && new Set(sig.map((s) => s.music)).size === 3, "the editing decisions differ: caption treatment and music");
    report.styleDiff = pair;
  } else soft(false, "style comparison skipped in QUICK mode");
}

// ---------------------------------------------------------------------------------------------------------------------
console.log("\nSound design timing (voice removed so only the music and accents are in the file)");
if (!VERIFY_ONLY && want("sound")) {
  const energyPlan = (outs["energy/16:9"] || outs["energy/9:16"])?.plan;
  const a = await render({ style: "energy", aspect: "16:9", name: "sfx-only", silent: true, verify: false, params: { music: false }, clips: moments });
  const p = a.plan, env = V.envelopeDb(V.pcm(a.file, { sampleRate: 16000 }), 16000, 10);
  const ons = []; for (const e of p.audio.sfx.filter((x) => x.gainDb >= -45)) { let t = null; for (let T = Math.max(0, e.t - 0.1); T < e.t + 0.45; T += 0.01) { const k = Math.round(T / 0.01); if (env[k] > -64) { t = T; break; } } ons.push({ e, t }); }
  const hit = ons.filter((o) => o.t != null && Math.abs(o.t - o.e.t) <= 0.15);
  console.log(`  ${p.audio.sfx.length} planned accents (${[...new Set(p.audio.sfx.map((s) => s.kind))].join(", ")}); ${hit.length} heard within 0.15 s of their planned time`);
  assert(p.audio.sfx.length >= 3 && hit.length / ons.length >= 0.85, `sound accents are synchronised to the plan: ${hit.length} of ${ons.length} start within 150 ms of their planned time`);
  const quiet = env.filter((v, k) => !p.audio.sfx.some((e) => k / 100 >= e.t - 0.2 && k / 100 <= e.t + 1.8)); const loud = Math.max(...env);
  assert(loud <= -14 && loud > -45, `accents are subtle: the loudest peaks at ${loud.toFixed(1)} dBFS short-term level, nothing near full scale`);
  const b = await render({ style: "energy", aspect: "16:9", name: "music-only", silent: true, verify: false, params: { sfx: false }, clips: moments });
  const mp = b.plan, mm = V.pcm(b.file, { sampleRate: 16000, filter: "lowpass=f=140" }), menv = V.envelopeDb(mm, 16000, 10);
  const kicks = V.onsets(menv, 10, { riseDb: 6, floorDb: -40, minGapS: 0.3 });          // the rising edge of each kick drum (not the envelope peak, which lags the attack)
  const beat = 60 / mp.audio.music.bpm, gaps = kicks.slice(1).map((v, i) => v - kicks[i]).filter((g) => g < beat * 1.6).sort((x, y) => x - y), medGap = gaps[Math.floor(gaps.length / 2)];
  const phase = kicks.map((t) => { const r = t % beat; return Math.min(r, beat - r); }).sort((x, y) => x - y)[Math.floor(kicks.length / 2)];
  console.log(`  music: ${mp.audio.music.style} ${mp.audio.music.bpm} bpm; ${kicks.length} kicks found, median interval ${medGap?.toFixed(3)} s (beat ${beat.toFixed(3)} s), median phase error ${phase?.toFixed(3)} s`);
  assert(kicks.length >= 20 && Math.abs(medGap - beat) / beat < 0.05 && phase < 0.08, `the music runs on its beat grid and starts with the video within ${(phase * 1000).toFixed(0)} ms (limit 80 ms, under three frames), so beat-aligned cuts are aligned in the file`);
  const lv = V.envelopeDb(V.pcm(b.file, { sampleRate: 16000 }), 16000, 50), avg = (t0, t1) => { let s = 0, n = 0; for (let k = Math.round(t0 / 0.05); k < Math.round(t1 / 0.05); k++) { s += 10 ** (lv[k] / 10); n++; } return 10 * Math.log10(s / Math.max(1, n)); };
  const T = mp.timeline.total, head = avg(0, 0.15), body = avg(2, 6), tail = avg(T - 0.25, T);
  console.log(`  music level: first 0.15 s ${head.toFixed(1)} dB, body ${body.toFixed(1)} dB, last 0.25 s ${tail.toFixed(1)} dB`);
  assert(head < body - 4, "the music fades in rather than starting at full level");
  assert(tail < body - 6, "and fades out under the end card instead of being cut off");
  const bt = energyPlan?.decisions.find((d) => d.rule === "beat-cuts");
  if (bt) console.log(`  ${bt.action}`);
}

// ---------------------------------------------------------------------------------------------------------------------
console.log("\nB-roll: only from the user's own footage, only where the words match");
if (!VERIFY_ONLY && want("broll")) {
  const hit = await render({ style: "clean", aspect: "16:9", name: "broll-match", verify: false, clips: moments, params: { broll: true }, brollTags: ["hiring"] });
  assert(hit.plan.broll.length >= 1 && hit.plan.broll.every((b) => /hiring/i.test(b.word)), `with a clip tagged “hiring”, it is cut in where “${hit.plan.broll[0]?.word}” is said (${hit.plan.broll.length} cutaway${hit.plan.broll.length === 1 ? "" : "s"})`);
  const b0 = hit.plan.broll[0]; const G = V.frames(hit.file, 5, 320, 1920, 1080); const intro = hit.plan.timeline.intro;
  const magenta = (r, g, bl) => r > 120 && bl > 90 && g < 90 && r > g + 60 && bl > g + 30;
  assert(V.count(V.at(G, intro + (b0.start + b0.end) / 2), [0, 0, 1, 1], magenta) > 1500 && V.count(V.at(G, intro + b0.end + 1), [0, 0, 1, 1], magenta) < 200, "the B-roll footage is on screen during the cutaway and gone after it");
  const none = await render({ style: "clean", aspect: "16:9", name: "broll-none", verify: false, clips: moments, params: { broll: true }, brollTags: ["volcano"] });
  assert(none.plan.broll.length === 0 && none.plan.warnings.some((w) => /No spoken word matched/.test(w)), "with no matching words nothing is inserted, and it says so");
}

// ---------------------------------------------------------------------------------------------------------------------
console.log("\nFinal checks");
assert(errors.length === 0, "no page errors during the whole run");
console.log("\nREPORT " + JSON.stringify({ tts: report.tts, outputs: report.outputs.map((o) => ({ ...o, file: o.file.split("/").pop() })), audio: report.audio, styleDiff: report.styleDiff, scratch }, null, 1));
console.log("\nALL PASSED — Make My Video edits, renders and exports real videos, and the exported files measure up.");
await browser?.close();
process.exit(0);
