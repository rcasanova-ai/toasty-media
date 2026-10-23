// Vocal behavior from the audio itself, judged against THIS recording's own baseline so a quiet conversation and a loud one
// are both analysed fairly: a rise is "louder than this speaker usually is", never "louder than some fixed dB".
// Measures: intensity, pitch (autocorrelation F0), pitch variation, speaking rate (syllable-like envelope peaks), pauses, and
// the existing laughter / overlap / loud-reaction detector (js/audio-events.js). Optional pitch-based turn estimate for
// uploads without speaker labels.
import { detectAudioEvents } from "../audio-events.js";

export const HOP = 0.05;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pctile = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const yieldNow = () => new Promise((r) => setTimeout(r, 0));
const semis = (hz) => 12 * Math.log2(hz / 100);

function f0Estimate(frame8k) {
  const n = frame8k.length; let r0 = 0;
  for (let i = 0; i < n; i++) r0 += frame8k[i] * frame8k[i];
  if (r0 < 1e-7) return 0;
  const minLag = 20, maxLag = 114;      // 400 Hz .. 70 Hz at 8 kHz
  const r = new Float32Array(maxLag + 2);
  let best = 0;
  for (let lag = minLag; lag <= maxLag + 1; lag++) { let s = 0; for (let i = 0; i + lag < n; i++) s += frame8k[i] * frame8k[i + lag]; r[lag] = s / r0; if (lag <= maxLag && r[lag] > best) best = r[lag]; }
  if (best < 0.45) return 0;
  for (let lag = minLag + 1; lag <= maxLag; lag++) if (r[lag] >= 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) return 8000 / lag;   // first strong peak avoids octave errors
  return 0;
}

// Returns { series, baseline, events, duration }. series: { hop, db, f0, active } at HOP seconds.
export async function analyzeVocal(pcm, sampleRate = 16000, { signal, onProgress, includeSoundEvents = true } = {}) {
  const duration = pcm.length / sampleRate, hopN = Math.round(sampleRate * HOP), frames = Math.floor(pcm.length / hopN);
  const db = new Float32Array(frames), f0 = new Float32Array(frames), pitchWin = Math.round(sampleRate * 0.04);
  const block = Math.max(1, Math.round(20 / HOP));
  for (let b = 0; b < frames; b += block) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    for (let k = b; k < Math.min(frames, b + block); k++) {
      let s = 0; const o = k * hopN;
      for (let i = 0; i < hopN; i++) { const v = pcm[o + i]; s += v * v; }
      db[k] = 20 * Math.log10(Math.sqrt(s / hopN) + 1e-9);
    }
    onProgress?.(Math.min(0.5, (b / frames) * 0.5));
    await yieldNow();
  }
  const floor = pctile(Array.from(db), 0.1), peak = pctile(Array.from(db), 0.95);
  const thr = Math.max(floor + 6, peak - 28);
  const active = new Uint8Array(frames);
  for (let k = 0; k < frames; k++) active[k] = db[k] > thr ? 1 : 0;
  // Pitch every second hop on active frames only (keeps long recordings cheap).
  const tmp = new Float32Array(pitchWin >> 1);
  for (let b = 0; b < frames; b += block) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    for (let k = b; k < Math.min(frames, b + block); k += 2) {
      if (!active[k]) continue;
      const o = k * hopN; if (o + pitchWin > pcm.length) break;
      for (let i = 0; i < tmp.length; i++) tmp[i] = (pcm[o + 2 * i] + pcm[o + 2 * i + 1]) * 0.5;
      const v = f0Estimate(tmp); f0[k] = v; if (k + 1 < frames) f0[k + 1] = v;
    }
    onProgress?.(0.5 + Math.min(0.4, (b / frames) * 0.4));
    await yieldNow();
  }

  const activeDb = []; for (let k = 0; k < frames; k++) if (active[k]) activeDb.push(db[k]);
  // Speaking level of a span: the 75th percentile of its frames, so the dips between syllables do not drag it down and the
  // quiet end of a recording is not flattered by the activity threshold.
  const perSec0 = Math.round(1 / HOP);
  const level = (a, b) => {
    a = Math.max(0, a); b = Math.min(frames, b); let act = 0; const v = [];
    for (let k = a; k < b; k++) { v.push(db[k]); if (active[k]) act++; }
    if (act < 0.25 * (b - a) || !v.length) return null;
    v.sort((x, y) => x - y); return v[Math.floor(v.length * 0.75)];
  };
  const levels = []; for (let k = 0; k + 2 * perSec0 <= frames; k += perSec0) { const l = level(k, k + 2 * perSec0); if (l != null) levels.push(l); }
  const medDb = median(levels), madDb = Math.max(1.5, 1.4826 * median(levels.map((v) => Math.abs(v - medDb))));
  const voiced = []; for (let k = 0; k < frames; k++) if (f0[k] > 0) voiced.push(semis(f0[k]));
  const baseline = { floorDb: floor, activeThresholdDb: thr, medianDb: medDb, spreadDb: madDb, medianF0: voiced.length ? 100 * 2 ** (median(voiced) / 12) : 0, voicedFrames: voiced.length, activeFraction: frames ? activeDb.length / frames : 0 };
  const series = { hop: HOP, db, f0, active };
  const events = [];
  const push = (type, t, end, strength, data) => events.push({ type, t: Math.round(t * 100) / 100, end: Math.round(end * 100) / 100, strength: clamp(strength), data });
  const perSec = Math.round(1 / HOP);

  // Intensity rise: 2 s of speaking louder than the preceding 8 s AND louder than this recording's usual level.
  const winN = 2 * perSec, prevN = 8 * perSec;
  const meanActive = level;
  const rises = [];
  for (let k = prevN; k + winN <= frames; k += perSec / 2) {
    const cur = meanActive(k, k + winN), before = meanActive(k - prevN, k);
    if (cur == null || before == null) continue;
    const delta = cur - before, z = (cur - medDb) / madDb;
    if (delta >= 3.5 && z >= 1.0) {
      const last = rises[rises.length - 1], t = k * HOP;
      if (last && t - last.t < 4) { if (delta > last.delta) Object.assign(last, { t, delta, above: cur - medDb }); } else rises.push({ t, delta, above: cur - medDb });
    }
  }
  for (const r of rises) push("intensity-rise", r.t, r.t + 3, (r.delta - 3) / 9, { deltaDb: Math.round(r.delta * 10) / 10, aboveUsualDb: Math.round(r.above * 10) / 10 });
  // Pitch variation: unusually wide pitch movement over 4 s, against this recording's distribution.
  const spans = [], sN = 4 * perSec;
  for (let k = 0; k + sN <= frames; k += perSec * 2) {
    const v = []; for (let j = k; j < k + sN; j++) if (f0[j] > 0) v.push(semis(f0[j]));
    if (v.length >= 20) { const m = v.reduce((a, b) => a + b, 0) / v.length; spans.push({ k, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) }); }
  }
  const sdThr = Math.max(1.5, pctile(spans.map((s) => s.sd), 0.8)), sdMed = median(spans.map((s) => s.sd));
  let lastP = -99;
  for (const s of spans) if (s.sd >= sdThr && s.k * HOP - lastP >= 6) { lastP = s.k * HOP; push("pitch-variation", s.k * HOP, s.k * HOP + 4, (s.sd - sdMed) / 4, { sdSemitones: Math.round(s.sd * 10) / 10, usualSemitones: Math.round(sdMed * 10) / 10 }); }
  // Pitch jump across a short gap (a reaction or a change in delivery).
  for (let k = 4; k < frames - 4; k++) {
    if (f0[k] > 0 && f0[k - 1] > 0 && f0[k - 2] === 0 && f0[k - 3] === 0) {
      const before = []; for (let j = k - 20; j < k - 3; j++) if (j >= 0 && f0[j] > 0) before.push(semis(f0[j]));
      const after = []; for (let j = k; j < k + 10; j++) if (f0[j] > 0) after.push(semis(f0[j]));
      if (before.length >= 6 && after.length >= 6) { const d = median(after) - median(before); if (Math.abs(d) >= 4.5 && k * HOP - (events.at(-1)?.t ?? -99) > 1) push("pitch-jump", k * HOP, k * HOP + 1, (Math.abs(d) - 3) / 6, { semitones: Math.round(d * 10) / 10 }); }
    }
  }
  // Speaking rate: envelope peaks per active second in 4 s windows, relative to the recording's median.
  const rates = [];
  for (let k = 0; k + sN <= frames; k += perSec * 2) {
    let peaks = 0, act = 0;
    for (let j = k + 1; j < k + sN - 1; j++) { if (active[j]) act++; if (active[j] && db[j] > db[j - 1] && db[j] >= db[j + 1] && db[j] - Math.min(db[j - 1], db[j + 1]) > 0.5) peaks++; }
    if (act >= sN * 0.4) rates.push({ k, rate: peaks / (act * HOP) });
  }
  const rateMed = median(rates.map((r) => r.rate));
  baseline.syllableRate = Math.round(rateMed * 100) / 100;
  let lastR = -99;
  for (const r of rates) {
    if (rateMed > 0 && r.k * HOP - lastR >= 8) {
      if (r.rate >= rateMed * 1.4 && r.rate - rateMed >= 1.0) { lastR = r.k * HOP; push("speech-faster", r.k * HOP, r.k * HOP + 4, (r.rate / rateMed - 1) / 0.8, { rate: Math.round(r.rate * 10) / 10, usual: Math.round(rateMed * 10) / 10 }); }
      else if (r.rate <= rateMed * 0.6 && rateMed - r.rate >= 1.0) { lastR = r.k * HOP; push("speech-slower", r.k * HOP, r.k * HOP + 4, (1 - r.rate / rateMed) / 0.6, { rate: Math.round(r.rate * 10) / 10, usual: Math.round(rateMed * 10) / 10 }); }
    }
  }
  // Pauses: gaps in speech of 0.8 s or more that sit between speech.
  for (let k = 0; k < frames;) {
    if (active[k]) { k++; continue; }
    let j = k; while (j < frames && !active[j]) j++;
    const dur = (j - k) * HOP;
    if (dur >= 0.8 && k > 0 && j < frames) {
      const meaningful = dur >= 1.2;
      push("pause", k * HOP, j * HOP, clamp((dur - 0.6) / 3), { duration: Math.round(dur * 10) / 10, meaningful });
    }
    k = j;
  }
  // Changes in conversational energy: ten seconds against the ten before, on a composite of level, rate and pitch movement.
  const comp = [];
  for (let k = 0; k + 10 * perSec <= frames; k += 5 * perSec) {
    const m = meanActive(k, k + 10 * perSec); if (m == null) { comp.push(null); continue; }
    const r = rates.find((x) => x.k >= k && x.k < k + 10 * perSec)?.rate ?? rateMed;
    comp.push((m - medDb) / madDb + (rateMed ? (r - rateMed) / Math.max(0.5, rateMed) : 0));
  }
  for (let i = 2; i < comp.length; i++) {
    if (comp[i] == null || comp[i - 2] == null) continue;
    const d = comp[i] - comp[i - 2];
    if (Math.abs(d) >= 1.6) push(d > 0 ? "energy-up" : "energy-down", (i) * 5, i * 5 + 10, Math.abs(d) / 4, { change: Math.round(d * 10) / 10 });
  }
  if (includeSoundEvents) {
    onProgress?.(0.95);
    for (const ev of detectAudioEvents(pcm, sampleRate)) {
      if (ev.type === "laughter") push("laughter", ev.t, ev.end ?? ev.t + 1.5, 0.45 + Math.min(0.45, ((ev.end ?? ev.t + 1.5) - ev.t) / 5), { duration: Math.round(((ev.end ?? ev.t + 1.5) - ev.t) * 10) / 10 });
      else if (ev.type === "spike") push("loud-reaction", ev.t, ev.end ?? ev.t + 1, 0.5, {});
      else if (ev.type === "overlap") push("overlap", ev.t, ev.end ?? ev.t + 2, 0.55, {});
    }
  }
  onProgress?.(1);
  return { series, baseline, events: events.sort((a, b) => a.t - b.t), duration };
}

// Stats for one span, for explanation and for turn estimation.
export function vocalStats(series, baseline, a, b) {
  const k0 = Math.max(0, Math.floor(a / series.hop)), k1 = Math.min(series.db.length, Math.ceil(b / series.hop));
  let s = 0, c = 0; const f = [];
  for (let k = k0; k < k1; k++) { if (series.active[k]) { s += series.db[k]; c++; } if (series.f0[k] > 0) f.push(semis(series.f0[k])); }
  return { activeFraction: k1 > k0 ? c / (k1 - k0) : 0, meanDb: c ? s / c : null, aboveUsualDb: c ? s / c - baseline.medianDb : 0, f0Semitones: f.length ? median(f) : null, voicedFrames: f.length };
}

// Pitch-based turn estimate for units with no speaker label: two clusters of median pitch at least 3 semitones apart.
// This groups voices by pitch; it does not identify anyone, and it is marked as an estimate.
export function estimateTurns(units, series, baseline) {
  if (units.some((u) => u.speaker)) return { applied: false, reason: "speaker labels were provided" };
  const st = units.map((u) => vocalStats(series, baseline, u.t, u.end));
  const pts = st.map((s, i) => ({ i, p: s.f0Semitones, ok: s.voicedFrames >= 8 })).filter((x) => x.ok);
  if (pts.length < 6) return { applied: false, reason: "not enough voiced speech to separate voices" };
  let lo = Math.min(...pts.map((x) => x.p)), hi = Math.max(...pts.map((x) => x.p));
  for (let it = 0; it < 12; it++) {
    const a = pts.filter((x) => Math.abs(x.p - lo) <= Math.abs(x.p - hi)), b = pts.filter((x) => Math.abs(x.p - lo) > Math.abs(x.p - hi));
    if (!a.length || !b.length) break;
    lo = a.reduce((s, x) => s + x.p, 0) / a.length; hi = b.reduce((s, x) => s + x.p, 0) / b.length;
  }
  const loN = pts.filter((x) => Math.abs(x.p - lo) <= Math.abs(x.p - hi)).length, hiN = pts.length - loN;
  if (Math.abs(hi - lo) < 3 || Math.min(loN, hiN) < pts.length * 0.15) return { applied: false, reason: "voices are not distinct enough in pitch" };
  let current = "Voice A";
  units.forEach((u, i) => { const s = st[i]; if (s.voicedFrames >= 8) current = Math.abs(s.f0Semitones - lo) <= Math.abs(s.f0Semitones - hi) ? "Voice A" : "Voice B"; u.speaker = current; u.speakerEstimated = true; });
  return { applied: true, separationSemitones: Math.round((hi - lo) * 10) / 10, voices: 2 };
}
