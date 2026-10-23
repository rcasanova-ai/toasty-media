// Deterministic fixtures for the behavioral engine tests: voiced audio with known level, pitch and pace; transcripts; and
// visual feature series. Nothing here needs a network, a camera or a model.
export const SR = 16000;

function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

// segments: [{ t0, t1, f0 = 120, db = -26, rate = 4.2 (syllables/s), vibrato = 0.02, f0End }]
// Returns Float32Array mono at 16 kHz. Silence elsewhere, plus a faint noise floor.
export function voicedPcm(segments, seconds, { floorDb = -62, seed = 5 } = {}) {
  const rand = lcg(seed), n = Math.round(seconds * SR), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() - 0.5) * 2 * 10 ** (floorDb / 20);
  for (const seg of segments) {
    const a = Math.round(seg.t0 * SR), b = Math.min(n, Math.round(seg.t1 * SR)), f0 = seg.f0 ?? 120, rate = seg.rate ?? 2.6, amp = 10 ** ((seg.db ?? -26) / 20) * 1.55;
    // Irregular syllables (speech is not metronomic; a steady 3-8 Hz pulse would be read as laughter).
    const syl = []; for (let t = 0; t < (b - a) / SR;) { const len = (0.35 + rand() * 1.5) / rate; syl.push({ at: t, len: len * 0.9 }); t += len + (rand() < 0.25 ? 0.18 : 0); }
    let phase = 0, si = 0;
    for (let i = a; i < b; i++) {
      const t = (i - a) / SR, frac = (i - a) / Math.max(1, b - a);
      while (si < syl.length - 1 && t > syl[si].at + syl[si].len + 0.2) si++;
      const x = (t - syl[si].at) / syl[si].len, env = 0.3 + 0.7 * (x >= 0 && x <= 1 ? Math.sin(Math.PI * x) ** 0.7 : 0);
      const f = (f0 + ((seg.f0End ?? f0) - f0) * frac) * (1 + (seg.vibrato ?? 0.02) * Math.sin(2 * Math.PI * 5 * t));
      phase += 2 * Math.PI * f / SR;
      let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(h * phase) / h;
      const edge = Math.min(1, t / 0.03, (b - i) / SR / 0.03);
      out[i] += amp * v * env * edge * 0.55;
    }
  }
  return out;
}
// A burst of laughter: 6 to 8 bursts per second of noisy voiced energy.
export function laughSegment(t0, t1, db = -20) { const segs = []; for (let t = t0; t < t1; t += 0.2) segs.push({ t0: t, t1: t + 0.11, f0: 300, db, rate: 1, vibrato: 0.1 }); return segs; }

// Transcript with plain, trigger-free sentences about one topic after another. Returns lines at ~7 s spacing.
export function plainTranscript({ speakers = ["Guest", "Host"], every = 6, seconds = 7.5 } = {}) {
  const texts = [
    "So we started the bakery in a tiny rented garage back in two thousand eleven.", "The oven was second hand and it broke down almost every week.", "My sister handled the books while I handled the dough.",
    "Nobody believed a garage could turn out bread that people would drive across town for.", "We sold forty loaves the first Saturday and eleven of them were burnt.", "Then a food writer wandered in by accident and wrote three paragraphs about our rye.",
    "By Monday there was a line down the block and I had no flour left.", "I called every supplier in the county and one of them drove out that night with a truck.", "That night taught me that a business is really a chain of people who answer the phone.",
    "Pricing is where most small shops quietly fail.", "They charge what feels polite instead of what the work costs.", "We raised the price of a loaf by a dollar and sales did not move at all.",
    "The customers who complained were the ones who bought the least.", "So the real lesson is that fear of the price tag lives mostly in the owner's head.", "Hiring was a different kind of problem.",
    "We hired a baker with fifteen years of experience and she quit in nine days.", "The reason was simple, she wanted to change the recipe and I would not let her.", "Looking back I was protecting my ego more than the bread.",
    "Now every baker on the team gets one loaf a month to rework however they want.", "Three of our bestsellers came out of that experiment.", "Which brings me to the part nobody tells you about growth.",
    "The second location nearly sank us because we copied the first one exactly.", "A neighbourhood with students wants cheap and fast, not slow and sourdough.", "We rebuilt the menu around cookies and coffee and the shop turned around in a quarter.",
    "What surprised me was how little the bread itself mattered to the turnaround.", "It was the morning routine, the smell, the person who remembered your name.", "That is probably why the garage worked in the first place.",
    "People were not buying loaves, they were buying a small good start to the day.", "Anyway that is where we are today, eleven shops and a very tired oven.", "Thanks for having me on the show, this was a pleasure."];
  return texts.map((text, i) => ({ t: i * seconds, end: i * seconds + seconds - 1.5, speaker: speakers ? (i % every === every - 1 ? speakers[1] : speakers[0]) : "", text }));
}

// Visual samples at 1 sample/s. events: [{ t, kind: "smile"|"brow"|"nod"|"turn"|"hands"|"lean" , slot }] applied to a calm baseline.
export function visualSamples(seconds, events = [], { faces = 1, step = 1, motion = 0.012, hands = false, pose = false } = {}) {
  const S = [], rand = lcg(11);
  for (let t = 0; t <= seconds; t += step) {
    const s = { t, motion: motion * (0.8 + 0.4 * rand()), faces: [], hands: [], pose: pose ? { x: 0.5, y: 0.6, width: 0.4, tilt: 0 } : null };
    for (let slot = 0; slot < faces; slot++) s.faces.push({ smile: 0.05, brow: 0.05, mouthOpen: 0.05, yaw: 0, pitch: 0, roll: 0, x: faces === 1 ? 0.5 : 0.3 + slot * 0.4, y: 0.4, size: 0.3 });
    S.push(s);
  }
  const at = (t) => S.find((s) => Math.abs(s.t - t) < step / 2 + 1e-6);
  for (const e of events) {
    const slot = e.slot ?? 0;
    if (e.kind === "smile") for (const dt of [0, 1, 2].map((k) => k * step)) { const s = at(e.t + dt); if (s?.faces[slot]) s.faces[slot].smile = 0.75; }
    if (e.kind === "brow") { const s = at(e.t); if (s?.faces[slot]) s.faces[slot].brow = 0.8; }
    if (e.kind === "turn") [0, 15, 32].forEach((yaw, k) => { const s = at(e.t + k * step); if (s?.faces[slot]) s.faces[slot].yaw = yaw; });
    if (e.kind === "nod") [0, 1, 2, 3].forEach((dt, k) => { const s = at(e.t + dt * 0.4); if (s?.faces[slot]) s.faces[slot].pitch = k % 2 ? -8 : 8; });
    if (e.kind === "lean") [0, 1, 2].forEach((k) => { const s = at(e.t + k * step); if (s?.faces[slot]) s.faces[slot].size = 0.3 + k * 0.05; });
    if (e.kind === "hands") [0, 1, 2, 3, 4, 5].forEach((k) => { const s = at(e.t + k * step); if (s) s.hands = [{ x: 0.2 + 0.25 * (k % 2), y: 0.7, reach: 0.1 }]; });
    if (e.kind === "burst") { const s = at(e.t); if (s) s.motion = 0.12; }
  }
  return S;
}
