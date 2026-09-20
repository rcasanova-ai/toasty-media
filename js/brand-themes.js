export const DEFAULT_BRAND_THEME = "toasty";

const THEME_STORAGE_KEY = "toastyStudioBrandTheme";
const MODULE_KEY = "toastyStudioModules";
const DEFAULT_MODULES = Object.freeze({ live: true, ai: true, expertise: true });

export const BRAND_THEMES = Object.freeze({
  toasty: Object.freeze({
    id: "toasty", label: "Toasty Media", showPoweredBy: false,
    logoSrc: "../shared/brand/toasty-media/ToastyMediaStudio.png", logoAlt: "Toasty Media Studio",
    // homeUrl/faviconSrc are set explicitly (not left to fall back to "whatever a previous brand set")
    // because applyBrandTheme only assigns these when the theme defines them — Toasty is the one brand
    // every other theme's switch has to be able to land back on cleanly, so its own reset targets can't
    // be optional. Without these two, switching 8alta -> toasty left the brand-lockup link and the
    // favicon pointing at 8alta's, since nothing ever told them to change back.
    homeUrl: "../site/", faviconSrc: "../shared/brand/toasty-media/ToastyTransparent.png",
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
  }),
  // Colors verified live against tangem.com (2026-09-17): #0099ff is their actual CTA/accent blue
  // (every "Buy Tangem" button on the site), #000 background, #fff text, ~#6c6c70 muted text. No
  // logoSrc on purpose — their real logo is an inline currentColor SVG on their own site and their only
  // public "media kit" is an unlisted Google Drive folder, not a stable hostable asset URL, so this
  // leans on brand-themes.js's own existing textLogo fallback (see applyBrandTheme) instead of
  // scraping/rehosting anything. Body font is Inter (already loaded here) rather than their licensed
  // Graphik LC Web, which this app has no rights to load.
  tangem: Object.freeze({
    id: "tangem", label: "Tangem", showPoweredBy: true,
    homeUrl: "https://tangem.com", faviconSrc: "https://tangem.com/favicon.ico",
    textLogo: "Tangem Studio", atmosphereBrand: "TANGEM", atmosphereProduct: "STUDIO",
    copy: Object.freeze({
      studioName: "Tangem Studio",
      publicHeroTitle: "Security, produced with the same restraint you build with.",
      publicHeroSupport: "Turn product walkthroughs, briefings, and raw recordings into precise, on-brand media—consistently produced from first frame to final export.",
      publicHeroTagline: "Hold the keys. Control the story.",
      quickLabel: "Fast Production",
      quickTitle: "Bring the source. Leave with a clean signal.",
      quickBody: "Upload raw media and build a restrained Tangem production with intros, lower thirds, captions, and export-ready formats.",
      liveBody: "Invite guests, direct the session, record, and keep every production detail inside one Tangem workspace.",
      aiBody: "Start from a briefing, a link, or raw material and move through a controlled production workflow.",
      memoryBody: "Keep Tangem colors, logo use, voice, lower thirds, and calls to action consistent across every production.",
      guestLede: "Set your name and devices before entering the Tangem Studio.",
      productionTitle: "Security, produced with the same restraint you build with.",
      productionSubtitle: "Upload your source material. The Studio handles a clean, brand-consistent production.",
      preparedTitle: "Your Tangem production is prepared.",
      conciergePrefix: "Tangem Studio suggests:"
    }),
    vars: Object.freeze({
      "--brand-primary":"#0099ff","--brand-secondary":"#ffffff","--brand-accent":"#33aaff","--brand-background":"#000000","--brand-surface":"#0d0d0f","--brand-surface-alt":"#16161a","--brand-text":"#ffffff","--brand-text-muted":"#6c6c70","--brand-border":"rgba(255, 255, 255, 0.10)","--brand-button":"#0099ff","--brand-button-text":"#ffffff","--brand-focus":"#33aaff","--brand-gradient":"linear-gradient(135deg, #33aaff, #0099ff)","--brand-heading-font":"Inter, system-ui, sans-serif","--brand-body-font":"Inter, system-ui, -apple-system, sans-serif",
      "--studio-canvas":"#000000","--studio-canvas-2":"#0d0d0f","--studio-surface":"#0d0d0f","--studio-surface-2":"#16161a","--studio-surface-raised":"#1e1e22","--studio-line":"rgba(255, 255, 255, 0.10)","--studio-line-strong":"rgba(0, 153, 255, 0.32)","--studio-line-warm":"rgba(0, 153, 255, 0.42)","--studio-cream":"#ffffff","--studio-cream-dim":"#c7c7ca","--studio-muted":"#6c6c70","--studio-orange":"#0099ff","--studio-orange-bright":"#33aaff","--studio-amber":"#66bbff","--studio-burnt":"#0077cc","--studio-brown":"#16161a","--studio-green":"#0099ff","--studio-client-glow":"rgba(0, 153, 255, 0.18)","--studio-button-text":"#ffffff","--studio-button-shadow":"rgba(0, 153, 255, 0.24)","--studio-button-shadow-hover":"rgba(0, 153, 255, 0.36)","--studio-atmosphere-stroke":"rgba(0, 153, 255, 0.07)","--studio-atmosphere-stroke-2":"rgba(255, 255, 255, 0.045)","--studio-mark-opacity":"0.04"
    })
  }),
  superteam: Object.freeze({
    id: "superteam", label: "Superteam Thailand", showPoweredBy: true,
    logoSrc: "../shared/brand/clients/superteam-thailand/logo.png", logoAlt: "Superteam Thailand",
    faviconSrc: "../shared/brand/clients/superteam-thailand/logo.png", homeUrl: "https://th.superteam.fun",
    textLogo: "Superteam Thailand Studio", atmosphereBrand: "SUPERTEAM", atmosphereProduct: "THAILAND",
    copy: Object.freeze({
      studioName: "Superteam Thailand Studio",
      publicHeroTitle: "Build together. Power APAC.",
      publicHeroSupport: "Turn builder conversations, demos, and community recordings into Superteam Thailand productions—consistent from first frame to final export.",
      publicHeroTagline: "Build together. Power APAC.",
      quickLabel: "Fast Production",
      quickTitle: "Bring the build. Ship the story.",
      quickBody: "Upload raw media and produce Superteam Thailand intros, lower thirds, captions, and export-ready formats.",
      liveBody: "Invite builders, direct the session, record, and keep every production detail inside one Superteam Thailand workspace.",
      aiBody: "Start from a demo, a briefing, a link, or raw material and move through a technical production workflow.",
      memoryBody: "Keep Superteam Thailand colors, logo use, voice, lower thirds, and calls to action consistent across every production.",
      guestLede: "Set your name and devices before entering the Superteam Thailand Studio.",
      productionTitle: "Build together. Power APAC.",
      productionSubtitle: "Upload the source. Superteam Thailand Studio turns it into a precise, on-brand production.",
      preparedTitle: "Your Superteam Thailand production is prepared.",
      conciergePrefix: "Superteam Thailand Studio suggests:"
    }),
    artwork: Object.freeze({
      backgroundWatermark: "../shared/brand/clients/superteam-thailand/watermark-elephant.png",
      backgroundSilhouette: "../shared/brand/clients/superteam-thailand/silhouette-skyline.png",
      brandPattern: "",
      backgroundArtwork: "",
      surfaceGradient: "radial-gradient(920px 480px at 100% -8%, rgba(196, 30, 90, 0.11), transparent 58%), linear-gradient(165deg, rgba(165, 25, 49, 0.07) 0%, transparent 26%, rgba(8, 16, 48, 0.55) 100%)",
      accentGradient: "linear-gradient(180deg, #f4f7fc 0%, #d7deea 100%)",
      decorativeOpacity: 0.04,
      watermarkOpacity: 0.055,
      silhouetteOpacity: 0.05,
      titleCardFill: "rgba(7, 11, 28, 0.86)",
      grainBlend: "overlay",
      watermarkFilter: "grayscale(0.15)",
      identityStripe: "linear-gradient(180deg, #a51931 0 16%, #ffffff 16% 32%, #2d2a6a 32% 68%, #ffffff 68% 84%, #a51931 84% 100%)",
      identityStripeWidth: "3px",
      logoMaxHeight: "88px",
      logoMaxWidth: "260px",
      logoObjectPosition: "center center",
      logoJustify: "center",
      cardRadius: "14px",
      grainOpacity: 0.03,
      logoTreatment: "centered-mark",
      lowerThirdTreatment: "navy-flag-bar",
      titleCardTreatment: "navy-depth",
      introTreatment: "navy-open",
      outroTreatment: "flag-close"
    }),
    vars: Object.freeze({
      "--brand-primary":"#c8102e","--brand-secondary":"#f4f7fc","--brand-accent":"#c41e5a","--brand-background":"#050814","--brand-surface":"#0b1328","--brand-surface-alt":"#101a34","--brand-text":"#f3f6fb","--brand-text-muted":"#8b97b0","--brand-border":"rgba(243, 246, 251, 0.12)","--brand-button":"#f4f7fc","--brand-button-text":"#070b1c","--brand-focus":"#8eb4ff","--brand-gradient":"linear-gradient(180deg, #f4f7fc 0%, #d7deea 100%)","--brand-heading-font":"Inter, system-ui, sans-serif","--brand-body-font":"Inter, system-ui, -apple-system, sans-serif",
      "--studio-canvas":"#050814","--studio-canvas-2":"#070b1c","--studio-surface":"#0b1328","--studio-surface-2":"#101a34","--studio-surface-raised":"#162040","--studio-line":"rgba(243, 246, 251, 0.10)","--studio-line-strong":"rgba(142, 180, 255, 0.28)","--studio-line-warm":"rgba(165, 25, 49, 0.55)","--studio-cream":"#f3f6fb","--studio-cream-dim":"#c5cde0","--studio-muted":"#8b97b0","--studio-orange":"#8eb4ff","--studio-orange-bright":"#f4f7fc","--studio-amber":"#14f195","--studio-burnt":"#a51931","--studio-brown":"#101a34","--studio-green":"#14f195","--studio-client-glow":"rgba(196, 30, 90, 0.10)","--studio-button-text":"#070b1c","--studio-button-shadow":"rgba(244, 247, 252, 0.16)","--studio-button-shadow-hover":"rgba(244, 247, 252, 0.28)","--studio-atmosphere-stroke":"rgba(196, 30, 90, 0.09)","--studio-atmosphere-stroke-2":"rgba(243, 246, 251, 0.05)","--studio-mark-opacity":"0.06"
    })
  }),
  peeps: Object.freeze({
    id: "peeps", label: "Toasty Peeps", showPoweredBy: false,
    logoSrc: "../shared/brand/toasty-peeps/logo.png", logoAlt: "Toasty Peeps",
    compactMark: "../shared/brand/toasty-media/ToastyTransparent.png",
    faviconSrc: "../shared/brand/toasty-peeps/logo.png", homeUrl: "../peeps/",
    textLogo: "Toasty Peeps Studio", atmosphereBrand: "TOASTY", atmosphereProduct: "PEEPS",
    copy: Object.freeze({
      studioName: "Toasty Peeps Studio",
      publicHeroTitle: "People. Expertise. Conversation.",
      publicHeroSupport: "Capture expert conversations, discovery, and collaboration as branded Toasty Peeps productions—from first hello to final export.",
      publicHeroTagline: "Find the people. Keep the conversation.",
      quickLabel: "Fast Production",
      quickTitle: "Bring the conversation. We'll make it Peeps.",
      quickBody: "Upload raw media and turn expert conversations into Toasty Peeps productions with intros, outros, lower thirds, captions, and export-ready formats.",
      liveBody: "Invite experts, manage the session, record, and keep the conversation in one Toasty Peeps workspace.",
      aiBody: "Start from a brief, notes, or raw material, then move through idea, script, record, scenes, assets, assemble, review, and export.",
      memoryBody: "Keep Toasty Peeps colors, logo behavior, lower thirds, voice, and calls to action consistent across every expert production.",
      guestLede: "Set your name, devices, and background before entering Toasty Peeps Studio.",
      productionTitle: "Bring the conversation. We'll make it Peeps.",
      productionSubtitle: "People, expertise, and opportunities — produced with Toasty Peeps warmth.",
      preparedTitle: "Toasty Peeps prepared your production.",
      conciergePrefix: "Toasty Peeps suggests:"
    }),
    artwork: Object.freeze({
      backgroundArtwork: "",
      backgroundWatermark: "../shared/brand/toasty-peeps/watermark-mascot.png",
      // Toasty Peeps is presented under the Superteam Thailand / Colosseum banner — reuses the SAME
      // restrained temple-skyline silhouette already established for the superteam theme below (real
      // asset, not a new one) so the Thai visual language is consistent between the two, without
      // replacing Peeps' own watermark mascot (that stays Peeps' own character, not the elephant).
      backgroundSilhouette: "../shared/brand/clients/superteam-thailand/silhouette-skyline.png",
      brandPattern: "",
      surfaceGradient: "linear-gradient(180deg, rgba(255, 253, 248, 0.94) 0%, rgba(247, 237, 224, 0.55) 48%, rgba(255, 197, 61, 0.10) 100%)",
      titleCardFill: "rgba(61, 36, 21, 0.86)",
      grainBlend: "multiply",
      accentGradient: "linear-gradient(135deg, #ffe08a, #ff7a29 58%, #e85a12)",
      decorativeOpacity: 0.07,
      watermarkOpacity: 0.09,
      silhouetteOpacity: 0.06,
      watermarkFilter: "grayscale(0)",
      identityStripe: "linear-gradient(180deg, #ffc53d 0%, #ff7a29 52%, #c1470f 100%)",
      identityStripeWidth: "3px",
      logoMaxHeight: "84px",
      logoMaxWidth: "280px",
      logoObjectPosition: "center center",
      logoJustify: "center",
      cardRadius: "18px",
      grainOpacity: 0.035,
      logoTreatment: "warm-lockup",
      lowerThirdTreatment: "cream-orange-bar",
      titleCardTreatment: "warm-card",
      introTreatment: "people-first",
      outroTreatment: "conversation-close"
    }),
    vars: Object.freeze({
      "--brand-primary":"#ff7a29","--brand-secondary":"#ffc53d","--brand-accent":"#e85a12","--brand-background":"#fbf6ee","--brand-surface":"#fff9f1","--brand-surface-alt":"#fffdf8","--brand-text":"#3d2415","--brand-text-muted":"#8b6548","--brand-border":"rgba(61, 36, 21, 0.12)","--brand-button":"#ff7a29","--brand-button-text":"#3d2415","--brand-focus":"#ffc53d","--brand-gradient":"linear-gradient(135deg, #ffe08a, #ff7a29 58%, #e85a12)","--brand-heading-font":"Montserrat, Inter, system-ui, sans-serif","--brand-body-font":"Inter, system-ui, -apple-system, sans-serif",
      "--studio-canvas":"#fbf6ee","--studio-canvas-2":"#f3e6d4","--studio-surface":"#fff9f1","--studio-surface-2":"#fffdf8","--studio-surface-raised":"#ffffff","--studio-line":"rgba(61, 36, 21, 0.12)","--studio-line-strong":"rgba(255, 122, 41, 0.34)","--studio-line-warm":"rgba(193, 71, 15, 0.38)","--studio-cream":"#3d2415","--studio-cream-dim":"#5c4030","--studio-muted":"#8b6548","--studio-orange":"#ff7a29","--studio-orange-bright":"#e85a12","--studio-amber":"#ffc53d","--studio-burnt":"#c1470f","--studio-brown":"#3d2415","--studio-green":"#2f9e6a","--studio-client-glow":"rgba(255, 122, 41, 0.20)","--studio-button-text":"#3d2415","--studio-button-shadow":"rgba(255, 122, 41, 0.28)","--studio-button-shadow-hover":"rgba(255, 122, 41, 0.40)","--studio-atmosphere-stroke":"rgba(61, 36, 21, 0.10)","--studio-atmosphere-stroke-2":"rgba(232, 90, 18, 0.08)","--studio-mark-opacity":"0.09"
    })
  })
});

export const BRAND_THEME_IDS = Object.freeze(Object.keys(BRAND_THEMES));
export const BRAND_THEME_VAR_KEYS = Object.freeze(Object.keys(BRAND_THEMES.toasty.vars));
export function isKnownBrandId(themeId) {
  return BRAND_THEME_IDS.includes(themeId);
}

const THEME_ALIASES = Object.freeze({
  workspace: "8alta",
  optimainetwork: "optimai",
  opi: "optimai",
  superteamthailand: "superteam",
  stthailand: "superteam",
  superteamthai: "superteam",
  toastypeeps: "peeps"
});

export function normalizeBrandTheme(themeId) {
  const normalized = String(themeId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliased = THEME_ALIASES[normalized] || normalized;
  return BRAND_THEMES[aliased]?.id || DEFAULT_BRAND_THEME;
}
export function getInitialBrandTheme(search = window.location.search, options = {}) {
  const { useStorage = true } = options;
  const fromUrl = new URLSearchParams(search).get("brand");
  if (fromUrl) return normalizeBrandTheme(fromUrl);
  if (!useStorage) return DEFAULT_BRAND_THEME;
  try { return normalizeBrandTheme(window.localStorage.getItem(THEME_STORAGE_KEY)); } catch { return DEFAULT_BRAND_THEME; }
}
export function saveBrandTheme(themeId) { try { window.localStorage.setItem(THEME_STORAGE_KEY, normalizeBrandTheme(themeId)); } catch {} }
// Toasty is always a listed option, on every brand, on purpose: it's the native Studio identity, not a
// client — the one-click way back out of any client immersion has to always be reachable from the
// dropdown itself (see applyBrandTheme's homeUrl/faviconSrc comment for the other half of this).
export function populateBrandThemeSelect(select, activeThemeId = DEFAULT_BRAND_THEME) {
  if (!select) return;
  const activeId = normalizeBrandTheme(activeThemeId);
  const themes = Object.values(BRAND_THEMES);
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
  applyArtworkTokens(root, theme);
  // Only defaults to Toasty's own flame mark for the toasty theme itself. A client theme with no
  // logoSrc of its own (Tangem, deliberately, over hotlinking/rehosting an asset we don't have rights
  // to) must NOT fall through to Toasty's mark either — that would leak Toasty's own brand as a faint
  // watermark inside an immersive client workspace, which is exactly the stale-branding failure mode
  // this theme system exists to prevent.
  const markImage = studioMarkImage(theme);
  const compactMark = compactMarkImage(theme);
  root.style.setProperty("--studio-mark-image", markImage);
  root.style.setProperty("--studio-compact-mark-image", compactMark);
  root.dataset.lowerThirdMark = compactMark === "none" ? "hidden" : "shown";
  root.style.setProperty("--po-font-heading", theme.vars["--brand-heading-font"]);
  root.style.setProperty("--po-font-body", theme.vars["--brand-body-font"]);
  if (elements.logoImg) {
    bindOptionalBrandImage(elements.logoImg, theme, { textFallback: elements.logoText });
  }
  if (elements.logoText) {
    elements.logoText.hidden = Boolean(theme.logoSrc);
    elements.logoText.textContent = theme.textLogo || `${theme.label} Studio`;
  }
  if (elements.poweredBy) elements.poweredBy.hidden=!theme.showPoweredBy;
  if (elements.brandLink) elements.brandLink.href = theme.homeUrl || "#";
  if (elements.atmosphereBrandWord) elements.atmosphereBrandWord.textContent=theme.atmosphereBrand;
  if (elements.atmosphereProductWord) elements.atmosphereProductWord.textContent=theme.atmosphereProduct;
  if (elements.atmosphereMark) elements.atmosphereMark.style.backgroundImage = studioMarkImage(theme);
  document.querySelectorAll("[data-brand-copy]").forEach((node)=>{
    const value=theme.copy?.[node.dataset.brandCopy];
    if(value) node.textContent=value;
  });
  document.querySelectorAll("[data-brand-logo]").forEach((img)=>{
    bindOptionalBrandImage(img, theme);
  });
  document.querySelectorAll("[data-brand-home]").forEach((link)=>{ link.href = theme.homeUrl || "#"; });
  document.querySelectorAll("#brandThemeSelect, #aiBrandProfile").forEach((select)=>populateBrandThemeSelect(select, theme.id));
  document.title=`${theme.textLogo || theme.label}${document.body.classList.contains("program-output") ? " — Program Output" : ""}`;
  const favicon=document.querySelector('link[rel~="icon"]');
  if(favicon && theme.faviconSrc) favicon.href=theme.faviconSrc;
  return theme;
}

function applyArtworkTokens(root, theme) {
  const art = theme.artwork || {};
  root.style.setProperty("--studio-artwork-image", cssImage(art.backgroundArtwork));
  root.style.setProperty("--studio-watermark-image", cssImage(art.backgroundWatermark));
  root.style.setProperty("--studio-silhouette-image", cssImage(art.backgroundSilhouette));
  root.style.setProperty("--studio-pattern-image", cssImage(art.brandPattern));
  root.style.setProperty("--studio-surface-gradient", art.surfaceGradient || "linear-gradient(transparent, transparent)");
  root.style.setProperty("--studio-accent-gradient", art.accentGradient || theme.vars["--brand-gradient"]);
  root.style.setProperty("--studio-decorative-opacity", String(art.decorativeOpacity ?? 0));
  root.style.setProperty("--studio-watermark-opacity", String(art.watermarkOpacity ?? theme.vars["--studio-mark-opacity"] ?? 0.025));
  root.style.setProperty("--studio-silhouette-opacity", String(art.silhouetteOpacity ?? 0));
  root.style.setProperty("--studio-watermark-filter", art.watermarkFilter || "grayscale(1)");
  root.style.setProperty("--studio-identity-stripe", art.identityStripe || "transparent");
  root.style.setProperty("--studio-identity-stripe-width", art.identityStripeWidth || "0px");
  root.style.setProperty("--studio-logo-max-height", art.logoMaxHeight || "48px");
  root.style.setProperty("--studio-logo-max-width", art.logoMaxWidth || "180px");
  root.style.setProperty("--studio-logo-object-position", art.logoObjectPosition || "left center");
  root.style.setProperty("--studio-logo-justify", art.logoJustify || "flex-start");
  root.style.setProperty("--studio-card-radius", art.cardRadius || "16px");
  root.style.setProperty("--ui-radius", art.cardRadius || "16px");
  root.style.setProperty("--studio-grain-opacity", String(art.grainOpacity ?? 0.018));
  root.style.setProperty("--studio-grain-blend", art.grainBlend || "overlay");
  root.style.setProperty("--studio-title-card-fill", art.titleCardFill || "rgba(9, 7, 6, 0.72)");
  const treatments = ["logoTreatment", "lowerThirdTreatment", "titleCardTreatment", "introTreatment", "outroTreatment"];
  treatments.forEach((key) => {
    const value = art[key];
    if (value) root.dataset[key] = value;
    else delete root.dataset[key];
  });
  // Unlike the other four treatments above (which stay absent when a theme doesn't define one — existing,
  // untouched behavior), the participant lower-third/nameplate always needs SOME determinate CSS hook: it
  // renders on every theme, including the five (toasty/8alta/santati/optimai/tangem) that have no artwork
  // block at all. "solid-accent-bar" (css/studio.css) is the default look, built entirely from each
  // theme's own --brand-primary/--brand-text/--brand-surface/--brand-border — no new per-theme data
  // required. superteam/peeps opt into their own bespoke treatments via the SAME existing
  // artwork.lowerThirdTreatment field.
  root.dataset.lowerThirdTreatment = art.lowerThirdTreatment || "solid-accent-bar";
  // Optional per-theme escape hatch — only ever sets a property when a theme explicitly overrides it, so
  // css/studio.css's own body-level defaults (derived from existing --brand-*/--studio-* tokens) are what
  // apply everywhere else, never duplicated here.
  const lowerThird = art.lowerThird || {};
  ["Background", "Accent", "Foreground", "Secondary", "Border", "Radius", "Shadow"].forEach((suffix) => {
    const prop = `--lower-third-${suffix.toLowerCase()}`;
    const value = lowerThird[suffix.charAt(0).toLowerCase() + suffix.slice(1)];
    if (value) root.style.setProperty(prop, value);
    else root.style.removeProperty(prop);
  });
}

function cssImage(path) {
  return path ? `url("${path}")` : "none";
}

function studioMarkImage(theme) {
  const watermark = theme.artwork?.backgroundWatermark;
  if (watermark) return `url("${watermark}")`;
  if (theme.logoSrc && theme.id === "toasty") return `url("${theme.logoSrc}")`;
  if (theme.id === "toasty") return `url("../shared/brand/toasty-media/ToastyTransparent.png")`;
  return "none";
}

function compactMarkImage(theme) {
  const src = theme.compactMark || theme.faviconSrc || "";
  return src ? `url("${src}")` : "none";
}

function bindOptionalBrandImage(img, theme, { textFallback } = {}) {
  if (!img) return;
  img.onerror = () => {
    img.hidden = true;
    if (textFallback) {
      textFallback.hidden = false;
      textFallback.textContent = theme.textLogo || `${theme.label} Studio`;
    }
  };
  if (theme.logoSrc) {
    img.hidden = false;
    img.src = theme.logoSrc;
    img.alt = theme.logoAlt || `${theme.label} Studio`;
    return;
  }
  img.hidden = true;
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
