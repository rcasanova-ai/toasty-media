// Toasty Studio original generated sound effects.
// These are first-class catalogue media assets, synthesized once into WAV data URLs at catalogue load.
// No third-party samples are embedded.

const SR = 11025;

function wavDataUrl(duration, sample) {
  const count = Math.floor(duration * SR);
  const bytes = new Uint8Array(44 + count);
  const view = new DataView(bytes.buffer);
  const put = (offset, text) => { for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i); };
  put(0, "RIFF"); view.setUint32(4, 36 + count, true); put(8, "WAVE"); put(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SR, true); view.setUint32(28, SR, true); view.setUint16(32, 1, true);
  view.setUint16(34, 8, true); put(36, "data"); view.setUint32(40, count, true);
  let seed = 123456789;
  const noise = () => { seed = (1664525 * seed + 1013904223) >>> 0; return (seed / 4294967296) * 2 - 1; };
  for (let i = 0; i < count; i += 1) {
    const t = i / SR;
    const x = Math.max(-1, Math.min(1, sample(t, duration, noise)));
    bytes[44 + i] = Math.max(0, Math.min(255, Math.round(128 + x * 105)));
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const fade = (t, d, attack = 0.015, release = 0.12) => Math.min(1, t / attack, Math.max(0, (d - t) / release));

const EFFECTS = {
  "cholo-whistle": [1.15, (t, d) => {
    const f = t < 0.5 ? 1500 : 1950;
    return 0.58 * Math.sin(2 * Math.PI * f * t) * fade(t, d, 0.04, 0.18) * (1 + 0.08 * Math.sin(2 * Math.PI * 6 * t));
  }],
  "fah": [1.25, (t, d) => {
    const f = 270 - 125 * t / d;
    return (0.5 * Math.sin(2 * Math.PI * f * t) + 0.18 * Math.sin(4 * Math.PI * f * t) + 0.08 * Math.sin(6 * Math.PI * f * t)) * fade(t, d, 0.03, 0.28);
  }],
  "rider": [0.9, (t, d, noise) => (0.30 * Math.sin(2 * Math.PI * 92 * t) + 0.17 * Math.sign(Math.sin(2 * Math.PI * 184 * t)) + 0.08 * noise()) * Math.exp(-4 * t)],
  "click": [0.12, (t, d, noise) => (0.45 * noise() + 0.22 * Math.sin(2 * Math.PI * 1700 * t)) * Math.exp(-48 * t)],
  "pop": [0.24, (t) => 0.7 * Math.sin(2 * Math.PI * (220 - 130 * t / 0.24) * t) * Math.exp(-17 * t)],
  "glitch": [0.65, (t, d, noise) => (Math.sin(2 * Math.PI * 17 * t) > 0 ? 1 : 0) * (0.28 * Math.sign(Math.sin(2 * Math.PI * (350 + 900 * ((t * 0.9) % 1)) * t)) + 0.12 * noise()) * fade(t, d, 0.005, 0.05)],
  "cha-ching": [0.8, (t) => {
    const q = (s, f) => t >= s ? Math.sin(2 * Math.PI * f * (t - s)) * Math.exp(-14 * (t - s)) : 0;
    return 0.34 * q(0.02, 2400) + 0.32 * q(0.09, 3300) + 0.28 * q(0.23, 1800) + 0.24 * q(0.30, 2700);
  }],
  "core-hit": [0.72, (t, d, noise) => (0.48 * Math.sin(2 * Math.PI * 55 * t) + 0.18 * Math.sin(2 * Math.PI * 110 * t) + 0.08 * noise()) * Math.exp(-5 * t)],
  "space-alert": [0.86, (t) => {
    const p = (s, f) => t >= s && t < s + 0.24 ? 0.28 * Math.sign(Math.sin(2 * Math.PI * f * (t - s))) * Math.exp(-6 * (t - s)) : 0;
    return p(0, 740) + p(0.2, 554) + p(0.4, 830);
  }],
  "fast-forward": [0.65, (t, d) => 0.42 * Math.sin(2 * Math.PI * (300 * t + 900 * t * t)) * (Math.sin(2 * Math.PI * 18 * t) > 0 ? 1 : 0) * fade(t, d, 0.01, 0.08)],
  "mouse-click": [0.09, (t, d, noise) => (0.5 * noise() + 0.15 * Math.sin(2 * Math.PI * 2400 * t)) * Math.exp(-65 * t)],
  "camera-shutter": [0.4, (t, d, noise) => {
    let y = 0;
    for (const s of [0.03, 0.13, 0.23]) if (t >= s && t < s + 0.06) y += (0.4 * noise() + 0.18 * Math.sin(2 * Math.PI * 900 * (t - s))) * Math.exp(-45 * (t - s));
    return y;
  }],
  "paper-rustle": [1.2, (t, d, noise) => 0.28 * noise() * (0.25 + 0.75 * Math.pow(Math.sin(4 * Math.PI * t), 2)) * fade(t, d, 0.05, 0.2)],
  "metallic-riser": [1.6, (t, d) => {
    const f = 280 + 2500 * Math.pow(t / d, 2);
    return 0.28 * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 1.51 * t)) * (t / d) * fade(t, d, 0.08, 0.08);
  }],
  "bass-boom": [1.0, (t, d, noise) => {
    const f = 42 + 80 * Math.exp(-2.5 * t);
    return (0.62 * Math.sin(2 * Math.PI * f * t) + 0.1 * noise() * Math.exp(-12 * t)) * Math.exp(-4.2 * t);
  }],
  "bass-impact": [0.88, (t, d, noise) => {
    const f = 34 + 65 * Math.exp(-3 * t);
    return (0.65 * Math.sin(2 * Math.PI * f * t) + 0.06 * noise() * Math.exp(-18 * t)) * Math.exp(-3.7 * t);
  }]
};

const CACHE = new Map();

export function generatedAudio(generator) {
  if (!generator || !EFFECTS[generator]) return null;
  if (!CACHE.has(generator)) {
    const [duration, sample] = EFFECTS[generator];
    CACHE.set(generator, { src: wavDataUrl(duration, sample), duration });
  }
  return CACHE.get(generator);
}
