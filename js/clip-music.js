// Built-in background music, generated on the spot with Web Audio synthesis. There is no music library to license, nothing to
// download and nothing sent anywhere: each style is a small score (chords, bass, drums) rendered by OfflineAudioContext to
// exactly the length needed. Users can instead supply their own file (decoded locally).

const NOTE = (name) => { const m = /^([A-G])(#|b)?(\d)$/.exec(name); const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0); return 440 * 2 ** ((base + (Number(m[3]) + 1) * 12 - 69) / 12); };

export const MUSIC_STYLES = Object.freeze({
  upbeat: { bpm: 124, chords: [["C4", "E4", "G4"], ["A3", "C4", "E4"], ["F3", "A3", "C4"], ["G3", "B3", "D4"]], bass: ["C2", "A1", "F2", "G2"], drums: "four", lead: ["G4", "A4", "C5", "A4"] },
  chill: { bpm: 78, chords: [["D4", "F4", "A4", "C5"], ["G3", "B3", "D4", "F4"], ["C4", "E4", "G4", "B4"], ["A3", "C4", "E4", "G4"]], bass: ["D2", "G2", "C2", "A1"], drums: "lofi", lead: ["A4", "F4", "E4", "G4"] },
  cinematic: { bpm: 70, chords: [["A2", "E3", "A3", "C4"], ["F2", "C3", "F3", "A3"], ["C3", "G3", "C4", "E4"], ["G2", "D3", "G3", "B3"]], bass: ["A1", "F1", "C2", "G1"], drums: "timpani", lead: [] },
  tense: { bpm: 100, chords: [["A2", "C3", "E3"], ["A2", "C3", "Eb3"], ["F2", "A2", "C3"], ["E2", "G#2", "B2"]], bass: ["A1", "A1", "F1", "E1"], drums: "tick", lead: [] }
});

// The score as plain data (testable without audio): [{ t, kind, freq?, dur }] for `seconds` of music.
export function musicEvents(style, seconds) {
  const s = MUSIC_STYLES[style];
  if (!s) return [];
  const beat = 60 / s.bpm, bar = beat * 4, ev = [];
  for (let b = 0; b * bar < seconds; b++) {
    const t0 = b * bar, chord = s.chords[b % s.chords.length], bass = s.bass[b % s.bass.length];
    chord.forEach((n) => ev.push({ t: t0, kind: s.drums === "timpani" || style === "chill" ? "pad" : "stab", freq: NOTE(n), dur: bar * (s.drums === "four" ? 0.45 : 0.98) }));
    if (s.drums === "four") for (let k = 0; k < 8; k++) ev.push({ t: t0 + k * beat / 2, kind: "bass", freq: NOTE(bass), dur: beat * 0.42 });
    else ev.push({ t: t0, kind: "bass", freq: NOTE(bass), dur: bar * 0.96 });
    for (let k = 0; k < 4; k++) {
      const t = t0 + k * beat;
      if (s.drums === "four") { ev.push({ t, kind: "kick", dur: 0.25 }); ev.push({ t: t + beat / 2, kind: "hat", dur: 0.06 }); if (k % 2 === 1) ev.push({ t, kind: "snare", dur: 0.18 }); }
      if (s.drums === "lofi") { if (k === 0 || k === 2) ev.push({ t, kind: "kick", dur: 0.3 }); if (k === 1 || k === 3) ev.push({ t, kind: "snare", dur: 0.22 }); ev.push({ t: t + beat / 2, kind: "hat", dur: 0.05 }); }
      if (s.drums === "timpani" && k === 0 && b % 2 === 0) ev.push({ t, kind: "timpani", freq: NOTE(bass), dur: 1.2 });
      if (s.drums === "tick") { ev.push({ t, kind: "hat", dur: 0.04 }); ev.push({ t: t + beat / 2, kind: "hat", dur: 0.03 }); if (k === 0) ev.push({ t, kind: "kick", dur: 0.2 }); }
    }
    s.lead.forEach((n, k) => { if (style !== "chill" || b % 2 === 0) ev.push({ t: t0 + k * beat, kind: "lead", freq: NOTE(n), dur: beat * 0.7 }); });
  }
  return ev.filter((e) => e.t < seconds).sort((a, b) => a.t - b.t);
}

// Browser: render `seconds` of the style to a stereo AudioBuffer (48 kHz). Fades in over 0.3 s and out over 1 s.
export async function renderMusic(style, seconds, { OfflineCtx = globalThis.OfflineAudioContext, sampleRate = 48000 } = {}) {
  if (!MUSIC_STYLES[style] || !OfflineCtx) return null;
  const len = Math.ceil(seconds * sampleRate), ctx = new OfflineCtx(2, len, sampleRate);
  const master = ctx.createGain(); master.gain.setValueAtTime(0, 0); master.gain.linearRampToValueAtTime(0.9, 0.3); master.gain.setValueAtTime(0.9, Math.max(0.31, seconds - 1)); master.gain.linearRampToValueAtTime(0, seconds);
  master.connect(ctx.destination);
  const noise = ctx.createBuffer(1, sampleRate, sampleRate), nd = noise.getChannelData(0); let seed = 12345; for (let i = 0; i < nd.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; nd[i] = (seed / 2 ** 32) * 2 - 1; }
  const env = (g, t, a, d, peak) => { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  for (const e of musicEvents(style, seconds)) {
    const t = e.t;
    if (e.kind === "kick") { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); env(g, t, 0.004, 0.22, 0.9); o.connect(g).connect(master); o.start(t); o.stop(t + 0.3); }
    else if (e.kind === "snare" || e.kind === "hat") { const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noise; f.type = "highpass"; f.frequency.value = e.kind === "hat" ? 7000 : 1800; env(g, t, 0.002, e.dur, e.kind === "hat" ? 0.12 : 0.3); s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + e.dur + 0.05); }
    else if (e.kind === "bass") { const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter(); o.type = "sawtooth"; o.frequency.value = e.freq; f.type = "lowpass"; f.frequency.value = 420; env(g, t, 0.01, e.dur, 0.28); o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + e.dur + 0.1); }
    else if (e.kind === "stab" || e.kind === "pad") { const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter(); o.type = e.kind === "pad" ? "triangle" : "square"; o.frequency.value = e.freq; f.type = "lowpass"; f.frequency.value = e.kind === "pad" ? 1400 : 2400; const peak = e.kind === "pad" ? 0.06 : 0.04; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + (e.kind === "pad" ? 0.35 : 0.02)); g.gain.setValueAtTime(peak, t + Math.max(0.05, e.dur - 0.4)); g.gain.linearRampToValueAtTime(0.0001, t + e.dur); o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + e.dur + 0.05); }
    else if (e.kind === "lead") { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "triangle"; o.frequency.value = e.freq; env(g, t, 0.01, e.dur, 0.09); o.connect(g).connect(master); o.start(t); o.stop(t + e.dur + 0.05); }
    else if (e.kind === "timpani") { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(e.freq * 2, t); o.frequency.exponentialRampToValueAtTime(e.freq, t + 0.2); env(g, t, 0.005, e.dur, 0.7); o.connect(g).connect(master); o.start(t); o.stop(t + e.dur + 0.1); }
  }
  return ctx.startRendering();
}
