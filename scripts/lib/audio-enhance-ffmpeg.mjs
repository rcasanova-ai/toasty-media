// Streaming (any length) voice enhancement with ffmpeg, using the SAME defaults as js/audio-enhance.js.
// Two passes: (1) run the dynamics chain and measure integrated loudness with ebur128; (2) run it again with one
// constant, capped gain to reach the target, then a look-ahead limiter. A constant gain (not loudnorm's dynamic mode)
// is what keeps a voice from "pumping". Video is stream-copied when present: only the audio is re-encoded, and the
// input file is never modified.
import { spawn } from "node:child_process";
import { ffmpegLoudness } from "./audio-file-analysis.mjs";
import { buildFfmpegEnhanceFilters, buildFfmpegLimiter, normalizeEnhanceOptions } from "../../js/audio-enhance.js";
import { analyseSpeechLevel, classifyLevel, planSpeechGain, TRUE_PEAK_TARGET_DBTP as TP_TARGET } from "../../js/loudness-plan.js";
import { loadMono } from "./audio-file-analysis.mjs";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function run(args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("ffmpeg timed out")); }, timeoutMs);
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-1e6); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stderr) : reject(new Error(stderr.trim().split("\n").slice(-4).join(" | ") || `ffmpeg exited ${code}`)); });
  });
}

export async function measureAfterChain(input, options = {}, chainOptions = {}) {
  const chain = buildFfmpegEnhanceFilters(options, chainOptions);
  const stderr = await run(["-hide_banner", "-nostats", "-i", input, "-vn", "-map", "0:a:0", "-af", [...chain, "ebur128=peak=true"].join(","), "-f", "null", "-"]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const m = summary.match(/I:\s+(-?[\d.]+) LUFS/);
  return m ? Number(m[1]) : null;
}

// True-peak guard: lossy encoders and inter-sample peaks can push the decoded file above the limiter's sample-peak
// ceiling (noise-like laughter is the worst case). After encoding, the true peak is measured; if it is above the
// -1 dBTP target the file is rendered again with exactly that much extra headroom. At most two corrections.
export const TRUE_PEAK_TARGET_DBTP = TP_TARGET;   // -1.5 dBTP

// Measure, then correct. The speech level is measured (BS.1770 gated, signal-to-noise ratio) and the gain planned from it
// (js/loudness-plan.js); that gain goes in front of the compressor so the compressor works at speech level, a small trim after it
// lands on the target exactly, and a limiter holds the true peak. An already-correct file gets ~0 dB.
export async function enhanceFile(input, output, { options = {}, audioOnly = false, audioBitrate = "192k", analysisSeconds = 1800 } = {}) {
  let o = normalizeEnhanceOptions(options);
  const mono = await loadMono(input, { seconds: analysisSeconds });
  const analysis = analyseSpeechLevel([mono.samples], mono.sampleRate);
  const verdict = classifyLevel(analysis);
  const plan = planSpeechGain(analysis, { targetLufs: o.targetLufs, maxBoostDb: o.maxBoostDb, maxCutDb: o.maxCutDb });
  const noiseReduction = o.noiseReduction.enabled === true || (o.noiseReduction.enabled === "auto" && plan.noiseReduction);
  const chainOptions = { preGainDb: plan.gainDb, noiseReduction };
  const chain = buildFfmpegEnhanceFilters(o, chainOptions);
  const measured = verdict.state === "silent" ? null : await measureAfterChain(input, o, chainOptions);
  let trimDb = 0;
  if (measured != null && Number.isFinite(measured)) trimDb = Math.max(-6, Math.min(Math.max(0, plan.maxAllowedBoostDb + 6 - plan.gainDb), o.targetLufs - measured));
    const boostCapped = plan.capped;
  const hasVideo = !audioOnly && /\.(mp4|mov|m4v|webm|mkv)$/i.test(input);
  let truePeak = null, corrections = 0, loud = null, passes = 0;
  for (;;) {
    const filter = [...chain, ...(trimDb ? [`volume=${trimDb.toFixed(2)}dB`] : []), buildFfmpegLimiter(o)].join(",");
    const args = ["-hide_banner", "-nostats", "-y", "-i", input, "-map", "0:a:0", ...(hasVideo ? ["-map", "0:v?", "-c:v", "copy"] : ["-vn"]),
      "-af", filter, "-c:a", /\.(webm|mkv)$/i.test(output) ? "libopus" : "aac", "-b:a", audioBitrate, "-ar", "48000", ...(/\.mp4$/i.test(output) ? ["-movflags", "+faststart"] : []), output];
    await run(args);
    loud = await ffmpegLoudness(output);
    truePeak = loud.truePeakDbfs;
    passes++;
    const overshoot = truePeak == null ? 0 : truePeak - TRUE_PEAK_TARGET_DBTP;
    const lufsError = loud.integratedLufs == null ? 0 : o.targetLufs - loud.integratedLufs;
    // The limiter and encoder move loudness a little: close the gap by measuring the OUTPUT and re-rendering (at most three corrections).
    if (passes > 3) break;
    if (overshoot > 0.05) { o = normalizeEnhanceOptions({ ...o, limiterCeilingDb: Math.max(-12, o.limiterCeilingDb - overshoot - 0.1) }); corrections++; continue; }
    if (Math.abs(lufsError) > 0.7 && verdict.state !== "silent" && trimDb + lufsError <= 12) { trimDb += lufsError; corrections++; continue; }
    break;
  }
  return {
    options: o, verdict, inputAnalysis: analysis, plannedGainDb: Math.round(plan.gainDb * 100) / 100, appliedGainDb: Math.round((plan.gainDb + trimDb) * 100) / 100,
    noiseReduced: noiseReduction, boostCapped, capReason: plan.reason, videoCopied: hasVideo,
    outputLufs: loud?.integratedLufs ?? null, truePeakDbtp: truePeak, truePeakCorrections: corrections, output
  };
}
