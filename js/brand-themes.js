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
      "--studio-line-strong": "rgba(255, 170, 110, 0.28)",
      "--studio-line-warm": "rgba(184, 70, 14, 0.35)",
      "--studio-orange": "#ff7a29",
      "--studio-orange-bright": "#ffab5c",
      "--studio-amber": "#ffc670",
      "--studio-burnt": "#c1470f",
      "--studio-client-glow": "rgba(255, 122, 41, 0.24)"
    })
  }),
  "8alta": Object.freeze({
    id: "8alta",
    label: "8alta",
    showPoweredBy: true,
    textLogo: "8alta Studio",
    atmosphereBrand: "8ALTA",
    atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--studio-canvas": "#060b12",
      "--studio-canvas-2": "#07111f",
      "--studio-surface": "#0e1724",
      "--studio-surface-2": "#121f30",
      "--studio-surface-raised": "#18283c",
      "--studio-line-strong": "rgba(92, 199, 255, 0.28)",
      "--studio-line-warm": "rgba(72, 162, 255, 0.34)",
      "--studio-orange": "#48a2ff",
      "--studio-orange-bright": "#7ed6ff",
      "--studio-amber": "#c2f0ff",
      "--studio-burnt": "#1f6fd1",
      "--studio-client-glow": "rgba(72, 162, 255, 0.28)"
    })
  }),
  santati: Object.freeze({
    id: "santati",
    label: "Santati",
    showPoweredBy: true,
    textLogo: "Santati Studio",
    atmosphereBrand: "SANTATI",
    atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--studio-canvas": "#09110d",
      "--studio-canvas-2": "#0d1711",
      "--studio-surface": "#121d16",
      "--studio-surface-2": "#17271d",
      "--studio-surface-raised": "#1f3327",
      "--studio-line-strong": "rgba(219, 188, 108, 0.3)",
      "--studio-line-warm": "rgba(122, 179, 104, 0.34)",
      "--studio-orange": "#d7b56d",
      "--studio-orange-bright": "#f5d889",
      "--studio-amber": "#ffe7a8",
      "--studio-burnt": "#718f46",
      "--studio-client-glow": "rgba(219, 188, 108, 0.26)"
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
    elements.poweredBy.textContent = "Powered by Toasty Media";
  }

  if (elements.atmosphereBrandWord) {
    elements.atmosphereBrandWord.textContent = theme.atmosphereBrand;
  }

  if (elements.atmosphereProductWord) {
    elements.atmosphereProductWord.textContent = theme.atmosphereProduct;
  }

  return theme;
}
