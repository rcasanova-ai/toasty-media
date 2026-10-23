// Canvas drawing for one clip frame. Takes the plain frame description from computeFrame() (js/clip-timeline.js) and paints it.
// Nothing here decides timing; it only knows how to draw each styled element.
import { EASE } from "./clip-timeline.js";

const FONTS = {
  sans: "'Montserrat','Helvetica Neue',Arial,sans-serif",
  display: "Impact,'Arial Black','Helvetica Neue',sans-serif",
  serif: "Georgia,'Times New Roman',serif",
  mono: "'SF Mono',Menlo,Consolas,monospace"
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/), lines = [];
  let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > maxWidth && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  return lines;
}

// Cover-fit a source into the whole canvas with camera zoom/pan and a horizontal focus (0..1) used when cropping to a
// narrower frame (9:16 from a 16:9 recording): the crop window slides toward where the people are.
function drawVideoCover(ctx, video, W, H, camera, focusX) {
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const scale = Math.max(W / vw, H / vh) * camera.scale;
  const dw = vw * scale, dh = vh * scale;
  const overflowX = dw - W;
  const x = -overflowX * clamp01(focusX) + camera.panX * W;
  const y = (H - dh) / 2 + camera.panY * H;
  ctx.drawImage(video, x, y, dw, dh);
}

function drawLogo(ctx, logo, x, y, maxW, maxH, alpha = 1) {
  if (!logo || !logo.width) return false;
  const k = Math.min(maxW / logo.width, maxH / logo.height);
  const w = logo.width * k, h = logo.height * k;
  ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(logo, x - w / 2, y - h / 2, w, h); ctx.restore();
  return true;
}

function drawIntro(ctx, f, tpl, W, H, assets) {
  const it = f.intro, th = tpl.theme, font = FONTS[th.font];
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  // accent shapes sweep in
  const k = EASE.out(clamp01(it.p / 0.5));
  ctx.fillStyle = th.accent; ctx.globalAlpha = 0.9; ctx.fillRect(0, H * 0.66, W * k, H * 0.008); ctx.globalAlpha = 1;
  if (it.kind === "logo-sting") {
    const s = 0.7 + 0.3 * EASE.back(clamp01(it.p / 0.5));
    if (!drawLogo(ctx, assets.logo, W / 2, H * 0.42, W * 0.5 * s, H * 0.3 * s, clamp01(it.p / 0.25))) { ctx.fillStyle = th.accent; ctx.font = `${H * 0.08 * s}px ${font}`; ctx.textAlign = "center"; ctx.fillText("TOASTY", W / 2, H * 0.45); }
  }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (it.kind === "rolling-title" || it.kind === "title-card" || it.kind === "logo-sting") {
    const size = Math.min(W, H) * (it.kind === "logo-sting" ? 0.06 : 0.1);
    ctx.font = `${size}px ${font}`;
    const rows = it.kind === "rolling-title" ? it.rows : wrapLines(ctx, it.title, W * 0.82).slice(0, 4).map((text) => ({ text, k: EASE.out(clamp01(it.p / 0.4)), out: clamp01((it.p - 0.85) / 0.15) }));
    const lineH = size * 1.18, startY = (it.kind === "logo-sting" ? H * 0.68 : H * 0.5) - ((rows.length - 1) * lineH) / 2;
    rows.forEach((row, i) => {
      const rise = (1 - Math.min(1, row.k)) * size * 1.4, a = clamp01(row.k) * (1 - row.out);
      ctx.save(); ctx.globalAlpha = a; ctx.translate(0, rise - row.out * size);
      ctx.fillStyle = i === rows.length - 1 && rows.length > 1 ? th.accent2 : th.fg;
      ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = size * 0.2;
      ctx.fillText(row.text, W / 2, startY + i * lineH);
      ctx.restore();
    });
    if (it.subtitle) { ctx.save(); ctx.globalAlpha = clamp01((it.p - 0.3) / 0.25) * (1 - clamp01((it.p - 0.85) / 0.15)); ctx.fillStyle = th.accent; ctx.font = `${Math.min(W, H) * 0.04}px ${FONTS.sans}`; ctx.fillText(it.subtitle, W / 2, startY + rows.length * lineH * 0.9 + size * 0.5); ctx.restore(); }
  }
}

function drawOutro(ctx, f, tpl, W, H, assets) {
  const o = f.outro, th = tpl.theme, font = FONTS[th.font];
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = th.accent; ctx.globalAlpha = 0.18; ctx.beginPath(); ctx.arc(W * 0.85, H * 0.15, Math.min(W, H) * (0.25 + 0.05 * o.k), 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const a = clamp01(o.p / 0.25);
  if (o.kind === "brand-end") {
    const drawn = drawLogo(ctx, assets.logo, W / 2, H * 0.42, W * 0.46, H * 0.28, a);
    ctx.globalAlpha = a; ctx.fillStyle = th.fg; ctx.font = `${Math.min(W, H) * (drawn ? 0.055 : 0.09)}px ${font}`; ctx.fillText(o.text, W / 2, drawn ? H * 0.66 : H * 0.46);
    ctx.fillStyle = th.accent; ctx.font = `${Math.min(W, H) * 0.036}px ${FONTS.sans}`; ctx.fillText(o.subtitle, W / 2, drawn ? H * 0.74 : H * 0.58); ctx.globalAlpha = 1;
  } else if (o.kind === "cta") {
    const size = Math.min(W, H) * 0.085; ctx.font = `${size}px ${font}`;
    const lines = wrapLines(ctx, o.text, W * 0.8); ctx.globalAlpha = a; ctx.fillStyle = th.fg;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, H * 0.42 + (i - (lines.length - 1) / 2) * size * 1.2));
    const bw = W * 0.5, bh = size * 1.1, by = H * 0.42 + lines.length * size * 0.75 + size * 0.5; ctx.fillStyle = th.accent; roundRect(ctx, W / 2 - bw / 2, by, bw, bh, bh / 2); ctx.fill();
    ctx.fillStyle = th.bg; ctx.font = `${size * 0.5}px ${FONTS.sans}`; ctx.fillText(o.subtitle || "toasty.media", W / 2, by + bh / 2); ctx.globalAlpha = 1;
  }
}

function drawCaptions(ctx, c, W, H, tpl) {
  const size = c.size * Math.min(W, H) * (W > H ? 1.35 : 1.1), th = tpl.theme, font = c.style === "bar" ? FONTS.sans : FONTS[th.font];
  const text = (w) => (c.uppercase ? w.text.toUpperCase() : w.text);
  ctx.save(); ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.font = `${size}px ${font}`;
  const cy = c.position === "top" ? H * 0.16 : c.position === "center" ? H * 0.5 : H * 0.8;
  if (c.style === "bar") {
    const line = c.words.map(text).join(" "), lines = wrapLines(ctx, line, W * 0.84).slice(0, 3), lh = size * 1.25;
    const bw = Math.min(W * 0.9, Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 1.2), bh = lines.length * lh + size * 0.5;
    ctx.globalAlpha = 0.78; ctx.fillStyle = "#000"; roundRect(ctx, W / 2 - bw / 2, cy - bh / 2, bw, bh, size * 0.3); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff"; lines.forEach((l, i) => ctx.fillText(l, W / 2, cy - ((lines.length - 1) / 2) * lh + i * lh));
  } else {
    // kinetic / karaoke: words laid out in a row (wrapping), the active word pops and takes the highlight colour
    const gap = size * 0.28, widths = c.words.map((w) => ctx.measureText(text(w)).width);
    const rows = []; let row = [], rw = 0;
    c.words.forEach((w, i) => { if (row.length && rw + gap + widths[i] > W * 0.88) { rows.push({ row, rw }); row = []; rw = 0; } row.push(i); rw += (row.length > 1 ? gap : 0) + widths[i]; });
    rows.push({ row, rw });
    const lh = size * 1.2;
    rows.forEach(({ row: r, rw: total }, ri) => {
      let x = W / 2 - total / 2; const y = cy - ((rows.length - 1) / 2) * lh + ri * lh;
      r.forEach((i) => {
        const w = c.words[i], active = w.state === "active", past = w.state === "past";
        const pop = active ? 1 + 0.18 * Math.sin(Math.PI * Math.min(1, w.k)) : 1;
        ctx.save(); ctx.translate(x + widths[i] / 2, y); ctx.scale(pop, pop);
        ctx.globalAlpha = c.style === "kinetic" && w.state === "future" ? 0 : (w.state === "future" ? 0.55 : 1) * (c.style === "kinetic" && !active ? 0.92 : 1);
        ctx.lineWidth = size * 0.16; ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineJoin = "round"; ctx.strokeText(text(w), 0, 0);
        ctx.fillStyle = active ? c.highlight : (past && c.style === "karaoke" ? c.highlight : "#fff"); ctx.fillText(text(w), 0, 0);
        ctx.restore(); x += widths[i] + gap;
      });
    });
  }
  ctx.restore();
}

function drawTransition(ctx, f, tpl, W, H, drawLayer) {
  const t = f.transition, p = t.p;
  // The two phases are drawn into the main canvas by the caller; here the overlay shape finishes the effect.
  ctx.save();
  if (t.kind === "fade") { ctx.globalAlpha = Math.sin(Math.PI * p) * 0.9; ctx.fillStyle = tpl.theme.bg; ctx.fillRect(0, 0, W, H); }
  else if (t.kind === "wipe") { ctx.fillStyle = tpl.theme.accent; const x = (p < 0.5 ? p * 2 : (p - 0.5) * 2) * W; if (p < 0.5) ctx.fillRect(0, 0, x, H); else ctx.fillRect(x, 0, W - x, H); }
  else if (t.kind === "slide") { ctx.fillStyle = tpl.theme.accent; const k = Math.sin(Math.PI * p); ctx.fillRect(0, H * (1 - k), W, H * k); }
  else if (t.kind === "zoom") { ctx.globalAlpha = Math.sin(Math.PI * p) * 0.85; ctx.fillStyle = tpl.theme.fg; ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.hypot(W, H) * 0.55 * Math.sin(Math.PI * p), 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

export function drawFrame(ctx, f, tpl, { W, H, video = null, assets = {}, focusX = 0.5, images = [], brandName = "" } = {}) {
  ctx.save();
  ctx.fillStyle = tpl.theme.bg; ctx.fillRect(0, 0, W, H);
  const showClip = f.phase === "clip" || (f.transition && f.transition.to === "clip" && f.phase !== "outro") || (f.transition && f.transition.from === "clip");
  if (f.phase === "intro" && !(f.transition && f.transition.p > 0.5)) drawIntro(ctx, f, tpl, W, H, assets);
  else if (f.phase === "outro" && !(f.transition && f.transition.p < 0.5)) drawOutro(ctx, f, tpl, W, H, assets);
  else if (showClip || f.phase === "intro" || f.phase === "outro") {
    if (video && video.readyState >= 2) drawVideoCover(ctx, video, W, H, f.camera, focusX);
    if (tpl.overlays.frame === "letterbox") { ctx.fillStyle = "#000"; const bar = H * 0.1; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar); }
    if (tpl.overlays.frame === "border") { ctx.strokeStyle = tpl.theme.accent; ctx.lineWidth = Math.min(W, H) * 0.012; ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth); }
    const o = f.overlays, m = Math.min(W, H);
    if (o.progressBar != null) { ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(0, 0, W, m * 0.012); ctx.fillStyle = tpl.theme.accent; ctx.fillRect(0, 0, W * o.progressBar, m * 0.012); }
    if (o.badge && o.badge.alpha > 0) { ctx.save(); ctx.globalAlpha = o.badge.alpha; ctx.font = `${m * 0.04}px ${FONTS[tpl.theme.font]}`; const tw = ctx.measureText(o.badge.text).width + m * 0.05; ctx.fillStyle = tpl.theme.accent; roundRect(ctx, m * 0.04, m * 0.06, tw, m * 0.075, m * 0.01); ctx.fill(); ctx.fillStyle = tpl.theme.bg; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillText(o.badge.text, m * 0.065, m * 0.0975); ctx.restore(); }
    if (o.lowerThird) { const l = o.lowerThird; ctx.save(); ctx.globalAlpha = l.alpha; ctx.translate(-l.slide * W * 0.25, 0); const y = H * (W > H ? 0.74 : 0.66), bw = W * (W > H ? 0.34 : 0.7), bh = m * 0.13; ctx.fillStyle = tpl.theme.accent; ctx.fillRect(m * 0.04, y, m * 0.012, bh); ctx.fillStyle = "rgba(0,0,0,0.72)"; ctx.fillRect(m * 0.052, y, bw, bh); ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.fillStyle = "#fff"; ctx.font = `${m * 0.05}px ${FONTS[tpl.theme.font]}`; ctx.fillText(l.name, m * 0.075, y + bh * 0.5); if (l.role) { ctx.fillStyle = tpl.theme.accent2; ctx.font = `${m * 0.032}px ${FONTS.sans}`; ctx.fillText(l.role, m * 0.075, y + bh * 0.86); } ctx.restore(); }
    for (const c of o.custom) { ctx.save(); ctx.globalAlpha = c.alpha; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `${m * 0.07}px ${FONTS[tpl.theme.font]}`; ctx.lineWidth = m * 0.012; ctx.strokeStyle = "rgba(0,0,0,0.85)"; const y = (c.position === "top" ? H * 0.18 : H * 0.45) + c.rise * m * 0.05; const lines = wrapLines(ctx, c.text, W * 0.8); lines.forEach((l, i) => { ctx.strokeText(l, W / 2, y + i * m * 0.08); ctx.fillStyle = tpl.theme.fg; ctx.fillText(l, W / 2, y + i * m * 0.08); }); ctx.restore(); }
    if (f.captions && f.phase === "clip") drawCaptions(ctx, f.captions, W, H, tpl);
    for (const im of images) { if (!im.img || !im.img.width) continue; const inRange = f.phase === "clip" && f.clipT >= (im.at ?? 0) && f.clipT <= (im.at ?? 0) + (im.dur ?? 1e9); if (!inRange) continue; const size = (im.size ?? 0.16) * Math.min(W, H); const pad = Math.min(W, H) * 0.04; const k = Math.min(size / im.img.width, size / im.img.height); const w = im.img.width * k, h = im.img.height * k; const pos = im.position || "top-right"; const x = pos.includes("left") ? pad : pos.includes("right") ? W - pad - w : (W - w) / 2; const y = pos.includes("top") ? pad : pos.includes("bottom") ? H - pad - h : (H - h) / 2; ctx.drawImage(im.img, x, y, w, h); }
    if (tpl.overlays.logo && assets.logo && f.phase === "clip" && !images.some((i) => i.kind === "logo")) { const w = Math.min(W, H) * 0.14, h = w * (assets.logo.height / assets.logo.width), pad = Math.min(W, H) * 0.035; ctx.globalAlpha = 0.9; ctx.drawImage(assets.logo, W - pad - w, pad + (o.progressBar != null ? Math.min(W, H) * 0.014 : 0), w, h); ctx.globalAlpha = 1; }
  }
  if (f.transition) drawTransition(ctx, f, tpl, W, H);
  ctx.restore();
}
