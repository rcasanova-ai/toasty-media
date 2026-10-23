// Visual behavior: observable movement only. Nothing here infers a feeling; it reports what a camera can show:
// a smile (mouth corners raised), raised brows, an open mouth, a head turn or nod, leaning in or back, hands moving,
// a posture shift, sudden movement, and stillness.
//
// Two layers:
//   * Pure functions (this top half) turn per-frame measurements into scalar features and then into events. They are
//     unit-tested with synthetic data and never see pixels or landmarks beyond the instant they are measured.
//   * A browser sampler (bottom half) seeks through the video at a modest rate, always measures frame-to-frame motion, and
//     measures faces, hands and body pose with MediaPipe when it can be loaded. Landmarks and blendshapes are reduced to
//     the scalars below and discarded: no face template or embedding is ever stored (see BehaviorTimeline.assertNoBiometrics).
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ---- features from one MediaPipe result ----
const bs = (map, name) => map[name] ?? 0;
export function blendshapeMap(categories) { const m = {}; for (const c of categories || []) m[c.categoryName] = c.score; return m; }

// Rotation (degrees) from a 4x4 column-major facial transformation matrix.
export function headPoseFromMatrix(m) {
  if (!m || m.length < 16) return { yaw: 0, pitch: 0, roll: 0 };
  const r00 = m[0], r10 = m[1], r20 = m[2], r21 = m[6], r22 = m[10];
  const deg = 180 / Math.PI;
  return { yaw: Math.atan2(-r20, Math.sqrt(r21 * r21 + r22 * r22)) * deg, pitch: Math.atan2(r21, r22) * deg, roll: Math.atan2(r10, r00) * deg };
}

export function faceFeatures({ blendshapes = {}, matrix = null, box = null }) {
  const pose = headPoseFromMatrix(matrix);
  return {
    smile: clamp((bs(blendshapes, "mouthSmileLeft") + bs(blendshapes, "mouthSmileRight")) / 2),
    brow: clamp(Math.max(bs(blendshapes, "browInnerUp"), (bs(blendshapes, "browOuterUpLeft") + bs(blendshapes, "browOuterUpRight")) / 2)),
    mouthOpen: clamp(bs(blendshapes, "jawOpen")),
    yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll,
    x: box ? box.x : 0.5, y: box ? box.y : 0.5, size: box ? box.size : 0
  };
}

export function boxFromLandmarks(landmarks) {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (const p of landmarks) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) };
}
export function handFeatures(hands) {
  const out = []; for (const h of hands || []) { const w = h[0], tip = h[12] || h[9] || w; out.push({ x: w.x, y: w.y, reach: Math.hypot(tip.x - w.x, tip.y - w.y) }); }
  return out;
}
export function poseFeatures(lm) {
  if (!lm || lm.length < 13) return null;
  const l = lm[11], r = lm[12]; if ((l.visibility ?? 1) < 0.5 || (r.visibility ?? 1) < 0.5) return null;
  return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, width: Math.hypot(l.x - r.x, l.y - r.y), tilt: Math.atan2(r.y - l.y, r.x - l.x) * 180 / Math.PI };
}

// ---- grayscale motion between two small frames ----
export function motionBetween(prev, cur, w, h) {
  if (!prev || prev.length !== cur.length) return { total: 0, upper: 0, lower: 0, left: 0, right: 0 };
  let tot = 0, up = 0, lo = 0, le = 0, ri = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.abs(cur[y * w + x] - prev[y * w + x]) / 255;
    tot += d; if (y < h / 2) up += d; else lo += d; if (x < w / 2) le += d; else ri += d;
  }
  const n = w * h;
  return { total: tot / n, upper: up / (n / 2), lower: lo / (n / 2), left: le / (n / 2), right: ri / (n / 2) };
}

// ---- events from a feature series ----
// samples: [{ t, motion, faces: [{smile, brow, mouthOpen, yaw, pitch, x, y, size}], hands: [{x,y,reach}], pose: {x,y,width,tilt}|null }]
// caps: { face, hands, pose, motion } booleans. Returns { events, summary }.
export function detectVisualEvents(samples, caps = {}) {
  const ev = [], add = (type, t, end, strength, data = {}) => ev.push({ type, t: Math.round(t * 100) / 100, end: Math.round(end * 100) / 100, strength: clamp(strength), data });
  const S = samples.filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  if (S.length < 3) return { events: ev, summary: { samples: S.length } };
  const dt = median(S.slice(1).map((s, i) => s.t - S[i].t)) || 1;
  const within = (t0, sec) => S.filter((s) => s.t >= t0 && s.t <= t0 + sec);

  // Per face slot (left to right in the frame; this is a position, not an identity).
  if (caps.face) {
    for (let slot = 0; slot < 2; slot++) {
      const series = S.map((s) => ({ t: s.t, f: s.faces?.[slot] || null }));
      const have = series.filter((x) => x.f);
      if (have.length < 3) continue;
      const base = { smile: median(have.map((x) => x.f.smile)), brow: median(have.map((x) => x.f.brow)), mouth: median(have.map((x) => x.f.mouthOpen)) };
      const tag = (x) => ({ slot, x: Math.round(x.f.x * 100) / 100 });
      let inSmile = false, lastBrow = -9, lastMouth = -9;
      series.forEach((x, i) => {
        if (!x.f) { inSmile = false; return; }
        const smileUp = x.f.smile - base.smile;
        if (!inSmile && x.f.smile >= 0.35 && smileUp >= 0.25) { inSmile = true; add("smile", x.t, x.t + dt, (x.f.smile - 0.3) / 0.5, { ...tag(x), level: Math.round(x.f.smile * 100) / 100 }); }
        else if (inSmile && x.f.smile < 0.2) inSmile = false;
        if (x.f.brow - base.brow >= 0.3 && x.f.brow >= 0.4 && x.t - lastBrow > 1.5) { lastBrow = x.t; add("brow-raise", x.t, x.t + dt, (x.f.brow - base.brow) / 0.6, { ...tag(x), level: Math.round(x.f.brow * 100) / 100 }); }
        if (x.f.mouthOpen - base.mouth >= 0.35 && x.f.mouthOpen >= 0.5 && x.f.brow >= base.brow + 0.2 && x.t - lastMouth > 1.5) { lastMouth = x.t; add("mouth-open", x.t, x.t + dt, (x.f.mouthOpen - 0.4) / 0.5, { ...tag(x) }); }
      });
      // head turn / nod / movement / lean over sliding 1.5 s windows
      let lastTurn = -9, lastNod = -9, lastLean = -9, lastMove = -9;
      const win = Math.max(1.5, dt * 2.5);
      for (let i = 0; i < have.length; i++) {
        const w = have.filter((h) => h.t >= have[i].t && h.t <= have[i].t + win);
        if (w.length < 3) continue;
        const yaws = w.map((h) => h.f.yaw), pitches = w.map((h) => h.f.pitch);
        const yawD = Math.max(...yaws) - Math.min(...yaws);
        if (yawD >= 18 && have[i].t - lastTurn > 2 + win) { lastTurn = have[i].t; add("head-turn", have[i].t, w[w.length - 1].t, (yawD - 12) / 30, { slot, degrees: Math.round(yawD) }); }
        let flips = 0, dir = 0; for (let k = 1; k < pitches.length; k++) { const d = pitches[k] - pitches[k - 1]; if (Math.abs(d) < 1.2) continue; const nd = Math.sign(d); if (dir && nd !== dir) flips++; dir = nd; }
        const pitchD = Math.max(...pitches) - Math.min(...pitches);
        if (flips >= 2 && pitchD >= 5 && pitchD <= 35 && have[i].t - lastNod > 2) { lastNod = have[i].t; add("head-nod", have[i].t, w[w.length - 1].t, (pitchD - 3) / 15, { slot, degrees: Math.round(pitchD), nods: Math.ceil(flips / 2) + 1 }); }
        const speed = Math.hypot(w[w.length - 1].f.x - w[0].f.x, w[w.length - 1].f.y - w[0].f.y) / Math.max(0.1, w[w.length - 1].t - w[0].t);
        if (speed >= 0.12 && have[i].t - lastMove > 2.5) { lastMove = have[i].t; add("head-movement", have[i].t, w[w.length - 1].t, speed / 0.4, { slot }); }
        const grow = (w[w.length - 1].f.size - w[0].f.size) / Math.max(0.01, w[0].f.size);
        if (Math.abs(grow) >= 0.14 && have[i].t - lastLean > 3) { lastLean = have[i].t; add(grow > 0 ? "lean-in" : "lean-back", have[i].t, w[w.length - 1].t, Math.abs(grow) / 0.4, { slot, change: Math.round(grow * 100) / 100 }); }
      }
    }
  }
  // Hands: speed of the wrist across frames.
  if (caps.hands) {
    let active = null;
    for (let i = 1; i < S.length; i++) {
      const a = S[i - 1].hands || [], b = S[i].hands || [];
      let speed = 0;
      if (a.length && b.length) speed = Math.max(...b.map((h) => Math.min(...a.map((g) => Math.hypot(h.x - g.x, h.y - g.y))))) / Math.max(0.05, S[i].t - S[i - 1].t);
      const moving = speed >= 0.18;
      if (moving && !active) active = { t: S[i - 1].t, peak: speed };
      else if (moving) active.peak = Math.max(active.peak, speed);
      else if (active) { if (S[i].t - active.t >= Math.min(0.8, dt * 1.5)) add("gesture", active.t, S[i - 1].t + dt, active.peak / 0.8, { intensity: Math.round(active.peak * 100) / 100 }); active = null; }
    }
    if (active) add("gesture", active.t, S[S.length - 1].t, active.peak / 0.8, { intensity: Math.round(active.peak * 100) / 100 });
  }
  // Posture from shoulders.
  if (caps.pose) {
    const P = S.filter((s) => s.pose);
    let lastPosture = -9, lastLean = -9;
    for (let i = 0; i < P.length; i++) {
      const w = P.filter((p) => p.t >= P[i].t && p.t <= P[i].t + 2.5); if (w.length < 2) continue;
      const a = w[0].pose, b = w[w.length - 1].pose;
      const shift = Math.hypot(b.x - a.x, b.y - a.y), scale = (b.width - a.width) / Math.max(0.02, a.width);
      if (shift >= 0.06 && P[i].t - lastPosture > 3) { lastPosture = P[i].t; add("posture-shift", P[i].t, w[w.length - 1].t, shift / 0.2, { distance: Math.round(shift * 100) / 100 }); }
      if (Math.abs(scale) >= 0.12 && P[i].t - lastLean > 3) { lastLean = P[i].t; add(scale > 0 ? "body-lean-in" : "body-lean-back", P[i].t, w[w.length - 1].t, Math.abs(scale) / 0.35, { change: Math.round(scale * 100) / 100 }); }
    }
  }
  // Whole-frame motion: sudden movement and stillness, against this recording's own typical motion.
  if (caps.motion) {
    const m = S.map((s) => s.motion ?? 0), med = median(m), spread = Math.max(0.004, median(m.map((v) => Math.abs(v - med))) * 1.4826);
    let lastSudden = -9;
    S.forEach((s) => { if (s.motion > med + 5 * spread && s.motion >= 0.04 && s.t - lastSudden > 2) { lastSudden = s.t; add("sudden-movement", s.t, s.t + dt, (s.motion - med) / 0.2, { motion: Math.round(s.motion * 1000) / 1000 }); } });
    const sorted = [...m].sort((a, b) => a - b), ref = sorted[Math.floor(sorted.length * 0.9)] || 0, still = Math.max(0.0035, ref * 0.25);
    for (let i = 0; i < S.length;) {
      if (S[i].motion <= still) { let j = i; while (j + 1 < S.length && S[j + 1].motion <= still) j++; const len = S[j].t - S[i].t + dt; if (len >= 4 && ref >= 0.006 && i > 0) add("stillness", S[i].t, S[j].t + dt, (len - 3) / 8, { seconds: Math.round(len) }); i = j + 1; } else i++;
    }
  }
  return { events: ev.sort((a, b) => a.t - b.t), summary: { samples: S.length, intervalSeconds: Math.round(dt * 100) / 100 } };
}

// ---- browser sampling ----
export const MP_VERSION = "0.10.14";
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
export const MP_MODELS = {
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  hands: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
};

// Loads whatever MediaPipe components it can. Returns { face, hands, pose, notes[] }; any may be null.
export async function loadMediaPipe({ onStatus, importer } = {}) {
  const out = { face: null, hands: null, pose: null, notes: [] };
  let lib, fileset;
  try {
    onStatus?.("Loading the body and face tracker (a few MB, once)…");
    lib = await (importer ? importer(`${MP_BASE}/vision_bundle.mjs`) : import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`));
    fileset = await lib.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  } catch (error) { out.notes.push(`Face, hand and posture tracking is unavailable (${String(error?.message || error).slice(0, 100)}); movement was measured from the picture instead.`); return out; }
  const make = async (kind, Cls, opts) => {
    for (const delegate of ["GPU", "CPU"]) {
      try { return await Cls.createFromOptions(fileset, { baseOptions: { modelAssetPath: MP_MODELS[kind], delegate }, runningMode: "IMAGE", ...opts }); } catch (error) { if (delegate === "CPU") out.notes.push(`${kind} tracking could not start (${String(error?.message || error).slice(0, 80)}).`); }
    }
    return null;
  };
  out.face = await make("face", lib.FaceLandmarker, { numFaces: 2, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true });
  out.hands = await make("hands", lib.HandLandmarker, { numHands: 4 });
  out.pose = await make("pose", lib.PoseLandmarker, { numPoses: 1 });
  return out;
}

// Seeks through a video and measures it. Returns { samples, caps, notes }. All measurement happens here; raw frames and
// landmarks are dropped as soon as the scalar features are computed.
export async function sampleVideo(blob, { duration = 0, intervalSeconds = null, maxSamples = 900, signal, onProgress, onStatus, tracker = "auto", importer, doc = globalThis.document } = {}) {
  const notes = [];
  const video = doc.createElement("video"); video.muted = true; video.playsInline = true; video.preload = "auto";
  const url = URL.createObjectURL(blob); video.src = url;
  try {
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error("The video could not be read")); setTimeout(() => rej(new Error("The video took too long to open")), 15000); });
    if (!video.videoWidth || !video.videoHeight) return { samples: [], caps: { face: false, hands: false, pose: false, motion: false }, notes: ["No picture was found in this file (audio only)."] };
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
    const step = intervalSeconds || clamp(dur / maxSamples, 0.5, 4);
    const mp = tracker === "off" ? { face: null, hands: null, pose: null, notes: [] } : await loadMediaPipe({ onStatus, importer });
    notes.push(...mp.notes);
    const W = 64, H = 36, small = doc.createElement("canvas"); small.width = W; small.height = H;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    const big = doc.createElement("canvas"), bw = 480, bh = Math.round(480 * video.videoHeight / video.videoWidth); big.width = bw; big.height = bh;
    const bctx = big.getContext("2d");
    const samples = []; let prevGray = null;
    const total = Math.max(1, Math.floor(dur / step));
    for (let n = 0; n <= total; n++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const t = Math.min(dur - 0.05, n * step); if (t < 0) break;
      await new Promise((res) => { const done = () => { video.removeEventListener("seeked", done); res(); }; video.addEventListener("seeked", done); video.currentTime = t; setTimeout(done, 2500); });
      sctx.drawImage(video, 0, 0, W, H);
      const px = sctx.getImageData(0, 0, W, H).data, gray = new Uint8Array(W * H);
      for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
      const m = motionBetween(prevGray, gray, W, H); prevGray = gray;
      const sample = { t, motion: n ? m.total : 0, faces: [], hands: [], pose: null };
      if (mp.face || mp.hands || mp.pose) {
        bctx.drawImage(video, 0, 0, bw, bh);
        try {
          if (mp.face) { const r = mp.face.detect(big); const faces = (r.faceLandmarks || []).map((lm, k) => faceFeatures({ blendshapes: blendshapeMap(r.faceBlendshapes?.[k]?.categories), matrix: r.facialTransformationMatrixes?.[k]?.data, box: boxFromLandmarks(lm) })); sample.faces = faces.sort((a, b) => a.x - b.x).slice(0, 2); }
          if (mp.hands) sample.hands = handFeatures(mp.hands.detect(big).landmarks);
          if (mp.pose) sample.pose = poseFeatures(mp.pose.detect(big).landmarks?.[0]);
        } catch (error) { if (!notes.some((x) => /tracking error/.test(x))) notes.push(`A tracking error occurred part-way (${String(error?.message || error).slice(0, 80)}); later frames used movement only.`); mp.face = mp.hands = mp.pose = null; }
      }
      samples.push(sample);
      onProgress?.(n / total);
    }
    for (const k of ["face", "hands", "pose"]) { try { mp[k]?.close?.(); } catch (_) {} }
    const caps = { face: samples.some((s) => s.faces.length), hands: Boolean(mp.hands) || samples.some((s) => s.hands.length), pose: samples.some((s) => s.pose), motion: samples.length > 2 };
    if (tracker !== "off" && !caps.face && !notes.length) notes.push("No faces were detected in the video.");
    if (step > 0.6) notes.push(`The picture was sampled every ${Math.round(step * 10) / 10} s to keep a long recording fast, so quick head nods and short gestures can be missed.`);
    return { samples, caps, notes, intervalSeconds: step };
  } finally { URL.revokeObjectURL(url); video.removeAttribute("src"); video.load?.(); }
}
