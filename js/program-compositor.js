// First-party Program Output compositor for Personal Recording.
//
// Program Output (listener.html) is DOM + cross-origin VDO iframes, so it can't be captureStream()'d —
// that's why the live master recorder tab-captures it (js/program-recording.js). Personal Recording has no
// iframes: the camera is a first-party getUserMedia stream, so the SAME program can be drawn onto a canvas
// and recorded at full quality with no screen-share picker.
//
// This module draws from the SAME canonical program state the live Program Output consumes (scene,
// asset, ticker, endCard, participants, brandTheme — see LiveSession.canonicalControlState and
// ProgramServerSubscriber), the SAME skins (BRAND_THEMES vars), the SAME layout geometry
// (resolveProgramGeometry) and the SAME End Card model. Moxie/producer/host changes arrive as state
// updates and show up in the recording; nothing here is a second source of truth.
//
// Structure (so the logic is testable without a browser):
//   buildCompositionModel(state, size, now)  pure: state -> what to draw, in pixels
//   renderProgramFrame(ctx, model, media)    draws a model onto any 2D context
//   ProgramCompositor                        owns the canvas, a background-tab-proof ticker, captureStream

import { BRAND_THEMES, DEFAULT_BRAND_THEME, normalizeBrandTheme } from "./brand-themes.js";
import { ProgramLayout } from "./program-composition.js";
import { resolveProgramGeometry } from "./program-geometry.js";
import { END_CARD_SOCIAL_LABELS, END_CARD_SOCIAL_PLATFORMS, defaultEndCard } from "./end-card.js";
import { formatCompanyTitle } from "./participant-lower-third.js";
import { tickerPixelsPerSecond } from "./program-ticker.js";

export const PersonalLayout = Object.freeze({
  SINGLE: "single",
  FULLBLEED: "fullbleed",
  ASSET_SPEAKER: "asset-speaker",
  ASSET_SPEAKER_PIP: "asset-speaker-pip",
  ASSET_FULL: "asset-full"
});

export const PERSONAL_LAYOUT_LABELS = Object.freeze({
  [PersonalLayout.SINGLE]: "Framed (single)",
  [PersonalLayout.FULLBLEED]: "Full frame",
  [PersonalLayout.ASSET_SPEAKER]: "Speaker + asset",
  [PersonalLayout.ASSET_SPEAKER_PIP]: "Asset + speaker PiP",
  [PersonalLayout.ASSET_FULL]: "Asset full"
});

export const PROGRAM_RESOLUTIONS = Object.freeze({
  "720p": Object.freeze({ width: 1280, height: 720 }),
  "1080p": Object.freeze({ width: 1920, height: 1080 })
});

const SCENE_COPY = Object.freeze({
  holding: { kicker: "Starting soon" },
  brb: { kicker: "Be right back", title: "We'll be right back" },
  "technical-difficulties": { kicker: "Technical difficulties", title: "Please stand by" }
});

export function defaultPersonalState(overrides = {}) {
  return {
    scene: "live",
    layout: PersonalLayout.SINGLE,
    brandTheme: DEFAULT_BRAND_THEME,
    sessionTitle: "",
    topic: "",
    participants: [],
    asset: null,
    ticker: { enabled: false, text: "", speed: 16 },
    lowerThird: { visible: true },
    endCard: defaultEndCard(),
    watermark: null,
    ...overrides
  };
}

export function resolveCompositorTheme(themeOrId) {
  const theme = themeOrId && typeof themeOrId === "object" ? themeOrId : BRAND_THEMES[normalizeBrandTheme(themeOrId)] || BRAND_THEMES[DEFAULT_BRAND_THEME];
  const v = theme.vars || {};
  return {
    id: theme.id,
    label: theme.label,
    textLogo: theme.textLogo || theme.label || "",
    logoSrc: theme.logoSrc || "",
    showPoweredBy: Boolean(theme.showPoweredBy),
    colors: {
      canvasTop: v["--studio-canvas"] || v["--brand-background"] || "#0b0908",
      canvasBottom: v["--studio-canvas-2"] || v["--brand-surface"] || "#0f0b0a",
      surface: v["--brand-surface"] || "#171210",
      surfaceAlt: v["--brand-surface-alt"] || "#201815",
      primary: v["--brand-primary"] || "#ff7a29",
      secondary: v["--brand-secondary"] || "#ffc670",
      accent: v["--brand-accent"] || "#ffab5c",
      text: v["--brand-text"] || "#f4ead9",
      muted: v["--brand-text-muted"] || "#9c8d7c",
      border: v["--brand-border"] || "rgba(255,255,255,0.12)",
      buttonText: v["--brand-button-text"] || "#1c0f06"
    },
    fonts: {
      heading: v["--brand-heading-font"] || "Montserrat, Inter, system-ui, sans-serif",
      body: v["--brand-body-font"] || "Inter, system-ui, sans-serif"
    }
  };
}

// "6% 12%" / "4%" / "1% 2% 3% 4%" -> pixel insets (CSS shorthand order). Geometry specs are all percentages.
export function parsePadding(spec, width, height) {
  const parts = String(spec || "0").trim().split(/\s+/).map((part) => parseFloat(part) / 100);
  const [a, b = a, c = a, d = b] = parts.length ? parts : [0];
  return {
    top: a * height,
    right: b * width,
    bottom: c * height,
    left: d * width
  };
}

function rect(x, y, w, h, radius = 0) {
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), radius: Math.round(radius) };
}

function scaledCenter(box, scale) {
  const w = box.w * scale;
  const h = box.h * scale;
  return rect(box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h, box.radius);
}

function radiusFor(geometry, width) {
  const px = parseFloat(geometry.frame.radius) || 16;
  return Math.round(px * (width / 1280));
}

// Where the camera (and an asset, when one is live) go, per layout. Uses the same geometry table the DOM
// Program Output does, so "Framed" here is the same floating-frame look, scaled to the canvas.
export function computeFrameLayout({ layout, width, height, hasAsset }) {
  const effective = !hasAsset && layout !== PersonalLayout.FULLBLEED ? PersonalLayout.SINGLE : layout;
  const geometryLayout = {
    [PersonalLayout.SINGLE]: ProgramLayout.SINGLE,
    [PersonalLayout.FULLBLEED]: ProgramLayout.SINGLE,
    [PersonalLayout.ASSET_SPEAKER]: ProgramLayout.ASSET_SPEAKER,
    [PersonalLayout.ASSET_SPEAKER_PIP]: ProgramLayout.ASSET_SPEAKER_PIP,
    [PersonalLayout.ASSET_FULL]: ProgramLayout.ASSET_FULL
  }[effective] || ProgramLayout.SINGLE;
  const geometry = resolveProgramGeometry(geometryLayout);
  const radius = radiusFor(geometry, width);
  if (effective === PersonalLayout.FULLBLEED || (layout === PersonalLayout.FULLBLEED && !hasAsset)) {
    return { layout: PersonalLayout.FULLBLEED, camera: rect(0, 0, width, height, 0), asset: null, chrome: true, focal: geometry.frame.focal };
  }
  const pad = parsePadding(geometry.canvasPadding, width, height);
  const content = rect(pad.left, pad.top, width - pad.left - pad.right, height - pad.top - pad.bottom, radius);
  const gap = (parseFloat(geometry.gap) || 0) / 100 * width;
  if (effective === PersonalLayout.SINGLE) {
    // 16:9 frame centred in the content box.
    const target = 16 / 9;
    const fitW = Math.min(content.w, content.h * target) * geometry.frame.scale;
    const frame = rect(content.x + (content.w - fitW) / 2, content.y + (content.h - fitW / target) / 2, fitW, fitW / target, radius);
    return { layout: effective, camera: frame, asset: null, chrome: true, focal: geometry.frame.focal };
  }
  if (effective === PersonalLayout.ASSET_FULL) {
    return { layout: effective, camera: null, asset: scaledCenter(content, geometry.frame.scale), chrome: true, focal: geometry.frame.focal };
  }
  if (effective === PersonalLayout.ASSET_SPEAKER_PIP) {
    const asset = scaledCenter(content, geometry.frame.scale);
    const pipW = Math.round(asset.w * 0.24);
    const pipH = Math.round(pipW * 9 / 16);
    const inset = Math.round(width * 0.018);
    return {
      layout: effective,
      asset,
      camera: rect(asset.x + asset.w - pipW - inset, asset.y + asset.h - pipH - inset, pipW, pipH, Math.round(radius * 0.7)),
      chrome: true,
      focal: geometry.frame.focal
    };
  }
  // ASSET_SPEAKER: asset left (62%), speaker right.
  const speakerW = Math.round((content.w - gap) * 0.36);
  const assetW = content.w - gap - speakerW;
  const asset = scaledCenter(rect(content.x, content.y, assetW, content.h, radius), geometry.frame.scale);
  const speakerH = Math.min(content.h * geometry.frame.scale, speakerW * 16 / 12);
  const camera = rect(content.x + assetW + gap, content.y + (content.h - speakerH) / 2, speakerW, speakerH, radius);
  return { layout: effective, asset, camera, chrome: true, focal: geometry.frame.focal };
}

function primaryParticipant(state) {
  const list = Array.isArray(state.participants) ? state.participants : [];
  return list.find((p) => p?.onProgram !== false && (p.role === "host" || p.participantId === "host")) || list.find((p) => p?.onProgram !== false) || null;
}

export function tickerOffset({ nowMs, startedMs, speed, viewportWidth, textWidth }) {
  const pps = tickerPixelsPerSecond(speed);
  const distance = viewportWidth + textWidth;
  const travelled = ((nowMs - startedMs) / 1000 * pps) % Math.max(1, distance);
  return viewportWidth - travelled;
}

// state -> draw model. `now` is ms (for the ticker); everything else is deterministic.
export function buildCompositionModel(rawState = {}, { width = 1280, height = 720, now = Date.now(), tickerStartedMs = 0 } = {}) {
  const state = { ...defaultPersonalState(), ...rawState };
  const theme = resolveCompositorTheme(state.brandTheme);
  const scene = state.scene || "live";
  const model = { width, height, theme, scene, now, layout: null, cameraVisible: false, lowerThird: null, ticker: null, asset: null, card: null, endCard: null, watermark: null };
  const u = width / 1280; // scale type with canvas size
  model.unit = u;
  if (scene === "ending") {
    const endCard = { ...defaultEndCard(), ...(state.endCard || {}) };
    model.endCard = {
      headline: endCard.headline || "THANKS FOR WATCHING",
      message: endCard.message || "",
      website: endCard.website || "",
      socials: END_CARD_SOCIAL_PLATFORMS.map((platform) => [END_CARD_SOCIAL_LABELS[platform], endCard.socials?.[platform]]).filter(([, value]) => value),
      qrImage: endCard.showQr && endCard.qrImage ? endCard.qrImage : ""
    };
  } else if (scene !== "live") {
    const copy = SCENE_COPY[scene] || SCENE_COPY.holding;
    model.card = { kicker: copy.kicker, title: copy.title || state.topic || state.sessionTitle || theme.textLogo, subtitle: scene === "holding" ? state.sessionTitle : "" };
  } else {
    const hasAsset = Boolean(state.asset && state.asset.status !== "removed" && state.asset.media?.kind !== "audio");
    const frames = computeFrameLayout({ layout: state.layout, width, height, hasAsset });
    model.layout = frames;
    model.cameraVisible = Boolean(frames.camera);
    if (hasAsset && frames.asset) {
      model.asset = {
        rect: frames.asset,
        title: state.asset.preview?.title || state.asset.title || "",
        sourceName: state.asset.preview?.sourceName || state.asset.sourceName || "",
        excerpt: state.asset.preview?.excerpt || state.asset.excerpt || "",
        imageUrl: state.asset.preview?.imageUrl || (state.asset.media?.kind === "image" ? state.asset.media.src : "") || ""
      };
    }
    const person = primaryParticipant(state);
    if (person && state.lowerThird?.visible !== false && frames.camera && (person.displayName || "").trim()) {
      model.lowerThird = {
        name: person.displayName.trim(),
        secondary: formatCompanyTitle(person),
        anchor: frames.camera
      };
    }
    if (state.ticker?.enabled && state.ticker.text) {
      model.ticker = { text: String(state.ticker.text), speed: state.ticker.speed, startedMs: tickerStartedMs, height: Math.round(40 * u) };
    }
  }
  const watermark = state.watermark ?? (theme.showPoweredBy ? "Powered by Toasty Studio" : "");
  if (watermark) model.watermark = String(watermark);
  return model;
}

// --- Drawing ------------------------------------------------------------------------------------------------

function roundedRectPath(ctx, r) {
  const radius = Math.min(r.radius || 0, r.w / 2, r.h / 2);
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(r.x, r.y, r.w, r.h, radius); return; }
  ctx.moveTo(r.x + radius, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, radius);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, radius);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, radius);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, radius);
  ctx.closePath();
}

function drawCover(ctx, source, sw, sh, dest, focalY = 0.5) {
  if (!sw || !sh) return;
  const scale = Math.max(dest.w / sw, dest.h / sh);
  const cw = dest.w / scale;
  const ch = dest.h / scale;
  const sx = (sw - cw) / 2;
  const sy = Math.max(0, Math.min(sh - ch, (sh - ch) * focalY));
  ctx.drawImage(source, sx, sy, cw, ch, dest.x, dest.y, dest.w, dest.h);
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function focalYFrom(focal = "") {
  const match = /(\d+)%$/.exec(String(focal));
  return match ? Number(match[1]) / 100 : 0.5;
}

function paintBackground(ctx, model) {
  const { width, height, theme } = model;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, theme.colors.canvasTop);
  gradient.addColorStop(1, theme.colors.canvasBottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * 0.78, height * 0.1, 0, width * 0.78, height * 0.1, width * 0.55);
  glow.addColorStop(0, withAlpha(theme.colors.primary, 0.16));
  glow.addColorStop(1, withAlpha(theme.colors.primary, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
}

export function withAlpha(color, alpha) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color;
}

function drawLogo(ctx, model, media) {
  const { theme, unit } = model;
  const x = 40 * unit;
  const y = 28 * unit;
  if (media.logo && media.logo.naturalWidth) {
    const h = 44 * unit;
    ctx.drawImage(media.logo, x, y, (media.logo.naturalWidth / media.logo.naturalHeight) * h, h);
  } else if (theme.textLogo) {
    ctx.font = `800 ${22 * unit}px ${theme.fonts.heading}`;
    ctx.fillStyle = theme.colors.primary;
    ctx.textBaseline = "top";
    ctx.fillText(theme.textLogo.toUpperCase(), x, y + 8 * unit);
  }
}

function drawCenteredCard(ctx, model, media) {
  const { width, height, theme, unit, card } = model;
  drawLogoCentered(ctx, model, media, height * 0.28);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.colors.accent;
  ctx.font = `700 ${22 * unit}px ${theme.fonts.body}`;
  ctx.fillText(card.kicker.toUpperCase(), width / 2, height * 0.46);
  ctx.fillStyle = theme.colors.text;
  ctx.font = `800 ${56 * unit}px ${theme.fonts.heading}`;
  const lines = wrapText(ctx, card.title, width * 0.76, 2);
  lines.forEach((line, i) => ctx.fillText(line, width / 2, height * 0.56 + i * 68 * unit));
  if (card.subtitle) {
    ctx.fillStyle = theme.colors.muted;
    ctx.font = `500 ${24 * unit}px ${theme.fonts.body}`;
    ctx.fillText(card.subtitle, width / 2, height * 0.56 + lines.length * 68 * unit + 20 * unit);
  }
  ctx.textAlign = "left";
}

function drawLogoCentered(ctx, model, media, centerY) {
  const { width, theme, unit } = model;
  if (media.logo && media.logo.naturalWidth) {
    const h = 84 * unit;
    const w = (media.logo.naturalWidth / media.logo.naturalHeight) * h;
    ctx.drawImage(media.logo, (width - w) / 2, centerY - h / 2, w, h);
  } else if (theme.textLogo) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${34 * unit}px ${theme.fonts.heading}`;
    ctx.fillStyle = theme.colors.primary;
    ctx.fillText(theme.textLogo.toUpperCase(), width / 2, centerY);
    ctx.textAlign = "left";
  }
}

function drawEndCard(ctx, model, media) {
  const { width, height, theme, unit, endCard } = model;
  drawLogoCentered(ctx, model, media, height * 0.2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.colors.text;
  ctx.font = `800 ${60 * unit}px ${theme.fonts.heading}`;
  const headlineLines = wrapText(ctx, endCard.headline, width * 0.8, 2);
  headlineLines.forEach((line, i) => ctx.fillText(line, width / 2, height * 0.38 + i * 70 * unit));
  let y = height * 0.38 + headlineLines.length * 70 * unit + 10 * unit;
  if (endCard.message) {
    ctx.fillStyle = theme.colors.muted;
    ctx.font = `500 ${26 * unit}px ${theme.fonts.body}`;
    for (const line of wrapText(ctx, endCard.message, width * 0.62, 3)) { ctx.fillText(line, width / 2, y); y += 36 * unit; }
  }
  if (endCard.website) {
    ctx.fillStyle = theme.colors.primary;
    ctx.font = `700 ${32 * unit}px ${theme.fonts.heading}`;
    ctx.fillText(endCard.website, width / 2, y + 18 * unit);
    y += 56 * unit;
  }
  if (endCard.socials.length) {
    ctx.fillStyle = theme.colors.text;
    ctx.font = `600 ${22 * unit}px ${theme.fonts.body}`;
    const text = endCard.socials.map(([label, handle]) => `${label}  ${handle}`).join("     ");
    ctx.fillText(text, width / 2, Math.min(y + 20 * unit, height * 0.88));
  }
  if (endCard.qrImage && media.qr && media.qr.naturalWidth) {
    const size = 150 * unit;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(width - size - 60 * unit, height - size - 60 * unit, size, size);
    ctx.drawImage(media.qr, width - size - 60 * unit + 8 * unit, height - size - 60 * unit + 8 * unit, size - 16 * unit, size - 16 * unit);
  }
  ctx.textAlign = "left";
}

function drawAsset(ctx, model, media) {
  const { asset, theme, unit } = model;
  const r = asset.rect;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.42)";
  ctx.shadowBlur = 40 * unit;
  ctx.shadowOffsetY = 18 * unit;
  roundedRectPath(ctx, r);
  ctx.fillStyle = theme.colors.surface;
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundedRectPath(ctx, r);
  ctx.clip();
  const pad = 36 * unit;
  let textTop = r.y + pad;
  if (media.assetImage && media.assetImage.naturalWidth) {
    const imgH = r.h * 0.5;
    drawCover(ctx, media.assetImage, media.assetImage.naturalWidth, media.assetImage.naturalHeight, rect(r.x, r.y, r.w, imgH, 0));
    textTop = r.y + imgH + pad * 0.6;
  }
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.colors.accent;
  ctx.font = `700 ${16 * unit}px ${theme.fonts.body}`;
  if (asset.sourceName) { ctx.fillText(asset.sourceName.toUpperCase(), r.x + pad, textTop); textTop += 28 * unit; }
  ctx.fillStyle = theme.colors.text;
  ctx.font = `800 ${Math.max(22, 34 * unit * Math.min(1, r.w / (900 * unit)))}px ${theme.fonts.heading}`;
  for (const line of wrapText(ctx, asset.title, r.w - pad * 2, 3)) { ctx.fillText(line, r.x + pad, textTop); textTop += 44 * unit; }
  if (asset.excerpt && textTop < r.y + r.h - 60 * unit) {
    ctx.fillStyle = theme.colors.muted;
    ctx.font = `500 ${20 * unit}px ${theme.fonts.body}`;
    const room = Math.max(1, Math.floor((r.y + r.h - textTop - pad) / (28 * unit)));
    for (const line of wrapText(ctx, asset.excerpt, r.w - pad * 2, Math.min(5, room))) { ctx.fillText(line, r.x + pad, textTop + 8 * unit); textTop += 28 * unit; }
  }
  ctx.restore();
}

function drawLowerThird(ctx, model) {
  const { lowerThird, theme, unit } = model;
  const a = lowerThird.anchor;
  const nameSize = 26 * unit;
  const roleSize = 17 * unit;
  const barH = (lowerThird.secondary ? 74 : 54) * unit;
  const x = a.x + 22 * unit;
  const y = a.y + a.h - barH - 22 * unit;
  ctx.save();
  ctx.font = `800 ${nameSize}px ${theme.fonts.heading}`;
  const nameW = ctx.measureText(lowerThird.name).width;
  ctx.font = `500 ${roleSize}px ${theme.fonts.body}`;
  const roleW = lowerThird.secondary ? ctx.measureText(lowerThird.secondary).width : 0;
  const w = Math.min(a.w - 44 * unit, Math.max(nameW, roleW) + 44 * unit);
  ctx.fillStyle = withAlpha(theme.colors.surface, 0.92);
  roundedRectPath(ctx, rect(x, y, w, barH, 8 * unit));
  ctx.fill();
  ctx.fillStyle = theme.colors.primary;
  ctx.fillRect(x, y + 6 * unit, 5 * unit, barH - 12 * unit);
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.colors.text;
  ctx.font = `800 ${nameSize}px ${theme.fonts.heading}`;
  ctx.fillText(lowerThird.name, x + 20 * unit, y + 9 * unit, w - 30 * unit);
  if (lowerThird.secondary) {
    ctx.fillStyle = theme.colors.muted;
    ctx.font = `500 ${roleSize}px ${theme.fonts.body}`;
    ctx.fillText(lowerThird.secondary, x + 20 * unit, y + 12 * unit + nameSize, w - 30 * unit);
  }
  ctx.restore();
}

function drawTicker(ctx, model) {
  const { ticker, theme, width, height, unit } = model;
  const y = height - ticker.height;
  ctx.fillStyle = withAlpha(theme.colors.surface, 0.94);
  ctx.fillRect(0, y, width, ticker.height);
  ctx.fillStyle = theme.colors.primary;
  ctx.fillRect(0, y, width, 3 * unit);
  ctx.font = `600 ${20 * unit}px ${theme.fonts.body}`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.colors.text;
  const textWidth = ctx.measureText(ticker.text).width;
  const x = tickerOffset({ nowMs: model.now, startedMs: ticker.startedMs, speed: ticker.speed, viewportWidth: width, textWidth });
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y, width, ticker.height);
  ctx.clip();
  ctx.fillText(ticker.text, x, y + ticker.height / 2 + 2 * unit);
  ctx.restore();
}

// Draws one frame. `media` = { video, logo, qr, assetImage } — all optional; missing media simply isn't drawn.
export function renderProgramFrame(ctx, model, media = {}) {
  ctx.save();
  paintBackground(ctx, model);
  if (model.endCard) {
    drawEndCard(ctx, model, media);
  } else if (model.card) {
    drawCenteredCard(ctx, model, media);
  } else {
    if (model.layout?.chrome && model.layout.layout !== PersonalLayout.FULLBLEED) drawLogo(ctx, model, media);
    if (model.asset) drawAsset(ctx, model, media);
    if (model.cameraVisible && media.video) {
      const cam = model.layout.camera;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.42)";
      ctx.shadowBlur = 36 * model.unit;
      ctx.shadowOffsetY = 16 * model.unit;
      roundedRectPath(ctx, cam);
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundedRectPath(ctx, cam);
      ctx.clip();
      drawCover(ctx, media.video, media.video.videoWidth || cam.w, media.video.videoHeight || cam.h, cam, focalYFrom(model.layout.focal));
      ctx.restore();
      ctx.strokeStyle = model.theme.colors.border;
      ctx.lineWidth = Math.max(1, model.unit);
      roundedRectPath(ctx, cam);
      ctx.stroke();
    }
    if (model.lowerThird) drawLowerThird(ctx, model);
    if (model.ticker) drawTicker(ctx, model);
  }
  if (model.watermark) {
    ctx.font = `600 ${14 * model.unit}px ${model.theme.fonts.body}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = withAlpha(model.theme.colors.text, 0.55);
    ctx.fillText(model.watermark, model.width - 24 * model.unit, model.height - (model.ticker ? model.ticker.height + 10 * model.unit : 16 * model.unit));
    ctx.textAlign = "left";
  }
  ctx.restore();
}

// Timer that keeps ticking when the tab is hidden: rAF stops entirely and setInterval is clamped to 1s in
// background tabs, which would freeze the recorded program the moment the host alt-tabs to a slide. A
// Worker's timers aren't throttled.
export function createFrameTicker(fps, callback, { WorkerImpl = globalThis.Worker, BlobImpl = globalThis.Blob, URLImpl = globalThis.URL, setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval } = {}) {
  const interval = Math.max(8, Math.round(1000 / fps));
  if (WorkerImpl && BlobImpl && URLImpl?.createObjectURL) {
    try {
      const url = URLImpl.createObjectURL(new BlobImpl([`let t=null;onmessage=e=>{if(e.data==='start'){t=setInterval(()=>postMessage(0),${interval})}else{clearInterval(t);t=null}}`], { type: "text/javascript" }));
      const worker = new WorkerImpl(url);
      worker.onmessage = () => callback();
      worker.postMessage("start");
      return { kind: "worker", stop() { worker.postMessage("stop"); worker.terminate(); URLImpl.revokeObjectURL?.(url); } };
    } catch { /* CSP or sandbox blocks blob workers: fall back */ }
  }
  const id = setIntervalImpl(callback, interval);
  return { kind: "interval", stop() { clearIntervalImpl(id); } };
}

function loadImage(src, ImageImpl = globalThis.Image) {
  return new Promise((resolve) => {
    if (!src || !ImageImpl) return resolve(null);
    const image = new ImageImpl();
    image.crossOrigin = "anonymous"; // never taint the canvas: a tainted canvas records black frames
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export class ProgramCompositor {
  constructor({
    stream = null,
    video = null,
    canvas = null,
    resolution = "720p",
    fps = 30,
    state = {},
    documentImpl = globalThis.document,
    ImageImpl = globalThis.Image,
    tickerFactory = createFrameTicker,
    nowImpl = () => Date.now()
  } = {}) {
    const size = PROGRAM_RESOLUTIONS[resolution] || PROGRAM_RESOLUTIONS["720p"];
    this.width = size.width;
    this.height = size.height;
    this.fps = fps;
    this.documentImpl = documentImpl;
    this.ImageImpl = ImageImpl;
    this.tickerFactory = tickerFactory;
    this.nowImpl = nowImpl;
    this.canvas = canvas || documentImpl.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.stream = stream;
    this.video = video || null;
    this.state = defaultPersonalState(state);
    this.media = { video: null, logo: null, qr: null, assetImage: null };
    this._imageKeys = { logo: "", qr: "", assetImage: "" };
    this.tickerStartedMs = nowImpl();
    this.ticker = null;
    this.framesDrawn = 0;
  }

  async attachStream(stream) {
    this.stream = stream;
    if (!this.video) {
      this.video = this.documentImpl.createElement("video");
      this.video.muted = true;
      this.video.playsInline = true;
    }
    this.video.srcObject = stream;
    await this.video.play?.().catch(() => {});
    this.media.video = this.video;
  }

  setState(next = {}) {
    const previousTicker = this.state.ticker?.text;
    this.state = { ...this.state, ...next };
    if (next.ticker && next.ticker.text !== previousTicker) this.tickerStartedMs = this.nowImpl();
    void this._refreshImages();
  }

  async _refreshImages() {
    const theme = resolveCompositorTheme(this.state.brandTheme);
    const wanted = {
      logo: theme.logoSrc,
      qr: this.state.scene === "ending" && this.state.endCard?.showQr ? this.state.endCard.qrImage : "",
      assetImage: this.state.asset?.preview?.imageUrl || (this.state.asset?.media?.kind === "image" ? this.state.asset.media.src : "") || ""
    };
    for (const [slot, src] of Object.entries(wanted)) {
      if (this._imageKeys[slot] === src) continue;
      this._imageKeys[slot] = src;
      this.media[slot] = null;
      const image = await loadImage(src, this.ImageImpl);
      if (this._imageKeys[slot] === src) this.media[slot] = image;
    }
  }

  drawFrame() {
    const model = buildCompositionModel(this.state, { width: this.width, height: this.height, now: this.nowImpl(), tickerStartedMs: this.tickerStartedMs });
    renderProgramFrame(this.ctx, model, this.media);
    this.framesDrawn += 1;
    return model;
  }

  start() {
    if (this.ticker) return;
    void this._refreshImages();
    this.drawFrame();
    this.ticker = this.tickerFactory(this.fps, () => this.drawFrame());
  }

  stop() {
    this.ticker?.stop();
    this.ticker = null;
    if (this.video) { this.video.srcObject = null; }
  }

  captureStream() {
    return this.canvas.captureStream(this.fps);
  }
}
