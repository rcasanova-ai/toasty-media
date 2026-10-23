// Safety net for a recording whose microphone level is too low, plus the live loudness figures that show it.
//
// A browser microphone with auto gain off delivers whatever level the operating system's input volume and the device give it.
// A take recorded that way at -45 LUFS is unusable and cannot be rescued cleanly afterwards beyond what a gain can do, so the
// recorder lifts a quiet voice while it is being recorded:
//   - BOOST ONLY. A voice already at a normal level is not touched (gain stays 0 dB); nothing is ever turned down.
//   - It steers speech toward a 400 ms RMS of -30 dBFS (about -23 LUFS, the raw level of a healthy microphone), by at most +30 dB,
//     and only while somebody is talking (js/speech-dynamics.js), so pauses are not ridden up.
//   - The look-ahead limiter (js/streaming-limiter.js) follows, so a boosted voice cannot clip when someone laughs or leans in.
// Exports finish the job: Toasty Clips measures the recording and brings it to -16 LUFS (js/clip-loudness.js).
//
// It also keeps the numbers needed to say so: how long the voice was quiet, how much gain was applied, how long the line was dead.
// Turn it off with localStorage["toasty.recording.leveler"] = "off".
import { LoudnessMeter } from "./audio-analysis.js";
import { dbOf, SpeechLeveler } from "./speech-dynamics.js";
import { StreamingLimiter } from "./streaming-limiter.js";

export const LEVELER_STORAGE_KEY = "toasty.recording.leveler";
export const QUIET_INPUT_DB = -38;      // speech with a 400 ms RMS below this is "quiet": a healthy microphone sits near -24 to -18
export const DEAD_INPUT_DB = -80;       // below this the line is effectively dead (muted, unplugged, wrong device)

export function levelerEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem?.(LEVELER_STORAGE_KEY) !== "off"; } catch (_) { return true; }
}

export class RecordingLeveler {
  constructor(sampleRate, channels = 1, { enabled = true, targetDb = -30, maxBoostDb = 30, ceilingDb = -2, lookaheadMs = 5, releaseMs = 80, measure = true } = {}) {
    this.sampleRate = sampleRate; this.channels = channels; this.enabled = enabled;
    this.leveler = enabled ? new SpeechLeveler(sampleRate, { targetDb, maxBoostDb, maxCutDb: 0, upDbPerSec: 3, downDbPerSec: 6, fastSeconds: 6, fastUpDbPerSec: 10 }) : null;
    this.limiter = new StreamingLimiter(sampleRate, channels, { ceilingDb, lookaheadMs, releaseMs, truePeak: true });
    this.meter = measure ? new LoudnessMeter(sampleRate, channels) : null;
    this.stage = Array.from({ length: channels }, () => new Float32Array(128));
    this.zero = new Float32Array(128);
    this.inputMs = null;            // 400 ms input power, for the quiet/dead figures
    this.seconds = 0; this.quietSpeechSeconds = 0; this.deadSeconds = 0; this.currentDeadSeconds = 0; this.longestDeadSeconds = 0;
    this.peakIn = 0;
  }

  get latencySamples() { return this.limiter.latencySamples; }

  // ins/outs: arrays of Float32Array per channel (a worklet block). outs may alias ins.
  process(ins, outs) {
    const n = outs[0].length, ch = this.channels, dt = n / this.sampleRate;
    if (this.stage[0].length < n) this.stage = this.stage.map(() => new Float32Array(n));
    const src = [];
    for (let c = 0; c < ch; c++) src.push((ins[c] || ins[0] || this.zero).subarray(0, n));
    let e = 0;
    for (let c = 0; c < ch; c++) { const a = src[c]; for (let i = 0; i < n; i++) { const v = a[i]; e += v * v; const m = v < 0 ? -v : v; if (m > this.peakIn) this.peakIn = m; } }
    const a4 = Math.exp(-dt / 0.4);
    this.inputMs = this.inputMs === null ? e / (n * ch) : a4 * this.inputMs + (1 - a4) * e / (n * ch);
    const inDb = 10 * Math.log10(this.inputMs + 1e-24);
    this.seconds += dt;
    if (inDb < DEAD_INPUT_DB) { this.deadSeconds += dt; this.currentDeadSeconds += dt; this.longestDeadSeconds = Math.max(this.longestDeadSeconds, this.currentDeadSeconds); } else this.currentDeadSeconds = 0;
    let work = src;
    if (this.leveler) {
      const stage = this.stage.map((b) => b.subarray(0, n));
      this.leveler.processBlock(src, stage);
      if (this.leveler.speaking && inDb < QUIET_INPUT_DB) this.quietSpeechSeconds += dt;
      work = stage;
    }
    this.limiter.process(work, outs.map((o) => o.subarray(0, n)));
    if (this.meter) this.meter.push(outs.map((o) => o.subarray(0, n)));
  }

  // Cheap figures, safe to ask for every second.
  stats() {
    const lv = this.leveler;
    return {
      seconds: this.seconds,
      enabled: this.enabled,
      inputLevelDb: this.inputMs === null ? null : 10 * Math.log10(this.inputMs + 1e-24),
      inputPeakDbfs: dbOf(this.peakIn),
      gainDb: lv ? lv.gainDb : 0,
      maxGainDb: lv ? lv.stats.maxGainDb : 0,
      averageSpeechGainDb: lv ? lv.averageSpeechGainDb : 0,
      speechSeconds: lv ? lv.stats.speechSeconds : 0,
      quietSpeechSeconds: this.quietSpeechSeconds,
      deadSeconds: this.deadSeconds,
      currentDeadSeconds: this.currentDeadSeconds,
      longestDeadSeconds: this.longestDeadSeconds,
      limiterMaxReductionDb: this.limiter.maxReductionDb,
      limiterActiveSeconds: this.limiter.activeSamples / this.sampleRate
    };
  }

  // Heavier: BS.1770 integrated loudness of what was recorded (after the leveler and limiter). Ask once, at the end.
  finalStats() {
    const r = this.meter?.result();
    return { ...this.stats(), integratedLufs: r && Number.isFinite(r.integratedLufs) ? r.integratedLufs : null, loudnessRangeLu: r ? r.loudnessRangeLu : null };
  }
}

// Plain-language verdict for the Studio from stats(): what to tell the host while recording or after.
export function levelAdvice(s) {
  if (!s || !(s.seconds > 3)) return null;
  if (s.longestDeadSeconds >= 10 || (s.seconds > 15 && s.deadSeconds / s.seconds > 0.9)) {
    return { state: "silent", message: "The microphone is silent. Check that it is not muted and that the right input is selected." };
  }
  if (s.quietSpeechSeconds >= 5) {
    return { state: "quiet", message: `Your microphone is very quiet (${Math.round(s.inputLevelDb)} dBFS). Studio is raising it${s.maxGainDb >= 3 ? ` by ${Math.round(s.maxGainDb)} dB` : ""}, but raise the input volume in your system sound settings or move closer for a cleaner recording.` };
  }
  return null;
}
