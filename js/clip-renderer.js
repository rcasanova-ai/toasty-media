// Local clip renderer. Plays the chosen part of the source in a hidden <video>, draws every frame to a canvas through the
// template (js/clip-draw.js), mixes the voice (optionally enhanced) with ducked music in an AudioWorklet
// (js/clip-mixer.js), and records canvas + mixed audio with MediaRecorder: H.264/AAC MP4 where the browser can, WebM
// otherwise. Everything stays on this computer; nothing is uploaded and no server does any video work.
//
// A render takes as long as the clip plays (it is recorded in real time), so a 30 s clip with a 2 s intro and outro takes
// about 35 s. That is the price of using only the browser's own encoder; it is reliable and needs no extra downloads.
import { ASPECTS, applyOverrides, validateTemplate } from "./clip-templates.js";
import { captionChunks, captionWords, computeFrame, planTimeline } from "./clip-timeline.js";
import { drawFrame } from "./clip-draw.js";
import { renderMusic } from "./clip-music.js";
import { judgeRendered, LOUDNESS_TOLERANCE_LU, measureRendered, planClipAudio, TRUE_PEAK_LIMIT_DBTP, TRUE_PEAK_TARGET_DBTP, WARNING_TEXT } from "./clip-loudness.js";
import { SPEECH_TARGET_LUFS } from "./loudness-plan.js";

const MP4_TYPES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.4d4028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2"];
const WEBM_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

export function pickRenderMime(Rec = globalThis.MediaRecorder) {
  const ok = (t) => { try { return Rec?.isTypeSupported?.(t); } catch (_) { return false; } };
  const mp4 = MP4_TYPES.find(ok);
  if (mp4) return { mime: mp4, container: "mp4" };
  const webm = WEBM_TYPES.find(ok);
  return webm ? { mime: webm, container: "webm" } : { mime: "", container: "webm" };
}

export function renderCapabilities() {
  const hasRec = typeof MediaRecorder !== "undefined", { container, mime } = pickRenderMime();
  return {
    supported: Boolean(hasRec && mime && typeof HTMLCanvasElement !== "undefined" && HTMLCanvasElement.prototype.captureStream && (globalThis.AudioContext || globalThis.webkitAudioContext) && typeof AudioWorkletNode !== "undefined"),
    container, mime, worklet: typeof AudioWorkletNode !== "undefined"
  };
}

// 30 fps timer that keeps running in a background tab (a worker is not throttled like setInterval on the page).
export function makeTicker(fps, onTick) {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${Math.round(1000 / fps)})`], { type: "text/javascript" }));
    const worker = new Worker(url); worker.onmessage = onTick;
    return () => { worker.terminate(); URL.revokeObjectURL(url); };
  } catch (_) { const id = setInterval(onTick, Math.round(1000 / fps)); return () => clearInterval(id); }
}

export const once = (el, ev) => new Promise((res, rej) => { const ok = () => { el.removeEventListener("error", bad); res(); }, bad = () => { el.removeEventListener(ev, ok); rej(new Error("The video could not be loaded.")); }; el.addEventListener(ev, ok, { once: true }); el.addEventListener("error", bad, { once: true }); });

export async function loadVideo(blobOrUrl) {
  const video = document.createElement("video");
  video.playsInline = true; video.preload = "auto"; video.crossOrigin = "anonymous";
  const url = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  video.src = url;
  if (video.readyState < 1) await once(video, "loadedmetadata");
  video.__url = typeof blobOrUrl === "string" ? null : url;
  return video;
}

export async function loadImage(blobOrUrl) {
  const url = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const img = new Image(); img.src = url; await img.decode();
  if (typeof blobOrUrl !== "string") URL.revokeObjectURL(url);
  return img;
}

// spec: { clip: {start,end}, template (validated or id-resolved by caller), aspect, title, subtitle, lowerThird, custom[], words | lines,
//         focusX, music: { style, buffer? }, enhance, images[], logo }
async function renderOnce({ source, spec, onProgress, signal, audio = {} } = {}) {
  const caps = renderCapabilities();
  if (!caps.supported) throw new Error("This browser cannot render clips locally. Use a current Chrome, Edge or Safari.");
  const tpl = validateTemplate(spec.template);
  const aspect = ASPECTS[spec.aspect] || ASPECTS["16:9"], W = aspect.width, H = aspect.height;
  const clipLen = Math.max(1, spec.clip.end - spec.clip.start);
  const plan = planTimeline(tpl, clipLen);
  const words = spec.words || captionWords(spec.lines || [], spec.clip.start, spec.clip.end);
  const chunks = captionChunks(words, tpl.captions.style);
  const video = source instanceof HTMLVideoElement ? source : await loadVideo(source);
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const actx = new AC({ sampleRate: 48000, latencyHint: 0 });
  const cleanup = [];
  try {
    await actx.audioWorklet.addModule(new URL("./clip-mixer-worklet.js", import.meta.url).href);
    const mixer = new AudioWorkletNode(actx, "toasty-clip-mixer", { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { enhance: tpl.audio.enhance && spec.enhance !== false, musicGainDb: tpl.music.gainDb, duckDb: tpl.music.duckDb, preGainDb: audio.preGainDb, noiseReduction: audio.noiseReduction === true, ceilingDb: audio.ceilingDb, targetRmsDb: audio.targetRmsDb } });
    const dest = actx.createMediaStreamDestination(); dest.channelCount = 2; dest.channelCountMode = "explicit";
    mixer.connect(dest);
    const voiceSrc = actx.createMediaElementSource(video);
    voiceSrc.connect(mixer, 0, 0);
    // Music: the user's own file, or a score generated for exactly this length.
    const musicStyle = spec.music?.style ?? tpl.music.style;
    let musicBuf = spec.music?.buffer || null;
    if (!musicBuf && musicStyle && musicStyle !== "none") musicBuf = await renderMusic(musicStyle, plan.total + 1);
    let musicNode = null;
    if (musicBuf) { musicNode = actx.createBufferSource(); musicNode.buffer = musicBuf; musicNode.loop = true; musicNode.connect(mixer, 0, 1); }

    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { alpha: false });
    const assets = { logo: spec.logo || null };
    const vars = { title: spec.title || spec.clipTitle || "", subtitle: spec.subtitle || "" };
    const frameSpec = { title: spec.title, subtitle: spec.subtitle, lowerThird: spec.lowerThird, custom: spec.custom || [] };

    // Seek to the clip start and let the first frame decode before recording begins.
    video.muted = false; video.volume = 1; video.currentTime = spec.clip.start;
    if (video.readyState < 2 || Math.abs(video.currentTime - spec.clip.start) > 0.05) await once(video, "seeked").catch(() => {});
    const draw = (t) => {
      const f = computeFrame({ tpl, plan, words, chunks, t, vars, spec: frameSpec });
      drawFrame(ctx, f, tpl, { W, H, video, assets, focusX: spec.focusX ?? 0.5, images: spec.images || [] });
      return f;
    };
    draw(plan.intro ? 0 : 0.001);

    const stream = canvas.captureStream(30);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    const { mime, container } = pickRenderMime();
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: W * H > 1500000 ? 10_000_000 : 6_000_000, audioBitsPerSecond: 192_000 });
    const chunksOut = []; recorder.ondataavailable = (e) => e.data?.size && chunksOut.push(e.data);
    const stopped = new Promise((res) => { recorder.onstop = res; });
    await actx.resume();

    let videoStarted = false, finished = false, lastBoost = null;
    const t0 = performance.now();
    recorder.start(1000);
    musicNode?.start();
    await new Promise((resolve, reject) => {
      const stopTick = makeTicker(30, () => {
        if (finished) return;
        if (signal?.aborted) { finished = true; stopTick(); reject(new DOMException("Render cancelled", "AbortError")); return; }
        const t = (performance.now() - t0) / 1000;
        const f = draw(Math.min(t, plan.total));
        const inClipRange = t >= plan.intro && t < plan.intro + plan.clip;
        if (inClipRange && !videoStarted) { videoStarted = true; video.play().catch(() => {}); }
        if (videoStarted) {
          const expected = spec.clip.start + (t - plan.intro);
          if (inClipRange && Math.abs(video.currentTime - expected) > 0.25) video.currentTime = expected;   // drift correction
          if (!inClipRange && !video.paused) video.pause();
        }
        // No voice during intro and outro: lift the music a little there.
        const boost = f.phase === "clip" ? 0 : 6;
        if (boost !== lastBoost) { lastBoost = boost; mixer.port.postMessage({ musicBoostDb: boost }); }
        onProgress?.({ t: Math.min(t, plan.total), total: plan.total, phase: f.phase });
        if (t >= plan.total) { finished = true; stopTick(); resolve(); }
      });
      cleanup.push(stopTick);
    });
    video.pause();
    await new Promise((r) => setTimeout(r, 120));
    recorder.stop();
    await stopped;
    const blob = new Blob(chunksOut, { type: mime.split(";")[0] });
    if (!blob.size) throw new Error("The render produced no data.");
    return { blob, mimeType: mime, container, width: W, height: H, seconds: plan.total, aspect: spec.aspect };
  } finally {
    cleanup.forEach((fn) => { try { fn(); } catch (_) {} });
    try { await actx.close(); } catch (_) {}
    if (!(source instanceof HTMLVideoElement)) { video.pause(); if (video.__url) URL.revokeObjectURL(video.__url); video.removeAttribute("src"); video.load(); }
  }
}

// Render with a measured audio plan, then measure the file that came out. The source's loudness is measured first and the gain
// needed to reach -16 LUFS is applied (js/clip-loudness.js), capped by the take's signal-to-noise ratio. The exported file is then
// decoded and measured; if it is more than 1.5 LU from the target or its true peak is above -1 dBTP, it is rendered once more with
// the measured error corrected. The result reports what was measured so the app can show it (and say so when audio is quiet).
export async function renderClip({ source, spec, onProgress, signal } = {}) {
  const tpl = validateTemplate(spec.template);
  const enhance = tpl.audio.enhance && spec.enhance !== false;
  const target = spec.targetLufs ?? SPEECH_TARGET_LUFS;
  let planned = null;
  if (enhance && !(source instanceof HTMLVideoElement)) {
    onProgress?.({ t: 0, total: 1, phase: "measuring" });
    planned = await planClipAudio(source, spec.clip, { targetLufs: target, noiseReduction: spec.noiseReduction }).catch(() => null);
  }
  const usePlan = Boolean(planned?.available && planned.plan.reason !== "no-signal");
  let gainDb = usePlan ? planned.plan.gainDb : null;
  const noiseReduction = spec.noiseReduction === true || (spec.noiseReduction !== false && Boolean(usePlan && planned.plan.noiseReduction));
  let ceilingDb = -2.5, corrected = false, result = null, measured = null, judged = null, firstPass = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    result = await renderOnce({ source, spec, onProgress, signal, audio: { preGainDb: gainDb, targetRmsDb: usePlan ? planned.plan.levelerTargetDb + (gainDb - planned.plan.gainDb) : null, noiseReduction, ceilingDb } });
    if (spec.verifyAudio === false) break;      // quick previews are not checked or re-rendered
    measured = await measureRendered(result.blob).catch(() => null);
    if (!measured) break;
    judged = judgeRendered(measured, { targetLufs: target, expectTarget: usePlan });
    if (attempt === 0) firstPass = { integratedLufs: measured.integratedLufs, truePeakDbtp: measured.truePeakDbtp, predictedLufs: planned?.plan?.calibration?.predictedLufs ?? null };
    const needsFix = usePlan && attempt === 0 && (judged.warnings.includes("output-too-quiet") || judged.warnings.includes("output-too-loud") || judged.warnings.includes("peak-high"));
    if (!needsFix) break;
    onProgress?.({ t: 0, total: 1, phase: "correcting" });
    if (judged.deltaLu !== null && Math.abs(judged.deltaLu) > LOUDNESS_TOLERANCE_LU) gainDb = Math.min(planned.plan.maxAllowedBoostDb, gainDb + judged.deltaLu);
    if (measured.truePeakDbtp > TRUE_PEAK_LIMIT_DBTP) ceilingDb -= measured.truePeakDbtp - TRUE_PEAK_TARGET_DBTP + 0.1;
    corrected = true;
  }
  const warnings = [...new Set([...(planned?.verdict?.warnings || []), ...(judged?.warnings || [])])];
  return {
    ...result,
    audio: {
      enhanced: enhance,
      measuredBefore: planned?.available ? { integratedLufs: planned.analysis.integratedLufs, snrDb: planned.analysis.snrDb, peakDbfs: planned.analysis.peakDbfs, state: planned.verdict.state } : null,
      measuredAfter: measured ? { integratedLufs: measured.integratedLufs, truePeakDbtp: measured.truePeakDbtp, state: judged?.verdict?.state } : null,
      appliedGainDb: gainDb, planReason: usePlan ? planned.plan.reason : "none", noiseReduction, corrected, firstPass: corrected ? firstPass : null, targetLufs: target,
      ok: judged ? judged.ok : null,
      warnings,
      messages: warnings.map((w) => WARNING_TEXT[w]).filter(Boolean)
    }
  };
}

// Batch: every selected clip in every chosen aspect, one after another (a browser records one canvas at a time reliably). Each
// render gets a fresh <video>: a media element can only ever be connected to one Web Audio graph.
export async function renderBatch({ source, jobs, onProgress, signal } = {}) {
  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    if (signal?.aborted) break;
    try {
      const r = await renderClip({ source, spec: jobs[i].spec, onProgress: (p) => onProgress?.({ index: i, count: jobs.length, job: jobs[i], ...p }), signal });
      results.push({ job: jobs[i], ok: true, ...r });
    } catch (error) {
      results.push({ job: jobs[i], ok: false, error: error?.message || String(error) });
      if (error?.name === "AbortError") break;
    }
  }
  return results;
}
