// Sound accents, synthesized in the browser. No sample library and nothing to download or license: each accent is a few
// oscillators and a burst of filtered noise shaped by an envelope, rendered to a stereo buffer by OfflineAudioContext. Peak level
// of each accent is set by the plan (gainDb relative to full scale), and the mixer ducks this bus under the voice.
export const SFX_KINDS = Object.freeze(["whoosh", "impact", "boom", "pop", "tick", "swell"]);
const DURATION = { whoosh: 0.55, impact: 0.8, boom: 1.6, pop: 0.18, tick: 0.06, swell: 1.0 };
export const sfxDuration = (kind) => DURATION[kind] || 0.5;

const dbToLin = (db) => 10 ** (db / 20);

// The accents as plain data for tests: [{ t, kind, dur, peak }].
export function sfxSchedule(events) { return (events || []).map((e) => ({ t: e.t, kind: e.kind, dur: sfxDuration(e.kind), peak: dbToLin(e.gainDb) })); }

export async function renderSfx(events, seconds, { OfflineCtx = globalThis.OfflineAudioContext, sampleRate = 48000 } = {}) {
  if (!events?.length || !OfflineCtx) return null;
  const ctx = new OfflineCtx(2, Math.ceil(seconds * sampleRate), sampleRate), master = ctx.createGain(); master.connect(ctx.destination);
  const noise = ctx.createBuffer(1, sampleRate * 2, sampleRate), nd = noise.getChannelData(0); let seed = 987654321;
  for (let i = 0; i < nd.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; nd[i] = (seed / 2 ** 32) * 2 - 1; }
  const env = (g, t, a, d, peak) => { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  const noiseSrc = (t, d) => { const s = ctx.createBufferSource(); s.buffer = noise; s.start(t, 0, d + 0.05); return s; };
  for (const e of events) {
    const t = Math.max(0, e.t), peak = dbToLin(e.gainDb), dur = sfxDuration(e.kind);
    if (e.kind === "whoosh" || e.kind === "swell") {
      const s = noiseSrc(t, dur), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = "bandpass"; f.Q.value = e.kind === "swell" ? 0.8 : 1.4;
      f.frequency.setValueAtTime(e.kind === "swell" ? 200 : 350, t); f.frequency.exponentialRampToValueAtTime(e.kind === "swell" ? 1800 : 4200, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + dur * (e.kind === "swell" ? 0.8 : 0.45)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f).connect(g).connect(master);
    } else if (e.kind === "impact" || e.kind === "boom") {
      const o = ctx.createOscillator(), g = ctx.createGain(); const f0 = e.kind === "boom" ? 62 : 110, f1 = e.kind === "boom" ? 30 : 38;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.8); env(g, t, 0.004, dur, peak * 0.9); o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.1);
      const s = noiseSrc(t, 0.25), lp = ctx.createBiquadFilter(), ng = ctx.createGain(); lp.type = "lowpass"; lp.frequency.value = e.kind === "boom" ? 500 : 1800; env(ng, t, 0.002, e.kind === "boom" ? 0.6 : 0.16, peak * 0.55); s.connect(lp).connect(ng).connect(master);
    } else if (e.kind === "pop") {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o.frequency.setValueAtTime(820, t); o.frequency.exponentialRampToValueAtTime(260, t + 0.1); env(g, t, 0.002, 0.14, peak); o.connect(g).connect(master); o.start(t); o.stop(t + 0.25);
    } else {
      const s = noiseSrc(t, 0.06), hp = ctx.createBiquadFilter(), g = ctx.createGain(); hp.type = "highpass"; hp.frequency.value = 2500; env(g, t, 0.001, 0.04, peak * 0.7); s.connect(hp).connect(g).connect(master);
    }
  }
  return ctx.startRendering();
}
