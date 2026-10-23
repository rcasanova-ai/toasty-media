#!/usr/bin/env node
// REAL-BROWSER, REAL-NETWORK check of the three optional downloadable models Moxie can use: the sentence-embedding model,
// the MediaPipe face / hand / pose trackers, and the Whisper speech model. Skipped (not failed) when the model hosts cannot be
// reached. It proves the libraries load, run in the page and produce well-formed output; it does not judge their accuracy.
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavBytes } from "./lib/synth-programme.mjs";
import { voicedPcm, plainTranscript, SR } from "./lib/behavior-fixtures.mjs";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, BASE } from "./lib/studio-browser-harness.mjs";

const assert = makeAsserter();
try { const r = await fetch("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/package.json", { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(String(r.status)); await fetch("https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json", { signal: AbortSignal.timeout(8000) }).then((x) => { if (!x.ok) throw new Error(String(x.status)); }); } catch (e) { console.log(`SKIPPED: the model hosts are not reachable from here (${e.message}).`); process.exit(0); }
const scratch = mkdtempSync(join(tmpdir(), "moxie-models-"));
const playwright = await loadPlaywright(), chromePath = findChrome();
const wav = join(scratch, "speech.wav"); writeFileSync(wav, wavBytes(voicedPcm([{ t0: 1, t1: 18, db: -28 }], 20), SR));
const video = join(scratch, "v.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-i", wav, "-t", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
await startServers(scratch);
const browser = await launchChrome(playwright, { programmePath: wav, chromePath });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
try {
  await page.goto(`${BASE}/studio/clips.html`);
  console.log("\nSentence-embedding model (all-MiniLM-L6-v2, quantized)");
  const emb = await page.evaluate(async (texts) => {
    const { createEmbedder } = await import("/js/behavior/embeddings.js");
    const e = await createEmbedder(texts);
    if (e.kind !== "minilm") return { kind: e.kind, note: e.note };
    const v = await e.embed(texts), cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    return { kind: e.kind, dim: v[0].length, simClose: cos(v[0], v[1]), simFar: cos(v[0], v[2]) };
  }, ["The bakery raised its prices and sales did not drop.", "We charged a dollar more for each loaf and customers kept buying.", "The satellite entered orbit above the equator."]);
  console.log("  ", JSON.stringify(emb));
  assert(emb.kind === "minilm" && emb.dim === 384, "the model loads and returns 384-dimension embeddings");
  assert(emb.simClose > emb.simFar + 0.2, `related sentences are closer than unrelated ones (${emb.simClose.toFixed(2)} vs ${emb.simFar.toFixed(2)})`);
  const lang = await page.evaluate(async (lines) => {
    const { createEmbedder } = await import("/js/behavior/embeddings.js"); const { analyzeLanguage } = await import("/js/behavior/language.js");
    const r = await analyzeLanguage(lines, { embedder: await createEmbedder(lines.map((l) => l.text)) });
    return { kind: r.semantic.kind, units: r.units.length, proto: r.units.every((u) => u.proto && typeof u.proto.opinion === "number"), events: r.events.length, topics: r.topics.length };
  }, plainTranscript());
  console.log("  ", JSON.stringify(lang));
  assert(lang.kind === "minilm" && lang.proto && lang.events >= 3, "language analysis with the real model returns prototype affinities and events");

  console.log("\nMediaPipe face, hand and pose trackers");
  const mp = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { sampleVideo } = await import("/js/behavior/visual.js");
    const r = await sampleVideo(new Blob([bytes], { type: "video/mp4" }), { duration: 20, intervalSeconds: 1, tracker: "auto" });
    return { samples: r.samples.length, caps: r.caps, notes: r.notes, faces: r.samples.reduce((n, s) => n + s.faces.length, 0) };
  }, readFileSync(video).toString("base64"));
  console.log("  ", JSON.stringify(mp));
  assert(mp.samples >= 18 && mp.caps.motion, "frames were sampled and movement measured");
  assert(!mp.notes.some((n) => /unavailable|could not start|tracking error/.test(n)), `the trackers loaded (${mp.notes.join(" | ") || "no notes"})`);
  assert(mp.faces === 0 && !mp.caps.face, "a test pattern has no face, and none is invented");

  console.log("\nWhisper speech model");
  const asr = await page.evaluate(async () => {
    const { transcribePcm } = await import("/js/clip-transcribe.js");
    const pcm = new Float32Array(16000 * 6); for (let i = 0; i < pcm.length; i++) pcm[i] = 0.1 * Math.sin(i / 20) * Math.sin(i / 4000);
    const lines = await transcribePcm(pcm, { windowSeconds: 30 });
    return { isArray: Array.isArray(lines), n: lines.length, ok: lines.every((l) => Number.isFinite(l.t) && Number.isFinite(l.end) && typeof l.text === "string") };
  });
  console.log("  ", JSON.stringify(asr));
  assert(asr.isArray && asr.ok, "the speech model loads and returns well-formed timed lines");
  console.log("\nThe whole Clips page with every model switched on (imported transcript, real language model, real trackers)");
  const srt = join(scratch, "talk.srt"), fmt = (t) => { const ms = Math.round(t * 1000), h = String(Math.floor(ms / 3600000)).padStart(2, "0"), m = String(Math.floor(ms / 60000) % 60).padStart(2, "0"), sec = String(Math.floor(ms / 1000) % 60).padStart(2, "0"); return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, "0")}`; };
  writeFileSync(srt, plainTranscript({ seconds: 0.62, speakers: null }).map((l, i) => `${i + 1}\n${fmt(l.t)} --> ${fmt(l.t + 0.55)}\n${l.text}\n`).join("\n"));
  const page2 = await page.context().newPage();   // same browser profile: the models downloaded above are already cached
  await page2.goto(`${BASE}/studio/clips.html`);
  await page2.setInputFiles("#tcFile", video);
  await page2.waitForFunction(() => window.__toastyClips.source?.name === "v.mp4" && !document.querySelector("#tcFind").disabled);
  await page2.setInputFiles("#tcTranscriptFile", srt);
  await page2.waitForFunction(() => /Imported 30 lines/.test(document.querySelector("#tcTranscriptNote").textContent));
  await page2.click("#tcFind");
  await page2.waitForFunction(() => window.__toastyClips.clips.length > 0 || /could not analyse|cancel/i.test(document.querySelector("#tcFindStatus").textContent), null, { timeout: 600000 });
  const full = await page2.evaluate(() => ({ n: window.__toastyClips.clips.length, signals: document.querySelector("#tcSignals").textContent, notes: document.querySelector("#tcNotes").textContent, status: document.querySelector("#tcFindStatus").textContent }));
  console.log("  ", JSON.stringify(full).slice(0, 600));
  assert(full.n >= 1, `clips were produced with all models on (${full.n})`);
  assert(/sentence-embedding model \(local\)/.test(full.signals), "the page says the real language model ran");
  assert(!/could not be loaded|Transcription was unavailable|tracker/i.test(full.notes), `no model failed (${full.notes || "no notes"})`);
  console.log("\nAll model checks passed.");
} catch (error) { console.error(String(error?.stack || error)); process.exitCode = 1; } finally { await browser.close(); process.exit(process.exitCode || 0); }
