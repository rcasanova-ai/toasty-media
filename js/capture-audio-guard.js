// Safety limiter in front of the recorder's audio.
//
// The recorder gets the Program audio as a plain browser capture. When two loud people talk at once the browser's own
// mix can exceed full scale and the encoder then hard-clips it, which cannot be repaired later. This runs the capture's
// audio through a transparent look-ahead peak limiter (js/streaming-limiter.js) before it is encoded: untouched below
// the ceiling, never above it. The ceiling is -2 dBFS rather than -1: the AAC/Opus encoder that follows can overshoot its input by up to about 1 dB (measured), and the headroom keeps the decoded file below full scale. If anything about it is unavailable or fails, the original stream is returned unchanged
// (fail open): a recording must never be lost because a safety feature could not start.
//
// Turn off with localStorage["toasty.recording.limiter"] = "off" (kept for diagnosing a suspected processing problem).
export const GUARD_STORAGE_KEY = "toasty.recording.limiter";

export function guardEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem?.(GUARD_STORAGE_KEY) !== "off"; } catch (_) { return true; }
}

const passthrough = (stream, reason) => ({ stream, applied: false, reason, async stats() { return null; }, dispose() {} });

export async function guardCaptureAudio(stream, {
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  MediaStreamImpl = globalThis.MediaStream,
  workletUrl = new URL("./limiter-worklet.js", import.meta.url).href,
  enabled = guardEnabled(),
  ceilingDb = -2,
  lookaheadMs = 5,
  latencyHint = 0,
  onlyDisplayCapture = true
} = {}) {
  const audioTrack = stream?.getAudioTracks?.()[0];
  if (!enabled) return passthrough(stream, "disabled");
  if (!audioTrack) return passthrough(stream, "no-audio-track");
  if (!AudioContextImpl || !MediaStreamImpl) return passthrough(stream, "web-audio-unavailable");
  // The Studio's own canvas recording carries a single microphone: nothing is being mixed, so there is nothing to protect and
  // no reason to add latency. Mixing happens in the Program Output tab, which is a display capture.
  if (onlyDisplayCapture && !stream.getVideoTracks?.()[0]?.getSettings?.().displaySurface) return passthrough(stream, "single-source-capture");
  let ctx = null;
  try {
    ctx = new AudioContextImpl({ sampleRate: 48000, latencyHint });
    if (!ctx.audioWorklet?.addModule) { ctx.close?.(); return passthrough(stream, "audio-worklet-unavailable"); }
    await ctx.audioWorklet.addModule(workletUrl);
    const channels = Math.max(1, Math.min(2, audioTrack.getSettings?.().channelCount || 2));
    const source = ctx.createMediaStreamSource(new MediaStreamImpl([audioTrack]));
    const node = new AudioWorkletNode(ctx, "toasty-safety-limiter", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels], channelCount: channels, channelCountMode: "explicit",
      processorOptions: { channels, ceilingDb, lookaheadMs }
    });
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = channels; destination.channelCountMode = "explicit";
    source.connect(node); node.connect(destination);
    await ctx.resume?.();
    let latest = null;
    node.port.onmessage = (event) => { if (event.data?.type === "stats") latest = event.data; };
    // Never record silence because a safety feature misbehaved: the context must be running AND the audio thread must be
    // processing frames before the guarded stream is used. (A context created without user activation starts suspended.)
    const abandon = (reason) => { try { source.disconnect(); node.disconnect(); } catch (_) {} try { ctx.close?.(); } catch (_) {} return passthrough(stream, reason); };
    if (ctx.state && ctx.state !== "running") return abandon(`audio-context-${ctx.state}`);
    let alive = false;
    for (let i = 0; i < 12 && !alive; i++) {
      try { node.port.postMessage({ type: "stats" }); } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 50));
      alive = Boolean(latest && latest.seconds > 0.02);
    }
    if (!alive) return abandon("audio-thread-not-processing");
    const guarded = new MediaStreamImpl([...stream.getVideoTracks(), destination.stream.getAudioTracks()[0]]);
    return {
      stream: guarded,
      applied: true,
      reason: "",
      ceilingDb,
      // Latest reduction figures from the audio thread (reported about once per second; asks for a fresh one on demand).
      async stats() {
        try { node.port.postMessage({ type: "stats" }); } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 60));
        return latest;
      },
      dispose() {
        try { source.disconnect(); node.disconnect(); } catch (_) {}
        try { destination.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { ctx.close?.(); } catch (_) {}
      }
    };
  } catch (error) {
    try { ctx?.close?.(); } catch (_) {}
    return passthrough(stream, `failed: ${error?.message || error}`);
  }
}
