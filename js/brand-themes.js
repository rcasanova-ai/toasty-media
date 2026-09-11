export const DEFAULT_BRAND_THEME = "toasty";

const THEME_STORAGE_KEY = "toastyStudioBrandTheme";
const MODULE_KEY = "toastyStudioModules";
const DEFAULT_MODULES = Object.freeze({ live: true, ai: true, expertise: true });

export const BRAND_THEMES = Object.freeze({
  toasty: Object.freeze({
    id: "toasty", label: "Toasty Media", showPoweredBy: false,
    logoSrc: "../shared/brand/toasty-media/ToastyMediaStudio.png", logoAlt: "Toasty Media Studio",
    textLogo: "Toasty Studio", atmosphereBrand: "TOASTY", atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--brand-primary":"#ff7a29","--brand-secondary":"#ffc670","--brand-accent":"#ffab5c","--brand-background":"#0b0908","--brand-surface":"#171210","--brand-surface-alt":"#201815","--brand-text":"#f4ead9","--brand-text-muted":"#9c8d7c","--brand-border":"rgba(230, 200, 168, 0.1)","--brand-button":"#ff7a29","--brand-button-text":"#1c0f06","--brand-focus":"#ffab5c","--brand-gradient":"linear-gradient(135deg, #ffc670, #ff7a29 60%, #c1470f)","--brand-heading-font":"Montserrat, Inter, system-ui, sans-serif","--brand-body-font":"Inter, system-ui, -apple-system, sans-serif",
      "--studio-canvas":"#0b0908","--studio-canvas-2":"#0f0b0a","--studio-surface":"#171210","--studio-surface-2":"#201815","--studio-surface-raised":"#2a201a","--studio-line":"rgba(230, 200, 168, 0.1)","--studio-line-strong":"rgba(255, 170, 110, 0.28)","--studio-line-warm":"rgba(184, 70, 14, 0.35)","--studio-cream":"#f4ead9","--studio-cream-dim":"#d3c2ac","--studio-muted":"#9c8d7c","--studio-orange":"#ff7a29","--studio-orange-bright":"#ffab5c","--studio-amber":"#ffc670","--studio-burnt":"#c1470f","--studio-brown":"#4a2d2a","--studio-green":"#34c77b","--studio-client-glow":"rgba(255, 122, 41, 0.24)","--studio-button-text":"#1c0f06","--studio-button-shadow":"rgba(255, 122, 41, 0.32)","--studio-button-shadow-hover":"rgba(255, 122, 41, 0.42)","--studio-atmosphere-stroke":"rgba(255, 171, 92, 0.06)","--studio-atmosphere-stroke-2":"rgba(244, 234, 217, 0.045)","--studio-mark-opacity":"0.05"
    })
  }),
  "8alta": Object.freeze({
    id: "8alta", label: "8ALTA", showPoweredBy: true,
    logoSrc: "../shared/brand/clients/8alta/logo.svg", logoAlt: "8ALTA",
    textLogo: "8ALTA Production Studio", atmosphereBrand: "8ALTA", atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--brand-primary":"#1c355c","--brand-secondary":"#c9a24f","--brand-accent":"#e5c879","--brand-background":"#eaf1f7","--brand-surface":"#ffffff","--brand-surface-alt":"#dfe9f2","--brand-text":"#162947","--brand-text-muted":"#617089","--brand-border":"rgba(28, 53, 92, 0.16)","--brand-button":"#1c355c","--brand-button-text":"#fffaf0","--brand-focus":"#c9a24f","--brand-gradient":"linear-gradient(135deg, #1c355c, #294a78 58%, #c9a24f)","--brand-heading-font":"Montserrat, Inter, system-ui, sans-serif","--brand-body-font":"Inter, system-ui, -apple-system, sans-serif",
      "--studio-canvas":"#eaf1f7","--studio-canvas-2":"#dfe9f2","--studio-surface":"#ffffff","--studio-surface-2":"#f6f9fc","--studio-surface-raised":"#ffffff","--studio-line":"rgba(28, 53, 92, 0.12)","--studio-line-strong":"rgba(28, 53, 92, 0.26)","--studio-line-warm":"rgba(201, 162, 79, 0.38)","--studio-cream":"#162947","--studio-cream-dim":"#324863","--studio-muted":"#617089","--studio-orange":"#1c355c","--studio-orange-bright":"#c9a24f","--studio-amber":"#e5c879","--studio-burnt":"#9d7c32","--studio-brown":"#d4e1ed","--studio-green":"#26765c","--studio-client-glow":"rgba(201, 162, 79, 0.22)","--studio-button-text":"#fffaf0","--studio-button-shadow":"rgba(28, 53, 92, 0.22)","--studio-button-shadow-hover":"rgba(28, 53, 92, 0.32)","--studio-atmosphere-stroke":"rgba(28, 53, 92, 0.08)","--studio-atmosphere-stroke-2":"rgba(201, 162, 79, 0.16)","--studio-mark-opacity":"0.08"
    })
  }),
  santati: Object.freeze({
    id: "santati", label: "Santati", showPoweredBy: true,
    logoSrc: "../shared/brand/clients/santati/logo.svg", logoAlt: "Santati",
    textLogo: "Santati Production Studio", atmosphereBrand: "SANTATI", atmosphereProduct: "STUDIO",
    vars: Object.freeze({
      "--brand-primary":"#55308d","--brand-secondary":"#22a6a6","--brand-accent":"#93e0dc","--brand-background":"#120f24","--brand-surface":"#1e1835","--brand-surface-alt":"#2a2147","--brand-text":"#f6f1ff","--brand-text-muted":"#c8bfd8","--brand-border":"rgba(147, 224, 220, 0.18)","--brand-button":"#22a6a6","--brand-button-text":"#061f22","--brand-focus":"#93e0dc","--brand-gradient":"linear-gradient(135deg, #55308d, #22a6a6 72%, #93e0dc)","--brand-heading-font":"Montserrat, Inter, system-ui, sans-serif","--brand-body-font":"Inter, system-ui, -apple-system, sans-serif",
      "--studio-canvas":"#120f24","--studio-canvas-2":"#191330","--studio-surface":"#1e1835","--studio-surface-2":"#2a2147","--studio-surface-raised":"#352a58","--studio-line":"rgba(147, 224, 220, 0.12)","--studio-line-strong":"rgba(147, 224, 220, 0.28)","--studio-line-warm":"rgba(85, 48, 141, 0.45)","--studio-cream":"#f6f1ff","--studio-cream-dim":"#d8d0ea","--studio-muted":"#a9a0bd","--studio-orange":"#22a6a6","--studio-orange-bright":"#93e0dc","--studio-amber":"#b9f0e9","--studio-burnt":"#55308d","--studio-brown":"#211a38","--studio-green":"#6fdbb5","--studio-client-glow":"rgba(34, 166, 166, 0.24)","--studio-button-text":"#061f22","--studio-button-shadow":"rgba(34, 166, 166, 0.26)","--studio-button-shadow-hover":"rgba(34, 166, 166, 0.38)","--studio-atmosphere-stroke":"rgba(147, 224, 220, 0.08)","--studio-atmosphere-stroke-2":"rgba(246, 241, 255, 0.06)","--studio-mark-opacity":"0.055"
    })
  })
});

export function normalizeBrandTheme(themeId) {
  const normalized = String(themeId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "workspace") return "8alta";
  return BRAND_THEMES[normalized]?.id || DEFAULT_BRAND_THEME;
}
export function getInitialBrandTheme(search = window.location.search, options = {}) {
  const { useStorage = true } = options;
  const fromUrl = new URLSearchParams(search).get("brand");
  if (fromUrl) return normalizeBrandTheme(fromUrl);
  if (!useStorage) return DEFAULT_BRAND_THEME;
  try { return normalizeBrandTheme(window.localStorage.getItem(THEME_STORAGE_KEY)); } catch { return DEFAULT_BRAND_THEME; }
}
export function saveBrandTheme(themeId) { try { window.localStorage.setItem(THEME_STORAGE_KEY, normalizeBrandTheme(themeId)); } catch {} }
export function applyBrandTheme(themeId, elements = {}) {
  const theme = BRAND_THEMES[normalizeBrandTheme(themeId)]; const root = elements.root || document.body; root.dataset.brandTheme = theme.id;
  Object.entries(theme.vars).forEach(([property,value])=>root.style.setProperty(property,value));
  if (elements.logoImg) { if (theme.logoSrc) { elements.logoImg.hidden=false; elements.logoImg.src=theme.logoSrc; elements.logoImg.alt=theme.logoAlt||`${theme.label} Studio`; } else elements.logoImg.hidden=true; }
  if (elements.logoText) { elements.logoText.hidden=Boolean(theme.logoSrc); elements.logoText.textContent=theme.textLogo||`${theme.label} Studio`; }
  if (elements.poweredBy) elements.poweredBy.hidden=!theme.showPoweredBy;
  if (elements.atmosphereBrandWord) elements.atmosphereBrandWord.textContent=theme.atmosphereBrand;
  if (elements.atmosphereProductWord) elements.atmosphereProductWord.textContent=theme.atmosphereProduct;
  if (elements.atmosphereMark) elements.atmosphereMark.style.backgroundImage = `url("${theme.logoSrc || "../shared/brand/toasty-media/ToastyTransparent.png"}")`;
  return theme;
}

function getModules(){ try{return {...DEFAULT_MODULES,...JSON.parse(localStorage.getItem(MODULE_KEY)||'{}')}}catch{return {...DEFAULT_MODULES}} }
function applyModuleVisibility(){
  const modules=getModules();
  const live=document.querySelector('[data-studio-mode="live"]');
  const ai=document.querySelector('[data-studio-mode="ai"]');
  if(live) live.hidden=!modules.live;
  if(ai) ai.hidden=!modules.ai;
  const switcher=document.querySelector('.studio-mode-switcher');
  if(switcher && !document.querySelector('[data-studio-mode="expertise"]')){
    const link=document.createElement('a');
    link.className='mode-card'; link.dataset.studioMode='expertise'; link.href='experts.html';
    link.innerHTML='<span class="mode-icon mode-icon--ai" aria-hidden="true"></span><strong>Expertise</strong>';
    switcher.appendChild(link);
  }
  const expertise=document.querySelector('[data-studio-mode="expertise"]');
  if(expertise) expertise.hidden=!modules.expertise;
  if(!modules.live && modules.ai && ai) ai.click();
}

if (typeof document !== "undefined") {
  document.querySelectorAll("#brandThemeSelect, #aiBrandProfile").forEach((select)=>{select.innerHTML='<option value="toasty">Toasty Media</option><option value="8alta">8ALTA</option><option value="santati">Santati</option>';});
  queueMicrotask(applyModuleVisibility);
}
