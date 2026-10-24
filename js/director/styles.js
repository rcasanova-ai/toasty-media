// The three editing styles. A style is DATA: the numbers and enumerations the planner (plan.js) turns into decisions, and the
// look the renderer (draw.js) paints. The styles differ in what Moxie decides, not just in a colour: pacing, how tightly dead air
// is cut, how often it zooms, how it types words on screen, which transitions it uses, what it adds to the sound.
// `limits` are the anti-overediting rules: effects per ten seconds, minimum gaps, and the share of time that may be zoomed.

export const STYLE_IDS = Object.freeze(["clean", "energy", "cinematic"]);

export const STYLES = Object.freeze({
  clean: {
    id: "clean", name: "Clean Professional", blurb: "Natural pacing, intelligent jump cuts, subtle zooms, clean captions.",
    targetSeconds: 75,
    pace: { maxGap: 0.75, keepGap: 0.34, lead: 0.22, tail: 0.4, maxShot: 16, minShot: 1.6, reactionHold: 0.8 },
    camera: { jumpScales: [1, 1.05], drift: [1, 1.035], punch: { scale: 1.07, dur: 1.3 }, ease: "inOut" },
    captions: { style: "bar", position: "bottom", size: 0.042, maxWords: 8, uppercase: false, font: "sans" },
    typography: { keyPhrase: "label", keywordMark: "underline" },
    transitions: { topic: "fade", jump: "hard", seconds: 0.4, share: 0.25 },
    graphics: { lowerThird: true, stats: true, diagram: true, arrows: false, accents: "none", bug: false },
    sound: { sfx: "minimal", sfxGainDb: -30, music: "chill", musicGainDb: -26, duckDb: -14 },
    grade: { tone: "rgba(255,196,130,0.07)", vignette: 0.1, saturate: 0, frame: "none" },
    theme: { bg: "#f4ead9", fg: "#2a1a12", accent: "#c1470f", accent2: "#ff7a29", font: "sans", capBg: "rgba(24,14,10,0.74)", capFg: "#fff8ec" },
    intro: { kind: "title-card", seconds: 1.8 }, outro: { kind: "brand-end", seconds: 2.2 },
    limits: { per10s: 1.6, minGap: 6.5, zoomCoverage: 0.2, punchMinGap: 9, maxConcurrent: 1 }
  },
  energy: {
    id: "energy", name: "High Energy", blurb: "Fast cuts, punch-in zooms, kinetic captions, callouts and sound accents.",
    targetSeconds: 45,
    pace: { maxGap: 0.32, keepGap: 0.12, lead: 0.1, tail: 0.18, maxShot: 5.2, minShot: 1.0, reactionHold: 0.45 },
    camera: { jumpScales: [1, 1.12, 1.05, 1.17], drift: [1.02, 1.08], punch: { scale: 1.16, dur: 0.9 }, ease: "out" },
    captions: { style: "kinetic", position: "lower", size: 0.074, maxWords: 3, uppercase: true, font: "display" },
    typography: { keyPhrase: "slide", keywordMark: "pop" },
    transitions: { topic: "wipe", jump: "hard", seconds: 0.3, share: 0.55, cycle: ["wipe", "push", "flash"] },
    graphics: { lowerThird: true, stats: true, diagram: true, arrows: true, accents: "corners", bug: false },
    sound: { sfx: "full", sfxGainDb: -22, music: "upbeat", musicGainDb: -21, duckDb: -15 },
    grade: { tone: "rgba(255,150,60,0.10)", vignette: 0.14, saturate: 0.14, frame: "none" },
    theme: { bg: "#1b0f08", fg: "#fff4e0", accent: "#ff7a29", accent2: "#ffc670", font: "display", capBg: "rgba(0,0,0,0.0)", capFg: "#ffffff" },
    intro: { kind: "rolling-title", seconds: 1.4 }, outro: { kind: "cta", seconds: 1.8 },
    limits: { per10s: 4.2, minGap: 2.2, zoomCoverage: 0.45, punchMinGap: 2.6, maxConcurrent: 2 }
  },
  cinematic: {
    id: "cinematic", name: "Cinematic", blurb: "Deliberate pacing, slow camera moves, serif typography, restrained dissolves, warm grade.",
    targetSeconds: 60,
    pace: { maxGap: 1.2, keepGap: 0.62, lead: 0.4, tail: 0.7, maxShot: 24, minShot: 2.6, reactionHold: 1.2 },
    camera: { jumpScales: [1], drift: [1.0, 1.1], punch: { scale: 1.05, dur: 2.4 }, ease: "inOut", driftPerShot: true },
    captions: { style: "cinema", position: "bottom", size: 0.04, maxWords: 7, uppercase: false, font: "serif" },
    typography: { keyPhrase: "quote", keywordMark: "italic" },
    transitions: { topic: "dissolve", jump: "hard", seconds: 0.9, share: 0.4 },
    graphics: { lowerThird: true, stats: false, diagram: false, arrows: false, accents: "letterbox", bug: false },
    sound: { sfx: "sparse", sfxGainDb: -26, music: "cinematic", musicGainDb: -20, duckDb: -14 },
    grade: { tone: "rgba(255,140,60,0.14)", vignette: 0.34, saturate: -0.08, frame: "letterbox" },
    theme: { bg: "#0f0a08", fg: "#f4ead9", accent: "#c1470f", accent2: "#ffc670", font: "serif", capBg: "rgba(0,0,0,0)", capFg: "#f4ead9" },
    intro: { kind: "title-card", seconds: 2.6 }, outro: { kind: "brand-end", seconds: 2.6 },
    limits: { per10s: 1.3, minGap: 8, zoomCoverage: 0.3, punchMinGap: 12, maxConcurrent: 1 }
  }
});

export const getStyle = (id) => STYLES[id] || STYLES.clean;

// Runtime knobs that revisions ("less zooming", "make it faster") change. Everything is a multiplier or switch on the style.
export const DEFAULT_PARAMS = Object.freeze({
  pace: 1,                 // >1 tighter cuts, more cuts
  zoom: 1,                 // 0 = none
  transitions: 1,          // 0 = hard cuts only
  captionScale: 1,
  captions: true,
  music: true,
  musicGainDb: null,
  sfx: true,
  graphics: 1,             // 0 = none
  typography: 1,           // 0 = no emphasis typography
  targetSeconds: null,
  startWithStrongest: false,
  intro: true,
  outro: true,
  branding: "outro",       // "outro" | "full" | "none"
  title: null,
  lowerThird: null,        // { name, role }
  count: 1
});

export function resolveParams(user = {}) {
  const p = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(DEFAULT_PARAMS)) if (user[k] !== undefined && user[k] !== null) p[k] = user[k];
  p.pace = Math.max(0.6, Math.min(2, Number(p.pace) || 1));
  p.zoom = Math.max(0, Math.min(2, Number(p.zoom)));
  p.transitions = Math.max(0, Math.min(2, Number(p.transitions)));
  p.captionScale = Math.max(0.6, Math.min(1.8, Number(p.captionScale) || 1));
  p.graphics = Math.max(0, Math.min(2, Number(p.graphics)));
  p.typography = Math.max(0, Math.min(2, Number(p.typography)));
  if (p.targetSeconds != null) p.targetSeconds = Math.max(8, Math.min(600, Number(p.targetSeconds)));
  p.count = Math.max(1, Math.min(6, Math.round(Number(p.count) || 1)));
  return p;
}
