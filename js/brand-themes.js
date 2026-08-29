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
  "8alta": Object.freeze({
    id: "8alta",
    label: "8alta",
    showPoweredBy: true,
    logoSrc: "../shared/brand/clients/8alta/logo.svg",
    logoAlt: "8ALTA Studio",
    textLogo: "8alta Studio",
    atmosphereBrand: "8ALTA",
    atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--studio-canvas": "#060b12",
      "--studio-canvas-2": "#0c0f17",
      "--studio-surface": "#14151d",
      "--studio-surface-2": "#1b1b24",
      "--studio-surface-raised": "#24232f",
      "--studio-line": "rgba(215, 181, 109, 0.13)",
      "--studio-line-strong": "rgba(215, 181, 109, 0.34)",
      "--studio-line-warm": "rgba(244, 234, 217, 0.25)",
      "--studio-cream": "#f4ead9",
      "--studio-cream-dim": "#d8ccb8",
      "--studio-muted": "#9b968b",
      "--studio-orange": "#d7b56d",
      "--studio-orange-bright": "#f1d48b",
      "--studio-amber": "#f4ead9",
      "--studio-burnt": "#8f743c",
      "--studio-brown": "#28202a",
      "--studio-green": "#52b788",
      "--studio-client-glow": "rgba(215, 181, 109, 0.28)"
    })
  }),
  santati: Object.freeze({
    id: "santati",
    label: "Santati",
    showPoweredBy: true,
    logoSrc: "../shared/brand/clients/santati/logo.svg",
    logoAlt: "Santati Studio",
    textLogo: "Santati Studio",
    atmosphereBrand: "SANTATI",
    atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--studio-canvas": "#09110d",
      "--studio-canvas-2": "#0e1915",
      "--studio-surface": "#14211c",
      "--studio-surface-2": "#192b25",
      "--studio-surface-raised": "#20372f",
      "--studio-line": "rgba(122, 179, 104, 0.14)",
      "--studio-line-strong": "rgba(122, 179, 104, 0.34)",
      "--studio-line-warm": "rgba(60, 149, 169, 0.28)",
      "--studio-cream": "#eef6ef",
      "--studio-cream-dim": "#c8d9ce",
      "--studio-muted": "#92aaa0",
      "--studio-orange": "#7ab368",
      "--studio-orange-bright": "#a7d993",
      "--studio-amber": "#d9bf78",
      "--studio-burnt": "#3c95a9",
      "--studio-brown": "#17332b",
      "--studio-green": "#7ab368",
      "--studio-client-glow": "rgba(122, 179, 104, 0.28)"
    })
  })
});

export function normalizeBrandTheme(themeId) {
  const normalized = String(themeId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
    // Theme persistence is nice to have, not critical to running a session.
  }
}

export function applyBrandTheme(themeId, elements = {}) {
  const theme = BRAND_THEMES[normalizeBrandTheme(themeId)];
  const root = elements.root || document.body;
  root.dataset.brandTheme = theme.id;

  Object.entries(theme.vars).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });

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

  if (elements.poweredBy) {
    elements.poweredBy.hidden = !theme.showPoweredBy;
  }

  if (elements.atmosphereBrandWord) {
    elements.atmosphereBrandWord.textContent = theme.atmosphereBrand;
  }

  if (elements.atmosphereProductWord) {
    elements.atmosphereProductWord.textContent = theme.atmosphereProduct;
  }

  return theme;
}
