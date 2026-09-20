#!/usr/bin/env node
// Brand-skin regression for Toasty Studio.
// Run: node --experimental-default-type=module scripts/brand-skins-test.mjs

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELECTOR_IDS = [
  "toasty",
  "8alta",
  "santati",
  "tangem",
  "superteam",
  "peeps"
];
const FROZEN_SKINS = Object.freeze({
  toasty: Object.freeze({
    label: "Toasty Media",
    primary: "#ff7a29",
    secondary: "#ffc670",
    accent: "#ffab5c",
    logoSrc: "../shared/brand/toasty-media/ToastyMediaStudio.png",
    showPoweredBy: false
  }),
  "8alta": Object.freeze({
    label: "8ALTA",
    primary: "#c8a45d",
    secondary: "#f5f1e8",
    accent: "#d8c17e",
    logoSrc: "https://www.8alta.com/assets/8alta-logo-gold-transparent.png",
    showPoweredBy: true
  }),
  santati: Object.freeze({
    label: "Santati",
    primary: "#6f45ff",
    secondary: "#18d8c0",
    accent: "#ff4fc3",
    logoSrc: "https://www.santaticrm.com/assets/santati-logo-only-white.png",
    showPoweredBy: true
  }),
  tangem: Object.freeze({
    label: "Tangem",
    primary: "#0099ff",
    secondary: "#ffffff",
    accent: "#33aaff",
    logoSrc: undefined,
    showPoweredBy: true
  })
});

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); }
};

function createStyleMap() {
  const props = new Map();
  const style = {
    backgroundImage: "",
    setProperty(name, value) {
      props.set(name, value);
      if (name === "background-image") this.backgroundImage = value;
    },
    removeProperty(name) {
      props.delete(name);
      if (name === "background-image") this.backgroundImage = "";
    },
    getPropertyValue(name) {
      if (name === "background-image") return this.backgroundImage || props.get(name) || "";
      return props.get(name) || "";
    }
  };
  return style;
}

function createElement(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    hidden: false,
    src: "",
    alt: "",
    href: "",
    textContent: "",
    value: "",
    id: "",
    className: "",
    innerHTML: "",
    dataset: {},
    style: createStyleMap(),
    classList: { contains: () => false },
    children: [],
    onerror: null,
    click() {},
    replaceChildren(...nodes) { this.children = nodes; },
    appendChild(node) { this.children.push(node); return node; }
  };
}

const body = createElement("body");
body.dataset = {};
const documentStub = {
  body,
  title: "",
  createElement,
  querySelector: () => null,
  querySelectorAll: () => []
};

globalThis.window = {
  location: { search: "" },
  localStorage
};
globalThis.localStorage = localStorage;
globalThis.document = documentStub;

const {
  BRAND_THEMES,
  BRAND_THEME_IDS,
  BRAND_THEME_VAR_KEYS,
  DEFAULT_BRAND_THEME,
  applyBrandTheme,
  getInitialBrandTheme,
  normalizeBrandTheme,
  populateBrandThemeSelect,
  saveBrandTheme
} = await import("../js/brand-themes.js");
const { getBrandProfile, getBrandProfiles } = await import("../js/brand-profile.js");
const { createProductionSpec } = await import("../js/production-spec.js");
const { buildTimeline } = await import("../js/render-client.js");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed += 1;
    console.error(`  FAIL — ${message}`);
    return;
  }
  passed += 1;
  console.log(`  ok — ${message}`);
}

function themeChrome() {
  return {
    root: Object.assign(createElement("body"), { dataset: {}, style: createStyleMap() }),
    logoImg: createElement("img"),
    logoText: createElement("span"),
    poweredBy: createElement("span"),
    brandLink: createElement("a"),
    atmosphereBrandWord: createElement("span"),
    atmosphereProductWord: createElement("span"),
    atmosphereMark: createElement("div")
  };
}

function projectFixture(brandProfile) {
  return {
    id: "proj-brand-skins",
    source: {
      topic: `${brandProfile.name} test`,
      platform: "YouTube Shorts",
      aspectRatio: "9:16",
      targetDuration: 45
    },
    script: { hook: "Hook", body: "Body", cta: brandProfile.defaultCTA, title: "Title" },
    scenes: [{
      id: "scene-1",
      order: 1,
      scriptText: "Hello",
      captionText: "Hello",
      estimatedDuration: 3,
      visualType: "Text/card",
      lowerThird: brandProfile.lowerThird,
      watermark: true
    }],
    assets: [],
    audio: null,
    brandProfileId: brandProfile.id
  };
}

console.log("Brand skins\n");

assert(DEFAULT_BRAND_THEME === "toasty", "default brand theme remains Toasty");
assert(SELECTOR_IDS.every((id) => BRAND_THEMES[id]), "all requested profiles exist in BRAND_THEMES");
assert(!BRAND_THEMES.alice, "Alice in Cryptoland is permanently retired from BRAND_THEMES");
assert(!BRAND_THEME_IDS.includes("alice"), "Alice is not in BRAND_THEME_IDS");
assert(BRAND_THEME_IDS.includes("optimai"), "existing OptimAI skin remains registered");

const profiles = getBrandProfiles();
const profileIds = profiles.map((profile) => profile.id);
assert(!profileIds.includes("alice"), "getBrandProfiles does not resurrect Alice");
SELECTOR_IDS.forEach((id) => {
  const theme = BRAND_THEMES[id];
  const profile = getBrandProfile(id);
  assert(theme.id === id, `${id} theme resolves`);
  assert(profile.id === id, `${id} BrandProfile resolves`);
  if (["superteam", "peeps"].includes(id)) {
    assert(profile.name === theme.label, `${id} profile name matches theme label`);
  }
  assert(profile.primaryColor === theme.vars["--brand-primary"], `${id} primary color is wired from theme`);
  assert(Array.isArray(BRAND_THEME_VAR_KEYS) && BRAND_THEME_VAR_KEYS.length > 0, `${id} token key list is defined`);
  const missing = BRAND_THEME_VAR_KEYS.filter((key) => theme.vars[key] == null || theme.vars[key] === "");
  assert(missing.length === 0, `${id} has every CSS token (${missing.join(", ") || "none missing"})`);
});

const select = createElement("select");
populateBrandThemeSelect(select, "toasty");
const optionIds = select.children.map((option) => option.value);
const optionLabels = select.children.map((option) => option.textContent);
assert(SELECTOR_IDS.every((id) => optionIds.includes(id)), `selector exposes all skins (${optionIds.join(", ")})`);
assert(!optionIds.includes("alice"), "selector does not include Alice");
assert(optionLabels.includes("Superteam Thailand"), "selector label includes Superteam Thailand");
assert(optionLabels.includes("Toasty Peeps"), "selector label includes Toasty Peeps");
assert(select.value === "toasty", "selector selects the active theme");

populateBrandThemeSelect(select, "superteam");
assert(select.value === "superteam", "switching the selector to Superteam Thailand works");

const chrome = themeChrome();
applyBrandTheme("toasty", chrome);
assert(chrome.root.dataset.brandTheme === "toasty", "applying Toasty sets data-brand-theme");
assert(chrome.root.style.getPropertyValue("--brand-primary") === "#ff7a29", "Toasty primary lands on the root");
assert(chrome.root.style.getPropertyValue("--studio-compact-mark-image").includes("ToastyTransparent.png"), "Toasty compact mark uses the transparent mark");

applyBrandTheme("8alta", chrome);
assert(chrome.root.dataset.lowerThirdMark === "shown", "8ALTA compact mark is shown from favicon");
assert(chrome.root.style.getPropertyValue("--studio-compact-mark-image").includes("favicon.ico"), "8ALTA compact mark is the favicon");

applyBrandTheme("superteam", chrome);
assert(chrome.root.dataset.brandTheme === "superteam", "switching to Superteam updates immediately");
assert(chrome.root.style.getPropertyValue("--brand-primary") === "#c8102e", "Superteam primary is Thai red, not purple");
assert(chrome.root.style.getPropertyValue("--studio-canvas") === "#050814", "Superteam structural canvas is deep navy");
assert(chrome.root.style.getPropertyValue("--brand-primary") !== "#9945ff", "Superteam does not use Solana purple as primary");
assert(chrome.root.style.getPropertyValue("--studio-mark-image").includes("watermark-elephant.png"), "Superteam watermark is the elephant cutout");
assert(chrome.root.style.getPropertyValue("--studio-silhouette-image").includes("silhouette-skyline.png"), "Superteam silhouette token is set");
assert(chrome.root.style.getPropertyValue("--studio-identity-stripe").includes("#a51931"), "Superteam identity stripe uses Thai flag colors");
assert(chrome.root.dataset.logoTreatment === "centered-mark", "Superteam logo treatment is declarative");
assert(chrome.root.dataset.lowerThirdTreatment === "navy-flag-bar", "Superteam lower-third treatment is declarative");
assert(chrome.logoImg.src.includes("superteam-thailand/logo.png"), "Superteam logo is applied");
assert(chrome.poweredBy.hidden === false, "Superteam shows Powered by Toasty");

applyBrandTheme("peeps", chrome);
assert(chrome.root.dataset.brandTheme === "peeps", "switching to Toasty Peeps updates immediately");
assert(chrome.root.style.getPropertyValue("--studio-canvas") === "#fbf6ee", "Peeps canvas is warm cream, not dark Toasty");
assert(chrome.root.style.getPropertyValue("--brand-background") === "#fbf6ee", "Peeps brand background is cream");
assert(chrome.root.style.getPropertyValue("--brand-text") === "#3d2415", "Peeps text is dark chocolate");
assert(chrome.root.style.getPropertyValue("--studio-mark-image").includes("watermark-mascot.png"), "Peeps watermark is the mascot cutout");
assert(chrome.root.dataset.logoTreatment === "warm-lockup", "Peeps logo treatment is declarative");
assert(chrome.root.dataset.introTreatment === "people-first", "Peeps intro treatment is declarative");
assert(chrome.poweredBy.hidden === true, "Peeps does not show client Powered by chrome");
assert(chrome.atmosphereProductWord.textContent === "PEEPS", "Peeps atmosphere product is distinct from STUDIO");
assert(chrome.root.style.getPropertyValue("--studio-canvas") !== BRAND_THEMES.toasty.vars["--studio-canvas"], "Peeps is not a dark Toasty clone");

applyBrandTheme("toasty", chrome);
assert(chrome.root.style.getPropertyValue("--brand-primary") === "#ff7a29", "switching back to Toasty restores Toasty primary");
assert(chrome.brandLink.href.includes("site"), "switching back to Toasty restores the Toasty home URL");
assert(!chrome.root.dataset.logoTreatment, "switching back to Toasty clears Superteam/Peeps treatments");

saveBrandTheme("peeps");
assert(getInitialBrandTheme("", { useStorage: true }) === "peeps", "selected skin persists in localStorage");
assert(getInitialBrandTheme("?brand=superteam-thailand") === "superteam", "URL alias superteam-thailand resolves");
assert(getInitialBrandTheme("?brand=alice-in-cryptoland") === "toasty", "retired Alice URL falls back to Toasty");
assert(getInitialBrandTheme("?brand=toasty-peeps") === "peeps", "URL alias toasty-peeps resolves");
assert(normalizeBrandTheme("alice") === "toasty", "retired Alice id falls back to Toasty");
assert(normalizeBrandTheme("unknown-brand") === "toasty", "unknown ids fall back to Toasty rather than throwing");

SELECTOR_IDS.forEach((id) => {
  const brandProfile = getBrandProfile(id);
  const project = projectFixture(brandProfile);
  const spec = createProductionSpec({
    project,
    brandProfile,
    angle: null,
    script: project.script,
    scenes: project.scenes
  });
  const timeline = buildTimeline({ project, productionSpec: spec, brandProfile });
  assert(spec.brandProfileId === id, `production spec for ${id} keeps brandProfileId`);
  assert(spec.brandOverlays.primaryColor === brandProfile.primaryColor, `production preview overlays for ${id} use the selected primary`);
  assert(JSON.stringify(spec.brandOverlays.logos || []) === JSON.stringify(brandProfile.logos || []), `production logos for ${id} match the profile`);
  assert(timeline[0].overlay.brandProfileId === id, `render timeline for ${id} carries overlay.brandProfileId`);
  assert(timeline[0].overlay.primaryColor === brandProfile.primaryColor, `render/export overlay for ${id} uses selected primary, not Toasty fallback`);
  assert(timeline[0].overlay.defaultCTA === (brandProfile.defaultCTA || brandProfile.ctaStyle), `render/export CTA for ${id} comes from the selected profile`);
  assert("lowerThirdTreatment" in spec.brandOverlays, `production spec for ${id} carries lowerThirdTreatment`);
  assert("introTreatment" in spec.brandOverlays, `production spec for ${id} carries introTreatment`);
  assert(timeline[0].overlay.lowerThirdTreatment === (brandProfile.lowerThirdTreatment || ""), `render overlay for ${id} carries lowerThirdTreatment`);
});

assert(getBrandProfile("superteam").lowerThirdTreatment === "navy-flag-bar", "Superteam profile carries lower-third treatment");
assert(getBrandProfile("peeps").introTreatment === "people-first", "Peeps profile carries intro treatment");
assert(getBrandProfile("superteam").backgroundWatermark.includes("watermark-elephant.png"), "Superteam profile points at the elephant watermark");
assert(getBrandProfile("peeps").backgroundWatermark.includes("watermark-mascot.png"), "Peeps profile points at the mascot watermark");

Object.entries(FROZEN_SKINS).forEach(([id, frozen]) => {
  const theme = BRAND_THEMES[id];
  const profile = getBrandProfile(id);
  assert(theme.label === frozen.label, `${id} label unchanged`);
  assert(theme.vars["--brand-primary"] === frozen.primary, `${id} primary color unchanged`);
  assert(theme.vars["--brand-secondary"] === frozen.secondary, `${id} secondary color unchanged`);
  assert(theme.vars["--brand-accent"] === frozen.accent, `${id} accent color unchanged`);
  assert(theme.logoSrc === frozen.logoSrc, `${id} logo unchanged`);
  assert(theme.showPoweredBy === frozen.showPoweredBy, `${id} powered-by flag unchanged`);
  assert(profile.primaryColor === frozen.primary, `${id} BrandProfile primary unchanged`);
});

const tangemChrome = themeChrome();
applyBrandTheme("tangem", tangemChrome);
assert(tangemChrome.logoImg.hidden === true, "Tangem with no official logo hides the image slot");
assert(tangemChrome.logoText.hidden === false, "Tangem falls back to textLogo instead of a Toasty mark");
assert(tangemChrome.root.style.getPropertyValue("--studio-mark-image") === "none", "Tangem atmosphere mark does not leak the Toasty flame");
assert(tangemChrome.atmosphereMark.style.getPropertyValue("background-image") === "none" || tangemChrome.atmosphereMark.style.backgroundImage === "none", "Tangem atmosphere background is none");
assert(getBrandProfile("tangem").logos.length === 0, "Tangem profile keeps an empty logos list");

const missingAssetChrome = themeChrome();
applyBrandTheme("superteam", missingAssetChrome);
missingAssetChrome.logoImg.onerror();
assert(missingAssetChrome.logoImg.hidden === true, "unavailable brand image hides instead of keeping a broken Toasty/default mark");
assert(missingAssetChrome.logoText.hidden === false, "unavailable brand image reveals the text lockup");
assert(missingAssetChrome.logoText.textContent === "Superteam Thailand Studio", "text fallback uses the selected brand, not Toasty");

assert(existsSync(join(ROOT, "shared/brand/clients/superteam-thailand/logo.png")), "Superteam Thailand transparent mark is present");
assert(existsSync(join(ROOT, "shared/brand/clients/superteam-thailand/source/mark-square.png")), "Superteam supplied source mark is preserved");
assert(existsSync(join(ROOT, "shared/brand/clients/superteam-thailand/source/lockup-cinematic.png")), "Superteam cinematic lockup source is preserved");
assert(existsSync(join(ROOT, "shared/brand/clients/superteam-thailand/watermark-elephant.png")), "Superteam elephant watermark is present");
assert(existsSync(join(ROOT, "shared/brand/clients/superteam-thailand/silhouette-skyline.png")), "Superteam skyline silhouette is present");
assert(existsSync(join(ROOT, "shared/brand/toasty-peeps/logo.png")), "Toasty Peeps transparent lockup is present");
assert(existsSync(join(ROOT, "shared/brand/toasty-peeps/source/logo-source.png")), "Toasty Peeps supplied source artwork is preserved");
assert(existsSync(join(ROOT, "shared/brand/toasty-peeps/watermark-mascot.png")), "Toasty Peeps mascot watermark is present");
assert(!existsSync(join(ROOT, "shared/brand/clients/alice-cryptoland/logo.png")), "Alice in Cryptoland assets are removed");

assert(getBrandProfile("peeps").primaryColor === "#ff7a29", "Peeps keeps Toasty orange");
assert(getBrandProfile("peeps").supportingPalette.includes("#fbf6ee"), "Peeps supporting palette includes cream");
assert(profileIds.includes("superteam") && profileIds.includes("peeps"), "getBrandProfiles includes Superteam and Peeps");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
