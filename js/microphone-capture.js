export const CLEAN_MIC_TARGET = Object.freeze({
  channelCount: 1,
  sampleRate: 48000,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false
});

// Mic processing is a per-person choice, not a global constant. Echo cancellation must stay ON when the person
// listens on speakers (the mic hears the room and the guests come back to them as echo); it is only worth turning
// off for headphones or a deliberate raw studio capture. AGC is never on by default: it pumps levels and fights
// the loudness work done at export.
export const MIC_PROCESSING_STORAGE_KEY = "toasty.mic.processing";
export const MIC_PROCESSING_PRESETS = Object.freeze({
  speakers: Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: false }),
  headphones: Object.freeze({ echoCancellation: false, noiseSuppression: true, autoGainControl: false }),
  studio: Object.freeze({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })
});
export const DEFAULT_MIC_PROCESSING_PRESET = "speakers";

export function normalizeMicProcessing(value) {
  if (typeof value === "string") return { preset: MIC_PROCESSING_PRESETS[value] ? value : DEFAULT_MIC_PROCESSING_PRESET, ...MIC_PROCESSING_PRESETS[MIC_PROCESSING_PRESETS[value] ? value : DEFAULT_MIC_PROCESSING_PRESET] };
  const base = MIC_PROCESSING_PRESETS[DEFAULT_MIC_PROCESSING_PRESET];
  const pick = (key) => (typeof value?.[key] === "boolean" ? value[key] : base[key]);
  const flags = { echoCancellation: pick("echoCancellation"), noiseSuppression: pick("noiseSuppression"), autoGainControl: pick("autoGainControl") };
  const preset = Object.keys(MIC_PROCESSING_PRESETS).find((name) => Object.entries(flags).every(([k, v]) => MIC_PROCESSING_PRESETS[name][k] === v)) || "custom";
  return { preset, ...flags };
}

export function readMicProcessing(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(MIC_PROCESSING_STORAGE_KEY);
    if (!raw) return normalizeMicProcessing(DEFAULT_MIC_PROCESSING_PRESET);
    return normalizeMicProcessing(raw.startsWith("{") ? JSON.parse(raw) : raw);
  } catch (_) {
    return normalizeMicProcessing(DEFAULT_MIC_PROCESSING_PRESET);
  }
}

export function writeMicProcessing(value, storage = globalThis.localStorage) {
  const normalized = normalizeMicProcessing(value);
  try { storage?.setItem?.(MIC_PROCESSING_STORAGE_KEY, normalized.preset === "custom" ? JSON.stringify(normalized) : normalized.preset); } catch (_) {}
  return normalized;
}

export function cleanMicAudioConstraint(deviceId = "", processing = readMicProcessing()) {
  const p = normalizeMicProcessing(processing);
  const audio = {
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
    channelCount: { ideal: CLEAN_MIC_TARGET.channelCount },
    sampleRate: { ideal: CLEAN_MIC_TARGET.sampleRate }
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

// VDO.Ninja's `proaudio` switch forces echoCancellation, noiseSuppression and autoGainControl to false INSIDE the
// iframe that really captures and publishes the voice (vdo.ninja main.js: stereo 1/3/4/5 -> all three false), no
// matter what Toasty's own getUserMedia asked for. The explicit &aec/&denoise/&autogain params are VDO's documented
// override, applied after proaudio, so the settings chosen here are the ones the published voice actually gets.
export function vdoMicProcessingParams(processing = readMicProcessing()) {
  const p = normalizeMicProcessing(processing);
  return { aec: p.echoCancellation ? "1" : "0", denoise: p.noiseSuppression ? "1" : "0", autogain: p.autoGainControl ? "1" : "0" };
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

// Plain-language read-out of a meter sample for the pre-join level monitor. Thresholds come from CLEAN_MIC meter
// targets (speech average -18..-12 dBFS, peaks -9..-6 dBFS); clipping is anything within 0.5 dB of full scale.
export function classifyMicLevel(sample) {
  if (!sample || !Number.isFinite(sample.peakDbfs)) return { state: "silent", message: "No signal yet. Say something, or check that the right microphone is selected." };
  if (sample.peakDbfs >= -0.5) return { state: "clipping", message: "Clipping. Lower the microphone gain or move back from the mic." };
  if (sample.peakDbfs >= -3) return { state: "hot", message: "Very loud. Back off a little so peaks stay under -6 dBFS." };
  if (sample.peakDbfs < -40) return { state: "silent", message: "Almost no signal. Speak up or check the microphone." };
  if (sample.peakDbfs < -24) return { state: "quiet", message: "Quiet. Move closer or raise the microphone input level." };
  return { state: "good", message: "Good level." };
}
