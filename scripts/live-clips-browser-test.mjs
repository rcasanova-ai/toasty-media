#!/usr/bin/env node
// REAL-BROWSER test of Moxie's live clip listening inside the Studio: a recording runs with a microphone that laughs, the
// transcript receives lines (including the spoken "Moxie, clip that"), and afterwards the bookmarks are checked in the
// session, the saved manifest, the producer panel, and in Toasty Clips opened from the browser library.
// Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavBytes } from "./lib/synth-programme.mjs";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, newStudioPage, createSession, openStudio, joinStudio, sleep, BASE } from "./lib/studio-browser-harness.mjs";

const assert = makeAsserter();
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-live-clips-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();
// 90 s microphone: room noise, speech-like hum, and a 3 s laugh (5 bursts per second) at 14 s into the file.
const SR = 48000, N = SR * 90, mic = new Float32Array(N); let seed = 3;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
for (let i = 0; i < N; i++) mic[i] = rnd() * 10 ** (-58 / 20);
for (let t = 0; t < 90; t += 0.001) { /* placeholder to keep loop cheap */ break; }
for (let t = 0, k = 0; t < 3; t += 0.2, k++) { const start = Math.round((14 + t) * SR); for (let i = 0; i < 0.09 * SR; i++) mic[start + i] += 0.3 * Math.sin(Math.PI * i / (0.09 * SR)) * rnd(); }
for (let s = 2; s < 12; s += 4) for (let i = 0; i < 3 * SR; i++) mic[s * SR + i] += 0.05 * Math.sin(2 * Math.PI * 170 * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3.2 * i / SR));
const wav = join(scratch, "mic.wav"); writeFileSync(wav, wavBytes(mic));
await startServers(scratch);
const browser = await launchChrome(playwright, { programmePath: wav, chromePath });
const { ctx, page } = await newStudioPage(browser);
const errors = []; page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
try {
  const { id } = await createSession(page, "Live clips");
  const frame = await openStudio(page, id);
  await joinStudio(frame);
  console.log("\nRecording with Moxie listening");
  const t0 = Date.now();
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => window.__toastyLiveSession.recording.active && window.__toastyLiveSession.liveClips.active, null, { timeout: 20000 });
  await sleep(2500);
  const audioSource = await frame.evaluate(() => window.__toastyLiveSession.liveClips.audioSource);
  assert(audioSource === "host-mic", `Moxie listens to the host microphone for laughter and reactions (${audioSource})`);
  const say = (speaker, text) => frame.evaluate(([s, t]) => window.__toastyLiveSession.transcript.append({ speaker: s, role: s === "Host" ? "host" : "guest", text: t }), [speaker, text]);
  const at = async (sec) => { while ((Date.now() - t0) / 1000 < sec) await sleep(200); };
  await at(6);  await say("Guest", "Honestly I think the biggest mistake is hiring for resume instead of curiosity.");
  await at(11); await say("Guest", "Here is the thing, the reason it fails is because nobody owns the follow up.");
  await at(15); await say("Host", "Ha ha ha, that is hilarious, wait, no way.");
  await at(30); await say("Guest", "We tried the old process for three years and it never worked for us.");
  await at(35); await say("Guest", "That changed everything, we finally shipped on time.");
  await at(39); await say("Host", "Moxie, clip that");
  const during = await frame.evaluate(() => window.__toastyLiveSession.clipBookmarks.map((b) => ({ c: b.category, open: b.open, s: b.start })));
  assert(during.some((b) => b.c === "clip-that" && b.open), "the spoken command opens a clip while the moment is still going");
  const status = await frame.evaluate(() => document.querySelector("#lvRecordNote")?.textContent || "");
  await at(40); await say("Guest", "And yes we are still doing it that way today.");
  await at(52);
  const live = await frame.evaluate(() => window.__toastyLiveSession.clipBookmarks.map((b) => ({ id: b.id, c: b.category, open: b.open, s: b.start, e: b.end, title: b.title, src: b.source })));
  console.log("  live bookmarks:", live.map((b) => `${b.s}-${b.e}s ${b.c}${b.open ? " (open)" : ""}`).join(" | "));
  assert(live.some((b) => b.c === "clip-that" && !b.open && b.e - b.s >= 8 && b.s < 39 && b.e >= 41), "the clip closed on its own once the talking stopped, and reaches back before the command");
  assert(live.some((b) => b.src === "auto"), "Moxie also bookmarked moments by itself, without being asked");
  const evTypes = await frame.evaluate(() => (window.__toastyLiveSession.liveClips.detector?.events || []).map((e) => e.type));
  assert(evTypes.includes("laughter"), `the laughing microphone was heard as laughter (${evTypes.join(", ") || "no events"})`);
  const noAnswer = await frame.evaluate(() => !(window.__toastyLiveSession.feed?.items || window.__toastyLiveSession.productionLog?.items || []).some((x) => /clip that/i.test(JSON.stringify(x)) && /question|answer/i.test(JSON.stringify(x))));
  assert(noAnswer, "'Moxie, clip that' is not treated as a question for Moxie to answer");
  await frame.evaluate(() => document.querySelector("[data-lv-view-btn=producer]").click());
  const listed = await frame.evaluate(() => document.querySelectorAll("#lvClipBookmarkList li").length);
  assert(listed >= 2 && await frame.isVisible("#lvClipBookmarks"), `the producer panel lists the bookmarks (${listed})`);

  console.log("\nStop, save, and open in Toasty Clips");
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => ["finalized", "local-only", "failed"].includes(window.__toastyLiveSession.recording.last?.finalizationStatus), null, { timeout: 120000 });
  const saved = await frame.evaluate(() => { const l = window.__toastyLiveSession.recording.last; return { status: l.finalizationStatus, id: l.recordingId, clips: l.manifest?.clipBookmarks || [], markers: (l.manifest?.markers || []).filter((m) => /^Clip:/.test(m.label)).length }; });
  assert(saved.status === "finalized" && saved.clips.length >= 2, `the recording was saved with ${saved.clips.length} clip bookmarks in its manifest`);
  assert(saved.markers >= 1, `and as Moxie markers (${saved.markers})`);
  assert(await frame.isVisible("#lvMakeClips"), "a 'Make clips' button sits beside the download buttons");
  const p2 = await ctx.newPage(); await p2.addInitScript(() => { try { localStorage.setItem("toasty.moxie.prefs", JSON.stringify({ models: false, visual: false })); } catch (_) {} }); p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto(`${BASE}/studio/clips.html`);
  await p2.waitForSelector("#tcLibrary [data-recording]", { timeout: 20000 });
  await p2.click("#tcLibrary [data-recording]");
  await p2.waitForFunction(() => window.__toastyClips.source && !document.querySelector("#tcFind").disabled);
  await p2.click("#tcFind");
  await p2.waitForSelector("#tcClips .tc-clip");
  const cl = await p2.evaluate(() => window.__toastyClips.clips.map((c) => ({ cat: c.category, src: c.source, sel: c.selected, s: c.start, e: c.end })));
  console.log("  in Clips:", cl.map((c) => `${c.s}-${c.e}s ${c.cat}/${c.src}${c.sel ? "*" : ""}`).join(" | "));
  assert(cl.some((c) => c.cat === "clip-that" && c.sel), "the 'Moxie, clip that' clip arrives in Toasty Clips already selected");
  assert(cl.length >= 2 && cl.every((c) => c.e > c.s), "the live bookmarks are there with their times");
  assert(!errors.length, `no page errors (${errors.join(" | ") || "none"})`);
  console.log(`\nfiles: ${scratch}\nALL PASSED — Moxie bookmarks moments live, obeys "Moxie, clip that", and hands the clips to Toasty Clips.`);
  await browser.close(); process.exit(0);
} catch (error) {
  console.error(error.message || error, errors.join(" | "));
  try { await page.screenshot({ path: join(scratch, "failure.png") }); } catch (_) {}
  await browser.close().catch(() => {}); process.exit(1);
}
