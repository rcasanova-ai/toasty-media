#!/usr/bin/env node
// REAL-BROWSER Studio regression (Chrome with fake camera/mic/screen devices, real servers, real ffmpeg).
// It verifies the media a producer would actually get, not just that APIs answered:
//   solo recording · presenting (screen fills Program, camera PiP, name badge intact) · Program Output window
//   composition · stable toolbar geometry through record/present/live · continuous recording (no early stop)
//   · MP4 conversion through the job queue (ffprobe: H.264/AAC, constant 30fps, duration, audio signal, picture)
//   · download buttons · transcript export · guest-joined warning · crash recovery of an interrupted recording.
//
// Needs: `npm i --no-save playwright-core`, Chrome (CHROME_PATH or the usual locations), ffmpeg/ffprobe, python3.
// Env: RECORD_FORMAT=webm forces the WebM + server-conversion fallback (default: browser-encoded MP4 when supported),
//      STUDIO_RECORD_SECONDS (default 75; use 330 for the 5-minute soak), SKIP_SERVERS=1 to reuse :4173/:4174.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECONDS = Number(process.env.STUDIO_RECORD_SECONDS || 75);
const BASE = "http://127.0.0.1:4173", API = "http://127.0.0.1:4174";
const scratch = mkdtempSync(join(tmpdir(), "toasty-browser-reg-"));
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let playwright;
try { playwright = await import(process.env.PLAYWRIGHT_CORE || "playwright-core"); } catch { console.log("SKIPPED: playwright-core is not installed (npm i --no-save playwright-core)."); process.exit(0); }
const chromePath = process.env.CHROME_PATH || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chromePath) { console.log("SKIPPED: no Chrome found (set CHROME_PATH)."); process.exit(0); }

const children = [];
process.on("exit", () => children.forEach((c) => { try { c.kill("SIGKILL"); } catch (_) {} }));
if (!process.env.SKIP_SERVERS) {
  children.push(spawn("python3", ["-m", "http.server", "4173", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" }));
  children.push(spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: "4174", TOASTY_AUTH_DB: join(scratch, "t.sqlite"), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "browser-reg", RESEND_API_KEY: "", TOASTY_RECORDING_JOBS_DIR: join(scratch, "jobs") }, stdio: "ignore" }));
}
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${API}/health`)).ok && (await fetch(`${BASE}/studio/`)).ok) break; } catch (_) {} await sleep(250); }

const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: process.env.HEADLESS === "1",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen", "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required", ...(process.env.HEADLESS === "1" ? ["--headless=new"] : [])] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.grantPermissions(["camera", "microphone"], { origin: BASE });
if (process.env.RECORD_FORMAT) await ctx.addInitScript((f) => { try { localStorage.setItem("toasty.recording.format", f); } catch (_) {} }, process.env.RECORD_FORMAT);
const apiCalls = [];
ctx.on("request", (r) => { if (/\/api\/recordings\//.test(r.url())) apiCalls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
const H = { "Content-Type": "application/json", "X-Toasty-CSRF": "1" };

async function openStudio(sessionId) {
  await page.goto(`${BASE}/studio/sessions.html?session=${sessionId}`);
  let frame; for (let i = 0; i < 60 && !frame; i++) { frame = page.frames().find((f) => f.url().includes("director.html")); if (!frame) await sleep(500); }
  if (!frame) throw new Error("studio frame never loaded");
  await frame.waitForFunction(() => window.__toastyLiveSession?.hostState === "prejoin-ready", null, { timeout: 30000 });
  return frame;
}
async function joinStudio(frame) {
  await frame.fill("#lvHostPrejoinName", "Regression Host");
  await frame.click("#lvHostPrejoinJoin");
  await frame.waitForFunction(() => window.__toastyLiveSession.hostState === "in-studio", null, { timeout: 30000 });
}
const geometry = (frame) => frame.evaluate(() => Object.fromEntries(["lvToggleMic", "lvToggleCamera", "lvToggleScreen", "lvRecordToggle", "lvBottomGoLive"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }]; })));

try {
  console.log("\nSetup");
  const sessionId = await page.goto(`${BASE}/studio/sessions.html`).then(() => page.evaluate(async ([API, H]) => {
    await fetch(API + "/auth/register", { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ name: "Reg", email: "reg" + Date.now() + "@example.com", password: "password10chars" }) });
    const s = await fetch(API + "/api/sessions", { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ title: "Regression", brandId: "toasty", roomId: "qa" + Math.random().toString(36).slice(2, 10) }) });
    return (await s.json()).session.id;
  }, [API, H]));
  let frame = await openStudio(sessionId);
  await joinStudio(frame);
  assert(await frame.evaluate(() => window.__toastyLiveSession.studio.mode) === "backstage", "Studio opens BACKSTAGE with the camera live (nothing recorded, nothing LIVE)");

  console.log("\nLayout: one Present control, Settings top-right, no duplicates");
  const ui = await frame.evaluate(() => ({ quick: !!document.querySelector(".quick-actions, #toggleScreenQuick"), shareButtons: [...document.querySelectorAll("button")].filter((b) => /share screen|present/i.test(b.textContent) && b.offsetParent).length, settings: document.querySelector("#lvTopSettings")?.getBoundingClientRect().toJSON(), more: document.querySelector("#lvTopMore")?.getBoundingClientRect().toJSON(), view: innerWidth }));
  assert(!ui.quick, "the left-rail Quick Actions card with the duplicate Share Screen is gone");
  assert(ui.shareButtons === 1, `exactly ONE visible Present/Share control (found ${ui.shareButtons})`);
  assert(ui.settings && ui.more && ui.settings.x > ui.view * 0.5 && ui.settings.y < 120 && ui.settings.x < ui.more.x, "Settings is in the top-right header, next to the More menu");

  const idle = await geometry(frame);
  console.log("\nSolo recording");
  const t0 = Date.now();
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => window.__toastyLiveSession.recording.active, null, { timeout: 15000 });
  assert(await frame.evaluate(() => window.__toastyLiveSession.studio.mode) === "record", "Record shows RECORDING");
  const rec1 = await geometry(frame);
  // Same candidates, same order as pickMasterMime(): CI Chrome may support plain video/mp4 but not the High-profile codec string.
  const browserMp4 = await page.evaluate(() => ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"].some((t) => MediaRecorder.isTypeSupported(t)));
  const expectDirect = browserMp4 && process.env.RECORD_FORMAT !== "webm";
  const recOpts = await frame.evaluate(() => { const r = window.__toastyLiveSession._masterRecorder?.fallback?.recorder; return { mime: r?.mimeType, video: r?.videoBitsPerSecond, audio: r?.audioBitsPerSecond }; });
  assert(recOpts.video === 6000000 && recOpts.audio === 160000, `local recording quality is 6 Mbps video / 160 kbps audio (recorder reports ${recOpts.video}/${recOpts.audio})`);
  assert(expectDirect ? /^video\/mp4/.test(recOpts.mime) : /^video\/webm/.test(recOpts.mime), `the browser records ${expectDirect ? "MP4 directly" : "WebM (fallback)"} (${recOpts.mime})`);

  console.log("\nPresent while recording: Program Output follows automatically");
  await sleep(4000);
  await frame.evaluate(() => document.querySelector("#lvToggleScreen").click());
  await frame.waitForFunction(() => window.__toastyLiveSession.screenShare?.active, null, { timeout: 15000 });
  const presenting = await geometry(frame);
  const [popup] = await Promise.all([ctx.waitForEvent("page"), frame.evaluate(() => window.__toastyLiveSession.ensureProgramOutputWindow())]);
  await popup.waitForFunction(() => document.querySelector(".po-stage")?.dataset.layout === "screen-speaker" && document.querySelector('.po-tile[data-role="screen"] video')?.videoWidth > 0, null, { timeout: 30000 }).catch(() => {});
  const po = await popup.evaluate(() => { const stage = document.querySelector(".po-stage"); const screen = document.querySelector('.po-tile[data-role="screen"]'); const pip = document.querySelector('.po-tile[data-role="featured"]'); const name = pip?.querySelector(".lv-lower-third-name"); const s = screen?.getBoundingClientRect(), p = pip?.getBoundingClientRect(), st = stage?.getBoundingClientRect(); return { layout: stage?.dataset.layout, scene: document.querySelector(".po-scene-screen") ? getComputedStyle(document.querySelector(".po-scene-screen")).display : "none", screenW: s?.width, stageW: st?.width, pipW: p?.width, pipPos: pip && getComputedStyle(pip).position, screenPlaying: !!screen?.querySelector("video")?.videoWidth, nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : null, nameText: name?.textContent?.trim() }; });
  assert(po.layout === "screen-speaker" && po.screenPlaying, "Program Output switched to the presentation by itself and the shared screen is playing");
  assert(po.screenW > po.stageW * 0.85 && po.pipPos === "absolute" && po.pipW < po.screenW * 0.35, "the shared content fills the stage and the host camera is a picture-in-picture");
  assert(po.nameClipped === false && /Regression Host/i.test(po.nameText || ""), `the name badge shows the full name ("${po.nameText}")`);
  await popup.screenshot({ path: join(scratch, "program-output.png") });
  const preview = await frame.evaluate(() => { document.querySelector("[data-lv-view-btn=producer]").click(); const st = document.querySelector("#lvProgramPreviewStage"); const pip = st.querySelector('.po-tile[data-role="featured"]'); const n = pip?.querySelector(".lv-lower-third-name"); return { layout: st.dataset.layout, pipPos: pip && getComputedStyle(pip).position, clipped: n ? n.scrollWidth > n.clientWidth + 1 : null }; });
  assert(preview.layout === "screen-speaker" && preview.pipPos === "absolute" && preview.clipped === false, "the Producer preview shows the same composition, badge intact");

  console.log("\nToolbar never moves between idle, recording and presenting");
  for (const id of Object.keys(idle)) {
    for (const [name, g] of [["recording", rec1], ["presenting", presenting]]) assert(Math.abs(g[id].x - idle[id].x) < 1 && Math.abs(g[id].y - idle[id].y) < 1 && Math.abs(g[id].w - idle[id].w) < 1, `${id} stays put while ${name}`);
  }
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const ids = Object.keys(presenting); let overlaps = 0; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (overlap(presenting[ids[i]], presenting[ids[j]])) overlaps++;
  assert(overlaps === 0, "no toolbar controls overlap each other");

  console.log("\nGuests: a guest joining a camera-only recording is told what the file contains");
  await frame.evaluate(() => { const S = window.__toastyLiveSession; S.guestSeats = [{ id: "guest-1", name: "Guest" }]; S._applyControlBundle({}); });
  await sleep(300);
  assert(await frame.evaluate(() => { const S = window.__toastyLiveSession; return S._guestWarned === true; }), "joining mid-recording raises the 'recording only captures you and your screen' warning");
  await frame.evaluate(() => { window.__toastyLiveSession.guestSeats = []; });

  console.log(`\nContinuous recording for ${SECONDS}s (screen presented 5s-${Math.round(SECONDS * 0.6)}s)`);
  let stoppedEarly = false;
  const presentEndAt = Math.round(SECONDS * 0.6);
  let presentStopped = false;
  while ((Date.now() - t0) / 1000 < SECONDS) {
    const t = (Date.now() - t0) / 1000;
    if (!presentStopped && t > presentEndAt) { presentStopped = true; await frame.evaluate(() => document.querySelector("#lvToggleScreen").click()); }
    const s = await frame.evaluate(() => { const S = window.__toastyLiveSession; const r = S._masterRecorder?.fallback?.recorder; return { active: S.recording.active, rs: r?.state }; });
    if (!s.active || s.rs !== "recording") { stoppedEarly = true; break; }
    await sleep(2000);
  }
  assert(!stoppedEarly, `recording never stopped on its own (ran ${Math.round((Date.now() - t0) / 1000)}s until explicitly stopped)`);

  console.log(expectDirect ? "\nTranscript, stop — MP4 is complete locally" : "\nTranscript, stop, MP4 job");
  await frame.evaluate(() => { const S = window.__toastyLiveSession; S.transcript.append({ speaker: "Regression Host", text: "Hello and welcome." }); S.transcript.append({ speaker: "Guest", text: "Thanks for having me." }); });
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => ["finalized", "failed", "local-only", "too-large"].includes(window.__toastyLiveSession.recording.last?.finalizationStatus), null, { timeout: 240000 });
  const last = await frame.evaluate(() => { const l = window.__toastyLiveSession.recording.last; return { status: l.finalizationStatus, err: l.finalizationError, source: l.sourceBlob?.size, mp4: l.masterBlob?.size, dur: l.durationSeconds, as: l.recordedAs }; });
  if (expectDirect) {
    assert(last.status === "finalized" && last.as === "browser-mp4" && last.mp4 > 10000, `the MP4 was recorded by the browser itself (${(last.mp4 / 1048576).toFixed(1)}MB), ready the moment recording stopped`);
    await sleep(2500);
    assert(apiCalls.length === 0, `NOTHING was uploaded or sent to the recording APIs (${apiCalls.length} calls)`);
  } else {
    assert(last.status === "finalized" && last.mp4 > 10000 && last.source > 10000, `MP4 conversion succeeded and the source WebM is still held (${(last.source / 1048576).toFixed(1)}MB webm → ${(last.mp4 / 1048576).toFixed(1)}MB mp4)`);
    assert(apiCalls.some((c) => c.includes("/limits")) && apiCalls.some((c) => c.includes("/jobs")), "the WebM fallback asked the server what it accepts, then converted via a job");
  }

  console.log("\nDownloads and transcript export");
  await frame.evaluate(() => document.querySelector("[data-lv-view-btn=producer]").click());
  const dlMp4 = page.waitForEvent("download");
  await frame.evaluate(() => document.querySelector("#lvMasterDownload").click());
  const mp4File = await dlMp4; const mp4Path = join(scratch, "recording.mp4"); await mp4File.saveAs(mp4Path);
  assert(/\.mp4$/.test(mp4File.suggestedFilename()), `Download MP4 delivers an .mp4 (${mp4File.suggestedFilename()})`);
  let webmPath = null;
  if (expectDirect) {
    assert(await frame.evaluate(() => document.querySelector("#lvMasterDownloadWebm").hidden), "no separate 'source' download is offered — the MP4 is the recording");
  } else {
    const dlWebm = page.waitForEvent("download");
    await frame.evaluate(() => document.querySelector("#lvMasterDownloadWebm").click());
    const webmFile = await dlWebm; webmPath = join(scratch, "source.webm"); await webmFile.saveAs(webmPath);
    assert(/-source\.webm$/.test(webmFile.suggestedFilename()), "Advanced → Download Source WebM delivers the original WebM");
  }
  const downloads = []; page.on("download", (d) => downloads.push(d));
  await frame.evaluate(() => document.querySelector("#lvTranscriptDownload").click()); await sleep(1500);
  assert(downloads.length >= 2 && downloads.some((d) => /transcript\.txt$/.test(d.suggestedFilename())) && downloads.some((d) => /transcript\.json$/.test(d.suggestedFilename())), "Download Transcript delivers TXT and JSON");
  const txt = join(scratch, "t.txt"); await downloads.find((d) => /\.txt$/.test(d.suggestedFilename())).saveAs(txt);
  assert(/Regression Host: Hello and welcome\./.test(execFileSync("cat", [txt]).toString()), "the transcript file contains the spoken lines");

  console.log("\nThe downloaded files are really playable media");
  const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,r_frame_rate,avg_frame_rate,width,height", "-of", "json", f]).toString());
  const info = probe(mp4Path); const v = info.streams.find((s) => s.codec_type === "video"), a = info.streams.find((s) => s.codec_type === "audio");
  assert(v?.codec_name === "h264" && a?.codec_name === "aac", "MP4: H.264 video + AAC audio");
  const [fn, fd] = (v.avg_frame_rate || "0/1").split("/").map(Number);
  assert(expectDirect ? Math.abs(fn / fd - 30) < 1.5 && v.width === 1280 && v.height === 720 : v.r_frame_rate === "30/1" && v.width === 1280 && v.height === 720, expectDirect ? `MP4: ~30 fps average, 1280x720 (${(fn / fd).toFixed(2)} fps)` : "MP4: constant 30 fps, 1280x720");
  assert(Math.abs(Number(info.format.duration) - last.dur) < 2.5 && Number(info.format.duration) > SECONDS - 6, `MP4 duration matches the recording (${Number(info.format.duration).toFixed(1)}s of ${SECONDS}s)`);
  const vol = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i '${mp4Path}' -af volumedetect -vn -f null - 2>&1 | grep mean_volume || true`]).toString();
  assert(/mean_volume: -\d+(\.\d+)? dB/.test(vol) && !/-9\d\.\d dB/.test(vol), `MP4 audio carries real signal (${vol.trim().split(":").pop().trim()})`);
  const luma = (t) => Number(execFileSync("sh", ["-c", `ffmpeg -hide_banner -loglevel error -ss ${t} -i '${mp4Path}' -frames:v 1 -vf "scale=64:36,format=gray" -f rawvideo - | od -An -tu1 -v | tr -s ' ' '\\n' | awk 'NF{s+=$1;n++} END{print s/n}'`]).toString());
  assert(luma(3) > 12 && luma(Number(info.format.duration) / 2) > 12, "the MP4 picture is not black at the start or middle");
  if (webmPath) {
    const webmInfo = probe(webmPath);
    assert(webmInfo.streams.some((s) => s.codec_type === "video") && webmInfo.streams.some((s) => s.codec_type === "audio"), "the source WebM also contains video and audio");
  }
  writeFileSync(join(scratch, "ok.txt"), "ok");

  console.log("\nCrash recovery: an interrupted recording is recoverable");
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => window.__toastyLiveSession.recording.active, null, { timeout: 15000 });
  await sleep(26000);                                    // > two 10s checkpoints
  await page.close();                                    // tab dies mid-recording (no clean stop)
  const page2 = await ctx.newPage(); page2.on("pageerror", () => {});
  await page2.goto(`${BASE}/studio/sessions.html?session=${sessionId}`);
  let frame2; for (let i = 0; i < 60 && !frame2; i++) { frame2 = page2.frames().find((f) => f.url().includes("director.html")); if (!frame2) await sleep(500); }
  await frame2.waitForFunction(() => window.__toastyLiveSession?.recording?.last?.recovered === true, null, { timeout: 30000 });
  const rec = await frame2.evaluate(() => { const l = window.__toastyLiveSession.recording.last; return { size: l.sourceBlob.size, status: l.finalizationStatus }; });
  assert(rec.size > 100000, `the interrupted recording was recovered from checkpoints (${(rec.size / 1048576).toFixed(2)}MB)`);
  if (expectDirect) {
    assert(rec.status === "finalized" && await frame2.evaluate(() => window.__toastyLiveSession.recording.last.masterBlob?.size) > 10000, "the recovered MP4 is immediately downloadable (no conversion needed)");
  } else {
    await frame2.evaluate(() => window.__toastyLiveSession.retryRecordingFinalization());
    await frame2.waitForFunction(() => window.__toastyLiveSession.recording.last?.finalizationStatus === "finalized", null, { timeout: 120000 });
    assert(await frame2.evaluate(() => window.__toastyLiveSession.recording.last.masterBlob.size) > 10000, "Retry MP4 converts the recovered recording");
  }

  console.log("\nALL PASSED — Studio records, presents, converts and recovers real media end to end.");
  await browser.close();
  process.exit(0);
} catch (error) {
  console.error(error.message || error);
  try { await page.screenshot({ path: join(scratch, "failure.png") }); console.error("screenshot:", join(scratch, "failure.png")); } catch (_) {}
  await browser.close().catch(() => {});
  process.exit(1);
}
