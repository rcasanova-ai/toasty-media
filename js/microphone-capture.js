export const CLEAN_MIC_TARGET = Object.freeze({
  channelCount: 1,
  sampleRate: 48000,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false
});

export function cleanMicAudioConstraint(deviceId = "") {
  const audio = {
    echoCancellation: CLEAN_MIC_TARGET.echoCancellation,
    noiseSuppression: CLEAN_MIC_TARGET.noiseSuppression,
    autoGainControl: CLEAN_MIC_TARGET.autoGainControl,
    channelCount: { ideal: CLEAN_MIC_TARGET.channelCount },
    sampleRate: { ideal: CLEAN_MIC_TARGET.sampleRate }
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

export function cleanMicSettings(track) {
  const settings = track?.getSettings?.() || {};
  return {
    label: track?.label || "",
    sampleRate: settings.sampleRate ?? null,
    channelCount: settings.channelCount ?? null,
    echoCancellation: settings.echoCancellation ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
    autoGainControl: settings.autoGainControl ?? null,
    latency: settings.latency ?? null
  };
}

export function createMicMeter(stream, {
  label = "clean-mic",
  intervalMs = 250,
  onSample,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext
} = {}) {
  const audioTracks = stream?.getAudioTracks?.() || [];
  if (!AudioContextImpl || !audioTracks.length) {
    return { label, supported: false, stop() {}, sample: null };
  }

  const ctx = new AudioContextImpl();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  void ctx.resume?.().catch?.(() => {});

  const frame = new Float32Array(analyser.fftSize);
  let stopped = false;
  let latest = null;
  let timer = null;

  const read = () => {
    analyser.getFloatTimeDomainData(frame);
    let sumSquares = 0;
    let peak = 0;
    for (const value of frame) {
      const abs = Math.abs(value);
      peak = Math.max(peak, abs);
      sumSquares += value * value;
    }
    const rms = Math.sqrt(sumSquares / frame.length);
    latest = {
      label,
      rms,
      peak,
      rmsDbfs: amplitudeToDbfs(rms),
      peakDbfs: amplitudeToDbfs(peak),
      measuredAt: Date.now(),
      target: {
        averageDbfs: [-18, -12],
        peakDbfs: [-9, -6]
      }
    };
    onSample?.(latest);
    return latest;
  };

  timer = globalThis.setInterval?.(() => {
    if (!stopped) read();
  }, intervalMs);

  return {
    label,
    supported: true,
    get sample() { return latest; },
    sampleNow: read,
    stop() {
      stopped = true;
      if (timer) globalThis.clearInterval?.(timer);
      try { source.disconnect(); } catch (_) {}
      try { analyser.disconnect(); } catch (_) {}
      try { ctx.close?.(); } catch (_) {}
    }
  };
}

export function createCleanMicMeterPair(stream, { onSample, intervalMs } = {}) {
  return {
    // There is intentionally no Toasty DSP between these points. Both meters inspect the same canonical
    // clean mic stream so device/constraint changes can prove the signal is not being compressed,
    // normalized, channel-expanded, or gain-staged on the way to WebRTC/recording.
    pre: createMicMeter(stream, { label: "clean-mic-pre", intervalMs, onSample }),
    post: createMicMeter(stream, { label: "clean-mic-post", intervalMs, onSample })
  };
}

function amplitudeToDbfs(value) {
  if (!Number.isFinite(value) || value <= 0) return -Infinity;
  return Math.max(-120, 20 * Math.log10(value));
}
