#!/usr/bin/env node
import { ClipMixer } from "../js/clip-mixer.js";
import { analyzeChannels, toDbfs } from "../js/audio-analysis.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const SR = 48000, dB = (x) => 10 ** (x / 20);
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const rand = lcg(5);
const voice = (seconds, level, { gap = null } = {}) => { const o = new Float32Array(SR * seconds); for (let i = 0; i < o.length; i++) { const t = i / SR; if (gap && t >= gap[0] && t < gap[1]) { o[i] = (rand() * 2 - 1) * dB(-70); continue; } o[i] = level * Math.sin(2 * Math.PI * 190 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3.4 * t)) + (rand() * 2 - 1) * dB(-66); } return o; };
const music = (seconds, level) => Float32Array.from({ length: SR * seconds }, (_, i) => level * (Math.sin(2 * Math.PI * 330 * i / SR) + 0.6 * Math.sin(2 * Math.PI * 495 * i / SR)));
const run = (mixer, v, m) => { const n = v.length, out = [new Float32Array(n), new Float32Array(n)]; for (let i = 0; i < n; i += 128) { const e = Math.min(n, i + 128); mixer.process([v.subarray(i, e)], [m.subarray(i, e)], [out[0].subarray(i, e), out[1].subarray(i, e)]); } return out; };
const rmsDb = (x, a, b) => { let s = 0; for (let i = a * SR; i < b * SR; i++) s += x[i] * x[i]; return 10 * Math.log10(s / ((b - a) * SR) + 1e-18); };

console.log("\nVoice leveler (enhancement)");
{
  const quiet = voice(30, dB(-26)), mixer = new ClipMixer(SR, { enhance: true, musicGainDb: -200 });
  const out = run(mixer, quiet, new Float32Array(quiet.length));
  const before = rmsDb(quiet, 20, 28), after = rmsDb(out[0], 20, 28);
  ok(after - before > 6 && Math.abs(after - -20) < 2.5, `quiet speech is brought up to a steady level (${before.toFixed(1)} -> ${after.toFixed(1)} dBFS RMS, target -20)`);
  const loud = voice(30, dB(-8)), l = run(new ClipMixer(SR, { enhance: true, musicGainDb: -200 }), loud, new Float32Array(loud.length));
  ok(rmsDb(l[0], 20, 28) < rmsDb(loud, 20, 28) - 3, "loud speech is brought down toward the same level");
  let peak = 0; for (const x of l[0]) peak = Math.max(peak, Math.abs(x)); ok(peak <= dB(-3) + 1e-6, `and never exceeds the -3 dBFS ceiling (peak ${toDbfs(peak).toFixed(2)})`);
  const noise = Float32Array.from({ length: SR * 10 }, () => (rand() * 2 - 1) * dB(-62)), n = run(new ClipMixer(SR, { enhance: true, musicGainDb: -200 }), noise, new Float32Array(noise.length));
  ok(rmsDb(n[0], 4, 10) < -55, `room noise is not boosted (${rmsDb(n[0], 4, 10).toFixed(1)} dBFS out)`);
  const mixer2 = new ClipMixer(SR, { enhance: true, musicGainDb: -200 }), withPause = voice(30, dB(-26), { gap: [10, 16] }), o2 = run(mixer2, withPause, new Float32Array(withPause.length));
  ok(Math.abs(rmsDb(o2[0], 24, 29) - rmsDb(o2[0], 6, 9)) < 3, "the level after a pause matches the level before it (gain held through silence)");
  const off = new ClipMixer(SR, { enhance: false, musicGainDb: -200 }), x = voice(5, dB(-18)), y = run(off, x, new Float32Array(x.length));
  let maxDiff = 0; for (let i = 480; i < x.length - 480; i++) maxDiff = Math.max(maxDiff, Math.abs(y[0][i + off.latencySamples] - x[i])); ok(maxDiff < 1e-6, "with enhancement off the voice passes through unchanged (only the 5 ms look-ahead delay)");
}

console.log("\nMusic ducking");
{
  const v = new Float32Array(SR * 20), segs = [[2, 8], [12, 18]];
  const sp = voice(20, dB(-22)); for (const [a, b] of segs) for (let i = a * SR; i < b * SR; i++) v[i] = sp[i];
  const m = music(20, dB(-12)), mix = new ClipMixer(SR, { enhance: false, musicGainDb: -14, duckDb: -14 });
  const out = run(mix, v, m);
  // Compare the music-only portion (no voice) with the portion under voice using a music-only run for reference.
  const ref = run(new ClipMixer(SR, { enhance: false, musicGainDb: -14, duckDb: -14 }), new Float32Array(SR * 20), m);
  const free = rmsDb(ref[0], 9, 11), ducked = (() => { const o = out[0].map((x, i) => x - (v[i - 240] || 0)); return rmsDb(o, 4, 7); })();
  ok(free - ducked > 10, `music under speech is ${(free - ducked).toFixed(1)} dB quieter than the same music in the gaps`);
  const recovered = rmsDb(out[0], 10.5, 11.8); ok(Math.abs(recovered - free) < 1.5, "music is back to full level within about 2 s of the speech ending");
  ok(mix.minDuckDb < -12, `the mixer reports how far it ducked (${mix.minDuckDb.toFixed(1)} dB)`);
  const boosted = new ClipMixer(SR, { enhance: false, musicGainDb: -20, duckDb: -14 }); boosted.setMusicBoost(6);
  const b = run(boosted, new Float32Array(SR * 4), music(4, dB(-12))); ok(Math.abs(rmsDb(b[0], 1, 3) - rmsDb(run(new ClipMixer(SR, { enhance: false, musicGainDb: -20 }), new Float32Array(SR * 4), music(4, dB(-12)))[0], 1, 3) - 6) < 0.5, "intro and outro can lift the music by a set amount");
}

console.log("\nNothing clips");
{
  const v = voice(10, dB(-3)), m = music(10, dB(-3)), out = run(new ClipMixer(SR, { enhance: false, musicGainDb: -3, duckDb: -3 }), v, m);
  const a = analyzeChannels([out[0].subarray(1000)], SR);
  ok(a.clippedSamples === 0 && a.peakDbfs <= -2.9, `loud voice plus loud music stays under the ceiling (peak ${a.peakDbfs} dBFS)`);
}
console.log("ALL PASSED — the clip mixer levels the voice, ducks the music under it and never clips.");
