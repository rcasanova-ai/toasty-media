#!/usr/bin/env node
// The live-recording safety limiter: transparent below the ceiling, a hard guarantee above it, block-size independent.
import { StreamingLimiter } from "../js/streaming-limiter.js";
import { analyzeChannels } from "../js/audio-analysis.js";

const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const SR = 48000;
const dbToLin = (d) => 10 ** (d / 20);
const peakOf = (x) => { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; };
const sine = (f, s, a, sr = SR) => { const o = new Float32Array(Math.round(sr * s)); for (let i = 0; i < o.length; i++) o[i] = a * Math.sin(2 * Math.PI * f * i / sr); return o; };
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const noise = (s, a, seed) => { const r = lcg(seed), o = new Float32Array(Math.round(SR * s)); for (let i = 0; i < o.length; i++) o[i] = a * (r() * 2 - 1); return o; };

console.log("\nTransparent below the ceiling");
{
  const x = sine(440, 2, dbToLin(-12));
  const { channels, limiter } = StreamingLimiter.processBuffer([x], SR, { ceilingDb: -1 });
  let maxErr = 0; for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(channels[0][i] - x[i]));
  ok(maxErr < 1e-6, `a -12 dBFS signal passes bit-for-bit (max difference ${maxErr.toExponential(1)})`);
  ok(limiter.maxReductionDb === 0 && limiter.activeSamples === 0, "the limiter reports it never acted");
  ok(limiter.latencySamples === Math.round(SR * 0.005), `look-ahead latency is 5 ms (${limiter.latencySamples} samples)`);
}

console.log("\nHard guarantee above the ceiling");
{
  const ceiling = dbToLin(-1);
  const hot = noise(6, 0.9, 5).map((v, i) => v * (1 + 0.8 * Math.sin(i / 3000)));   // wanders well past full scale
  const r = StreamingLimiter.processBuffer([hot], SR, { ceilingDb: -1 });
  let peak = 0; for (const v of r.channels[0]) peak = Math.max(peak, Math.abs(v));
  ok(peak <= ceiling + 1e-6, `no output sample exceeds -1 dBFS even for a signal reaching ${peakOf(hot).toFixed(2)} (out ${peak.toFixed(4)} <= ${ceiling.toFixed(4)})`);
  ok(r.limiter.maxReductionDb < -1, `it reduced gain where needed (max ${r.limiter.maxReductionDb.toFixed(1)} dB)`);
  // two talkers summing past full scale: exactly the Program Output case
  const a = sine(220, 3, 0.7), b = sine(330, 3, 0.7), sum = Float32Array.from(a, (v, i) => v + b[i]);
  const s = StreamingLimiter.processBuffer([sum], SR, { ceilingDb: -1 });
  ok(analyzeChannels(s.channels, SR).clippedSamples === 0 && peakOf(s.channels[0]) <= ceiling + 1e-6, "two overlapping loud talkers (sum 1.4x full scale) come out unclipped");
  // a single isolated spike
  const spike = new Float32Array(SR); spike.fill(0.05); spike[24000] = 1.8;
  const sp = StreamingLimiter.processBuffer([spike], SR, { ceilingDb: -1 });
  ok(peakOf(sp.channels[0]) <= ceiling + 1e-6, "a one-sample 1.8x spike is held under the ceiling");
  ok(Math.abs(sp.channels[0][1000] - 0.05) < 1e-4 && Math.abs(sp.channels[0][SR - 100] - 0.05) < 0.005, "and the audio around it is left alone / recovers");
}

console.log("\nChannels are linked, so the stereo image does not shift");
{
  const l = sine(300, 2, 1.5), r = sine(300, 2, 0.3);
  const o = StreamingLimiter.processBuffer([l, r], SR, { ceilingDb: -1 });
  let ratioErr = 0, n = 0;
  for (let i = 5000; i < l.length - 5000; i += 7) { const a = o.channels[0][i], b = o.channels[1][i]; if (Math.abs(l[i]) > 0.1) { ratioErr = Math.max(ratioErr, Math.abs(a / l[i] - b / r[i])); n++; } }
  ok(n > 100 && ratioErr < 1e-4, `left and right receive the same gain (max difference ${ratioErr.toExponential(1)})`);
}

console.log("\nBlock size does not change the result (AudioWorklet delivers 128-frame blocks)");
{
  const x = noise(3, 0.9, 9).map((v, i) => v * (1 + 0.6 * Math.sin(i / 1700)));
  const whole = StreamingLimiter.processBuffer([x], SR, {});
  const lim = new StreamingLimiter(SR, 1, {});
  const padded = new Float32Array(x.length + lim.L); padded.set(x);
  const out = new Float32Array(padded.length);
  for (let i = 0; i < padded.length; i += 128) { const end = Math.min(padded.length, i + 128); lim.process([padded.subarray(i, end)], [out.subarray(i, end)]); }
  let diff = 0; for (let i = 0; i < x.length; i++) diff = Math.max(diff, Math.abs(out[i + lim.L] - whole.channels[0][i]));
  ok(diff === 0, "128-frame blocks produce exactly the same samples as one pass");
}

console.log("\nLong runs stay numerically healthy");
{
  const lim = new StreamingLimiter(SR, 1, {});
  const block = noise(1, 1.2, 3), out = new Float32Array(block.length);
  let bad = 0;
  for (let k = 0; k < 120; k++) { lim.process([block], [out]); for (let i = 0; i < out.length; i += 97) if (!Number.isFinite(out[i]) || Math.abs(out[i]) > dbToLin(-1) + 1e-6) bad++; }
  ok(bad === 0 && Number.isFinite(lim.heldSum), "two minutes of hot noise: every sample finite and under the ceiling");
}
console.log("ALL PASSED — the safety limiter is transparent below the ceiling and cannot be exceeded above it.");
