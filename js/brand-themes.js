export const DEFAULT_BRAND_THEME = "toasty";

const THEME_STORAGE_KEY = "toastyStudioBrandTheme";
const MODULE_KEY = "toastyStudioModules";
const DEFAULT_MODULES = Object.freeze({ live: true, ai: true, expertise: true });

export const BRAND_THEMES = Object.freeze({
  toasty: Object.freeze({
    id: "toasty", label: "Toasty Media", showPoweredBy: false,
    logoSrc: "../shared/brand/toasty-media/ToastyMediaStudio.png", logoAlt: "Toasty Media Studio",
    textLogo: "Toasty Studio", atmosphereBrand: "TOASTY", atmosphereProduct: "STUDIO",
    copy: Object.freeze({
      studioName: "Toasty Studio",
      publicHeroTitle: "Your content. Professionally produced.",
      publicHeroSupport: "Drop in footage, clips, photos or audio. Toasty handles the production work—branding, cuts, captions, formatting, intros, outros, and everything between.",
      publicHeroTagline: "You create. Toasty produces.",
      quickLabel: "Quick Toast",
      quickTitle: "Drop it in. We'll make it Toasty.",
      quickBody: "Upload raw media and turn it into a branded production with intros, outros, lower thirds, captions, watermarks, and export-ready formats.",
      liveBody: "Invite guests, manage the session, record, and keep the production flow in one Toasty workspace.",
      aiBody: "Start from an idea, a link, notes, or raw material, then move through idea, script, record, scenes, assets, assemble, review, and export.",
      memoryBody: "Keep colors, logo behavior, lower thirds, voice, creator context, and calls to action consistent across repeatable work.",
      guestLede: "Set your name, devices, and background before entering Toasty Studio.",
      productionTitle: "Drop it in. We'll make it Toasty.",
      productionSubtitle: "Video, clips, photos or audio. Toasty handles the production.",
      preparedTitle: "Toasty prepared your production.",
      conciergePrefix: "Toasty suggests:"
    }),
    vars: Object.freeze({
      "--brand-primary":"#ff7a29","--brand-secondary":"#ffc670","--brand-accent":"#ffab5c","--brand-background":"#0b0908","--brand-surface":"#171210","--brand-surface-alt":"#201815","--brand-text":"#f4ead9","--brand-text-muted":"#9c8d7c","--brand-border":"rgba(230, 200, 168, 0.1)","--brand-button":"#ff7a29","--brand-button-text":"#1c0f06","--brand-focus":"#ffab5c","--brand-gradient":"linear-gradient(135deg, #ffc670, #ff7a29 60%, #c1470f)","--brand-heading-font":"Montserrat, Inter, system-ui, sans-serif","--brand-body-font":"Inter, system-ui, -apple-system, sans-serif",
      "--studio-canvas":"#0b0908","--studio-canvas-2":"#0f0b0a","--studio-surface":"#171210","--studio-surface-2":"#201815","--studio-surface-raised":"#2a201a","--studio-line":"rgba(230, 200, 168, 0.1)","--studio-line-strong":"rgba(255, 170, 110, 0.28)","--studio-line-warm":"rgba(184, 70, 14, 0.35)","--studio-cream":"#f4ead9","--studio-cream-dim":"#d3c2ac","--studio-muted":"#9c8d7c","--studio-orange":"#ff7a29","--studio-orange-bright":"#ffab5c","--studio-amber":"#ffc670","--studio-burnt":"#c1470f","--studio-brown":"#4a2d2a","--studio-green":"#34c77b","--studio-client-glow":"rgba(255, 122, 41, 0.24)","--studio-button-text":"#1c0f06","--studio-button-shadow":"rgba(255, 122, 41, 0.32)","--studio-button-shadow-hover":"rgba(255, 122, 41, 0.42)","--studio-atmosphere-stroke":"rgba(255, 171, 92, 0.06)","--studio-atmosphere-stroke-2":"rgba(244, 234, 217, 0.045)","--studio-mark-opacity":"0.05"
    })
  }),
  "8alta": Object.freeze({
    id: "8alta", label: "8ALTA", showPoweredBy: true,
    logoSrc: "https://www.8alta.com/assets/8alta-logo-gold-transparent.png", logoAlt: "8ALTA",
    faviconSrc: "https://www.8alta.com/favicon.ico", homeUrl: "https://www.8alta.com",
    textLogo: "8ALTA Studio", atmosphereBrand: "CLARITY", atmosphereProduct: "STUDIO",
    copy: Object.freeze({
      studioName: "8ALTA Studio",
      publicHeroTitle: "Clear thinking. Credibly produced.",
      publicHeroSupport: "Turn executive insight, source material, and raw recordings into precise, boardroom-ready media—consistently branded from first frame to final export.",
      publicHeroTagline: "Structure the message. Control the production.",
      quickLabel: "Fast Production",
      quickTitle: "Bring the source. Leave with a clear signal.",
      quickBody: "Upload raw media and build a disciplined 8ALTA production with intros, lower thirds, captions, and export-ready formats.",
      liveBody: "Invite guests, direct the session, record, and keep every production detail inside one 8ALTA workspace.",
      aiBody: "Start from a decision, briefing, link, or raw material and move through a controlled production workflow.",
      memoryBody: "Keep 8ALTA colors, logo use, voice, lower thirds, and calls to action consistent across every production.",
      guestLede: "Set your name and devices before entering the 8ALTA Studio.",
      productionTitle: "Turn clear thinking into credible content.",
      productionSubtitle: "Upload your source material. The Studio handles a disciplined, brand-consistent production.",
      preparedTitle: "Your 8ALTA production is prepared.",
      conciergePrefix: "8ALTA Studio suggests:"
    }),
    vars: Object.freeze({
      "--brand-primary":"#c8a45d","--brand-secondary":"#f5f1e8","--brand-accent":"#d8c17e","--brand-background":"#07111f","--brand-surface":"#111d2d","--brand-surface-alt":"#172334","--brand-text":"#f5f1e8","--brand-text-muted":"#aeb8c5","--brand-border":"rgba(200, 164, 93, 0.24)","--brand-button":"#c8a45d","--brand-button-text":"#07111f","--brand-focus":"#d8c17e","--brand-gradient":"linear-gradient(135deg, #d8c17e, #c8a45d)","--brand-heading-font":"Inter, system-ui, sans-serif","--brand-body-font":"Inter, system-ui, -apple-system, sans-serif",
      "--studio-canvas":"#07111f","--studio-canvas-2":"#0b1625","--studio-surface":"#111d2d","--studio-surface-2":"#172334","--studio-surface-raised":"#1d2a3c","--studio-line":"rgba(216, 222, 230, 0.12)","--studio-line-strong":"rgba(200, 164, 93, 0.34)","--studio-line-warm":"rgba(200, 164, 93, 0.42)","--studio-cream":"#f5f1e8","--studio-cream-dim":"#d8dee6","--studio-muted":"#95a2b2","--studio-orange":"#c8a45d","--studio-orange-bright":"#d8c17e","--studio-amber":"#ead99d","--studio-burnt":"#8a6a2f","--studio-brown":"#172334","--studio-green":"#75b798","--studio-client-glow":"rgba(200, 164, 93, 0.16)","--studio-button-text":"#07111f","--studio-button-shadow":"rgba(200, 164, 93, 0.20)","--studio-button-shadow-hover":"rgba(200, 164, 93, 0.30)","--studio-atmosphere-stroke":"rgba(200, 164, 93, 0.08)","--studio-atmosphere-stroke-2":"rgba(245, 241, 232, 0.045)","--studio-mark-opacity":"0.055"
    })
  }),
  santati: Object.freeze({
    id: "santati", label: "Santati", showPoweredBy: true,
    logoSrc: "https://www.santaticrm.com/assets/santati-logo-only-white.png", logoAlt: "Santati",
    faviconSrc: "https://www.santaticrm.com/assets/favicon-leaves.png", homeUrl: "https://www.santaticrm.com",
    textLogo: "Santati Studio", atmosphereBrand: "SANTATI", atmosphereProduct: "STUDIO",
    copy: Object.freeze({
      studioName: "Santati Studio",
      publicHeroTitle: "Content that never loses the thread.",
      publicHeroSupport: "Bring conversations, recordings, and ideas together in one connected production workspace built around the Santati brand.",
      publicHeroTagline: "Preserve the context. Grow the connection.",
      quickLabel: "Fast Production",
      quickTitle: "Drop it in. Keep the story connected.",
      quickBody: "Turn raw media into a complete Santati production with branded intros, lower thirds, captions, and ready-to-share formats.",
      liveBody: "Invite guests, manage the room, and record the conversation in one connected Santati workspace.",
      aiBody: "Start from an idea, a customer signal, or raw material and shape it into a clear, human production.",
      memoryBody: "Keep Santati color, voice, logo behavior, lower thirds, and calls to action consistent everywhere.",
      guestLede: "Set your name and devices before entering the Santati Studio.",
      productionTitle: "Never lose the thread of your story.",
      productionSubtitle: "Bring the source material. Santati Studio turns it into clear, connected content.",
      preparedTitle: "Your Santati production is prepared.",
      conciergePrefix: "Santati Studio suggests:"
    }),
    vars: Object.freeze({
      "--brand-primary":"#6f45ff","--brand-secondary":"#18d8c0","--brand-accent":"#ff4fc3","--brand-background":"#17112d","--brand-surface":"#21183c","--brand-surface-alt":"#2a2147","--brand-text":"#f7f7fb","--brand-text-muted":"#ada5c7","--brand-border":"rgba(247, 247, 251, 0.14)","--brand-button":"#6f45ff","--brand-button-text":"#ffffff","--brand-focus":"#18d8c0","--brand-gradient":"linear-gradient(135deg, #18d8c0 0%, #6f45ff 52%, #ff4fc3 100%)","--brand-heading-font":"Manrope, Inter, system-ui, sans-serif","--brand-body-font":"DM Sans, Inter, system-ui, sans-serif",
      "--studio-canvas":"#17112d","--studio-canvas-2":"#1b1434","--studio-surface":"#21183c","--studio-surface-2":"#2a2147","--studio-surface-raised":"#332855","--studio-line":"rgba(247, 247, 251, 0.12)","--studio-line-strong":"rgba(24, 216, 192, 0.30)","--studio-line-warm":"rgba(111, 69, 255, 0.48)","--studio-cream":"#f7f7fb","--studio-cream-dim":"#d8d4e5","--studio-muted":"#ada5c7","--studio-orange":"#6f45ff","--studio-orange-bright":"#89f5e8","--studio-amber":"#ff78d4","--studio-burnt":"#5530cf","--studio-brown":"#21183c","--studio-green":"#18d8c0","--studio-client-glow":"rgba(111, 69, 255, 0.25)","--studio-button-text":"#ffffff","--studio-button-shadow":"rgba(111, 69, 255, 0.28)","--studio-button-shadow-hover":"rgba(111, 69, 255, 0.42)","--studio-atmosphere-stroke":"rgba(24, 216, 192, 0.09)","--studio-atmosphere-stroke-2":"rgba(255, 79, 195, 0.08)","--studio-mark-opacity":"0.05"
    })
  }),
  optimai: Object.freeze({
    id: "optimai", label: "OptimAI Network", showPoweredBy: true,
    logoSrc: "https://r2-opi-lp.optimai.network/images/branding/main-logo-v2.svg", logoAlt: "OptimAI Network",
    faviconSrc: "https://optimai.network/favicon.ico", homeUrl: "https://optimai.network",
    textLogo: "OptimAI Studio", atmosphereBrand: "OPTIMAI", atmosphereProduct: "NETWORK",
    copy: Object.freeze({
      studioName: "OptimAI Studio",
      publicHeroTitle: "Your data. Your agent. Your production.",
      publicHeroSupport: "Transform network intelligence, recordings, and raw media into high-contrast, distribution-ready OptimAI content.",
      publicHeroTagline: "Own the signal. Ship the story.",
      quickLabel: "Fast Production",
      quickTitle: "From raw data to network-ready media.",
      quickBody: "Upload source media and produce OptimAI-branded intros, lower thirds, captions, watermarks, and platform formats.",
      liveBody: "Bring operators, builders, and community voices into one directed OptimAI recording room.",
      aiBody: "Start from research, an agent insight, a link, or raw material and move through an agent-native production workflow.",
      memoryBody: "Keep OptimAI typography, network signals, logo use, and calls to action consistent across every output.",
      guestLede: "Set your name and devices before entering the OptimAI Studio.",
      productionTitle: "Your data. Your agent. Your production.",
      productionSubtitle: "Turn decentralized intelligence and raw media into network-ready content.",
      preparedTitle: "Your OptimAI production is prepared.",
      conciergePrefix: "OptimAI Studio suggests:"
    }),
    vars: Object.freeze({
      "--brand-primary":"#5eed87","--brand-secondary":"#f6f655","--brand-accent":"#baf46e","--brand-background":"#0a0a0a","--brand-surface":"#121614","--brand-surface-alt":"#18201b","--brand-text":"#ffffff","--brand-text-muted":"#939393","--brand-border":"rgba(255, 255, 255, 0.10)","--brand-button":"#5eed87","--brand-button-text":"#000000","--brand-focus":"#f6f655","--brand-gradient":"linear-gradient(90deg, #f6f655, #5eed87)","--brand-heading-font":"Plus Jakarta Sans, Inter, system-ui, sans-serif","--brand-body-font":"Plus Jakarta Sans, Inter, system-ui, sans-serif",
      "--studio-canvas":"#0a0a0a","--studio-canvas-2":"#0d100e","--studio-surface":"#121614","--studio-surface-2":"#18201b","--studio-surface-raised":"#202a23","--studio-line":"rgba(255, 255, 255, 0.09)","--studio-line-strong":"rgba(94, 237, 135, 0.28)","--studio-line-warm":"rgba(246, 246, 85, 0.30)","--studio-cream":"#ffffff","--studio-cream-dim":"#d4d4d4","--studio-muted":"#939393","--studio-orange":"#5eed87","--studio-orange-bright":"#baf46e","--studio-amber":"#f6f655","--studio-burnt":"#48b96c","--studio-brown":"#18201b","--studio-green":"#5eed87","--studio-client-glow":"rgba(94, 237, 135, 0.18)","--studio-button-text":"#000000","--studio-button-shadow":"rgba(94, 237, 135, 0.22)","--studio-button-shadow-hover":"rgba(94, 237, 135, 0.34)","--studio-atmosphere-stroke":"rgba(94, 237, 135, 0.075)","--studio-atmosphere-stroke-2":"rgba(246, 246, 85, 0.055)","--studio-mark-opacity":"0.045"
    })
  })
});

export function normalizeBrandTheme(themeId) {
  const normalized = String(themeId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "workspace") return "8alta";
  if (normalized === "optimainetwork" || normalized === "opi") return "optimai";
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
export function populateBrandThemeSelect(select, activeThemeId = DEFAULT_BRAND_THEME) {
  if (!select) return;
  const activeId = normalizeBrandTheme(activeThemeId);
  const themes = Object.values(BRAND_THEMES).filter((theme)=>activeId === DEFAULT_BRAND_THEME || theme.id !== DEFAULT_BRAND_THEME);
  select.replaceChildren(...themes.map((theme)=>{
    const option=document.createElement("option");
    option.value=theme.id;
    option.textContent=theme.label;
    return option;
  }));
  select.value=activeId;
}
export function applyBrandTheme(themeId, elements = {}) {
  const theme = BRAND_THEMES[normalizeBrandTheme(themeId)]; const root = elements.root || document.body; root.dataset.brandTheme = theme.id;
  Object.entries(theme.vars).forEach(([property,value])=>root.style.setProperty(property,value));
  root.style.setProperty("--studio-mark-image", `url("${theme.logoSrc || "../shared/brand/toasty-media/ToastyTransparent.png"}")`);
  root.style.setProperty("--po-font-heading", theme.vars["--brand-heading-font"]);
  root.style.setProperty("--po-font-body", theme.vars["--brand-body-font"]);
  if (elements.logoImg) { if (theme.logoSrc) { elements.logoImg.hidden=false; elements.logoImg.src=theme.logoSrc; elements.logoImg.alt=theme.logoAlt||`${theme.label} Studio`; } else elements.logoImg.hidden=true; }
  if (elements.logoText) { elements.logoText.hidden=Boolean(theme.logoSrc); elements.logoText.textContent=theme.textLogo||`${theme.label} Studio`; }
  if (elements.poweredBy) elements.poweredBy.hidden=!theme.showPoweredBy;
  if (elements.brandLink && theme.homeUrl) elements.brandLink.href=theme.homeUrl;
  if (elements.atmosphereBrandWord) elements.atmosphereBrandWord.textContent=theme.atmosphereBrand;
  if (elements.atmosphereProductWord) elements.atmosphereProductWord.textContent=theme.atmosphereProduct;
  if (elements.atmosphereMark) elements.atmosphereMark.style.backgroundImage = `url("${theme.logoSrc || "../shared/brand/toasty-media/ToastyTransparent.png"}")`;
  document.querySelectorAll("[data-brand-copy]").forEach((node)=>{
    const value=theme.copy?.[node.dataset.brandCopy];
    if(value) node.textContent=value;
  });
  document.querySelectorAll("[data-brand-logo]").forEach((img)=>{
    img.src=theme.logoSrc; img.alt=theme.logoAlt||theme.label;
  });
  document.querySelectorAll("[data-brand-home]").forEach((link)=>{ if(theme.homeUrl) link.href=theme.homeUrl; });
  document.querySelectorAll("#brandThemeSelect, #aiBrandProfile").forEach((select)=>populateBrandThemeSelect(select, theme.id));
  document.title=`${theme.textLogo || theme.label}${document.body.classList.contains("program-output") ? " — Program Output" : ""}`;
  const favicon=document.querySelector('link[rel~="icon"]');
  if(favicon && theme.faviconSrc) favicon.href=theme.faviconSrc;
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
    link.className='mode-card'; link.dataset.studioMode='expertise';
    link.href=`experts.html?brand=${encodeURIComponent(getInitialBrandTheme())}`;
    link.innerHTML='<span class="mode-icon mode-icon--ai" aria-hidden="true"></span><strong>Expertise</strong>';
    switcher.appendChild(link);
  }
  const expertise=document.querySelector('[data-studio-mode="expertise"]');
  if(expertise) expertise.hidden=!modules.expertise;
  if(!modules.live && modules.ai && ai) ai.click();
}

if (typeof document !== "undefined") {
  document.querySelectorAll("#brandThemeSelect, #aiBrandProfile").forEach((select)=>populateBrandThemeSelect(select));
  queueMicrotask(applyModuleVisibility);
}
