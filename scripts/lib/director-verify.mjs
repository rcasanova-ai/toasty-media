// Measurements on exported videos for the Automatic Director tests: decode frames with ffmpeg and look at pixels, read the audio.
import { execFileSync } from "node:child_process";

export const probe = (p) => {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p]).toString());
  if (!Number.isFinite(Number(j.format.duration))) { const m = String(execFileSync("sh", ["-c", `ffmpeg -hide_banner -i '${p}' -f null - 2>&1 | grep -o 'time=[0-9:.]*' | tail -1`]).toString()).match(/time=(\d+):(\d+):([\d.]+)/); const d = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN; j.format.duration = d; }
  return j;
};
// Real decode problems (corrupt data, missing atoms, decoder errors). MediaRecorder output has variable frame timing, so ffmpeg's null muxer
// warns about "non monotonically increasing dts" on re-timed frames; that is a timestamp-jitter warning, not a broken file, and is ignored.
export const decodeErrors = (p) => String(execFileSync("sh", ["-c", `ffmpeg -v error -i '${p}' -f null - 2>&1 || true`]).toString()).split("\n").filter((l) => l.trim() && !/non monotonically increasing dts/.test(l)).join("\n").trim();

// All frames at `fps`, scaled to fit width `w` (height follows the aspect). frame(k) -> { t, data, w, h }.
export function frames(path, fps, w, outW, outH, { from = 0, dur = null } = {}) {
  const h = Math.round(w * outH / outW) & ~1;
  const raw = execFileSync("ffmpeg", ["-v", "error", ...(from ? ["-ss", String(from)] : []), ...(dur ? ["-t", String(dur)] : []), "-i", path, "-vf", `fps=${fps},scale=${w}:${h}:flags=area`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  const size = w * h * 3, n = Math.floor(raw.length / size);
  return { fps, w, h, count: n, from, frame: (k) => ({ t: from + k / fps, data: raw.subarray(k * size, (k + 1) * size), w, h }) };
}
export const at = (F, t) => F.frame(Math.max(0, Math.min(F.count - 1, Math.round((t - (F.from || 0)) * F.fps))));

export const meanLuma = (f) => { let s = 0; for (let i = 0; i < f.data.length; i += 3) s += 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2]; return s / (f.data.length / 3); };

// Count pixels in a rectangle (fractions of the frame) matching a predicate.
export function count(f, rect, pred) {
  const x0 = Math.floor(rect[0] * f.w), x1 = Math.ceil(rect[2] * f.w), y0 = Math.floor(rect[1] * f.h), y1 = Math.ceil(rect[3] * f.h);
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(f.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(f.w, x1); x++) { const i = (y * f.w + x) * 3; if (pred(f.data[i], f.data[i + 1], f.data[i + 2])) n++; }
  return n;
}
// Overlay text colours: white / cream, the accent orange and the amber highlight. The footage never contains these.
export const isText = (r, g, b) => (r > 226 && g > 214 && b > 190) || (r > 235 && g > 100 && g < 150 && b < 80) || (r > 238 && g > 175 && g < 220 && b > 80 && b < 140);
export const isAccent = (r, g, b) => r > 225 && g > 95 && g < 150 && b < 80;
export const isAccentLoose = (r, g, b) => r > 150 && g > 50 && g < 175 && b < 100 && r > g + 55;
export const isBlueHead = (r, g, b) => b > r + 28 && b > g + 8;
export const isOliveHead = (r, g, b) => g > b + 36 && g >= r - 8 && r > b + 10;
const FLASH = (r, g, b) => r > 235 && g > 235 && b > 235;
// The sync-mark flash fills the picture with white; grading, vignette and letterbox bars darken it, so test the central region for bright pixels.
export const isFlashFrame = (f) => { const rect = [0.1, 0.2, 0.9, 0.8], area = 0.8 * 0.6 * f.w * f.h; return count(f, rect, (r, g, b) => r > 150 && g > 150 && b > 150) > area * 0.7; };

// Bounding box (fractions) of pixels matching a predicate, or null.
export function bbox(f, pred, minPixels = 30) {
  let x0 = f.w, y0 = f.h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) { const i = (y * f.w + x) * 3; if (pred(f.data[i], f.data[i + 1], f.data[i + 2])) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return n >= minPixels ? { x0: x0 / f.w, y0: y0 / f.h, x1: (x1 + 1) / f.w, y1: (y1 + 1) / f.h, n } : null;
}

// Mean absolute difference between two frames (0 to 255).
export function diff(a, b) { let s = 0; for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i] - b.data[i]); return s / a.data.length; }

// Least-squares blend M ~ a*A + (1-a)*B: returns { alpha, r2 } to prove a frame is a mix of two others.
export function blendFit(M, A, B, rect = [0, 0, 1, 1]) {
  let num = 0, den = 0, sstot = 0, n = 0, mean = 0;
  const x0 = Math.floor(rect[0] * M.w), x1 = Math.ceil(rect[2] * M.w), y0 = Math.floor(rect[1] * M.h), y1 = Math.ceil(rect[3] * M.h);
  const idx = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) idx.push((y * M.w + x) * 3 + c);
  for (const i of idx) { const d = A.data[i] - B.data[i]; num += (M.data[i] - B.data[i]) * d; den += d * d; mean += M.data[i]; n++; }
  if (den < 1) return { alpha: NaN, r2: NaN, flat: true };
  const alpha = Math.max(0, Math.min(1, num / den)); mean /= n; let sse = 0;
  for (const i of idx) { const pred = alpha * A.data[i] + (1 - alpha) * B.data[i]; sse += (M.data[i] - pred) ** 2; sstot += (M.data[i] - mean) ** 2; }
  return { alpha, r2: 1 - sse / Math.max(1, sstot) };
}

// ---------------------------------------------------------------- audio
export function pcm(path, { sampleRate = 16000, filter = "", from = 0, seconds = null } = {}) {
  const args = ["-v", "error", ...(from ? ["-ss", String(from)] : []), ...(seconds ? ["-t", String(seconds)] : []), "-i", path, "-vn", "-ac", "1", "-ar", String(sampleRate), ...(filter ? ["-af", filter] : []), "-f", "f32le", "-"];
  const buf = execFileSync("ffmpeg", args, { maxBuffer: 1 << 29 });
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}
export function envelopeDb(x, sampleRate, hopMs = 20) {
  const hop = Math.round(sampleRate * hopMs / 1000), n = Math.floor(x.length / hop), out = new Float32Array(n);
  for (let k = 0; k < n; k++) { let s = 0; for (let i = 0; i < hop; i++) { const v = x[k * hop + i]; s += v * v; } out[k] = 10 * Math.log10(s / hop + 1e-12); }
  return out;
}
export function correlation(a, b) {
  const n = Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb + 1e-12);
}
// First time (s) at or after `from` where the 20 ms envelope rises more than `riseDb` over the level 60 ms earlier.
export function onsets(envDb, hopMs, { riseDb = 9, floorDb = -62, minGapS = 0.25 } = {}) {
  const out = []; let last = -9;
  for (let k = 3; k < envDb.length; k++) { const t = k * hopMs / 1000; if (envDb[k] > floorDb && envDb[k] - envDb[k - 3] >= riseDb && t - last >= minGapS) { out.push(t); last = t; } }
  return out;
}

// Speech intelligibility and sync, shot by shot. For every shot of the plan, the voice-band level pattern (20 ms) of the export is
// compared with the same stretch of the ORIGINAL voice, allowing a small search in time. A high correlation means the voice reaches the
// listener intact under the music and accents; the best offset is how far the shot's audio sits from where the plan put it.
export function alignShots({ ref, out, plan, sr = 16000, hopMs = 20, search = 8, floorDb = -50 }) {
  const intro = plan.timeline.intro, hop = hopMs / 1000;
  const parts = plan.segments.map((s) => ref.subarray(Math.floor(s.srcStart * sr), Math.floor(s.srcEnd * sr)));
  const join = new Float32Array(parts.reduce((n, q) => n + q.length, 0)); { let o = 0; for (const q of parts) { join.set(q, o); o += q.length; } }
  const rEnv = envelopeDb(join, sr, hopMs), oEnv = envelopeDb(out.subarray(Math.round(intro * sr), Math.round((intro + plan.timeline.content) * sr) + sr), sr, hopMs);
  const shots = [];
  for (const s of plan.segments) {
    const a = Math.round(s.outStart / hop), b = Math.min(rEnv.length, Math.round(s.outEnd / hop)); let best = { c: -1, shift: 0, n: 0 };
    for (let sh = -search; sh <= search; sh++) {
      const x = [], y = []; for (let i = a + 2; i < b - 2; i++) if (rEnv[i] > floorDb && oEnv[i + sh] !== undefined) { x.push(rEnv[i]); y.push(oEnv[i + sh]); }
      if (x.length >= 15) { const c = correlation(x, y); if (c > best.c) best = { c, shift: sh * hopMs, n: x.length }; }
    }
    if (best.n) shots.push({ seg: s.index, ...best });
  }
  return shots;
}
