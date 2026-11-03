// Streaming (any length) voice enhancement with ffmpeg, using the SAME defaults as js/audio-enhance.js.
// Two passes: (1) run the dynamics chain and measure integrated loudness with ebur128; (2) run it again with one
// constant, capped gain to reach the target, then a look-ahead limiter. A constant gain (not loudnorm's dynamic mode)
// is what keeps a voice from "pumping". Video is stream-copied when present: only the audio is re-encoded, and the
// input file is never modified.
import { spawn } from "node:child_process";
import { ffmpegLoudness } from "./audio-file-analysis.mjs";
import { buildFfmpegEnhanceFilters, buildFfmpegLimiter, normalizeEnhanceOptions } from "../../js/audio-enhance.js";

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

export async function measureAfterChain(input, options = {}) {
  const chain = buildFfmpegEnhanceFilters(options);
  const stderr = await run(["-hide_banner", "-nostats", "-i", input, "-vn", "-map", "0:a:0", "-af", [...chain, "ebur128=peak=true"].join(","), "-f", "null", "-"]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const m = summary.match(/I:\s+(-?[\d.]+) LUFS/);
  return m ? Number(m[1]) : null;
}

// True-peak guard: lossy encoders and inter-sample peaks can push the decoded file above the limiter's sample-peak
// ceiling (noise-like laughter is the worst case). After encoding, the true peak is measured; if it is above the
// -1 dBTP target the file is rendered again with exactly that much extra headroom. At most two corrections.
export const TRUE_PEAK_TARGET_DBTP = -1;

export async function enhanceFile(input, output, { options = {}, audioOnly = false, audioBitrate = "192k" } = {}) {
  let o = normalizeEnhanceOptions(options);
  const chain = buildFfmpegEnhanceFilters(o);
  const measured = await measureAfterChain(input, o);
  let gainDb = 0, boostCapped = false;
  if (measured != null && Number.isFinite(measured)) {
    const wanted = o.targetLufs - measured;
    gainDb = Math.min(o.maxBoostDb, Math.max(-o.maxCutDb, wanted));
    boostCapped = wanted > o.maxBoostDb;
  }
  const hasVideo = !audioOnly && /\.(mp4|mov|m4v|webm|mkv)$/i.test(input);
  let truePeak = null, corrections = 0;
  for (;;) {
    const filter = [...chain, ...(gainDb ? [`volume=${gainDb.toFixed(2)}dB`] : []), buildFfmpegLimiter(o)].join(",");
    const args = ["-hide_banner", "-nostats", "-y", "-i", input, "-map", "0:a:0", ...(hasVideo ? ["-map", "0:v?", "-c:v", "copy"] : ["-vn"]),
      "-af", filter, "-c:a", /\.(webm|mkv)$/i.test(output) ? "libopus" : "aac", "-b:a", audioBitrate, "-ar", "48000", ...(/\.mp4$/i.test(output) ? ["-movflags", "+faststart"] : []), output];
    await run(args);
    truePeak = (await ffmpegLoudness(output)).truePeakDbfs;
    if (truePeak == null || truePeak <= TRUE_PEAK_TARGET_DBTP + 0.05 || corrections >= 2) break;
    o = normalizeEnhanceOptions({ ...o, limiterCeilingDb: Math.max(-6, o.limiterCeilingDb - (truePeak - TRUE_PEAK_TARGET_DBTP) - 0.1) });
    corrections++;
  }
  return { options: o, inputLufsAfterDynamics: measured, appliedGainDb: Math.round(gainDb * 100) / 100, boostCapped, videoCopied: hasVideo, truePeakDbtp: truePeak, truePeakCorrections: corrections, output };
}
