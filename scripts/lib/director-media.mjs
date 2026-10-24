// Real media for the Automatic Director tests. With macOS `say` the interview is spoken by two real text-to-speech voices and the
// transcript timing is exact (each line is generated separately and placed on a known timeline, with deliberate dead air between
// lines). Everywhere else (CI) a synthetic speech-like programme with the same timeline stands in, and the test says so.
// The picture is a static two-person scene on a flat background, so the tests can tell overlays and crops from the footage:
// Maya (blue-grey head, left), Jordan (olive head, right), the speaker's "mouth" opens while they talk, and one white flash
// coincides with a 1 kHz beep (the audio/video sync mark).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { wavBytes } from "./synth-programme.mjs";
import { voicedPcm } from "./behavior-fixtures.mjs";
import { SCRIPT, estimatedDurations } from "./director-fixtures.mjs";

const SR = 48000;
export const HEAD = { Maya: { x: 0.28, color: "0x6b8cae", rgb: [0x6b, 0x8c, 0xae] }, Jordan: { x: 0.72, color: "0x8aa05a", rgb: [0x8a, 0xa0, 0x5a] }, y: 0.42, size: 0.22 };
export const BG = [0x3a, 0x2a, 0x20];
const VOICES = { Maya: "Samantha", Jordan: "Daniel" };

function hasSay() { return process.platform === "darwin" && spawnSync("which", ["say"]).status === 0 && !process.env.NO_TTS; }

function decodeRaw(path) {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}
function trimSilence(x, thr = 0.004) {
  let a = 0, b = x.length; while (a < b && Math.abs(x[a]) < thr) a++; while (b > a && Math.abs(x[b - 1]) < thr) b--;
  return x.subarray(Math.max(0, a - 480), Math.min(x.length, b + 480));
}

export async function buildInterviewMedia(dir, { flashLine = 5, flashOffset = 4.0 } = {}) {
  mkdirSync(dir, { recursive: true });
  const tts = hasSay();
  const clips = [];
  if (tts) {
    SCRIPT.forEach((s, i) => {
      const aiff = join(dir, `line${i}.aiff`);
      execFileSync("say", ["-v", VOICES[s.speaker], "-r", "170", "-o", aiff, s.text]);
      clips.push(trimSilence(decodeRaw(aiff)));
    });
  } else {
    const durs = estimatedDurations();
    SCRIPT.forEach((s, i) => {
      const pcm16 = voicedPcm([{ t0: 0.05, t1: durs[i] - 0.05, f0: s.speaker === "Maya" ? 205 : 118, db: -24, rate: 3.2 }], durs[i]);
      const up = new Float32Array(Math.round(pcm16.length * 3)); for (let k = 0; k < up.length; k++) up[k] = pcm16[Math.floor(k / 3)];
      clips.push(up);
    });
  }
  // timeline: 1 s of room tone, then each line followed by its scripted pause
  const lead = 1.0; let t = lead; const placed = [];
  SCRIPT.forEach((s, i) => { placed.push({ t, dur: clips[i].length / SR, i }); t += clips[i].length / SR + s.pauseAfter; });
  const total = t + 0.8, n = Math.round(total * SR), pcm = new Float32Array(n);
  let seed = 42; for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pcm[i] = ((seed / 2 ** 32) - 0.5) * 0.0016; }         // room tone about -62 dBFS
  const gain = tts ? 0.9 / Math.max(...clips.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0))) * 0.55 : 1;                            // speech peaks around -5 dBFS
  for (const p of placed) { const c = clips[p.i], o = Math.round(p.t * SR); for (let k = 0; k < c.length && o + k < n; k++) pcm[o + k] += c[k] * gain; }
  const lines = placed.map((p) => ({ t: +p.t.toFixed(2), end: +(p.t + p.dur).toFixed(2), speaker: SCRIPT[p.i].speaker, text: SCRIPT[p.i].text }));
  // sync mark: white flash + 1 kHz beep, inside a kept stretch of speech
  const flashT = lines[flashLine].t + flashOffset;
  for (let k = Math.round(flashT * SR); k < Math.round((flashT + 0.25) * SR); k++) pcm[k] = 0.85 * Math.sin(2 * Math.PI * 1000 * k / SR);
  const wav = join(dir, "interview.wav"); writeFileSync(wav, wavBytes(pcm, SR));

  const mouth = (who) => lines.filter((l) => l.speaker === who).map((l) => `between(t,${l.t},${l.end})`).join("+") || "0";
  const hs = Math.round(0.22 * 720), cy = Math.round(0.42 * 720);
  const box = (who) => { const cx = Math.round(HEAD[who].x * 1280); return `drawbox=x=${cx - hs / 2}:y=${cy - hs / 2}:w=${hs}:h=${hs}:color=${HEAD[who].color}:t=fill,drawbox=x=${cx - hs}:y=${cy + hs / 2 + 6}:w=${hs * 2}:h=${Math.round(hs * 0.7)}:color=${HEAD[who].color}:t=fill,drawbox=x=${cx - 28}:y=${cy + 22}:w=56:h=14:color=0x1a1008:t=fill:enable='${mouth(who)}'`; };
  const video = join(dir, "interview.mp4");
  const vf = [box("Maya"), box("Jordan"), `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,${flashT},${flashT + 0.25})'`].join(",");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x3a2a20:s=1280x720:r=30`, "-i", wav, "-t", String(total), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", video]);
  return { dir, wav, video, lines, total, flashT, tts, voices: tts ? VOICES : null };
}

// A second, short clip to use as B-roll: orange-free, with a distinctive solid colour and a moving bar so it is visibly "other footage".
export function buildBrollClip(dir, name = "hiring-team.mp4", color = "0xb04a8a") {
  const out = join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=30`, "-t", "6", "-vf", "drawbox=x=40:y=40:w=180:h=100:color=0xffffff:t=fill", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", out]);
  return out;
}
