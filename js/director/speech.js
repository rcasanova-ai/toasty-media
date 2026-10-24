// Where is the person actually talking? A small, deterministic voice-activity detector over the decoded audio (16 kHz mono is
// plenty). It is used for dead-air removal, to place cuts in real pauses, and to spread transcript words over the stretches
// that are voiced instead of over silence. Pure: Float32Array in, plain regions out.

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

// Returns { regions: [{start,end}], floorDb, speechDb, thresholdDb, hop } in seconds. Adaptive: the threshold sits between this
// recording's own noise floor and its own speech level, so a quiet take and a loud take both work.
export function detectSpeechRegions(samples, sampleRate, { frameMs = 20, minSpeechMs = 140, mergeGapMs = 160, hangoverMs = 100 } = {}) {
  const hop = Math.max(1, Math.round(sampleRate * frameMs / 1000)), n = Math.floor(samples.length / hop);
  if (n < 5) return { regions: [], floorDb: -120, speechDb: -120, thresholdDb: -120, hop: frameMs / 1000 };
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) { let s = 0; const o = f * hop; for (let i = 0; i < hop; i++) { const x = samples[o + i]; s += x * x; } db[f] = 10 * Math.log10(s / hop + 1e-12); }
  const sorted = Array.from(db);
  const floorDb = pct(sorted, 0.1), speechDb = pct(sorted, 0.9);
  // Between floor and speech: 35 % of the way up, never closer than 8 dB to the floor and never above speech - 12 dB.
  const thresholdDb = Math.min(speechDb - 12, Math.max(floorDb + 8, floorDb + (speechDb - floorDb) * 0.35));
  if (speechDb - floorDb < 10) return { regions: n ? [{ start: 0, end: n * frameMs / 1000 }] : [], floorDb, speechDb, thresholdDb, hop: frameMs / 1000, flat: true };
  const hang = Math.round(hangoverMs / frameMs), minF = Math.round(minSpeechMs / frameMs), mergeF = Math.round(mergeGapMs / frameMs);
  let active = false, startF = 0, lastLoud = -999; const raw = [];
  for (let f = 0; f < n; f++) {
    if (db[f] >= thresholdDb) { if (!active) { active = true; startF = f; } lastLoud = f; }
    else if (active && f - lastLoud > hang) { raw.push([startF, lastLoud + 1]); active = false; }
  }
  if (active) raw.push([startF, lastLoud + 1]);
  const merged = [];
  for (const r of raw) { const last = merged[merged.length - 1]; if (last && r[0] - last[1] <= mergeF) last[1] = r[1]; else merged.push([...r]); }
  const regions = merged.filter((r) => r[1] - r[0] >= minF).map((r) => ({ start: r[0] * frameMs / 1000, end: r[1] * frameMs / 1000 }));
  return { regions, floorDb, speechDb, thresholdDb, hop: frameMs / 1000 };
}

// Regions clipped to [a, b].
export function regionsIn(regions, a, b) {
  const out = [];
  for (const r of regions || []) { const s = Math.max(a, r.start), e = Math.min(b, r.end); if (e > s) out.push({ start: s, end: e }); }
  return out;
}

export function totalSeconds(regions) { return (regions || []).reduce((s, r) => s + (r.end - r.start), 0); }
export const _stats = { median, pct };
