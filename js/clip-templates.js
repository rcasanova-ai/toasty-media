// Reusable clip templates. A template is DATA, never code: a bounded set of enumerated styles and numbers that the renderer
// (js/clip-renderer.js) knows how to draw. Anything that arrives from outside (a saved template, Moxie's reading of a plain
// English instruction, an imported file) goes through validateTemplate(), which drops unknown keys and clamps every value,
// so an interpreted instruction can never inject script or ask for something the renderer cannot do.

export const ASPECTS = Object.freeze({
  "16:9": { width: 1920, height: 1080, label: "Landscape 16:9 (1080p)" },
  "9:16": { width: 1080, height: 1920, label: "Vertical 9:16" },
  "1:1": { width: 1080, height: 1080, label: "Square 1:1" }
});

export const ENUMS = Object.freeze({
  introKind: ["none", "rolling-title", "title-card", "logo-sting"],
  outroKind: ["none", "brand-end", "cta"],
  captionStyle: ["none", "kinetic", "bar", "karaoke"],
  captionPosition: ["bottom", "center", "top"],
  transition: ["none", "fade", "slide", "zoom", "wipe"],
  ease: ["linear", "in", "out", "inOut"],
  frame: ["none", "border", "letterbox"],
  music: ["none", "upbeat", "chill", "cinematic", "tense"],
  font: ["sans", "display", "serif", "mono"],
  position: ["top-left", "top-right", "bottom-left", "bottom-right", "center", "top", "bottom"]
});

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const color = (v, d) => (typeof v === "string" && HEX.test(v) ? v : d);
const text = (v, d = "", max = 140) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").slice(0, max) : d);

export const DEFAULT_TEMPLATE = Object.freeze({
  theme: { bg: "#1b120e", fg: "#f4ead9", accent: "#ff7a29", accent2: "#ffc670", font: "sans" },
  intro: { kind: "none", seconds: 2.2, title: "{title}", subtitle: "" },
  outro: { kind: "none", seconds: 2.6, text: "Toasty Media", subtitle: "toasty.media" },
  captions: { style: "bar", position: "bottom", size: 0.05, highlight: "#ffc670", uppercase: false },
  camera: { zoomFrom: 1, zoomTo: 1, panX: 0, panY: 0, ease: "inOut", punchIns: [] },
  transition: { kind: "fade", seconds: 0.4 },
  overlays: { lowerThird: false, progressBar: false, logo: true, frame: "none", titleBadge: "" },
  music: { style: "none", gainDb: -20, duckDb: -14 },
  audio: { enhance: true }
});

export function validateTemplate(input = {}) {
  const d = DEFAULT_TEMPLATE, t = input || {};
  const punch = Array.isArray(t.camera?.punchIns) ? t.camera.punchIns.slice(0, 8).map((p) => ({ at: clamp(p?.at, 0, 1, 0.5), dur: clamp(p?.dur, 0.3, 3, 1.2), scale: clamp(p?.scale, 1, 1.4, 1.12) })) : [];
  return {
    id: text(t.id, "custom", 40).replace(/[^a-z0-9-]/gi, "-"),
    name: text(t.name, "Custom", 48),
    description: text(t.description, "", 160),
    keywords: Array.isArray(t.keywords) ? t.keywords.slice(0, 16).map((k) => text(k, "", 24).toLowerCase()).filter(Boolean) : [],
    bestFor: Array.isArray(t.bestFor) ? t.bestFor.filter((a) => a in ASPECTS) : ["16:9", "9:16", "1:1"],
    theme: {
      bg: color(t.theme?.bg, d.theme.bg), fg: color(t.theme?.fg, d.theme.fg), accent: color(t.theme?.accent, d.theme.accent), accent2: color(t.theme?.accent2, d.theme.accent2),
      font: pick(t.theme?.font, ENUMS.font, d.theme.font)
    },
    intro: { kind: pick(t.intro?.kind, ENUMS.introKind, d.intro.kind), seconds: clamp(t.intro?.seconds, 0.8, 6, d.intro.seconds), title: text(t.intro?.title, d.intro.title, 90), subtitle: text(t.intro?.subtitle, "", 90) },
    outro: { kind: pick(t.outro?.kind, ENUMS.outroKind, d.outro.kind), seconds: clamp(t.outro?.seconds, 1, 8, d.outro.seconds), text: text(t.outro?.text, d.outro.text, 80), subtitle: text(t.outro?.subtitle, d.outro.subtitle, 80) },
    captions: {
      style: pick(t.captions?.style, ENUMS.captionStyle, d.captions.style), position: pick(t.captions?.position, ENUMS.captionPosition, d.captions.position),
      size: clamp(t.captions?.size, 0.03, 0.12, d.captions.size), highlight: color(t.captions?.highlight, d.captions.highlight), uppercase: Boolean(t.captions?.uppercase)
    },
    camera: { zoomFrom: clamp(t.camera?.zoomFrom, 1, 1.5, 1), zoomTo: clamp(t.camera?.zoomTo, 1, 1.5, 1), panX: clamp(t.camera?.panX, -0.2, 0.2, 0), panY: clamp(t.camera?.panY, -0.2, 0.2, 0), ease: pick(t.camera?.ease, ENUMS.ease, "inOut"), punchIns: punch },
    transition: { kind: pick(t.transition?.kind, ENUMS.transition, d.transition.kind), seconds: clamp(t.transition?.seconds, 0.15, 1.2, d.transition.seconds) },
    overlays: { lowerThird: Boolean(t.overlays?.lowerThird), progressBar: Boolean(t.overlays?.progressBar), logo: t.overlays?.logo !== false, frame: pick(t.overlays?.frame, ENUMS.frame, "none"), titleBadge: text(t.overlays?.titleBadge, "", 28) },
    music: { style: pick(t.music?.style, ENUMS.music, "none"), gainDb: clamp(t.music?.gainDb, -40, -6, d.music.gainDb), duckDb: clamp(t.music?.duckDb, -30, -3, d.music.duckDb) },
    audio: { enhance: t.audio?.enhance !== false }
  };
}

const T = (o) => validateTemplate(o);

export const STARTER_TEMPLATES = Object.freeze([
  T({ id: "energy-burst", name: "Energy Burst", description: "Fast and loud: rolling title, kinetic captions, punch-ins and upbeat music.", keywords: ["energetic", "energy", "hype", "punchy", "fast", "exciting", "high energy", "upbeat"],
    theme: { bg: "#1b0f08", fg: "#fff4e0", accent: "#ff7a29", accent2: "#ffc670", font: "display" },
    intro: { kind: "rolling-title", seconds: 2.2, title: "{title}" }, outro: { kind: "brand-end", seconds: 2.4 },
    captions: { style: "kinetic", position: "center", size: 0.075, highlight: "#ffc670", uppercase: true },
    camera: { zoomFrom: 1, zoomTo: 1.1, ease: "inOut", punchIns: [{ at: 0.2, dur: 1, scale: 1.14 }, { at: 0.55, dur: 1, scale: 1.16 }, { at: 0.85, dur: 0.9, scale: 1.12 }] },
    transition: { kind: "wipe", seconds: 0.35 }, overlays: { progressBar: true }, music: { style: "upbeat", gainDb: -18, duckDb: -14 } }),
  T({ id: "clean-insight", name: "Clean Insight", description: "Calm and clear for explanations: lower third, bar captions, a slow subtle zoom.", keywords: ["clean", "calm", "clear", "insight", "explainer", "professional", "subtle", "minimal captions", "educational"],
    theme: { bg: "#f4ead9", fg: "#2a1a12", accent: "#c1470f", accent2: "#ff7a29", font: "sans" },
    intro: { kind: "title-card", seconds: 2 }, outro: { kind: "brand-end", seconds: 2.2 },
    captions: { style: "bar", position: "bottom", size: 0.045 }, camera: { zoomFrom: 1, zoomTo: 1.05, ease: "inOut" },
    transition: { kind: "fade", seconds: 0.5 }, overlays: { lowerThird: true }, music: { style: "chill", gainDb: -24, duckDb: -12 } }),
  T({ id: "hot-take", name: "Hot Take", description: "For strong opinions: big centred captions, a hard zoom on the punchline, tense music.", keywords: ["hot take", "opinion", "controversial", "bold", "dramatic", "debate", "spicy", "argument"],
    theme: { bg: "#190b08", fg: "#fff4e0", accent: "#e5382c", accent2: "#ffab5c", font: "display" },
    intro: { kind: "rolling-title", seconds: 1.8, title: "HOT TAKE", subtitle: "{title}" }, outro: { kind: "cta", seconds: 2.2, text: "Agree? Disagree?", subtitle: "Tell us" },
    captions: { style: "kinetic", position: "center", size: 0.085, highlight: "#ff5b45", uppercase: true },
    camera: { zoomFrom: 1, zoomTo: 1.16, ease: "in", punchIns: [{ at: 0.7, dur: 1.2, scale: 1.2 }] },
    transition: { kind: "zoom", seconds: 0.3 }, overlays: { titleBadge: "HOT TAKE", progressBar: true }, music: { style: "tense", gainDb: -20, duckDb: -16 } }),
  T({ id: "laugh-track", name: "Laugh Track", description: "Playful and bouncy for jokes and group laughter, with a bright badge and upbeat music.", keywords: ["funny", "laugh", "joke", "playful", "comedy", "fun", "banter", "humor", "humour"],
    theme: { bg: "#2a1608", fg: "#fff4e0", accent: "#ffc670", accent2: "#ff7a29", font: "display" },
    intro: { kind: "title-card", seconds: 1.6, title: "{title}" }, outro: { kind: "brand-end", seconds: 2 },
    captions: { style: "karaoke", position: "bottom", size: 0.065, highlight: "#ffc670", uppercase: false },
    camera: { zoomFrom: 1, zoomTo: 1.08, ease: "inOut", punchIns: [{ at: 0.5, dur: 0.9, scale: 1.1 }] },
    transition: { kind: "slide", seconds: 0.35 }, overlays: { titleBadge: "WAIT FOR IT" }, music: { style: "upbeat", gainDb: -22, duckDb: -16 } }),
  T({ id: "documentary", name: "Documentary", description: "Cinematic letterbox, a slow pan and a serif title, with a gentle cinematic bed.", keywords: ["cinematic", "documentary", "film", "epic", "emotional", "serious", "story", "dramatic pan"],
    theme: { bg: "#0f0a08", fg: "#f4ead9", accent: "#c1470f", accent2: "#ffc670", font: "serif" },
    intro: { kind: "title-card", seconds: 2.6, title: "{title}" }, outro: { kind: "brand-end", seconds: 2.8 },
    captions: { style: "bar", position: "bottom", size: 0.04 }, camera: { zoomFrom: 1.02, zoomTo: 1.1, panX: 0.04, panY: 0, ease: "inOut" },
    transition: { kind: "fade", seconds: 0.8 }, overlays: { frame: "letterbox" }, music: { style: "cinematic", gainDb: -20, duckDb: -14 } }),
  T({ id: "podcast-quote", name: "Podcast Quote", description: "A pull-quote card with a progress bar: the line on screen while it is spoken.", keywords: ["quote", "podcast", "soundbite", "pull quote", "audiogram", "highlight"],
    theme: { bg: "#241510", fg: "#fff4e0", accent: "#ff7a29", accent2: "#ffc670", font: "serif" },
    intro: { kind: "none" }, outro: { kind: "brand-end", seconds: 2.2 },
    captions: { style: "karaoke", position: "center", size: 0.06, highlight: "#ff7a29" }, camera: { zoomFrom: 1, zoomTo: 1.04 },
    transition: { kind: "fade", seconds: 0.4 }, overlays: { progressBar: true, lowerThird: true, frame: "border" }, music: { style: "chill", gainDb: -26, duckDb: -10 } }),
  T({ id: "news-flash", name: "News Flash", description: "A broadcast look: breaking banner, lower third and a crisp wipe.", keywords: ["news", "breaking", "announcement", "update", "broadcast", "headline"],
    theme: { bg: "#140c0a", fg: "#ffffff", accent: "#e5382c", accent2: "#ffc670", font: "sans" },
    intro: { kind: "title-card", seconds: 1.8, title: "{title}", subtitle: "BREAKING" }, outro: { kind: "cta", seconds: 2, text: "More at toasty.media" },
    captions: { style: "bar", position: "bottom", size: 0.045 }, camera: { zoomFrom: 1, zoomTo: 1.03 },
    transition: { kind: "wipe", seconds: 0.3 }, overlays: { lowerThird: true, titleBadge: "BREAKING" }, music: { style: "tense", gainDb: -24, duckDb: -14 } }),
  T({ id: "vertical-pop", name: "Vertical Pop", description: "Made for 9:16 feeds: huge captions mid-frame, progress bar, quick punch-ins.", keywords: ["tiktok", "reels", "shorts", "vertical", "social", "feed", "story", "viral"], bestFor: ["9:16", "1:1"],
    theme: { bg: "#1b0f08", fg: "#fff4e0", accent: "#ff7a29", accent2: "#ffc670", font: "display" },
    intro: { kind: "rolling-title", seconds: 1.6, title: "{title}" }, outro: { kind: "cta", seconds: 2, text: "Follow for more", subtitle: "@toastymedia" },
    captions: { style: "kinetic", position: "center", size: 0.09, highlight: "#ffc670", uppercase: true },
    camera: { zoomFrom: 1.04, zoomTo: 1.14, punchIns: [{ at: 0.3, dur: 0.9, scale: 1.18 }, { at: 0.7, dur: 0.9, scale: 1.18 }] },
    transition: { kind: "slide", seconds: 0.3 }, overlays: { progressBar: true }, music: { style: "upbeat", gainDb: -19, duckDb: -15 } }),
  T({ id: "toasty-classic", name: "Toasty Classic", description: "The house look: brand colours, a logo sting in and a branded end card.", keywords: ["toasty", "brand", "branded", "classic", "default", "house", "logo"],
    theme: { bg: "#241510", fg: "#f4ead9", accent: "#ff7a29", accent2: "#ffc670", font: "display" },
    intro: { kind: "logo-sting", seconds: 2.2, title: "{title}" }, outro: { kind: "brand-end", seconds: 2.8, text: "Toasty Media", subtitle: "toasty.media" },
    captions: { style: "kinetic", position: "bottom", size: 0.055, highlight: "#ffc670" }, camera: { zoomFrom: 1, zoomTo: 1.07 },
    transition: { kind: "zoom", seconds: 0.4 }, overlays: { logo: true, lowerThird: true }, music: { style: "upbeat", gainDb: -22, duckDb: -14 } }),
  T({ id: "minimal-cut", name: "Minimal Cut", description: "Nothing added but captions and a clean fade: the moment, as it happened.", keywords: ["minimal", "plain", "simple", "raw", "no frills", "just the clip", "clean cut"],
    theme: { bg: "#111111", fg: "#ffffff", accent: "#ffc670", accent2: "#ff7a29", font: "sans" },
    intro: { kind: "none" }, outro: { kind: "none" }, captions: { style: "bar", position: "bottom", size: 0.045 }, camera: {},
    transition: { kind: "fade", seconds: 0.3 }, overlays: { logo: false }, music: { style: "none" }, audio: { enhance: true } })
]);

export function getTemplate(id) { return STARTER_TEMPLATES.find((t) => t.id === id) || null; }

// Template + per-clip overrides (from the edit panel or an interpreted instruction) -> a validated template.
export function applyOverrides(base, overrides = {}) {
  const merge = (a, b) => (b && typeof b === "object" && !Array.isArray(b) ? Object.fromEntries([...new Set([...Object.keys(a || {}), ...Object.keys(b)])].map((k) => [k, k in b ? (typeof a?.[k] === "object" && !Array.isArray(a?.[k]) ? merge(a[k], b[k]) : b[k]) : a[k]])) : (b === undefined ? a : b));
  return validateTemplate(merge(base, overrides));
}

// Fill {title} style placeholders.
export function fillText(str, vars = {}) { return String(str || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : "")).trim(); }
