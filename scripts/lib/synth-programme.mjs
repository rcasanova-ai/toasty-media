// Deterministic speech-like test programme for audio pipeline tests (no external assets, no network, no `say`).
// Two "voices" with different pitch and formants speak in syllable bursts; the programme includes a quiet speaker,
// a sudden loud burst (laughter / a bump), overlapping speech, pauses, and a low room-noise floor. It is not speech,
// but it exercises the same things: harmonic structure, syllabic envelope, dynamics, simultaneous talkers.
const SR = 48000;

function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

function voice(seconds, { f0, formants, level, seed, vibrato = 4 }) {
  const rand = lcg(seed), n = Math.round(seconds * SR), out = new Float32Array(n);
  let phase = 0, t = 0;
  // syllable envelope: 3-5 syllables per second with random length and pitch inflection
  const syll = [];
  for (let at = 0; at < seconds;) { const len = 0.12 + rand() * 0.18, gap = 0.02 + rand() * 0.08; syll.push({ at, len, pitch: 0.9 + rand() * 0.25 }); at += len + gap; if (rand() < 0.15) at += 0.25; }
  let si = 0;
  for (let i = 0; i < n; i++) {
    t = i / SR;
    while (si < syll.length - 1 && t > syll[si].at + syll[si].len) si++;
    const s = syll[si], x = (t - s.at) / s.len;
    const env = x >= 0 && x <= 1 ? Math.sin(Math.PI * x) ** 0.6 : 0;
    if (!env) continue;
    const f = f0 * s.pitch * (1 + 0.01 * Math.sin(2 * Math.PI * vibrato * t));
    phase += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f < 5000; h++) {
      let g = 1 / h;
      for (const [fc, bw, gain] of formants) g += gain * Math.exp(-(((h * f - fc) / bw) ** 2));
      v += g * Math.sin(h * phase);
    }
    out[i] = level * env * v * 0.18 + (rand() - 0.5) * level * env * 0.02; // breathiness
  }
  return out;
}

const dbToLin = (db) => 10 ** (db / 20);

export function synthProgramme({ seconds = 36 } = {}) {
  const n = Math.round(SR * seconds);
  const host = new Float32Array(n), guest = new Float32Array(n);
  const rand = lcg(7);
  const add = (target, buf, atSec) => { const o = Math.round(atSec * SR); for (let i = 0; i < buf.length && o + i < n; i++) target[o + i] += buf[i]; };
  const A = { f0: 210, formants: [[700, 130, 5], [1700, 200, 3], [2800, 250, 2]], seed: 11 };
  const B = { f0: 120, formants: [[500, 110, 6], [1400, 180, 3], [2500, 220, 2]], seed: 23 };
  add(host, voice(6, { ...A, level: dbToLin(-20) }), 0.5);            // host speaks, normal level
  add(guest, voice(6, { ...B, level: dbToLin(-22) }), 7.5);           // guest answers, normal level
  const laughStart = 14.5;                                            // sudden burst: laughter / a bump, much louder than speech
  const laugh = new Float32Array(Math.round(0.6 * SR));
  for (let i = 0; i < laugh.length; i++) { const t = i / laugh.length; laugh[i] = (rand() * 2 - 1) * dbToLin(-4) * Math.sin(Math.PI * t) ** 2 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 7 * t * 0.6)); }
  add(host, laugh, laughStart);
  add(host, voice(5, { ...A, level: dbToLin(-21), seed: 31 }), 16);  // host again
  add(guest, voice(5, { ...B, level: dbToLin(-40), seed: 41 }), 22);  // QUIET speaker
  add(guest, voice(4, { ...B, level: dbToLin(-21), seed: 51 }), 27.5); // overlap: both talk at once
  add(host, voice(4, { ...A, level: dbToLin(-22), seed: 61 }), 28);
  // each microphone has its own room-noise floor ~ -58 dBFS so silence is not digital zero (as a real room is)
  const floorH = lcg(101), floorG = lcg(202);
  for (let i = 0; i < n; i++) { host[i] += (floorH() * 2 - 1) * dbToLin(-58); guest[i] += (floorG() * 2 - 1) * dbToLin(-58); }
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = host[i] + guest[i];
  return { samples, host, guest, sampleRate: SR, events: { laughStart, quietStart: 22, overlapStart: 28 } };
}

export function wavBytes(samples, sampleRate = SR) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}
