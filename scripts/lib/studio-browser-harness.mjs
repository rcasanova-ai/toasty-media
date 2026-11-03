// Shared real-browser scaffolding for Studio audio tests: static + API servers, Chrome with a fake microphone playing a
// known WAV, a registered user with a disposable session, Studio join, and sample-accurate capture helpers.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wavBytes } from "./synth-programme.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE = "http://127.0.0.1:4173";
export const API = "http://127.0.0.1:4174";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { "Content-Type": "application/json", "X-Toasty-CSRF": "1" };

export function makeAsserter() {
  const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
  return assert;
}

export async function loadPlaywright() {
  try { return await import(process.env.PLAYWRIGHT_CORE || "playwright-core"); } catch { console.log("SKIPPED: playwright-core is not installed (npm i --no-save playwright-core)."); process.exit(0); }
}

export function findChrome() {
  const chromePath = process.env.CHROME_PATH || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
  if (!chromePath) { console.log("SKIPPED: no Chrome found (set CHROME_PATH)."); process.exit(0); }
  return chromePath;
}

export async function startServers(scratch) {
  const children = [];
  process.on("exit", () => children.forEach((c) => { try { c.kill("SIGKILL"); } catch (_) {} }));
  if (!process.env.SKIP_SERVERS) {
    children.push(spawn("python3", ["-m", "http.server", "4173", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" }));
    children.push(spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: "4174", TOASTY_AUTH_DB: join(scratch, "t.sqlite"), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "audio-test", RESEND_API_KEY: "", TOASTY_RECORDING_JOBS_DIR: join(scratch, "jobs") }, stdio: "ignore" }));
  }
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${API}/health`)).ok && (await fetch(`${BASE}/studio/`)).ok) return children; } catch (_) {} await sleep(250); }
  throw new Error("servers did not start");
}

export async function launchChrome(playwright, { programmePath, chromePath, extraArgs = [] }) {
  return playwright.chromium.launch({ executablePath: chromePath, headless: process.env.HEADLESS === "1",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${programmePath}`, "--auto-select-desktop-capture-source=Entire screen", "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required", ...(process.env.HEADLESS === "1" ? ["--headless=new"] : []), ...extraArgs] });
}

export async function newStudioPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(["camera", "microphone"], { origin: BASE });
  if (process.env.RECORD_FORMAT) await ctx.addInitScript((f) => { try { localStorage.setItem("toasty.recording.format", f); } catch (_) {} }, process.env.RECORD_FORMAT);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  return { ctx, page };
}

export async function createSession(page, title = "Audio test") {
  return page.goto(`${BASE}/studio/sessions.html`).then(() => page.evaluate(async ([API, H, title]) => {
    await fetch(API + "/auth/register", { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ name: "Audio", email: "audio" + Date.now() + "@example.com", password: "password10chars" }) });
    const s = await fetch(API + "/api/sessions", { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ title, brandId: "toasty", roomId: "qa" + Math.random().toString(36).slice(2, 10) }) });
    const body = await s.json();
    return { id: body.session.id, roomId: body.session.roomId || null };
  }, [API, H, title]));
}

export async function openStudio(page, sessionId) {
  await page.goto(`${BASE}/studio/sessions.html?session=${sessionId}`);
  let frame; for (let i = 0; i < 60 && !frame; i++) { frame = page.frames().find((f) => f.url().includes("director.html")); if (!frame) await sleep(500); }
  if (!frame) throw new Error("studio frame never loaded");
  await frame.waitForFunction(() => window.__toastyLiveSession?.hostState === "prejoin-ready", null, { timeout: 30000 });
  return frame;
}

export async function joinStudio(frame, name = "Audio Host") {
  await frame.fill("#lvHostPrejoinName", name);
  await frame.click("#lvHostPrejoinJoin");
  await frame.waitForFunction(() => window.__toastyLiveSession.hostState === "in-studio", null, { timeout: 30000 });
}

// AudioWorklet capture of a fresh getUserMedia stream; returns base64 float32 + the settings Chrome applied.
export const CAPTURE_SOURCE = `async ({ constraints, seconds }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const track = stream.getAudioTracks()[0];
  const ctx = new AudioContext({ sampleRate: 48000 });
  const src = 'class C extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice());return true}}registerProcessor("cap",C)';
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "cap"); const chunks = [];
  node.port.onmessage = (e) => chunks.push(e.data);
  ctx.createMediaStreamSource(stream).connect(node); await ctx.resume();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const settings = track.getSettings(); stream.getTracks().forEach((t) => t.stop()); await ctx.close();
  const total = chunks.reduce((n, c) => n + c.length, 0), all = new Float32Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  let bin = ""; const u8 = new Uint8Array(all.buffer); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), sampleRate: ctx.sampleRate, settings };
}`;

export function f32FromB64(b64) { return new Float32Array(Buffer.from(b64, "base64").buffer.slice(0)); }
export { wavBytes };

export async function stopAndDownload(page, frame, scratch, baseName) {
  await frame.evaluate(() => document.querySelector("#lvRecordToggle").click());
  await frame.waitForFunction(() => ["finalized", "failed", "local-only", "too-large"].includes(window.__toastyLiveSession.recording.last?.finalizationStatus), null, { timeout: 240000 });
  const last = await frame.evaluate(() => { const l = window.__toastyLiveSession.recording.last; return { status: l.finalizationStatus, as: l.recordedAs, dur: l.durationSeconds, mime: l.masterBlob?.type || l.sourceBlob?.type }; });
  await frame.evaluate(() => document.querySelector("[data-lv-view-btn=producer]").click());
  const dl = page.waitForEvent("download");
  await frame.evaluate(() => document.querySelector("#lvMasterDownload").click());
  const file = await dl;
  const path = join(scratch, baseName + (/\.mp4$/.test(file.suggestedFilename()) ? ".mp4" : ".webm"));
  await file.saveAs(path);
  return { last, path };
}
