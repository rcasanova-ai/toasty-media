#!/usr/bin/env node
// The recorded microphone must be ONE stable track for the whole take, whatever the physical microphone does.
import { createStableMicTrack } from "../js/stable-mic-track.js";
import { vdoAudioInputPosition } from "../js/video-engine.js";

const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };

class FakeTrack { constructor(label) { this.label = label; this.readyState = "live"; this.enabled = true; this.stopped = false; } stop() { this.stopped = true; this.readyState = "ended"; } clone() { return Object.assign(new FakeTrack(this.label), { cloned: true }); } getTracks() { return [this]; } }
globalThis.MediaStream = class { constructor(tracks = []) { this.tracks = tracks; } getAudioTracks() { return this.tracks; } getTracks() { return this.tracks; } };
class FakeAudioContext {
  constructor() { this.closed = false; this.sources = []; }
  createMediaStreamDestination() { const out = new FakeTrack("destination"); this.dest = { stream: { getAudioTracks: () => [out], getTracks: () => [out] }, track: out }; return this.dest; }
  createMediaStreamSource(stream) { const node = { stream, connected: null, disconnected: false, connect: (d) => { node.connected = d; }, disconnect: () => { node.disconnected = true; node.connected = null; } }; this.sources.push(node); return node; }
  resume() { return Promise.resolve(); }
  close() { this.closed = true; }
}

console.log("\nStable microphone track");
{
  let mic = new FakeTrack("USB mic");
  let ctx = null;
  const Impl = class extends FakeAudioContext { constructor(...a) { super(...a); ctx = this; } };
  const stable = createStableMicTrack({ getMicTrack: () => mic, AudioContextImpl: Impl });
  const recorded = stable.track;
  ok(stable.kind === "webaudio" && recorded === ctx.dest.track, "the recorder is handed the Web Audio destination track, not the physical mic");
  ok(ctx.sources.length === 1 && ctx.sources[0].connected === ctx.dest, "the current microphone feeds the destination directly (no gain or processing node)");
  stable.bind(); stable.bind();
  ok(ctx.sources.length === 1, "binding the same microphone again does nothing");

  const second = new FakeTrack("Headset"); mic = second; stable.bind();
  ok(ctx.sources.length === 2 && ctx.sources[0].disconnected && ctx.sources[1].connected === ctx.dest && stable.swaps === 2, "switching microphone reconnects the source");
  ok(stable.track === recorded && !recorded.stopped, "the recorded track is the SAME object after the switch, so the recorder never sees a track change");

  second.stop(); mic = second; stable.bind();
  ok(stable.track === recorded && !recorded.stopped && ctx.sources.length === 2, "a lost microphone leaves the recorded track alive (silence, not a dead recorder)");
  const third = new FakeTrack("Default"); mic = third; stable.bind();
  ok(ctx.sources.length === 3 && ctx.sources[2].connected === ctx.dest, "when a microphone comes back it is picked up on the next tick without restarting anything");
  stable.dispose();
  ok(ctx.closed && recorded.stopped, "dispose stops the destination track and closes the audio context");
}

console.log("\nFallback when Web Audio is unavailable");
{
  const mic = new FakeTrack("Mic");
  const stable = createStableMicTrack({ getMicTrack: () => mic, AudioContextImpl: null });
  ok(stable.kind === "clone" && stable.track.cloned, "falls back to a clone of the microphone track");
  mic.enabled = false; stable.bind();
  ok(stable.track.enabled === false, "mute state still follows the microphone");
  const none = createStableMicTrack({ getMicTrack: () => null, AudioContextImpl: null });
  ok(none.track === null, "no microphone means no audio track, no crash");
}

console.log("\nVDO microphone position (1-based among audio inputs)");
{
  const list = [
    { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
    { kind: "audioinput", deviceId: "aaa", label: "MacBook Pro Microphone" },
    { kind: "audioinput", deviceId: "bbb", label: "Yeti Stereo Microphone" },
    { kind: "videoinput", deviceId: "vvv", label: "FaceTime HD Camera" },
    { kind: "audiooutput", deviceId: "ooo", label: "Speakers" }
  ];
  ok(vdoAudioInputPosition(list, { deviceId: "aaa" }) === 2, "second microphone is position 2 (not index 1)");
  ok(vdoAudioInputPosition(list, { deviceId: "default" }) === 1, "the first microphone is position 1 (index 0 would throw inside VDO)");
  ok(vdoAudioInputPosition(list, { label: "yeti stereo microphone" }) === 3, "matches by label when the device id is origin-salted");
  ok(vdoAudioInputPosition(list, { label: "Yeti" }) === 3, "matches a label fragment");
  ok(vdoAudioInputPosition(list, { deviceId: "nope", label: "Nothing" }) === 0, "unknown microphone returns 0 so no switch is attempted");
  ok(vdoAudioInputPosition([], { deviceId: "x" }) === 0, "empty list returns 0");
}
console.log("ALL PASSED — the recorded microphone track is stable across device changes.");
