// A recorded microphone track that survives the microphone changing underneath it.
//
// MediaRecorder stops with an error if a track is added to or removed from the stream it records, and it records
// silence if the single mic track ends (USB mic unplugged, Bluetooth headset dropped, device switched). Recording
// the OUTPUT of a Web Audio destination instead gives the recorder one stable track for the whole take, while the
// source feeding it can be swapped at any moment. Gain is exactly 1 (a bare source -> destination connection): no
// processing is added, and a disabled (muted) source track simply yields silence.
//
// latencyHint 0 (lowest available) is deliberate: with the default "interactive" hint the Web Audio hop delayed audio
// about 50 ms behind video in measurement (scripts/audio-av-sync-browser-test.mjs); with 0 the recorded audio sits within
// a few ms of video, and stayed glitch-free with the CPU saturated.
//
// A quiet-voice safety net can sit between the source and the destination (js/recording-leveler.js, loaded as an AudioWorklet after
// the track is already flowing): it only ever RAISES a microphone that is far too quiet (a take recorded at -45 LUFS is unusable),
// never lowers anything, and a limiter at -2 dBFS follows it. At a normal level the gain is 0 dB. If the worklet cannot load, the
// microphone stays connected straight to the destination as before.
//
// Falls back to a plain clone of the mic track where Web Audio is unavailable (the old behaviour), which is fine for
// a recording that never changes microphones.
import { levelerEnabled } from "./recording-leveler.js";

export function createStableMicTrack({
  getMicTrack, AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext, latencyHint = 0,
  leveler = levelerEnabled(), workletUrl = new URL("./limiter-worklet.js", import.meta.url).href, onLevelStats = null
} = {}) {
  const initial = getMicTrack?.() || null;
  if (!AudioContextImpl) {
    const clone = initial ? initial.clone() : null;
    return {
      kind: "clone",
      track: clone,
      swaps: 0,
      bind() { if (clone && initial) clone.enabled = initial.enabled && initial.readyState === "live"; },
      dispose() {}
    };
  }
  const ctx = new AudioContextImpl({ sampleRate: 48000, latencyHint });
  const destination = ctx.createMediaStreamDestination();
  // The canonical Studio microphone is mono. A default destination is stereo, which would make the recorder encode a
  // duplicated second channel; keep it mono (a stereo source is down-mixed).
  try { destination.channelCount = 1; destination.channelCountMode = "explicit"; destination.channelInterpretation = "speakers"; } catch (_) {}
  let source = null;
  let bound = null;
  // Sources connect to `entry`, so the leveler can be spliced in later without touching them.
  const entry = leveler && ctx.audioWorklet?.addModule && ctx.createGain ? ctx.createGain() : null;
  const sink = entry || destination;
  if (entry) entry.connect(destination);
  let levelNode = null, latestLevel = null, finalWaiters = [];
  const handle = {
    kind: "webaudio",
    track: destination.stream.getAudioTracks()[0] || null,
    swaps: 0,
    leveler: { applied: false, reason: entry ? "loading" : (leveler ? "audio-worklet-unavailable" : "disabled") },
    // Live figures from the audio thread (about once a second), or null before the leveler is running.
    levelStats() { return latestLevel; },
    // Final figures including integrated loudness of what was recorded; resolves null if the leveler is not running.
    finalStats() {
      if (!levelNode) return Promise.resolve(null);
      return new Promise((resolve) => { finalWaiters.push(resolve); try { levelNode.port.postMessage({ type: "final" }); } catch (_) { resolve(null); } setTimeout(() => resolve(null), 1500); });
    },
    bind() {
      const current = getMicTrack?.() || null;
      if (current === bound) return;
      try { source?.disconnect(); } catch (_) {}
      source = null;
      bound = current;
      if (current && current.readyState === "live") {
        source = ctx.createMediaStreamSource(new MediaStream([current]));
        source.connect(sink);
        handle.swaps += 1;
      }
    },
    dispose() {
      handle.disposed = true;
      try { source?.disconnect(); } catch (_) {}
      try { destination.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { ctx.close?.(); } catch (_) {}
    }
  };
  void ctx.resume?.().catch?.(() => {});
  handle.bind();
  if (entry) {
    // Splice the leveler in once the worklet module has loaded; until then (and if it never does) audio flows straight through.
    ctx.audioWorklet.addModule(workletUrl).then(() => {
      if (handle.disposed) return;
      const node = new AudioWorkletNode(ctx, "toasty-safety-limiter", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
        processorOptions: { channels: 1, leveler: true, ceilingDb: -2, lookaheadMs: 5 }
      });
      node.port.onmessage = (event) => {
        const d = event.data;
        if (d?.type === "stats" && d.level) { latestLevel = d.level; onLevelStats?.(d.level); }
        else if (d?.type === "final") { const w = finalWaiters; finalWaiters = []; w.forEach((r) => r(d)); }
      };
      // If the audio thread ever reports a processor error, go back to the straight connection: a recording must never go silent.
      const bypass = (reason) => { try { entry.disconnect(); entry.connect(destination); } catch (_) {} levelNode = null; handle.leveler = { applied: false, reason }; };
      node.onprocessorerror = () => bypass("processor-error");
      const prior = node.port.onmessage;
      node.port.onmessage = (event) => { if (event.data?.type === "error") bypass(`processor-error: ${event.data.message}`); else prior?.(event); };
      entry.disconnect(); entry.connect(node); node.connect(destination);
      levelNode = node;
      handle.leveler = { applied: true, reason: "", targetDb: -30, maxBoostDb: 30, ceilingDb: -2 };
    }).catch((error) => { handle.leveler = { applied: false, reason: `failed: ${error?.message || error}` }; });
  }
  return handle;
}
