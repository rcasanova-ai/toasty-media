// First-party Program canvas capture for Record / Go Live.
//
// Composes the screen share (main) and the host camera (picture-in-picture) onto ONE fixed 16:9 canvas and
// returns canvas.captureStream() plus a clone of the host microphone track. It reuses the streams the Studio
// page already holds: no getDisplayMedia picker, no second camera request, no dependency on the Program
// Output tab or on the user picking it. Remote guests live in cross-origin VDO iframes whose pixels cannot be
// drawn here, so the caller falls back to Program Output tab capture when guests are connected.

import { createStableMicTrack } from "./stable-mic-track.js";

export const PROGRAM_CANVAS = Object.freeze({ width: 1280, height: 720, fps: 30 });

// Source-rect -> destination-rect fit. "cover" fills (crops), "contain" letterboxes. Pure, for tests.
export function fitRect(srcW, srcH, dst, mode = "cover") {
  if (!srcW || !srcH) return { sx: 0, sy: 0, sw: 0, sh: 0, dx: dst.x, dy: dst.y, dw: dst.w, dh: dst.h };
  const srcRatio = srcW / srcH;
  const dstRatio = dst.w / dst.h;
  if (mode === "contain") {
    const dw = srcRatio > dstRatio ? dst.w : dst.h * srcRatio;
    const dh = srcRatio > dstRatio ? dst.w / srcRatio : dst.h;
    return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: dst.x + (dst.w - dw) / 2, dy: dst.y + (dst.h - dh) / 2, dw, dh };
  }
  const sw = srcRatio > dstRatio ? srcH * dstRatio : srcW;
  const sh = srcRatio > dstRatio ? srcH : srcW / dstRatio;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, dx: dst.x, dy: dst.y, dw: dst.w, dh: dst.h };
}

// Screen present: screen is the main picture, camera a small overlay bottom-right. Otherwise camera fills.
export function programCanvasLayout({ width = PROGRAM_CANVAS.width, height = PROGRAM_CANVAS.height, hasScreen = false, hasCamera = false } = {}) {
  const full = { x: 0, y: 0, w: width, h: height };
  if (hasScreen) {
    const w = Math.round(width * 0.22);
    const h = Math.round((w * 9) / 16);
    const margin = Math.round(width * 0.02);
    return { main: { source: "screen", rect: full, mode: "contain" }, pip: hasCamera ? { source: "camera", rect: { x: width - w - margin, y: height - h - margin, w, h }, mode: "cover" } : null };
  }
  return { main: hasCamera ? { source: "camera", rect: full, mode: "cover" } : null, pip: null };
}

const liveVideo = (stream) => (stream?.getVideoTracks?.() || []).some((track) => track.readyState === "live" && track.enabled !== false);

function makeTicker(fps, onTick) {
  const ms = Math.round(1000 / fps);
  // A worker timer is not throttled when the Studio tab is in the background (e.g. while the user presents
  // another tab), which would otherwise drop the recording to ~1 frame per second.
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${ms})`], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = onTick;
    return () => { worker.terminate(); URL.revokeObjectURL(url); };
  } catch (_) {
    const id = setInterval(onTick, ms);
    return () => clearInterval(id);
  }
}

// Returns { stream, dispose, canvas, mic }. getCamera/getScreen return MediaStreams (or null); getMicTrack a track that
// may be replaced during the take (mic switched/unplugged): see js/stable-mic-track.js.
export function createProgramCanvasCapture({ getCamera, getScreen, getMicTrack, documentRef = globalThis.document, fps = PROGRAM_CANVAS.fps, AudioContextImpl, micLatencyHint } = {}) {
  const { width, height } = PROGRAM_CANVAS;
  const canvas = documentRef.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const videos = { camera: null, screen: null };
  const bound = { camera: null, screen: null };
  const videoFor = (kind, stream) => {
    if (!videos[kind]) {
      const el = documentRef.createElement("video");
      el.muted = true;
      el.playsInline = true;
      videos[kind] = el;
    }
    if (bound[kind] !== stream) {
      bound[kind] = stream;
      videos[kind].srcObject = stream;
      videos[kind].play?.().catch(() => {});
    }
    return videos[kind];
  };
  const drawSource = (source, placement) => {
    const el = source === "screen" ? videoFor("screen", getScreen()) : videoFor("camera", getCamera());
    if (!el.videoWidth) return;
    const f = fitRect(el.videoWidth, el.videoHeight, placement.rect, placement.mode);
    ctx.drawImage(el, f.sx, f.sy, f.sw, f.sh, f.dx, f.dy, f.dw, f.dh);
  };
  const draw = () => {
    ctx.fillStyle = "#0b0908";
    ctx.fillRect(0, 0, width, height);
    const screen = getScreen();
    const camera = getCamera();
    const layout = programCanvasLayout({ width, height, hasScreen: liveVideo(screen), hasCamera: liveVideo(camera) });
    if (layout.main) drawSource(layout.main.source, layout.main);
    if (layout.pip) {
      const r = layout.pip.rect;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(r.x, r.y, r.w, r.h, 12) : ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      drawSource("camera", layout.pip);
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(r.x, r.y, r.w, r.h, 12) : ctx.rect(r.x, r.y, r.w, r.h);
      ctx.stroke();
    }
    micTrack.bind();
  };

  const micTrack = createStableMicTrack({ getMicTrack, ...(AudioContextImpl !== undefined ? { AudioContextImpl } : {}), ...(micLatencyHint !== undefined ? { latencyHint: micLatencyHint } : {}) });
  draw();
  const stream = canvas.captureStream(fps);
  if (micTrack.track) stream.addTrack(micTrack.track);
  const stopTicker = makeTicker(fps, draw);
  const dispose = () => {
    stopTicker();
    micTrack.dispose();
    for (const el of Object.values(videos)) { if (el) { el.pause?.(); el.srcObject = null; } }
    // Only our clone and the canvas track are stopped; the camera, mic and screen streams stay untouched.
  };
  return { stream, dispose, canvas, mic: micTrack };
}
