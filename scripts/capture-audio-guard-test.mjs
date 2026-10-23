#!/usr/bin/env node
// The recording guard must never make a recording worse: every way it can fail falls back to the raw capture.
import { guardCaptureAudio } from "../js/capture-audio-guard.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };

class Track { constructor(kind, settings = {}) { this.kind = kind; this._settings = settings; this.stopped = false; } getSettings() { return this._settings; } stop() { this.stopped = true; } }
class FakeStream { constructor(tracks = []) { this.tracks = tracks; } getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); } getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); } getTracks() { return this.tracks; } }
const capture = ({ display = true } = {}) => new FakeStream([new Track("video", display ? { displaySurface: "browser" } : {}), new Track("audio", { channelCount: 2 })]);

function makeCtx({ state = "running", workletFails = false, processes = true } = {}) {
  const made = { closed: false, nodes: [] };
  class Ctx {
    constructor() { this.state = state; this.audioWorklet = { addModule: async () => { if (workletFails) throw new Error("module blocked"); } }; made.ctx = this; }
    createMediaStreamSource() { const n = { connect() {}, disconnect() {} }; return n; }
    createMediaStreamDestination() { const out = new Track("audio"); return { connect() {}, stream: new FakeStream([out]), track: out }; }
    async resume() {}
    close() { made.closed = true; }
  }
  globalThis.AudioWorkletNode = class { constructor() { this.port = { postMessage: () => { if (processes) setTimeout(() => this.port.onmessage?.({ data: { type: "stats", seconds: 1.2, maxReductionDb: -3.1, activeSeconds: 0.4 } }), 1); } }; made.nodes.push(this); } connect() {} disconnect() {} };
  return { Ctx, made };
}

console.log("\nWhen the guard should not run");
{
  const c = capture();
  const r1 = await guardCaptureAudio(c, { enabled: false });
  ok(r1.stream === c && !r1.applied && r1.reason === "disabled", "switched off -> raw stream");
  const noAudio = new FakeStream([new Track("video", { displaySurface: "browser" })]);
  ok((await guardCaptureAudio(noAudio, {})).reason === "no-audio-track", "no audio track -> raw stream");
  const { Ctx } = makeCtx();
  const single = capture({ display: false });
  const r2 = await guardCaptureAudio(single, { AudioContextImpl: Ctx, MediaStreamImpl: FakeStream });
  ok(r2.stream === single && r2.reason === "single-source-capture", "a single-microphone canvas capture is left alone (nothing is mixed)");
  ok((await guardCaptureAudio(c, { AudioContextImpl: null, MediaStreamImpl: FakeStream })).reason === "web-audio-unavailable", "no Web Audio -> raw stream");
}

console.log("\nWhen the guard fails, the raw capture is recorded");
{
  for (const [label, opts, expect] of [
    ["worklet module cannot load", { workletFails: true }, /failed: module blocked/],
    ["context is suspended (autoplay policy)", { state: "suspended" }, /audio-context-suspended/],
    ["audio thread never processes a frame", { processes: false }, /audio-thread-not-processing/]
  ]) {
    const { Ctx, made } = makeCtx(opts);
    const c = capture();
    const r = await guardCaptureAudio(c, { AudioContextImpl: Ctx, MediaStreamImpl: FakeStream });
    ok(r.stream === c && !r.applied && expect.test(r.reason) && made.closed, `${label} -> raw stream, reason "${r.reason}", context closed`);
  }
}

console.log("\nWhen it works");
{
  const { Ctx, made } = makeCtx();
  const c = capture();
  const r = await guardCaptureAudio(c, { AudioContextImpl: Ctx, MediaStreamImpl: FakeStream });
  ok(r.applied && r.stream !== c, "a new stream is returned");
  ok(r.stream.getVideoTracks()[0] === c.getVideoTracks()[0], "the VIDEO track is passed through untouched");
  ok(r.stream.getAudioTracks().length === 1 && r.stream.getAudioTracks()[0] !== c.getAudioTracks()[0], "the audio is the limiter's output track");
  const stats = await r.stats();
  ok(stats.maxReductionDb === -3.1, "stats from the audio thread are readable");
  r.dispose();
  ok(made.closed && r.stream.getAudioTracks()[0].stopped, "dispose closes the context and stops the output track");
  ok(!c.getTracks().some((t) => t.stopped), "dispose never stops the original capture tracks (the Studio owns them)");
}
console.log("ALL PASSED — the recording guard fails open in every case.");
