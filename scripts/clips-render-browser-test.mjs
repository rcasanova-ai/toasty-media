#!/usr/bin/env node
// REAL-BROWSER test of the local clip renderer: a generated source video (with speech) is rendered through real templates to
// 16:9, 9:16 and 1:1 MP4/WebM files with the browser's own encoder, then every output is measured with ffprobe and the audio
// analysis (dimensions, length, codecs, loudness, clipping, picture content), including a batch export and a cancel.
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR, AUDIO_PROGRAMME (speech WAV for the source)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthProgramme, wavBytes } from "./lib/synth-programme.mjs";
import { analyzeFile } from "./lib/audio-file-analysis.mjs";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, BASE } from "./lib/studio-browser-harness.mjs";

const assert = makeAsserter();
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-clips-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();
const wav = join(scratch, "speech.wav");
if (process.env.AUDIO_PROGRAMME) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", process.env.AUDIO_PROGRAMME, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
else writeFileSync(wav, wavBytes(synthProgramme({ seconds: 36 }).samples));
const source = join(scratch, "source.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-i", wav, "-t", "34", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", source]);
await startServers(scratch);
const browser = await launchChrome(playwright, { programmePath: wav, chromePath });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.route("**/fixture-source.mp4", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: readFileSync(source) }));
await page.route("**/fixture-logo.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: readFileSync(new URL("../shared/brand/toasty-media/ToastyMediaStudio.png", import.meta.url)) }));
await page.goto(`${BASE}/studio/`);

const LINES = [
  { t: 4, end: 8, text: "Honestly I think the biggest mistake is hiring for resume instead of curiosity." },
  { t: 8.5, end: 12, text: "Here is the thing, the reason it fails is nobody owns the follow up." },
  { t: 12.5, end: 16, text: "That changed everything for us." }
];
const RUN = `async ({ jobs, mode }) => {
  const R = await import("/js/clip-renderer.js");
  const { getTemplate, applyOverrides } = await import("/js/clip-templates.js");
  const blob = await (await fetch("/fixture-source.mp4")).blob();
  const logo = await R.loadImage("/fixture-logo.png");
  const toB64 = async (b) => { const u = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const mk = (j) => ({ ...j, spec: { ...j.spec, template: applyOverrides(getTemplate(j.templateId), j.overrides || {}), logo } });
  const progress = []; const onProgress = (p) => progress.push(p.phase);
  if (mode === "batch") {
    const res = await R.renderBatch({ source: blob, jobs: jobs.map(mk), onProgress });
    return { results: await Promise.all(res.map(async (r) => ({ ok: r.ok, error: r.error, container: r.container, mimeType: r.mimeType, width: r.width, height: r.height, seconds: r.seconds, aspect: r.aspect, b64: r.ok ? await toB64(r.blob) : null }))) };
  }
  if (mode === "cancel") {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 3000);
    try { await R.renderClip({ source: blob, spec: mk(jobs[0]).spec, signal: ac.signal }); return { cancelled: false }; } catch (e) { return { cancelled: e.name === "AbortError" }; }
  }
  const r = await R.renderClip({ source: blob, spec: mk(jobs[0]).spec, onProgress });
  return { container: r.container, mimeType: r.mimeType, width: r.width, height: r.height, seconds: r.seconds, b64: await toB64(r.blob), phases: [...new Set(progress)] };
}`;
const save = (name, b64, container) => { const p = join(scratch, `${name}.${container}`); writeFileSync(p, Buffer.from(b64, "base64")); return p; };
const probe = (p) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p]).toString());
const lumaAt = (p, t) => Number(execFileSync("sh", ["-c", `ffmpeg -hide_banner -loglevel error -ss ${t} -i '${p}' -frames:v 1 -vf "scale=64:36,format=gray" -f rawvideo - | od -An -tu1 -v | tr -s ' ' '\\n' | awk 'NF{s+=$1;n++} END{print s/n}'`]).toString());
const base = (templateId, aspect, extra = {}) => ({ templateId, overrides: extra.overrides, spec: { clip: { start: 4, end: 16 }, aspect, title: "Why hiring fails", lines: LINES, lowerThird: { name: "Jane Doe", role: "CEO" }, custom: [{ text: "Subscribe", at: 6, dur: 3, position: "center" }], enhance: true, ...(extra.spec || {}) } });

try {
  const caps = await page.evaluate(async () => (await import("/js/clip-renderer.js")).renderCapabilities());
  console.log("\nCapabilities:", JSON.stringify(caps));
  assert(caps.supported, "the browser can render clips locally");
  const results = {};
  for (const [aspect, w, h] of [["16:9", 1920, 1080], ["9:16", 1080, 1920], ["1:1", 1080, 1080]]) {
    console.log(`\nRender ${aspect}, Energy Burst, upbeat music, enhanced audio`);
    const t0 = Date.now();
    const r = await page.evaluate(`(${RUN})(${JSON.stringify({ jobs: [base("energy-burst", aspect)], mode: "one" })})`);
    const p = save(`energy-${aspect.replace(":", "x")}`, r.b64, r.container);
    const info = probe(p), v = info.streams.find((s) => s.codec_type === "video"), a = info.streams.find((s) => s.codec_type === "audio");
    const m = await analyzeFile(p);
    results[aspect] = { seconds: Number(info.format.duration), width: v.width, height: v.height, vcodec: v.codec_name, acodec: a.codec_name, lufs: m.analysis.integratedLufs, peak: m.analysis.peakDbfs, clipped: m.analysis.clippedSamples, wall: (Date.now() - t0) / 1000 };
    console.log(`  ${v.codec_name} ${v.width}x${v.height}  ${a.codec_name} ${a.sample_rate} Hz ${a.channels}ch  ${Number(info.format.duration).toFixed(2)} s  ${m.analysis.integratedLufs} LUFS  peak ${m.analysis.peakDbfs} dBFS  rendered in ${results[aspect].wall.toFixed(1)} s`);
    assert(v.width === w && v.height === h, `${aspect} is ${w}x${h}`);
    assert(Math.abs(Number(info.format.duration) - r.seconds) < 0.8, `length matches the plan (${Number(info.format.duration).toFixed(2)} s of ${r.seconds.toFixed(1)} s: 2.2 s intro + 12 s clip + 2.4 s outro)`);
    assert(/aac|opus/.test(a.codec_name) && /h264|vp9|vp8/.test(v.codec_name), `${r.container.toUpperCase()} with ${v.codec_name} video and ${a.codec_name} audio`);
    assert(m.analysis.clippedSamples === 0 && m.analysis.peakDbfs <= -0.5, `no clipping (peak ${m.analysis.peakDbfs} dBFS)`);
    assert(m.analysis.integratedLufs > -30 && m.analysis.integratedLufs < -10, `loudness is in a sane range (${m.analysis.integratedLufs} LUFS)`);
    assert(r.phases.includes("intro") && r.phases.includes("clip") && r.phases.includes("outro"), "the render went through intro, clip and outro");
    const intro = lumaAt(p, 1.2), body = lumaAt(p, 2.2 + 3), outro = lumaAt(p, 2.2 + 12 + 1.2);
    assert(intro > 8 && body > 20 && outro > 8, `picture is not black in the intro, the clip or the outro (luma ${intro.toFixed(0)}/${body.toFixed(0)}/${outro.toFixed(0)})`);
    assert(Math.abs(info.streams.find((s) => s.codec_type === "audio").duration - Number(info.format.duration)) < 0.8, "audio and video are the same length");
    writeFileSync(join(scratch, `frame-${aspect.replace(":", "x")}.png`), execFileSync("ffmpeg", ["-v", "error", "-ss", String(2.2 + 4), "-i", p, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]));
  }

  console.log("\nTemplates differ visibly (picture at the same moment)");
  const lumas = {};
  for (const id of ["clean-insight", "documentary", "minimal-cut"]) {
    const r = await page.evaluate(`(${RUN})(${JSON.stringify({ jobs: [base(id, "16:9", { spec: { clip: { start: 4, end: 12 } } })], mode: "one" })})`);
    const p = save(`tpl-${id}`, r.b64, r.container);
    lumas[id] = { dur: Number(probe(p).format.duration), intro: lumaAt(p, 0.8), planned: r.seconds };
    console.log(`  ${id}: ${lumas[id].dur.toFixed(2)} s (planned ${r.seconds.toFixed(1)}), intro luma ${lumas[id].intro.toFixed(0)}`);
  }
  assert(Math.abs(lumas["minimal-cut"].dur - 8) < 0.8, "Minimal Cut has no intro or outro: exactly the 8 s clip");
  assert(lumas["clean-insight"].dur > 11 && lumas["clean-insight"].intro > lumas["documentary"].intro + 20, "Clean Insight (cream title card) and Documentary (dark) look different");

  console.log("\nBatch export: 2 clips x 2 formats");
  const jobs = [];
  for (const [start, end] of [[4, 12], [12, 20]]) for (const aspect of ["16:9", "9:16"]) jobs.push(base("vertical-pop", aspect, { spec: { clip: { start, end }, title: `Clip ${start}` } }));
  const batch = await page.evaluate(`(${RUN})(${JSON.stringify({ jobs, mode: "batch" })})`);
  batch.results.forEach((r, i) => { if (r.ok) save(`batch-${i}-${r.aspect.replace(":", "x")}`, r.b64, r.container); });
  assert(batch.results.length === 4 && batch.results.every((r) => r.ok), `all 4 batch outputs rendered (${batch.results.map((r) => r.ok ? `${r.width}x${r.height}` : r.error).join(", ")})`);
  assert(batch.results.filter((r) => r.aspect === "9:16").every((r) => r.width === 1080 && r.height === 1920), "vertical exports are 1080x1920");

  console.log("\nCancel");
  const c = await page.evaluate(`(${RUN})(${JSON.stringify({ jobs: [base("energy-burst", "16:9")], mode: "cancel" })})`);
  assert(c.cancelled === true, "a render can be cancelled part-way");
  const after = await page.evaluate(`(${RUN})(${JSON.stringify({ jobs: [base("minimal-cut", "1:1", { spec: { clip: { start: 4, end: 9 } } })], mode: "one" })})`);
  assert(after.width === 1080 && after.height === 1080, "and the next render works normally after a cancel");

  writeFileSync(join(scratch, "report.json"), JSON.stringify({ results, lumas }, null, 2));
  console.log(`\nfiles: ${scratch}\nALL PASSED — clips render locally to 16:9, 9:16 and 1:1 with intro, captions, music and enhanced audio.`);
  await browser.close(); process.exit(0);
} catch (error) {
  console.error(error.message || error);
  try { await page.screenshot({ path: join(scratch, "failure.png") }); } catch (_) {}
  await browser.close().catch(() => {}); process.exit(1);
}
