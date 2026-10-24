// Paints one frame of an edit plan on a canvas. It draws the description from frameState() (js/director/frame-state.js) and
// decides nothing about timing. Motion graphics are drawn from code: shapes, arrows, callouts, highlight boxes, lower thirds,
// accents, step diagrams and kinetic type. There are no templates to license and no external services.
import { EASE } from "./frame-state.js";
import { cropWindow } from "./framing.js";
import { FONTS, drawIntro, drawOutro, roundRect, wrapLines } from "../clip-draw.js";

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const TAU = Math.PI * 2;

// env: { W, H, video, logo, layer: { canvas, ctx }, snap: { canvas, ctx, has }, srcW, srcH }
export function makeSurfaces(W, H) {
  const mk = () => { const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H; return { canvas, ctx: canvas.getContext("2d", { alpha: false }), has: false }; };
  return { layer: mk(), snap: mk() };
}

function drawVideo(ctx, video, camera, W, H) {
  if (!video || video.readyState < 2) return false;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const win = cropWindow({ srcW: vw, srcH: vh, outW: W, outH: H, zoom: camera.scale, fx: camera.fx, fy: camera.fy });
  ctx.drawImage(video, win.x, win.y, win.w, win.h, 0, 0, W, H);
  return true;
}

function grade(ctx, g, W, H) {
  if (!g) return;
  ctx.save();
  if (g.saturate) { ctx.globalCompositeOperation = "saturation"; ctx.globalAlpha = Math.abs(g.saturate); ctx.fillStyle = g.saturate > 0 ? "hsl(28,100%,50%)" : "hsl(0,0%,50%)"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  if (g.tone) { ctx.globalCompositeOperation = "soft-light"; ctx.fillStyle = g.tone; ctx.fillRect(0, 0, W, H); ctx.fillStyle = g.tone; ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha = 0.35; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  if (g.vignette) { ctx.globalCompositeOperation = "multiply"; const r = Math.hypot(W, H) / 2, gr = ctx.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, `rgba(${Math.round(255 * (1 - g.vignette))},${Math.round(255 * (1 - g.vignette))},${Math.round(255 * (1 - g.vignette))},1)`); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}

// Transition from the held last frame of the outgoing shot (snap) to the live incoming shot (layer).
function compose(ctx, layer, snap, tr, W, H, theme) {
  const e = tr.e, k = Math.min(W, H) / 1080;
  if (!snap?.has) { ctx.drawImage(layer.canvas, 0, 0); return; }
  if (tr.kind === "fade" || tr.kind === "dissolve") { ctx.drawImage(layer.canvas, 0, 0); ctx.save(); ctx.globalAlpha = 1 - e; ctx.drawImage(snap.canvas, 0, 0); ctx.restore(); }
  else if (tr.kind === "wipe") {
    ctx.drawImage(layer.canvas, 0, 0);
    const x = e * W; ctx.save(); ctx.beginPath(); ctx.rect(x, 0, W - x, H); ctx.clip(); ctx.drawImage(snap.canvas, 0, 0); ctx.restore();
    ctx.fillStyle = theme.accent; ctx.fillRect(x - 5 * k, 0, 10 * k, H);
  } else if (tr.kind === "push") {
    ctx.drawImage(snap.canvas, -e * W, 0); ctx.drawImage(layer.canvas, (1 - e) * W, 0);
    ctx.fillStyle = theme.accent; ctx.fillRect((1 - e) * W - 4 * k, 0, 8 * k, H);
  } else if (tr.kind === "flash") {
    const s = 1 + 0.07 * (1 - e); ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.drawImage(layer.canvas, -W / 2, -H / 2); ctx.restore();
    ctx.save(); ctx.globalAlpha = (1 - e) ** 2 * 0.8; ctx.fillStyle = theme.accent2; ctx.fillRect(0, 0, W, H); ctx.restore();
  } else ctx.drawImage(layer.canvas, 0, 0);
}

// ---------------------------------------------------------------- captions
function capFont(c, size) { return c.style === "cinema" ? `${size}px ${FONTS.serif}` : c.style === "kinetic" ? `${size}px ${FONTS.display}` : `600 ${size}px ${FONTS.sans}`; }
function drawCaptions(ctx, c, W, H, theme, look) {
  const m = Math.min(W, H), landscape = W > H, size = c.size * m * (landscape ? 1.35 : 1.1);
  const text = (w) => (c.uppercase ? w.text.toUpperCase() : w.text);
  ctx.save(); ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.font = capFont(c, size);
  const yBase = c.style === "cinema" ? H * (landscape ? 0.8 : 0.74) : c.style === "kinetic" ? H * (landscape ? 0.74 : 0.66) : H * (landscape ? 0.86 : 0.78);
  if (c.style === "bar") {
    const line = c.words.map(text).join(" "), lines = wrapLines(ctx, line, W * 0.84).slice(0, 3), lh = size * 1.28;
    const bw = Math.min(W * 0.92, Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 1.4), bh = lines.length * lh + size * 0.55;
    const slide = (1 - EASE.out(c.inK)) * size * 0.6;
    ctx.globalAlpha = Math.min(c.inK, c.outK + 0.15); ctx.translate(0, slide);
    ctx.fillStyle = theme.capBg; roundRect(ctx, W / 2 - bw / 2, yBase - bh / 2, bw, bh, size * 0.3); ctx.fill();
    // words, with emphasized words in the accent colour and an underline that sweeps in as the word is spoken
    let wi = 0;
    lines.forEach((l, i) => {
      const toks = l.split(" "), widths = toks.map((t) => ctx.measureText(t).width), space = ctx.measureText(" ").width, total = widths.reduce((a, b) => a + b, 0) + space * (toks.length - 1);
      let x = W / 2 - total / 2; const y = yBase - ((lines.length - 1) / 2) * lh + i * lh;
      toks.forEach((t, k) => {
        const w = c.words[wi++] || {}; ctx.textAlign = "left";
        ctx.fillStyle = w.mark ? theme.accent2 : theme.capFg; ctx.fillText(t, x, y);
        if (w.mark) { ctx.fillStyle = theme.accent; ctx.fillRect(x, y + size * 0.52, widths[k] * (w.state === "future" ? 0 : EASE.out(w.state === "past" ? 1 : w.k)), Math.max(3, size * 0.07)); }
        x += widths[k] + space;
      });
    });
  } else if (c.style === "kinetic") {
    const gap = size * 0.3, widths = c.words.map((w) => ctx.measureText(text(w)).width * (w.mark ? 1.12 : 1));
    const rows = []; let row = [], rw = 0;
    c.words.forEach((w, i) => { if (row.length && rw + gap + widths[i] > W * 0.88) { rows.push({ row, rw }); row = []; rw = 0; } row.push(i); rw += (row.length > 1 ? gap : 0) + widths[i]; });
    rows.push({ row, rw });
    const lh = size * 1.18;
    rows.forEach(({ row: r, rw: total }, ri) => {
      let x = W / 2 - total / 2; const y = yBase - ((rows.length - 1) / 2) * lh + ri * lh;
      r.forEach((i) => {
        const w = c.words[i], active = w.state === "active", enter = EASE.back(w.shown);
        if (w.state === "future" && w.shown <= 0) { x += widths[i] + gap; return; }
        const pop = (w.mark ? 1.18 : 1) * (0.7 + 0.3 * enter) * (active ? 1 + 0.14 * Math.sin(Math.PI * Math.min(1, w.k)) : 1);
        ctx.save(); ctx.translate(x + widths[i] / 2, y + (1 - enter) * size * 0.5); ctx.scale(pop, pop); ctx.globalAlpha = clamp01(w.shown) * Math.min(1, c.outK + 0.2);
        ctx.lineWidth = size * 0.17; ctx.strokeStyle = "rgba(0,0,0,0.88)"; ctx.lineJoin = "round"; ctx.strokeText(text(w), 0, 0);
        ctx.fillStyle = w.mark ? theme.accent2 : active ? theme.accent : "#fff"; ctx.fillText(text(w), 0, 0);
        ctx.restore(); x += widths[i] + gap;
      });
    });
  } else {
    // cinema: one deliberate line, serif, fades in and out; emphasized words are italic in the accent colour
    ctx.globalAlpha = Math.min(EASE.out(c.inK), c.outK);
    const full = c.words.map(text).join(" "); const lines = wrapLines(ctx, full, W * 0.72).slice(0, 2), lh = size * 1.3;
    let wi = 0;
    lines.forEach((l, i) => {
      const toks = l.split(" "), space = ctx.measureText(" ").width;
      const widths = toks.map((t, k) => { const w = c.words[wi + k] || {}; ctx.font = w.mark ? `italic ${size}px ${FONTS.serif}` : `${size}px ${FONTS.serif}`; return ctx.measureText(t).width; });
      const total = widths.reduce((a, b) => a + b, 0) + space * (toks.length - 1); let x = W / 2 - total / 2; const y = yBase - ((lines.length - 1) / 2) * lh + i * lh;
      toks.forEach((t, k) => { const w = c.words[wi++] || {}; ctx.textAlign = "left"; ctx.font = w.mark ? `italic ${size}px ${FONTS.serif}` : `${size}px ${FONTS.serif}`; ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = size * 0.25; ctx.fillStyle = w.mark ? theme.accent2 : theme.capFg; ctx.fillText(t, x, y); x += widths[k] + space; });
    });
  }
  ctx.restore();
}

// ---------------------------------------------------------------- typography
function drawKeyPhrase(ctx, it, W, H, theme) {
  const m = Math.min(W, H), landscape = W > H, a = Math.min(EASE.out(it.inK), it.outK);
  ctx.save(); ctx.textBaseline = "middle";
  if (it.variant === "slide") {
    // kinetic: a highlight bar sweeps in behind the phrase, each word slams in as it is spoken
    const size = m * (landscape ? 0.082 : 0.074); ctx.font = `${size}px ${FONTS.display}`;
    const text = it.text.toUpperCase(), lines = wrapLines(ctx, text, W * 0.8).slice(0, 3), lh = size * 1.15;
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 0.9, bh = lines.length * lh + size * 0.4, y0 = H * (landscape ? 0.2 : 0.17), x0 = W / 2 - bw / 2;
    const sweep = EASE.out(clamp01(it.t / 0.3));
    ctx.globalAlpha = a; ctx.fillStyle = theme.accent; roundRect(ctx, x0, y0 - bh / 2, bw * sweep, bh, size * 0.18); ctx.fill();
    let wi = 0;
    lines.forEach((l, i) => {
      const toks = l.split(" "), space = ctx.measureText(" ").width, widths = toks.map((t) => ctx.measureText(t).width), total = widths.reduce((s, v) => s + v, 0) + space * (toks.length - 1); let x = W / 2 - total / 2; const y = y0 - ((lines.length - 1) / 2) * lh + i * lh;
      toks.forEach((t, k) => { const w = it.words[wi++] || { k: 1, shown: true }; if (!w.shown) { x += widths[k] + space; return; } const s = 0.6 + 0.4 * w.k; ctx.save(); ctx.translate(x + widths[k] / 2, y + (1 - Math.min(1, w.k)) * size * 0.6); ctx.scale(s, s); ctx.textAlign = "center"; ctx.globalAlpha = a * clamp01(w.k * 2); ctx.fillStyle = "#1b0f08"; ctx.fillText(t, 0, 0); ctx.restore(); x += widths[k] + space; });
    });
  } else if (it.variant === "quote") {
    const size = m * (landscape ? 0.06 : 0.058); ctx.font = `italic ${size}px ${FONTS.serif}`; ctx.textAlign = "center";
    const lines = wrapLines(ctx, `“${it.text}”`, W * 0.66).slice(0, 3), lh = size * 1.3, y0 = H * (landscape ? 0.32 : 0.28);
    ctx.globalAlpha = a; ctx.fillStyle = theme.accent; ctx.fillRect(W / 2 - m * 0.06 * EASE.out(clamp01(it.t / 0.8)), y0 - lh * (lines.length / 2 + 0.55), m * 0.12 * EASE.out(clamp01(it.t / 0.8)), Math.max(2, m * 0.004));
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = size * 0.4;
    lines.forEach((l, i) => { ctx.globalAlpha = a * clamp01((it.t - i * 0.25) / 0.7); ctx.fillStyle = theme.fg; ctx.fillText(l, W / 2, y0 + (i - (lines.length - 1) / 2) * lh); });
  } else {
    // label: a clean key-point card at the upper left
    const size = m * (landscape ? 0.044 : 0.04); ctx.font = `600 ${size}px ${FONTS.sans}`; ctx.textAlign = "left";
    const lines = wrapLines(ctx, it.text, W * (landscape ? 0.42 : 0.72)).slice(0, 3), lh = size * 1.3;
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 1.6, bh = lines.length * lh + size * 1.5, x0 = m * 0.05, y0 = H * (landscape ? 0.1 : 0.09);
    ctx.globalAlpha = a; ctx.translate(-(1 - EASE.out(it.inK)) * W * 0.06, 0);
    ctx.fillStyle = "rgba(24,14,10,0.78)"; roundRect(ctx, x0, y0, bw, bh, size * 0.3); ctx.fill();
    ctx.fillStyle = theme.accent; ctx.fillRect(x0, y0 + size * 0.2, size * 0.14, bh - size * 0.4);
    ctx.font = `700 ${size * 0.5}px ${FONTS.sans}`; ctx.fillStyle = theme.accent2; ctx.fillText("KEY POINT", x0 + size * 0.6, y0 + size * 0.6);
    ctx.font = `600 ${size}px ${FONTS.sans}`; ctx.fillStyle = "#fff8ec"; lines.forEach((l, i) => ctx.fillText(l, x0 + size * 0.6, y0 + size * 1.25 + i * lh));
  }
  ctx.restore();
}

// ---------------------------------------------------------------- motion graphics
function countUp(value, k) {
  const m = String(value).match(/^([^\d]*)([\d,.]+)(.*)$/);
  if (!m) return value;
  const target = parseFloat(m[2].replace(/,/g, "")); if (!Number.isFinite(target)) return value;
  const decimals = (m[2].split(".")[1] || "").length, cur = target * k;
  return `${m[1]}${decimals ? cur.toFixed(decimals) : Math.round(cur).toLocaleString("en-US")}${m[3]}`;
}

function drawArrow(ctx, x1, y1, x2, y2, k, color, width) {
  const x = x1 + (x2 - x1) * k, y = y1 + (y2 - y1) * k;
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x, y); ctx.stroke();
  if (k > 0.85) { const ang = Math.atan2(y2 - y1, x2 - x1), h = width * 4; ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - h * Math.cos(ang - 0.45), y2 - h * Math.sin(ang - 0.45)); ctx.lineTo(x2 - h * Math.cos(ang + 0.45), y2 - h * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill(); }
  ctx.restore();
}

function drawStat(ctx, g, W, H, theme) {
  const m = Math.min(W, H), landscape = W > H, a = Math.min(EASE.out(g.inK), g.outK), size = m * (landscape ? 0.12 : 0.13);
  ctx.save(); ctx.globalAlpha = a; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  const value = countUp(g.value, EASE.out(clamp01(g.t / 0.9)));
  ctx.font = `${size}px ${FONTS.display}`;
  const vw = ctx.measureText(value).width, bw = Math.max(vw + size * 0.9, m * 0.34), bh = size * (g.label ? 1.9 : 1.4);
  const cx = landscape ? W * 0.74 : W * 0.5, cy = landscape ? H * 0.36 : H * 0.34 + (1 - EASE.back(clamp01(g.inK))) * size, x0 = cx - bw / 2, y0 = cy - bh / 2;
  ctx.translate(0, (1 - EASE.out(g.inK)) * size * 0.4);
  ctx.fillStyle = "rgba(27,15,8,0.88)"; roundRect(ctx, x0, y0, bw, bh, size * 0.22); ctx.fill();
  ctx.lineWidth = Math.max(3, m * 0.006); ctx.strokeStyle = theme.accent; roundRect(ctx, x0, y0, bw, bh, size * 0.22); ctx.stroke();
  ctx.fillStyle = theme.accent2; ctx.fillText(value, cx, g.label ? cy - size * 0.28 : cy);
  if (g.label) { ctx.font = `600 ${size * 0.3}px ${FONTS.sans}`; ctx.fillStyle = "#fff4e0"; ctx.fillText(g.label.toUpperCase(), cx, cy + size * 0.58); }
  if (g.arrow) { const ax = cx - bw * 0.1, from = landscape ? H * 0.66 : H * 0.6; drawArrow(ctx, ax, from, ax, y0 + bh + m * 0.015, EASE.out(clamp01((g.t - 0.2) / 0.5)), theme.accent, Math.max(5, m * 0.01)); }
  ctx.restore();
}

function drawDiagram(ctx, g, W, H, theme, c) {
  const m = Math.min(W, H), a = Math.min(EASE.out(g.inK), g.outK), n = g.steps.length, r = m * 0.045, y = H * (W > H ? 0.2 : 0.17);
  const span = Math.min(W * 0.78, m * 1.3), x0 = W / 2 - span / 2, dx = span / (n - 1);
  ctx.save(); ctx.globalAlpha = a; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < n; i++) {
    const s = g.steps[i], appear = EASE.back(clamp01((c - s.at + 0.1) / 0.35)); const x = x0 + i * dx;
    if (i < n - 1) { const next = g.steps[i + 1], link = clamp01((c - next.at + 0.5) / 0.5); ctx.strokeStyle = theme.accent; ctx.lineWidth = Math.max(3, m * 0.006); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + r + (dx - 2 * r) * link * (appear > 0 ? 1 : 0), y); ctx.stroke(); }
    if (appear <= 0) continue;
    ctx.save(); ctx.translate(x, y); ctx.scale(appear, appear);
    ctx.fillStyle = theme.accent; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.fillStyle = "#1b0f08"; ctx.font = `${r * 1.1}px ${FONTS.display}`; ctx.fillText(String(i + 1), 0, 0);
    ctx.font = `600 ${m * 0.03}px ${FONTS.sans}`; ctx.lineWidth = m * 0.008; ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.fillStyle = "#fff"; const lab = s.label.length > 22 ? s.label.slice(0, 21) + "…" : s.label; ctx.strokeText(lab, 0, r * 1.9); ctx.fillText(lab, 0, r * 1.9);
    ctx.restore();
  }
  ctx.restore();
}

function drawLowerThird(ctx, g, W, H, theme) {
  const m = Math.min(W, H), a = Math.min(EASE.out(g.inK), g.outK), y = H * (W > H ? 0.64 : 0.56), bw = W * (W > H ? 0.3 : 0.62), bh = m * 0.12;
  ctx.save(); ctx.globalAlpha = a; ctx.translate(-(1 - EASE.out(g.inK)) * W * 0.25, 0);
  ctx.fillStyle = theme.accent; ctx.fillRect(m * 0.04, y, m * 0.012, bh); ctx.fillStyle = "rgba(0,0,0,0.72)"; ctx.fillRect(m * 0.052, y, bw, bh);
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.fillStyle = "#fff"; ctx.font = `${m * 0.048}px ${FONTS[theme.font] || FONTS.sans}`; ctx.fillText(g.name, m * 0.075, y + bh * (g.role ? 0.52 : 0.64));
  if (g.role) { ctx.fillStyle = theme.accent2; ctx.font = `${m * 0.03}px ${FONTS.sans}`; ctx.fillText(g.role, m * 0.075, y + bh * 0.86); }
  ctx.restore();
}

function drawAccent(ctx, g, W, H, theme, c) {
  const m = Math.min(W, H);
  if (g.variant === "corners") {
    const k = EASE.out(clamp01(g.t / 0.7)), L = m * 0.07 * k, pad = m * 0.035;
    ctx.save(); ctx.strokeStyle = theme.accent; ctx.lineWidth = Math.max(4, m * 0.006); ctx.lineCap = "round"; ctx.globalAlpha = 0.9;
    for (const [x, y, sx, sy] of [[pad, pad, 1, 1], [W - pad, pad, -1, 1], [pad, H - pad, 1, -1], [W - pad, H - pad, -1, -1]]) { ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke(); }
    ctx.restore();
  }
}

function drawBug(ctx, logo, W, H) {
  if (!logo?.width) return;
  const m = Math.min(W, H), w = m * 0.16, h = w * (logo.height / logo.width), pad = m * 0.035;
  ctx.save(); ctx.globalAlpha = 0.9; ctx.drawImage(logo, W - pad - w, H - pad - h - (W > H ? 0 : m * 0.08), w, h); ctx.restore();
}

// ---------------------------------------------------------------- the frame
export function drawDirectorFrame(ctx, st, plan, env) {
  const { W, H } = env, look = plan.look, theme = look.theme;
  ctx.save();
  if (st.phase === "intro" || st.phase === "outro") {
    const tpl = { theme };
    if (st.phase === "intro") drawIntro(ctx, { intro: st.card }, tpl, W, H, { logo: env.logo }); else drawOutro(ctx, { outro: st.card }, tpl, W, H, { logo: env.logo });
    ctx.restore(); return;
  }
  // live picture into the layer, then the transition composes the layer with the held frame of the outgoing shot
  const L = env.layer;
  drawVideo(L.ctx, env.video, st.camera, W, H);
  if (st.broll && env.broll?.[st.broll.clip]?.readyState >= 2) {
    const bv = env.broll[st.broll.clip], a = Math.min(st.broll.inK, st.broll.outK), z = 1 + 0.05 * clamp01((st.c - st.broll.start) / Math.max(0.5, st.broll.end - st.broll.start));
    L.ctx.save(); L.ctx.globalAlpha = a; drawVideo(L.ctx, bv, { scale: z, fx: 0.5, fy: 0.5 }, W, H); L.ctx.restore();
  }
  grade(L.ctx, look.grade, W, H);
  if (st.transition) compose(ctx, L, env.snap, st.transition, W, H, theme); else ctx.drawImage(L.canvas, 0, 0);
  if (st.snapshotDue) { env.snap.ctx.drawImage(L.canvas, 0, 0); env.snap.has = true; }
  const c = st.c;
  for (const g of st.graphics) {
    if (g.kind === "accent") drawAccent(ctx, g, W, H, theme, c);
    else if (g.kind === "stat-callout") drawStat(ctx, g, W, H, theme);
    else if (g.kind === "diagram") drawDiagram(ctx, g, W, H, theme, c);
    else if (g.kind === "lower-third") drawLowerThird(ctx, g, W, H, theme);
    else if (g.kind === "bug") drawBug(ctx, env.logo, W, H);
  }
  for (const it of st.typography) drawKeyPhrase(ctx, it, W, H, theme);
  if (st.captions) drawCaptions(ctx, st.captions, W, H, theme, look);
  if (look.grade?.frame === "letterbox") { const open = EASE.inOut(clamp01(c / 1.2)), bar = H * (0.16 - 0.06 * open); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar); }
  if (st.cardFade) { ctx.save(); ctx.globalAlpha = Math.abs(st.cardFade); ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  ctx.restore();
}
