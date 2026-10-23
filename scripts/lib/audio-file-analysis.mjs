// Node-side audio file measurement: ffprobe for the container/codec facts, ffmpeg to decode samples at the file's
// NATIVE rate and channel count (no resampling or downmixing, so what is measured is what was recorded), and the
// shared js/audio-analysis.js for the numbers.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StreamingAnalyzer } from "../../js/audio-analysis.js";

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export async function probeFile(path) {
  const { stdout } = await execFileAsync(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { maxBuffer: 16 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  const audio = info.streams.find((s) => s.codec_type === "audio") || null;
  const video = info.streams.find((s) => s.codec_type === "video") || null;
  const num = (v) => (v == null || v === "N/A" ? null : Number(v));
  return {
    container: info.format?.format_name || null,
    durationSec: num(info.format?.duration),
    sizeBytes: num(info.format?.size),
    overallBitrateKbps: num(info.format?.bit_rate) ? Math.round(num(info.format.bit_rate) / 1000) : null,
    audio: audio && {
      codec: audio.codec_name,
      profile: audio.profile || null,
      sampleRate: num(audio.sample_rate),
      channels: audio.channels,
      channelLayout: audio.channel_layout || null,
      bitrateKbps: num(audio.bit_rate) ? Math.round(num(audio.bit_rate) / 1000) : null,
      durationSec: num(audio.duration),
      startSec: num(audio.start_time)
    },
    video: video && {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      fps: video.avg_frame_rate && video.avg_frame_rate !== "0/0" ? Number(video.avg_frame_rate.split("/")[0]) / Number(video.avg_frame_rate.split("/")[1]) : null,
      durationSec: num(video.duration),
      startSec: num(video.start_time)
    },
    // Container-level A/V sync indicators: where each stream starts, and how far apart they end.
    avStartOffsetMs: audio && video && num(audio.start_time) != null && num(video.start_time) != null ? Math.round((num(audio.start_time) - num(video.start_time)) * 1000) : null,
    avDurationDeltaMs: audio && video && num(audio.duration) != null && num(video.duration) != null ? Math.round((num(audio.duration) - num(video.duration)) * 1000) : null
  };
}

// Decode the first audio stream to float32 at native rate/channels and stream it through `onBlock(channels[])`.
export function decodeAudio(path, probe, onBlock, { seconds = null, blockFrames = 48000 } = {}) {
  const { sampleRate, channels } = probe.audio;
  const args = ["-v", "error", "-i", path, "-vn", "-map", "0:a:0", ...(seconds ? ["-t", String(seconds)] : []), "-f", "f32le", "-acodec", "pcm_f32le", "-"];
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", carry = Buffer.alloc(0);
    const frameBytes = 4 * channels;
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (chunk) => {
      let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = Math.floor(buf.length / frameBytes) * frameBytes;
      carry = buf.subarray(usable);
      buf = buf.subarray(0, usable);
      for (let off = 0; off < buf.length; off += blockFrames * frameBytes) {
        const part = buf.subarray(off, Math.min(buf.length, off + blockFrames * frameBytes));
        const frames = part.length / frameBytes;
        const view = new Float32Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.length));
        const chans = Array.from({ length: channels }, () => new Float32Array(frames));
        for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) chans[c][i] = view[i * channels + c];
        onBlock(chans);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exited ${code}`))));
  });
}

export async function analyzeFile(path, { seconds = null } = {}) {
  const probe = await probeFile(path);
  if (!probe.audio) return { path, probe, analysis: null, error: "no audio stream" };
  const analyzer = new StreamingAnalyzer(probe.audio.sampleRate, probe.audio.channels);
  await decodeAudio(path, probe, (chans) => analyzer.push(chans), { seconds });
  return { path, probe, analysis: analyzer.result() };
}

// Whole (or first N seconds) mono mixdown held in memory, for delay/similarity comparisons.
export async function loadMono(path, { seconds = 60 } = {}) {
  const probe = await probeFile(path);
  const parts = [];
  await decodeAudio(path, probe, (chans) => {
    const mono = new Float32Array(chans[0].length);
    for (let i = 0; i < mono.length; i++) { let s = 0; for (const ch of chans) s += ch[i]; mono[i] = s / chans.length; }
    parts.push(mono);
  }, { seconds });
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return { samples: out, sampleRate: probe.audio.sampleRate, probe };
}

// Independent cross-check of our loudness number: ffmpeg's own EBU R128 meter.
export async function ffmpegLoudness(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", () => {
      const summary = err.slice(err.lastIndexOf("Summary:"));
      const grab = (re) => { const m = summary.match(re); return m ? Number(m[1]) : null; };
      resolve({ integratedLufs: grab(/I:\s+(-?[\d.]+) LUFS/), loudnessRangeLu: grab(/LRA:\s+(-?[\d.]+) LU/), truePeakDbfs: grab(/Peak:\s+(-?[\d.]+) dBFS/) });
    });
    child.on("error", reject);
  });
}
