#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHmac, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const HOST = process.env.TOASTY_BROADCAST_HOST || "127.0.0.1";
const PORT = Number(process.env.TOASTY_BROADCAST_PORT || 4175);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const AUTH_USERNAME = process.env.TOASTY_AUTH_USERNAME || "ricardo";
const AUTH_PASSWORD_SALT = process.env.TOASTY_AUTH_PASSWORD_SALT || "";
const AUTH_PASSWORD_HASH = process.env.TOASTY_AUTH_PASSWORD_HASH || "";
const SESSION_SECRET = process.env.TOASTY_SESSION_SECRET || "";
const SESSION_SECONDS = 12 * 60 * 60;
const COOKIE_NAME = "toasty_session";
const ALLOWED_ORIGINS = new Set([
  "https://toasty.media",
  "https://www.toasty.media",
  "http://localhost:4173",
  "http://127.0.0.1:4173"
]);
const jobs = new Map();

const server = createServer(async (req, res) => {
  if (!setCors(req, res)) return sendJson(res, 403, { error: "Origin is not allowed." });
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true, activeBroadcasts: jobs.size, authConfigured: authConfigured() });
    }

    if (req.method === "GET" && req.url === "/auth/session") {
      const session = readSession(req);
      return sendJson(res, 200, { authenticated: Boolean(session), username: session?.username || null });
    }

    if (req.method === "POST" && req.url === "/auth/login") {
      if (!authConfigured()) return sendJson(res, 503, { error: "Studio authentication is not configured." });
      const body = await readJson(req);
      if (!validCredentials(body?.username, body?.password)) {
        return sendJson(res, 401, { error: "Incorrect username or password." });
      }
      res.setHeader("Set-Cookie", makeSessionCookie(AUTH_USERNAME));
      return sendJson(res, 200, { authenticated: true, username: AUTH_USERNAME });
    }

    if (req.method === "POST" && req.url === "/auth/logout") {
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
      return sendJson(res, 200, { authenticated: false });
    }

    if (!readSession(req)) return sendJson(res, 401, { error: "Studio login required." });

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

function authConfigured() {
  return Boolean(AUTH_USERNAME && AUTH_PASSWORD_SALT && AUTH_PASSWORD_HASH && SESSION_SECRET);
}

function validCredentials(username, password) {
  if (String(username || "").toLowerCase() !== AUTH_USERNAME.toLowerCase()) return false;
  if (typeof password !== "string" || !password) return false;
  const candidate = scryptSync(password, AUTH_PASSWORD_SALT, 64);
  const expected = Buffer.from(AUTH_PASSWORD_HASH, "hex");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function makeSessionCookie(username) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = Buffer.from(JSON.stringify({ username, expires })).toString("base64url");
  const signature = sign(payload);
  return `${COOKIE_NAME}=${payload}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}`;
}

function readSession(req) {
  if (!authConfigured()) return null;
  const cookies = parseCookies(req.headers.cookie || "");
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const suppliedSignature = raw.slice(dot + 1);
  const expectedSignature = sign(payload);
  if (!safeStringEqual(suppliedSignature, expectedSignature)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (session.username !== AUTH_USERNAME || Number(session.expires) <= Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch (_) {
    return null;
  }
}

function sign(payload) {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function safeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header) {
  return header.split(";").reduce((out, item) => {
    const index = item.indexOf("=");
    if (index > 0) out[item.slice(0, index).trim()] = item.slice(index + 1).trim();
    return out;
  }, {});
}

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
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw httpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (_) {
    throw httpError(400, "Invalid JSON request.");
  }
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
