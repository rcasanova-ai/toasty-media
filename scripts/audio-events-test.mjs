#!/usr/bin/env node
import { detectAudioEvents } from "../js/audio-events.js";
import { synthProgramme } from "./lib/synth-programme.mjs";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const SR = 16000;
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const floorNoise = (n, db, r) => Float32Array.from({ length: n }, () => (r() * 2 - 1) * 10 ** (db / 20));
function laughter(seconds, rate = 5, level = 0.3, r = lcg(3), jitter = 0.04) {
  const out = new Float32Array(Math.round(seconds * SR)); let t = 0;
  while (t < seconds) { const on = 0.09, start = Math.round(t * SR); for (let i = 0; i < on * SR; i++) { const env = Math.sin(Math.PI * i / (on * SR)); if (start + i < out.length) out[start + i] += level * env * (r() * 2 - 1); } t += (1 / rate) * (1 + (r() - 0.5) * 2 * jitter); }
  return out;
}
const mix = (len, parts) => { const o = new Float32Array(len); for (const [buf, at] of parts) for (let i = 0; i < buf.length && at * SR + i < len; i++) o[Math.round(at * SR) + i] += buf[i]; return o; };
const r = lcg(1);

console.log("\nLaughter");
{
  const x = mix(30 * SR, [[floorNoise(30 * SR, -60, r), 0], [laughter(3, 5), 10], [laughter(2.2, 6, 0.3, lcg(9)), 20]]);
  const ev = detectAudioEvents(x, SR).filter((e) => e.type === "laughter");
  ok(ev.length === 2, `two laughs found in 30 s (${ev.length})`);
  ok(Math.abs(ev[0].t - 10) < 0.6 && ev[0].end - ev[0].t > 2, `first laugh located at ~10 s lasting ${(ev[0].end - ev[0].t).toFixed(1)} s`);
  ok(Math.abs(ev[1].t - 20) < 0.6, "second laugh located at ~20 s");
}
console.log("\nSpeech is not laughter");
{
  const p = synthProgramme({ seconds: 36 });
  const down = Float32Array.from({ length: Math.floor(p.samples.length / 3) }, (_, i) => p.samples[i * 3]);
  const ev = detectAudioEvents(down, 16000).filter((e) => e.type === "laughter");
  ok(ev.length <= 1, `at most one false positive in 36 s of two synthetic talkers whose syllables are unnaturally regular (${ev.length}${ev[0] ? " at " + ev[0].t.toFixed(1) + " s" : ""})`);
  const D = process.env.SPEECH_WAV;
  if (D) { const { loadMono } = await import("./lib/audio-file-analysis.mjs"); const { samples } = await loadMono(D, { seconds: 60 }); ok(detectAudioEvents(samples, 16000).filter((e) => e.type === "laughter").length === 0, "no laughter in real synthesised speech (SPEECH_WAV)"); }
}
console.log("\nSilence and sudden loud reactions");
{
  const speech = (s, level) => Float32Array.from({ length: s * SR }, (_, i) => level * Math.sin(2 * Math.PI * 180 * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3.1 * i / SR)));
  const x = mix(40 * SR, [[floorNoise(40 * SR, -62, r), 0], [speech(8, 0.06), 0], [speech(8, 0.06), 14], [speech(2, 0.9), 28]]);
  const ev = detectAudioEvents(x, SR);
  ok(ev.some((e) => e.type === "silence" && e.t >= 7.5 && e.t <= 9 && e.end - e.t >= 4), "a 6 s silence is found");
  ok(ev.some((e) => e.type === "spike" && Math.abs(e.t - 28) < 1), "a sudden loud reaction is found");
}
console.log("ALL PASSED — audio events find laughter, silence and loud reactions, and leave speech alone.");
