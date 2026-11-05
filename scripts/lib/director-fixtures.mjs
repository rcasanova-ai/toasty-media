// Deterministic inputs for the Automatic Director tests: a scripted two-person interview (transcript with exact timing, speaker
// labels, deliberate dead air), the speech regions that go with it, a picture track of two face positions whose mouths move
// in turn, and Moxie-style ranked moments. The audio itself is made by scripts/lib/director-media.mjs.

export const SCRIPT = [
  { speaker: "Maya", text: "Welcome back to the show." , pauseAfter: 0.5 },
  { speaker: "Maya", text: "Today we are talking about hiring, and honestly most companies get it completely wrong.", pauseAfter: 2.4 },
  { speaker: "Jordan", text: "73% of the hires I regret were chosen for their resume instead of their curiosity.", pauseAfter: 0.6 },
  { speaker: "Jordan", text: "That is the biggest mistake I see, and nobody ever talks about it.", pauseAfter: 1.9 },
  { speaker: "Maya", text: "So what should a team do instead?", pauseAfter: 0.5 },
  { speaker: "Jordan", text: "There are three steps. First, write down what the job really needs. Second, test for curiosity with a real problem. Third, never skip the follow up.", pauseAfter: 2.1 },
  { speaker: "Maya", text: "I love that.", pauseAfter: 0.4 },
  { speaker: "Jordan", text: "The reason it works is simple, because curious people keep learning when the job changes.", pauseAfter: 1.2 },
  { speaker: "Maya", text: "That changed everything for us. Thank you for joining.", pauseAfter: 0.6 }
];

// Wherever a fixture builder knows the real durations of each spoken line it returns lines with those times.
export function linesFromDurations(durs, lead = 1.0) {
  let t = lead; const lines = [];
  SCRIPT.forEach((s, i) => { lines.push({ t: +t.toFixed(2), end: +(t + durs[i]).toFixed(2), speaker: s.speaker, text: s.text }); t += durs[i] + s.pauseAfter; });
  return { lines, total: t + 0.8 };
}

// Estimated durations when no text-to-speech is available (about 2.6 words a second).
export const estimatedDurations = () => SCRIPT.map((s) => Math.max(1.2, s.text.split(/\s+/).length / 2.6));

// Speech regions as the voice detector would find them: each line's voiced span.
export function regionsFromLines(lines) { return lines.map((l) => ({ start: l.t + 0.04, end: l.end - 0.04 })); }

// Two faces, left (Maya, x 0.28) and right (Jordan, x 0.72). The speaking one's mouth is open while the voice is active.
export function pictureFromLines(lines, total, step = 0.5) {
  const out = [];
  for (let t = 0; t <= total; t += step) {
    const cur = lines.find((l) => t >= l.t && t <= l.end);
    out.push({ t: +t.toFixed(2), motion: cur ? 0.2 : 0.05, faces: [
      { x: 0.28, y: 0.42, size: 0.22, mouthOpen: cur?.speaker === "Maya" ? 0.5 : 0.04, smile: 0.2, brow: 0.1, yaw: 0, pitch: 0, roll: 0 },
      { x: 0.72, y: 0.42, size: 0.22, mouthOpen: cur?.speaker === "Jordan" ? 0.5 : 0.04, smile: 0.2, brow: 0.1, yaw: 0, pitch: 0, roll: 0 }
    ], hands: [], pose: null });
  }
  return out;
}

export function momentsFromLines(lines) {
  return [
    { id: "m1", start: lines[2].t - 0.5, end: lines[3].end + 1, score: 88, title: "73% of the hires I regret", category: "insight" },
    { id: "m2", start: lines[5].t - 0.5, end: lines[7].end + 1, score: 74, title: "Three steps to hire for curiosity", category: "explanation" }
  ];
}
