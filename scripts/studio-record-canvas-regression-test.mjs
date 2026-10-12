#!/usr/bin/env node
// Regression guard for Studio Record. Exercises the real canvas compositor and recorder code with fakes for
// canvas/MediaRecorder/MediaStream. It does NOT prove a browser records pixels; that is the manual test.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProgramCanvasCapture, programCanvasLayout, fitRect, PROGRAM_CANVAS } from "../js/program-canvas-capture.js";
import { MasterProgramRecorder, inspectMasterCapture } from "../js/program-recording.js";
import { LiveSession } from "../js/live-session.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };

const track = (kind, extra = {}) => ({ kind, readyState: "live", enabled: true, stopped: false, stop() { this.stopped = true; this.readyState = "ended"; }, clone() { return track(kind, { cloned: true }); }, addEventListener() {}, ...extra });
const stream = (...tracks) => ({ active: true, _t: [...tracks], getTracks() { return this._t; }, getVideoTracks() { return this._t.filter((t) => t.kind === "video"); }, getAudioTracks() { return this._t.filter((t) => t.kind === "audio"); }, addTrack(t) { this._t.push(t); } });

function fakeDoc() {
  const draws = [];
  const doc = { createElement(tag) {
    if (tag === "canvas") return { width: 0, height: 0, getContext: () => ({ fillRect() {}, save() {}, restore() {}, beginPath() {}, clip() {}, stroke() {}, rect() {}, roundRect() {}, drawImage(el) { draws.push(el.label); }, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {} }), captureStream() { return stream(track("video", { fromCanvas: true })); } };
    return { label: tag, videoWidth: 1920, videoHeight: 1080, play: () => Promise.resolve(), pause() {}, set srcObject(v) { this.label = v?.name || "video"; }, get srcObject() { return null; } };
  } };
  return { doc, draws };
}

console.log("Layout: screen is main, camera is the overlay, always 16:9");
{
  assert(PROGRAM_CANVAS.width / PROGRAM_CANVAS.height === 16 / 9, "canvas is 16:9");
  const both = programCanvasLayout({ hasScreen: true, hasCamera: true });
  assert(both.main.source === "screen" && both.pip.source === "camera" && both.pip.rect.w < both.main.rect.w / 3, "screen main + small camera PiP");
  const bottomRight = both.pip.rect.x + both.pip.rect.w <= PROGRAM_CANVAS.width && both.pip.rect.y + both.pip.rect.h <= PROGRAM_CANVAS.height && both.pip.rect.x > PROGRAM_CANVAS.width / 2;
  assert(bottomRight, "PiP sits inside the frame, bottom-right");
  const cam = programCanvasLayout({ hasCamera: true });
  assert(cam.main.source === "camera" && !cam.pip && cam.main.rect.w === PROGRAM_CANVAS.width && cam.main.rect.h === PROGRAM_CANVAS.height, "camera-only fills the same 16:9 canvas");
  const f = fitRect(1000, 1000, { x: 0, y: 0, w: 1280, h: 720 }, "contain");
  assert(f.dh === 720 && f.dw === 720 && f.dx === 280, "contain letterboxes without changing the canvas");
}

console.log("\nCanvas capture reuses existing streams and includes mic");
{
  const { doc, draws } = fakeDoc();
  const cam = stream(track("video"), track("audio")); cam.name = "camera";
  const scr = stream(track("video")); scr.name = "screen";
  let displayCalls = 0, userCalls = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { mediaDevices: { getDisplayMedia: async () => { displayCalls++; }, getUserMedia: async () => { userCalls++; } } } });
  const cap = createProgramCanvasCapture({ getCamera: () => cam, getScreen: () => scr, getMicTrack: () => cam.getAudioTracks()[0], documentRef: doc });
  await new Promise((r) => setTimeout(r, 120));
  cap.dispose();
  assert(displayCalls === 0 && userCalls === 0, "no screen picker and no camera/mic request");
  assert(draws.includes("screen") && draws.includes("camera"), "both the existing screen stream and the existing camera stream are drawn");
  assert(draws.indexOf("screen") < draws.lastIndexOf("camera"), "screen drawn first (main), camera on top (overlay)");
  assert(cap.stream.getAudioTracks().length === 1 && cap.stream.getAudioTracks()[0].cloned, "microphone audio is in the recorded stream (as a clone)");
  assert(cam.getTracks().every((t) => !t.stopped) && scr.getTracks().every((t) => !t.stopped), "disposing never stops the camera, mic or screen share");
  const check = inspectMasterCapture(cap.stream);
  assert(check.ok, "recorder accepts the stream (live video + audio)");
}

console.log("\nRecord produces a playable file and keeps the session");
{
  class FakeRecorder {
    constructor(s) { this.stream = s; this.state = "inactive"; this.mimeType = "video/webm"; this.l = {}; }
    addEventListener(e, f) { this.l[e] = f; }
    start() { this.state = "recording"; this.l.dataavailable?.({ data: new Blob(["chunk-a"], { type: "video/webm" }) }); }
    stop() { this.state = "inactive"; this.l.dataavailable?.({ data: new Blob(["chunk-b"], { type: "video/webm" }) }); this.l.stop?.(); }
    static isTypeSupported() { return true; }
  }
  const { doc } = fakeDoc();
  const cam = stream(track("video"), track("audio"));
  const cap = createProgramCanvasCapture({ getCamera: () => cam, getScreen: () => null, getMicTrack: () => cam.getAudioTracks()[0], documentRef: doc });
  const rec = new MasterProgramRecorder({ MediaRecorderImpl: FakeRecorder });
  const started = await rec.start({ recordingId: "rec-1", captureStream: cap.stream });
  const result = await rec.stop();
  cap.dispose();
  assert(started.recordingId === "rec-1" && result.bytes > 0 && result.blob.type === "video/webm", "stop returns a non-empty webm blob");
  assert(cam.getTracks().every((t) => !t.stopped), "studio camera/mic still live after stopping (session preserved)");
}

console.log("\nLiveSession picks the canvas path and never opens a picker");
{
  const ls = Object.create(LiveSession.prototype);
  let picker = 0, opened = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { mediaDevices: { getDisplayMedia: async () => { picker++; } } } });
  globalThis.HTMLCanvasElement = function HTMLCanvasElement() {}; globalThis.HTMLCanvasElement.prototype.captureStream = () => {};
  globalThis.MediaRecorder = class { static isTypeSupported() { return true; } };
  const { doc } = fakeDoc(); globalThis.document = doc;
  const cam = stream(track("video"), track("audio"));
  Object.assign(ls, { _hostPreviewStream: cam, screenShare: { active: false }, policy: { canRecord: () => true }, participants: { list: () => [{ role: "host", connectionStatus: "connected" }] }, emit() {}, ensureProgramOutputWindow() { opened++; } });
  const msg = [];
  ls.emit = (_, m) => msg.push(m);
  assert(ls.canCaptureProgramCanvas() === true, "solo host with camera+mic uses the canvas");
  const cap = await ls._captureProgramOutput();
  cap.dispose?.();
  assert(picker === 0 && opened === 0, "Record opens no picker and no Program Output window");
  assert(cap.stream.getVideoTracks().length === 1, "returns a composed video stream");
  ls.participants = { list: () => [{ role: "host", connectionStatus: "connected" }, { role: "guest", connectionStatus: "connected" }] };
  assert(ls.canCaptureProgramCanvas() === false, "with a connected remote guest it falls back to Program Output tab capture");
}

console.log("\nStatic guards");
{
  const html = read("studio/director.html");
  const rec = html.match(/<button[^>]*id="lvRecordToggle"[^>]*>/)[0];
  assert(/type="button"/.test(rec), "Record button is type=button (cannot submit a form)");
  const before = html.slice(0, html.indexOf('id="lvRecordToggle"'));
  assert((before.match(/<form\b/g) || []).length === (before.match(/<\/form>/g) || []).length, "Record button is not inside a <form>");
  const pv = read("js/producer-view.js");
  const toggle = pv.slice(pv.indexOf("async toggleRecording()"), pv.indexOf("function formatClock"));
  assert(!toggle.includes("ensureProgramOutputWindow") && !/location\.(assign|reload|href)/.test(toggle), "toggleRecording opens no window and never navigates");
  assert(/Click Record to try again/.test(toggle) && /humanizeError/.test(toggle), "failure shows an actionable error with retry");
  assert(/recordToggle\.textContent = saving \? "SAVING..." : active \? "STOP RECORDING" : "RECORD"/.test(pv), "button flips to STOP RECORDING");
  const dj = read("js/director.js");
  assert(/RECORDING \$\{elapsed\}/.test(dj), "visible recording timer in the bottom bar");
  const ls = read("js/live-session.js");
  assert(ls.indexOf("canCaptureProgramCanvas()) {") < ls.indexOf("getDisplayMedia(programOutputDisplayConstraints())"), "canvas path is tried before any picker");
}
console.log("\nPASS (fakes only; real recording needs the manual test)");
