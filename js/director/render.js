// Executes an edit plan in the browser. Two <video> elements take turns playing the source: while one plays a shot, the other is
// already seeked to the next one, so a cut is a switch, not a stall. Cuts that remove no time (re-frames, speaker changes) keep the
// same element playing and only change the camera. Every frame is drawn from frameState() (js/director/frame-state.js), mixed
// with music and sound accents by the same AudioWorklet mixer the Clips renderer uses (voice leveling, ducking, limiter), and
// recorded with MediaRecorder: H.264/AAC MP4 where the browser can, WebM otherwise. Nothing leaves this computer.
//
// Like the Clips renderer, a render plays in real time, so a 60 s edit takes about a minute. That is the price of using only the
// browser's own encoder. It is cancelable at any moment.
import { loadVideo, makeTicker, once, pickRenderMime, renderCapabilities } from "../clip-renderer.js";
import { renderMusic } from "../clip-music.js";
import { renderSfx } from "./sfx.js";
import { frameState } from "./frame-state.js";
import { drawDirectorFrame, makeSurfaces } from "./draw.js";
import { judgeRendered, LOUDNESS_TOLERANCE_LU, measureRendered, planClipAudio, TRUE_PEAK_LIMIT_DBTP, TRUE_PEAK_TARGET_DBTP, WARNING_TEXT } from "../clip-loudness.js";
import { SPEECH_TARGET_LUFS } from "../loudness-plan.js";

const PREROLL = 0.075;                                 // a player takes about this long to start producing picture and sound after play() (measured: 70-80 ms), so it is started this early

export async function buildAudioBed(plan) {
  const total = plan.timeline.total;
  // exactly as long as the video: the bed fades in over 0.3 s and out over its last second, which is the last second of the export
  const musicBuf = plan.audio.music ? await renderMusic(plan.audio.music.style, total) : null;
  const fxBuf = plan.audio.sfx?.length ? await renderSfx(plan.audio.sfx, total + 1) : null;
  return { musicBuf, fxBuf };
}

// audio: { preGainDb, targetRmsDb, noiseReduction, ceilingDb }
async function renderPlanOnce({ source, plan, onProgress, signal, audio = {}, bed = null, logo = null, brollFiles = null }) {
  const caps = renderCapabilities();
  if (!caps.supported) throw new Error("This browser cannot render videos locally. Use a current Chrome, Edge or Safari.");
  const [W, H] = plan.size, total = plan.timeline.total, segs = plan.segments, introT = plan.timeline.intro;
  const url = URL.createObjectURL(source);
  const videos = [await loadVideo(url), await loadVideo(url)];
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const actx = new AC({ sampleRate: 48000, latencyHint: 0 });
  const cleanup = [], brollUrls = [];
  let brollEls = [];
  try {
    await actx.audioWorklet.addModule(new URL("../clip-mixer-worklet.js", import.meta.url).href);
    const m = plan.audio.music;
    const mixer = new AudioWorkletNode(actx, "toasty-clip-mixer", { numberOfInputs: 3, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { enhance: plan.audio.enhance !== false, musicGainDb: m ? m.gainDb : -60, duckDb: m ? m.duckDb : -14, preGainDb: audio.preGainDb, noiseReduction: audio.noiseReduction === true, ceilingDb: audio.ceilingDb, targetRmsDb: audio.targetRmsDb } });
    const dest = actx.createMediaStreamDestination(); dest.channelCount = 2; dest.channelCountMode = "explicit";
    mixer.connect(dest);
    videos.forEach((v) => { v.muted = false; v.volume = 1; actx.createMediaElementSource(v).connect(mixer, 0, 0); });
    const { musicBuf, fxBuf } = bed || await buildAudioBed(plan);
    let musicNode = null, fxNode = null;
    if (musicBuf) { musicNode = actx.createBufferSource(); musicNode.buffer = musicBuf; musicNode.connect(mixer, 0, 1); }
    if (fxBuf) { fxNode = actx.createBufferSource(); fxNode.buffer = fxBuf; fxNode.connect(mixer, 0, 2); }

    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { alpha: false });
    const surf = makeSurfaces(W, H);
    const env = { W, H, video: videos[0], logo, layer: surf.layer, snap: surf.snap, broll: {} };
    // B-roll players (muted: the original voice carries on underneath), one per distinct clip
    for (const b of plan.broll || []) if (!env.broll[b.clip] && brollFiles?.[b.clip]) { const u = URL.createObjectURL(brollFiles[b.clip]); brollUrls.push(u); const v = await loadVideo(u); v.muted = true; env.broll[b.clip] = v; brollEls.push(v); }
    const brollState = new Map();

    // first shot ready before recording starts
    let cur = 0, curSeg = -1, prerolled = -1;
    const seekTo = async (v, t) => { v.pause(); v.currentTime = t; if (v.readyState < 2 || Math.abs(v.currentTime - t) > 0.05) await once(v, "seeked").catch(() => {}); };
    const contiguous = (a, b) => Math.abs(segs[b].srcStart - segs[a].srcEnd) < 0.03;
    const nextBreak = (i) => { for (let n = i + 1; n < segs.length; n++) if (!contiguous(n - 1, n)) return n; return -1; };
    await seekTo(videos[0], segs[0].srcStart);
    const nb0 = nextBreak(0); if (nb0 > 0) await seekTo(videos[1], segs[nb0].srcStart);
    let prepared = nb0;                                   // segment index the idle player is seeked to
    drawDirectorFrame(ctx, frameState(plan, 0.001), plan, env);

    const stream = canvas.captureStream(30);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    const { mime, container } = pickRenderMime();
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: W * H > 1500000 ? 10_000_000 : 6_000_000, audioBitsPerSecond: 192_000 });
    const out = []; recorder.ondataavailable = (e) => e.data?.size && out.push(e.data);
    const stopped = new Promise((res) => { recorder.onstop = res; });
    await actx.resume();

    let finished = false, lastBoost = null, drift = 0, startedFirst = false;
    const timing = [];                                    // for diagnostics: planned vs actual source time at each switch
    const t0 = performance.now();
    recorder.start(1000); musicNode?.start(); fxNode?.start();
    await new Promise((resolve, reject) => {
      const stop = makeTicker(30, () => {
        if (finished) return;
        if (signal?.aborted) { finished = true; stop(); reject(new DOMException("Render cancelled", "AbortError")); return; }
        const t = (performance.now() - t0) / 1000, st = frameState(plan, Math.min(t, total));
        if (st.phase === "content") {
          const c = st.c, seg = segs[st.seg];
          // start the incoming player slightly early; switch exactly at the cut
          const ahead = curSeg >= 0 ? nextBreak(curSeg) : -1;
          if (ahead > 0 && prepared === ahead && prerolled !== ahead && c >= segs[ahead].outStart - PREROLL && c < segs[ahead].outStart) { prerolled = ahead; videos[1 - cur].play().catch(() => {}); }
          if (st.seg !== curSeg) {
            if (curSeg < 0) { cur = 0; if (videos[0].paused) videos[0].play().catch(() => {}); }
            else if (!contiguous(curSeg, st.seg)) {
              videos[cur].pause(); cur = 1 - cur;
              const v = videos[cur];
              if (prepared !== st.seg) { v.currentTime = Math.max(0, seg.srcStart + (c - seg.outStart)); }
              if (v.paused) v.play().catch(() => {});
              timing.push({ seg: st.seg, at: +c.toFixed(3), expected: +seg.srcStart.toFixed(3), actual: +v.currentTime.toFixed(3) });
            }
            curSeg = st.seg; env.video = videos[cur];
            const nb = nextBreak(curSeg);
            if (nb > 0) { const idle = videos[1 - cur]; idle.pause(); idle.currentTime = segs[nb].srcStart; prepared = nb; } else prepared = -1;
          }
          const v = videos[cur], expected = st.srcTime;
          if (Math.abs(v.currentTime - expected) > 0.25 && !v.seeking) { v.currentTime = expected; drift++; }
        } else if (st.phase === "intro" && introT - st.T <= PREROLL && videos[0].paused && !startedFirst) { startedFirst = true; videos[0].play().catch(() => {}); }
        else if (st.phase === "outro") videos.forEach((v) => { if (!v.paused) v.pause(); });
        env.video = videos[cur];
        if (st.phase === "content") for (const b of plan.broll || []) {
          const v = env.broll[b.clip]; if (!v) continue; const key = `${b.start}`, s0 = brollState.get(key) || "";
          if (s0 === "" && st.c >= b.start - 0.6) { v.pause(); v.currentTime = b.srcStart; brollState.set(key, "ready"); }
          else if (s0 === "ready" && st.c >= b.start) { v.play().catch(() => {}); brollState.set(key, "playing"); }
          else if (s0 === "playing" && st.c > b.end) { v.pause(); brollState.set(key, "done"); }
        }
        drawDirectorFrame(ctx, st, plan, env);
        // no voice in the cards: lift the music a little there
        const boost = st.phase === "content" ? 0 : 6;
        if (boost !== lastBoost) { lastBoost = boost; mixer.port.postMessage({ musicBoostDb: boost }); }
        onProgress?.({ t: Math.min(t, total), total, phase: st.phase });
        if (t >= total) { finished = true; stop(); resolve(); }
      });
      cleanup.push(stop);
    });
    videos.forEach((v) => v.pause());
    // what the mixer did, for diagnostics (how far the music was ducked under the voice, how hard the limiter worked)
    const mixerStats = await new Promise((res) => { const to = setTimeout(() => res(null), 600); mixer.port.onmessage = (e) => { if (e.data?.type === "stats") { clearTimeout(to); res(e.data); } }; mixer.port.postMessage({ type: "stats" }); });
    await new Promise((r) => setTimeout(r, 120));
    recorder.stop(); await stopped;
    const blob = new Blob(out, { type: mime.split(";")[0] });
    if (!blob.size) throw new Error("The render produced no data.");
    return { blob, mimeType: mime, container, width: W, height: H, seconds: total, aspect: plan.aspect, diagnostics: { driftCorrections: drift, switches: timing, mixer: mixerStats } };
  } finally {
    cleanup.forEach((fn) => { try { fn(); } catch (_) {} });
    try { await actx.close(); } catch (_) {}
    videos.forEach((v) => { v.pause(); v.removeAttribute("src"); v.load(); });
    brollEls.forEach((v) => { v.pause(); v.removeAttribute("src"); v.load(); }); brollUrls.forEach((u) => URL.revokeObjectURL(u));
    URL.revokeObjectURL(url);
  }
}

// The voice as it will sound in the edit: the kept stretches, joined, for measuring loudness before the render.
export function concatSegments(decoded, plan) {
  const sr = decoded.sampleRate, parts = plan.segments.map((s) => decoded.samples.subarray(Math.max(0, Math.floor(s.srcStart * sr)), Math.min(decoded.samples.length, Math.ceil(s.srcEnd * sr))));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { samples: out, sampleRate: sr, duration: out.length / sr };
}

// Render with a measured audio plan, then measure the file that came out (the same loop Toasty Clips uses): the gain that reaches
// -16 LUFS is found first, the exported file is decoded and measured, and if it is more than 1.5 LU off or peaks above -1 dBTP it is
// rendered once more with the error corrected. The result reports what was measured.
export async function renderDirected({ source, plan, onProgress, signal, decoded = null, logo = null, verifyAudio = true, brollFiles = null } = {}) {
  const target = plan.audio.targetLufs ?? SPEECH_TARGET_LUFS;
  const enhance = plan.audio.enhance !== false;
  let planned = null;
  if (enhance) {
    onProgress?.({ t: 0, total: 1, phase: "measuring" });
    let dec = decoded;
    if (!dec) { const { decodeMono16k } = await import("../clip-analysis.js"); dec = await decodeMono16k(source).catch(() => null); }
    if (dec) { const joined = concatSegments(dec, plan); planned = await planClipAudio(source, { start: 0, end: joined.duration }, { targetLufs: target, decode: async () => joined }).catch(() => null); }
  }
  const usePlan = Boolean(planned?.available && planned.plan.reason !== "no-signal");
  let gainDb = usePlan ? planned.plan.gainDb : null;
  const noiseReduction = usePlan && Boolean(planned.plan.noiseReduction);
  let ceilingDb = -2.5, corrected = false, result = null, measured = null, judged = null, firstPass = null;
  onProgress?.({ t: 0, total: 1, phase: "preparing" });
  const bed = await buildAudioBed(plan);
  for (let attempt = 0; attempt < 2; attempt++) {
    result = await renderPlanOnce({ source, plan, onProgress, signal, bed, logo, brollFiles, audio: { preGainDb: gainDb, targetRmsDb: usePlan ? planned.plan.levelerTargetDb + (gainDb - planned.plan.gainDb) : null, noiseReduction, ceilingDb } });
    if (!verifyAudio) break;
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
      ok: judged ? judged.ok : null, warnings, messages: warnings.map((w) => WARNING_TEXT[w]).filter(Boolean)
    }
  };
}
