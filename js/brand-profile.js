import { BRAND_THEMES, DEFAULT_BRAND_THEME, normalizeBrandTheme } from "./brand-themes.js";

const STORAGE_KEY = "toastyBrandProfiles";

const PROFILE_DEFAULTS = {
  description: "",
  creatorName: "",
  creatorTitle: "",
  creatorHandle: "",
  logos: [],
  watermark: true,
  introAsset: "",
  outroAsset: "",
  defaultCTA: "",
  website: "",
  lowerThird: "",
  backgroundPreference: "",
  fontDirection: "",
  visualStyle: "",
  toneOfVoice: "",
  writingStyle: "",
  captionStyle: "",
  lowerThirdStyle: "",
  introStyle: "",
  outroStyle: "",
  ctaStyle: "",
  musicDirection: "",
  musicAsset: "",
  musicVolume: 0.12,
  defaultAspectRatio: "16:9",
  introDuration: 1.6,
  outroDuration: 2.4,
  avatarPreference: "",
  cameraDirection: "",
  thumbnailDirection: "",
  forbiddenStyles: [],
  preferredPhrases: [],
  avoidPhrases: [],
  platformPreferences: {},
  notes: ""
};

const DEFAULT_PROFILES = Object.freeze({
  toasty: Object.freeze({
    id: "toasty",
    name: "Toasty Media",
    description: "Warm, clever, high-energy creative production for ideas that need to feel human and worth watching.",
    creatorName: "Ricardo Casanova",
    creatorTitle: "Founder / Toasty Media",
    creatorHandle: "@ricardocasanova",
    logos: ["../shared/brand/toasty-media/ToastyMediaStudio.png"],
    watermark: true,
    defaultCTA: "Connect with Ricardo",
    website: "toasty.media",
    lowerThird: "Ricardo Casanova · Founder / Toasty Media",
    primaryColor: "#ff7a29",
    secondaryColor: "#ffc670",
    accentColor: "#ffab5c",
    backgroundPreference: "dark studio canvas with orange/fire glow and warm paper writing surfaces",
    fontDirection: "bold Montserrat headlines with readable Inter body text",
    visualStyle: "cinematic studio energy, firelight accents, practical creator-led visuals, minimal clutter",
    toneOfVoice: "energetic, warm, punchy, opinionated, useful",
    writingStyle: "short sentences, strong hooks, concrete proof, no corporate fog",
    captionStyle: "minimal text, high contrast, punchy lines that do not crowd the frame",
    lowerThirdStyle: "compact dark lower thirds with Toasty orange accent line",
    introStyle: "start immediately with the strongest human line",
    outroStyle: "land on a useful takeaway, not a generic sign-off",
    ctaStyle: "direct and practical with one clear next move",
    musicDirection: "warm pulse, light momentum, never overpowering the voice",
    defaultAspectRatio: "16:9",
    introDuration: 1.6,
    outroDuration: 2.4,
    avatarPreference: "creator digital twin driven by real recorded narration",
    cameraDirection: "confident eye-line, subtle punch-ins, avoid static talking head fatigue",
    thumbnailDirection: "bold face or object, orange contrast, 3-5 words max",
    forbiddenStyles: ["generic robot visuals", "cold SaaS gradients", "dense text slides", "AI voiceover"],
    preferredPhrases: ["worth watching", "make it real", "show the proof"],
    avoidPhrases: ["unlock synergy", "leverage cutting-edge", "AI-powered solution"],
    platformPreferences: {
      LinkedIn: { pacing: "polished and concise", targetDuration: 60, aspectRatio: "4:5" },
      "YouTube Shorts": { pacing: "fast hook, clean payoff", targetDuration: 45, aspectRatio: "9:16" },
      "Instagram Reels": { pacing: "visual and punchy", targetDuration: 35, aspectRatio: "9:16" },
      TikTok: { pacing: "direct and immediate", targetDuration: 30, aspectRatio: "9:16" },
      YouTube: { pacing: "structured and clear", targetDuration: 120, aspectRatio: "16:9" },
      Generic: { pacing: "tight and useful", targetDuration: 45, aspectRatio: "9:16" }
    },
    notes: "Preserve the creator's real narration as the source of truth."
  }),
  "8alta": Object.freeze({
    id: "8alta",
    name: "8alta",
    description: "Premium executive production with quiet confidence and precise delivery.",
    creatorName: "8alta",
    creatorTitle: "Executive AI Strategy",
    logos: ["../shared/brand/clients/8alta/logo.svg"],
    watermark: true,
    defaultCTA: "Book a strategic conversation",
    website: "8alta.com",
    lowerThird: "8alta · Executive AI Strategy",
    primaryColor: "#d7b56d",
    secondaryColor: "#f4ead9",
    accentColor: "#f1d48b",
    backgroundPreference: "dark executive canvas with restrained gold accents",
    fontDirection: "bold editorial headings, crisp professional body text",
    visualStyle: "premium advisory, composed, evidence-led, minimal ornament",
    toneOfVoice: "authoritative, calm, precise, executive",
    writingStyle: "clear claims, measured confidence, boardroom-ready language",
    captionStyle: "restrained captions with generous spacing",
    lowerThirdStyle: "minimal dark lower thirds with gold accent",
    introStyle: "lead with a sharp executive problem",
    outroStyle: "close with a strategic decision or next action",
    ctaStyle: "measured invitation to act with clarity",
    musicDirection: "subtle premium pulse",
    defaultAspectRatio: "16:9",
    introDuration: 1.6,
    outroDuration: 2.4,
    avatarPreference: "polished creator avatar driven by real narration",
    cameraDirection: "steady, frontal, composed",
    thumbnailDirection: "high contrast, premium restraint, no visual noise",
    forbiddenStyles: ["cartoon visuals", "hype language", "busy captions", "AI voiceover"],
    preferredPhrases: ["clear decision", "production proof", "executive signal"],
    avoidPhrases: ["viral hack", "crazy", "game changer"],
    platformPreferences: {},
    notes: "Use sparing visual emphasis."
  }),
  santati: Object.freeze({
    id: "santati",
    name: "Santati",
    description: "Trust-building, nature-aligned production with clarity and grounded warmth.",
    creatorName: "Santati",
    creatorTitle: "Trust-centered CRM",
    logos: ["../shared/brand/clients/santati/logo.svg"],
    watermark: true,
    defaultCTA: "Start with a clear next step",
    website: "santaticrm.com",
    lowerThird: "Santati · Trust-centered CRM",
    primaryColor: "#7ab368",
    secondaryColor: "#3c95a9",
    accentColor: "#d9bf78",
    backgroundPreference: "deep green canvas with organic highlights",
    fontDirection: "clean readable type with grounded spacing",
    visualStyle: "natural, calm, trustworthy, human-centered",
    toneOfVoice: "grounded, warm, clear, reassuring",
    writingStyle: "plain language, gentle authority, practical examples",
    captionStyle: "clear captions with soft contrast and natural pacing",
    lowerThirdStyle: "clean lower thirds with green accent",
    introStyle: "begin with a relatable human need",
    outroStyle: "end with confidence and care",
    ctaStyle: "supportive, specific, low-friction",
    musicDirection: "light organic bed, calm momentum",
    defaultAspectRatio: "16:9",
    introDuration: 1.6,
    outroDuration: 2.4,
    avatarPreference: "natural creator avatar driven by real narration",
    cameraDirection: "warm eye-line, soft movement",
    thumbnailDirection: "natural contrast, human warmth",
    forbiddenStyles: ["harsh glitch effects", "robot visuals", "fear-based copy", "AI voiceover"],
    preferredPhrases: ["with care", "clear next step", "built on trust"],
    avoidPhrases: ["disrupt", "dominate", "crush it"],
    platformPreferences: {},
    notes: "Favor trust and clarity over urgency."
  })
});

export function getBrandProfiles() {
  const saved = readSavedProfiles();
  return Object.values(BRAND_THEMES).map((theme) => mergeProfile(DEFAULT_PROFILES[theme.id] || profileFromTheme(theme), saved[theme.id]));
}

export function getBrandProfile(profileId = DEFAULT_BRAND_THEME) {
  const normalized = normalizeBrandTheme(profileId);
  return getBrandProfiles().find((profile) => profile.id === normalized) || getBrandProfiles()[0];
}

export function saveBrandProfile(profile) {
  const profiles = readSavedProfiles();
  profiles[profile.id] = mergeProfile(getBrandProfile(profile.id), profile);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  return profiles[profile.id];
}

function readSavedProfiles() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function profileFromTheme(theme) {
  return {
    ...PROFILE_DEFAULTS,
    id: theme.id,
    name: theme.label,
    logos: theme.logoSrc ? [theme.logoSrc] : [],
    primaryColor: theme.vars["--studio-orange"],
    secondaryColor: theme.vars["--studio-amber"],
    accentColor: theme.vars["--studio-orange-bright"],
    visualStyle: `${theme.label} studio style`,
    toneOfVoice: "clear, useful, brand-consistent",
    writingStyle: "concise and direct",
    captionStyle: "readable, high contrast",
    ctaStyle: "one clear next step"
  };
}

function mergeProfile(base, override = {}) {
  return {
    ...PROFILE_DEFAULTS,
    ...base,
    ...override,
    platformPreferences: {
      ...(base?.platformPreferences || {}),
      ...(override?.platformPreferences || {})
    }
  };
}
