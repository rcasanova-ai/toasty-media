// Per-participant audio ACTIVITY metadata. Not Program Audio. Not STT.
//
// Hierarchy:
//   A. VDO/WebRTC participant-specific level events, when present
//   B. AnalyserNode on a microphone stream THIS browser already owns
//
// Presence carries ONLY { participantId, transportSourceId, audioLevel, speaking, measuredAt }.
// Raw PCM never leaves the page.

export const AUDIO_ACTIVITY_THRESHOLD = 0.22;

export function createAudioActivity({
  participantId,
  transportSourceId = null,
  audioLevel = 0,
  speaking = false,
  measuredAt = Date.now()
} = {}) {
  const level = clamp01(audioLevel);
  return {
    participantId: participantId || null,
    transportSourceId: transportSourceId || null,
    audioLevel: level,
    speaking: Boolean(speaking || level >= AUDIO_ACTIVITY_THRESHOLD),
    measuredAt: Number(measuredAt) || Date.now()
  };
}

export function serializeAudioActivity(sample) {
  if (!sample || typeof sample !== "object") return null;
  const participantId = sample.participantId || null;
  if (!participantId) return null;
  return createAudioActivity(sample);
}

export function activityFromVdoDetailedState(detailed, { participantId, transportSourceId } = {}) {
  const self = pickSelfEntry(detailed, transportSourceId);
  if (!self) return null;
  const raw = firstNumber([
    self.audioEnergy,
    self.audio_energy,
    self.audioLevel,
    self.audio_level,
    self.loudness,
    self.volume,
    self.audio
  ]);
  if (raw == null) return null;
  const audioLevel = normalizeVdoLevel(raw);
  return createAudioActivity({
    participantId,
    transportSourceId,
    audioLevel,
    speaking: Boolean(self.talking || self.speaking) || audioLevel >= AUDIO_ACTIVITY_THRESHOLD
  });
}

export function createAudioActivityMeter(stream, {
  participantId,
  transportSourceId = null,
  fftSize = 512,
  onSample = null,
  intervalMs = 80
} = {}) {
  const audioTrack = stream?.getAudioTracks?.().find((track) => track.readyState === "live") || null;
  if (!audioTrack || typeof window === "undefined") {
    return { stop() {}, sample: null, reason: audioTrack ? "no-window" : "no-audio-track" };
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return { stop() {}, sample: null, reason: "no-audio-context" };
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let timerId = null;
  let last = createAudioActivity({ participantId, transportSourceId, audioLevel: 0, speaking: false });

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const centered = (data[i] - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length);
    last = createAudioActivity({
      participantId,
      transportSourceId,
      audioLevel: Math.min(1, rms * 3.2),
      measuredAt: Date.now()
    });
    onSample?.(last);
  };

  tick();
  timerId = window.setInterval(tick, intervalMs);
  ctx.resume?.().catch(() => {});

  return {
    get sample() { return last; },
    reason: "",
    stop() {
      if (timerId) window.clearInterval(timerId);
      timerId = null;
      try { source.disconnect(); } catch (_) {}
      try { analyser.disconnect(); } catch (_) {}
      ctx.close?.().catch(() => {});
    }
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function firstNumber(values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeVdoLevel(raw) {
  if (raw > 1 && raw <= 100) return clamp01(raw / 100);
  if (raw > 100) return clamp01(raw / 32767);
  return clamp01(raw);
}

function pickSelfEntry(detailed, transportSourceId) {
  if (!detailed || typeof detailed !== "object") return null;
  if (detailed.audioEnergy != null || detailed.audioLevel != null || detailed.loudness != null) return detailed;
  const values = Array.isArray(detailed) ? detailed : Object.values(detailed);
  if (transportSourceId) {
    const match = values.find((entry) => entry && (entry.streamID === transportSourceId || entry.streamId === transportSourceId));
    if (match) return match;
  }
  return values.find((entry) => entry && (entry.local || entry.self || entry.audioEnergy != null)) || values[0] || null;
}
