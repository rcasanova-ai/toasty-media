// Smart framing. Where to point the crop when a 16:9 recording becomes 9:16 or 1:1, and how far a zoom may go before it cuts a face.
// Evidence is the picture track Moxie already read (face boxes per sample). Nothing here identifies anyone: with two faces the
// speaker is taken to be the one whose mouth moves most while the voice is active, and when that is not clear-cut the frame stays wide.

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// samples: [{ t, faces: [{ x, y, size, mouthOpen }] }] (x, y, size are fractions of the frame). range: source seconds.
export function frameForRange(samples, a, b, { manualFocusX = null, needSingle = false } = {}) {
  const inRange = (samples || []).filter((s) => s.t >= a - 0.2 && s.t <= b + 0.2 && s.faces?.length);
  if (!inRange.length) return { fx: manualFocusX ?? 0.5, fy: 0.5, faceSize: 0, reason: manualFocusX != null ? "the focus you set" : "no face tracked, centred", faces: 0, confidence: 0 };
  // Cluster faces into left/right tracks by x (at most two are tracked).
  const tracks = [];
  for (const s of inRange) for (const f of s.faces) {
    let tr = tracks.find((t) => Math.abs(t.x - f.x) < 0.18);
    if (!tr) { tr = { x: f.x, xs: [], ys: [], sizes: [], mouth: [] }; tracks.push(tr); }
    tr.xs.push(f.x); tr.ys.push(f.y); tr.sizes.push(f.size || 0); tr.mouth.push(f.mouthOpen || 0); tr.x = mean(tr.xs);
  }
  tracks.sort((p, q) => q.xs.length - p.xs.length);
  const top = tracks.slice(0, 2).sort((p, q) => p.x - q.x);
  const info = (t) => ({ fx: mean(t.xs), fy: mean(t.ys), faceSize: mean(t.sizes), mouth: mean(t.mouth) });
  if (top.length === 1) { const i = info(top[0]); return { fx: i.fx, fy: i.fy, faceSize: i.faceSize, reason: "the one tracked face", faces: 1, confidence: 0.8 }; }
  const L = info(top[0]), R = info(top[1]), diff = Math.abs(L.mouth - R.mouth);
  if (diff >= 0.04) { const w = L.mouth > R.mouth ? L : R; return { fx: w.fx, fy: w.fy, faceSize: w.faceSize, reason: `the face whose mouth moves most while the voice is active (${w === L ? "left" : "right"})`, faces: 2, confidence: clamp(0.5 + diff * 4, 0.5, 0.9) }; }
  if (needSingle) { const w = R.mouth > L.mouth ? R : L; return { fx: w.fx, fy: w.fy, faceSize: w.faceSize, reason: `two faces, no clear speaker, and both do not fit this crop: following the ${w === L ? "left" : "right"} one (low confidence)`, faces: 2, confidence: 0.35 }; }
  return { fx: (L.fx + R.fx) / 2, fy: (L.fy + R.fy) / 2, faceSize: Math.max(L.faceSize, R.faceSize), reason: "two faces and no clear speaker, so the frame stays between them", faces: 2, confidence: 0.4, both: true, spread: Math.abs(R.fx - L.fx) };
}

// The crop window (fractions of the source) for an output aspect and zoom, centred on (fx, fy) and kept inside the picture.
export function cropWindow({ srcW, srcH, outW, outH, zoom = 1, fx = 0.5, fy = 0.5 }) {
  const cover = Math.max(outW / srcW, outH / srcH), s = cover * zoom;
  const w = outW / s, h = outH / s;
  const x = clamp(fx * srcW - w / 2, 0, Math.max(0, srcW - w)), y = clamp(fy * srcH - h / 2, 0, Math.max(0, srcH - h));
  return { x, y, w, h, scale: s };
}

// How far we can zoom while a face (size is a fraction of the source height) still has headroom inside the window.
export function maxZoomForFace({ srcW, srcH, outW, outH, faceSize = 0, limit = 1.3 }) {
  if (!faceSize) return limit;
  const cover = Math.max(outW / srcW, outH / srcH), baseH = outH / cover;               // source pixels visible at zoom 1
  const need = faceSize * srcH * 2.6;                                                      // face plus hair and shoulders room
  return clamp(baseH / need, 1, limit);
}

// Does the crop at this zoom keep the face box inside? Used by tests and the renderer's safety check.
export function faceInside(win, face, srcW, srcH, margin = 0.05) {
  const fw = (face.size || 0.1) * srcH, cx = face.x * srcW, cy = face.y * srcH;
  return cx - fw / 2 >= win.x - margin * win.w && cx + fw / 2 <= win.x + win.w + margin * win.w && cy - fw / 2 >= win.y - margin * win.h && cy + fw / 2 <= win.y + win.h + margin * win.h;
}
