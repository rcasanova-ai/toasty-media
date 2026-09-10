export const DEFAULT_BRAND_THEME = "toasty";

const THEME_STORAGE_KEY = "toastyStudioBrandTheme";

export const BRAND_THEMES = Object.freeze({
  toasty: Object.freeze({
    id: "toasty",
    label: "Toasty Media",
    showPoweredBy: false,
    logoSrc: "../shared/brand/toasty-media/ToastyMediaStudio.png",
    logoAlt: "Toasty Media Studio",
    textLogo: "Toasty Studio",
    atmosphereBrand: "TOASTY",
    atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--studio-canvas": "#0b0908",
      "--studio-canvas-2": "#0f0b0a",
      "--studio-surface": "#171210",
      "--studio-surface-2": "#201815",
      "--studio-surface-raised": "#2a201a",
      "--studio-line": "rgba(230, 200, 168, 0.1)",
      "--studio-line-strong": "rgba(255, 170, 110, 0.28)",
      "--studio-line-warm": "rgba(184, 70, 14, 0.35)",
      "--studio-cream": "#f4ead9",
      "--studio-cream-dim": "#d3c2ac",
      "--studio-muted": "#9c8d7c",
      "--studio-orange": "#ff7a29",
      "--studio-orange-bright": "#ffab5c",
      "--studio-amber": "#ffc670",
      "--studio-burnt": "#c1470f",
      "--studio-brown": "#4a2d2a",
      "--studio-green": "#34c77b",
      "--studio-client-glow": "rgba(255, 122, 41, 0.24)"
    })
  }),
  workspace: Object.freeze({
    id: "workspace",
    label: "Workspace brand",
    showPoweredBy: true,
    logoSrc: null,
    logoAlt: "Workspace Studio",
    textLogo: "Workspace Studio",
    atmosphereBrand: "YOUR",
    atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--studio-canvas": "#0a0d12",
      "--studio-canvas-2": "#10141b",
      "--studio-surface": "#151a22",
      "--studio-surface-2": "#1c232d",
      "--studio-surface-raised": "#252d39",
      "--studio-line": "rgba(255,255,255,0.10)",
      "--studio-line-strong": "rgba(255,255,255,0.24)",
      "--studio-line-warm": "rgba(214,180,109,0.28)",
      "--studio-cream": "#f5f1e8",
      "--studio-cream-dim": "#d8d3ca",
      "--studio-muted": "#98a1ad",
      "--studio-orange": "#d6b46d",
      "--studio-orange-bright": "#efd28e",
      "--studio-amber": "#f5e7bd",
      "--studio-burnt": "#9b7a3b",
      "--studio-brown": "#20252d",
      "--studio-green": "#5ec58b",
      "--studio-client-glow": "rgba(214,180,109,0.24)"
    })
  })
});

export function normalizeBrandTheme(themeId) {
  const normalized = String(themeId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["8alta", "santati", "client", "custom"].includes(normalized)) return "workspace";
  return BRAND_THEMES[normalized]?.id || DEFAULT_BRAND_THEME;
}

export function getInitialBrandTheme(search = window.location.search, options = {}) {
  const { useStorage = true } = options;
  const fromUrl = new URLSearchParams(search).get("brand");
  if (fromUrl) return normalizeBrandTheme(fromUrl);
  if (!useStorage) return DEFAULT_BRAND_THEME;
  try {
    return normalizeBrandTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_BRAND_THEME;
  }
}

export function saveBrandTheme(themeId) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, normalizeBrandTheme(themeId));
  } catch {
    // Theme persistence is optional.
  }
}

export function applyBrandTheme(themeId, elements = {}) {
  const theme = BRAND_THEMES[normalizeBrandTheme(themeId)];
  const root = elements.root || document.body;
  root.dataset.brandTheme = theme.id;
  Object.entries(theme.vars).forEach(([property, value]) => root.style.setProperty(property, value));

  if (elements.logoImg) {
    if (theme.logoSrc) {
      elements.logoImg.hidden = false;
      elements.logoImg.src = theme.logoSrc;
      elements.logoImg.alt = theme.logoAlt || `${theme.label} Studio`;
    } else {
      elements.logoImg.hidden = true;
    }
  }
  if (elements.logoText) {
    elements.logoText.hidden = Boolean(theme.logoSrc);
    elements.logoText.textContent = theme.textLogo || `${theme.label} Studio`;
  }
  if (elements.poweredBy) elements.poweredBy.hidden = !theme.showPoweredBy;
  if (elements.atmosphereBrandWord) elements.atmosphereBrandWord.textContent = theme.atmosphereBrand;
  if (elements.atmosphereProductWord) elements.atmosphereProductWord.textContent = theme.atmosphereProduct;
  return theme;
}

// Keep customer identities out of Toasty's product UI. Existing legacy theme links
// remain compatible, but Studio presents only Toasty or a generic white-label workspace.
if (typeof document !== "undefined") {
  document.querySelectorAll("#brandThemeSelect, #aiBrandProfile").forEach((select) => {
    select.innerHTML = '<option value="toasty">Toasty Media</option><option value="workspace">Workspace brand</option>';
  });
}
