#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const HOST = process.env.TOASTY_BROADCAST_HOST || "127.0.0.1";
const PORT = Number(process.env.TOASTY_BROADCAST_PORT || 4175);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const API_TOKEN = process.env.TOASTY_BROADCAST_TOKEN || "";
const ALLOWED_ORIGINS = new Set([
  "https://toasty.media",
  "http://localhost:4173",
  "http://127.0.0.1:4173"
]);
const jobs = new Map();

const server = createServer(async (req, res) => {
  if (!setCors(req, res)) return sendJson(res, 403, { error: "Origin is not allowed." });
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (!isAuthorized(req)) return sendJson(res, 401, { error: "Broadcast token is required." });

  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true, activeBroadcasts: jobs.size });
    }

    if (req.method === "POST" && req.url === "/broadcast/start") {
      const body = await readJson(req);
      validateDestination(body);
      const id = randomUUID();
      jobs.set(id, {
        id,
        state: "ready",
        createdAt: Date.now(),
        destination: body.destination,
        streamUrl: body.streamUrl,
        streamKey: body.streamKey,
        width: clampNumber(body.width, 640, 1920, 1920),
        height: clampNumber(body.height, 360, 1080, 1080),
        fps: clampNumber(body.fps, 24, 60, 30),
        bitrateKbps: clampNumber(body.bitrateKbps, 1000, 12000, 6000),
        process: null,
        stderr: ""
      });
      return sendJson(res, 201, { id, state: "ready", ingestPath: `/broadcast/${id}/ingest` });
    }

    const ingestMatch = req.url?.match(/^\/broadcast\/([a-f0-9-]+)\/ingest$/i);
    if (req.method === "POST" && ingestMatch) {
      const job = jobs.get(ingestMatch[1]);
      if (!job) return sendJson(res, 404, { error: "Broadcast not found." });
      if (job.process) return sendJson(res, 409, { error: "Broadcast is already ingesting." });
      startFfmpeg(job, req, res);
      return;
    }

    const stopMatch = req.url?.match(/^\/broadcast\/([a-f0-9-]+)\/stop$/i);
    if (req.method === "POST" && stopMatch) {
      const job = jobs.get(stopMatch[1]);
      if (!job) return sendJson(res, 404, { error: "Broadcast not found." });
      stopJob(job);
      jobs.delete(job.id);
      return sendJson(res, 200, { id: job.id, state: "stopped" });
    }

    const statusMatch = req.url?.match(/^\/broadcast\/([a-f0-9-]+)$/i);
    if (req.method === "GET" && statusMatch) {
      const job = jobs.get(statusMatch[1]);
      if (!job) return sendJson(res, 404, { error: "Broadcast not found." });
      return sendJson(res, 200, publicJob(job));
    }

    sendJson(res, 404, { error: "Toasty broadcast service is running." });
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, { error: error.message || "Broadcast service error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Toasty broadcast service listening on http://${HOST}:${PORT}`);
});

function startFfmpeg(job, req, res) {
  const target = joinRtmp(job.streamUrl, job.streamKey);
  const gop = Math.max(job.fps * 2, 48);
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "+genpts",
    "-f", "webm",
    "-i", "pipe:0",
    "-vf", `scale=${job.width}:${job.height}:force_original_aspect_ratio=decrease,pad=${job.width}:${job.height}:(ow-iw)/2:(oh-ih)/2`,
    "-r", String(job.fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-b:v", `${job.bitrateKbps}k`,
    "-maxrate", `${job.bitrateKbps}k`,
    "-bufsize", `${job.bitrateKbps * 2}k`,
    "-g", String(gop),
    "-keyint_min", String(gop),
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "48000",
    "-f", "flv",
    target
  ];

  const ffmpeg = spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
  job.process = ffmpeg;
  job.state = "live";
  job.startedAt = Date.now();
  job.stderr = "";

  ffmpeg.stderr.on("data", (chunk) => {
    job.stderr = `${job.stderr}${chunk.toString()}`.slice(-8000);
  });

  ffmpeg.on("exit", (code, signal) => {
    job.process = null;
    job.state = code === 0 || signal === "SIGTERM" ? "stopped" : "failed";
    job.exitCode = code;
    job.signal = signal;
  });

  req.on("aborted", () => stopJob(job));
  req.on("error", () => stopJob(job));
  req.pipe(ffmpeg.stdin);

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Connection": "keep-alive"
  });
  ffmpeg.on("exit", () => {
    if (!res.writableEnded) res.end(JSON.stringify(publicJob(job)));
  });
}

function stopJob(job) {
  if (job.process && !job.process.killed) {
    job.process.stdin?.end();
    job.process.kill("SIGTERM");
  }
  job.state = "stopped";
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    destination: job.destination,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    uptimeSeconds: job.startedAt ? Math.floor((Date.now() - job.startedAt) / 1000) : 0,
    exitCode: job.exitCode ?? null,
    error: job.state === "failed" ? tail(job.stderr) : null
  };
}

function validateDestination(body) {
  if (!body || typeof body !== "object") throw httpError(400, "Invalid broadcast request.");
  if (typeof body.streamUrl !== "string" || !/^rtmps?:\/\//i.test(body.streamUrl)) {
    throw httpError(400, "A valid RTMP or RTMPS stream URL is required.");
  }
  if (typeof body.streamKey !== "string" || body.streamKey.trim().length < 2) {
    throw httpError(400, "A stream key is required.");
  }
}

function joinRtmp(url, key) {
  return `${url.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return true;
}

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  return req.headers.authorization === `Bearer ${API_TOKEN}`;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw httpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store" });
  res.end(payload);
}

function tail(value) {
  return String(value || "").split("\n").slice(-8).join("\n");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
