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
// Falls back to a plain clone of the mic track where Web Audio is unavailable (the old behaviour), which is fine for
// a recording that never changes microphones.
export function createStableMicTrack({ getMicTrack, AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext, latencyHint = 0 } = {}) {
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
  const handle = {
    kind: "webaudio",
    track: destination.stream.getAudioTracks()[0] || null,
    swaps: 0,
    bind() {
      const current = getMicTrack?.() || null;
      if (current === bound) return;
      try { source?.disconnect(); } catch (_) {}
      source = null;
      bound = current;
      if (current && current.readyState === "live") {
        source = ctx.createMediaStreamSource(new MediaStream([current]));
        source.connect(destination);
        handle.swaps += 1;
      }
    },
    dispose() {
      try { source?.disconnect(); } catch (_) {}
      try { destination.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { ctx.close?.(); } catch (_) {}
    }
  };
  void ctx.resume?.().catch?.(() => {});
  handle.bind();
  return handle;
}
