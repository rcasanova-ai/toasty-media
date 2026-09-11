#!/usr/bin/env node
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const HOST = process.env.TOASTY_RENDER_HOST || "127.0.0.1";
const PORT = Number(process.env.TOASTY_RENDER_PORT || 4174);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const API_TOKEN = process.env.TOASTY_RENDER_TOKEN || "";
const SESSION_SECRET = process.env.TOASTY_SESSION_SECRET || API_TOKEN || "";
const AUTH_DB_PATH = process.env.TOASTY_AUTH_DB || "/var/lib/toasty/toasty.sqlite";
const AUTH_DB_HELPER = process.env.TOASTY_AUTH_DB_HELPER || join(SCRIPT_DIR, "toasty-auth-db.py");
const SESSION_SECONDS = Number(process.env.TOASTY_SESSION_SECONDS || 7 * 24 * 60 * 60);
const COOKIE_NAME = "toasty_session";
const ALLOWED_ORIGINS = new Set([
  "https://toasty.media",
  "https://www.toasty.media",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);
const MAX_UPLOAD_BYTES = Number(process.env.TOASTY_RENDER_MAX_UPLOAD_BYTES || 350 * 1024 * 1024);
const MAX_FILES = Number(process.env.TOASTY_RENDER_MAX_FILES || 20);
const MAX_FILE_BYTES = Number(process.env.TOASTY_RENDER_MAX_FILE_BYTES || 150 * 1024 * 1024);
const MAX_TOTAL_DURATION = Number(process.env.TOASTY_RENDER_MAX_DURATION || 180);
const MAX_SCENES = Number(process.env.TOASTY_RENDER_MAX_SCENES || 40);
const FFMPEG_TIMEOUT_MS = Number(process.env.TOASTY_RENDER_FFMPEG_TIMEOUT_MS || 120000);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const scryptAsync = promisify(scrypt);
const rateBuckets = new Map();

const server = createServer(async (req, res) => {
  if (!setCors(req, res)) {
    sendJson(req, res, 403, { error: "Origin is not allowed." });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    sendJson(req, res, 200, { ok: true, authConfigured: authConfigured() });
    return;
  }
  if (req.method === "GET" && req.url === "/auth/session") {
    const session = await readSession(req);
    sendJson(req, res, 200, {
      authenticated: Boolean(session),
      user: session ? publicSessionUser(session) : null
    });
    return;
  }
  if (req.method === "POST" && req.url === "/auth/register") {
    if (!requireCsrf(req, res) || !limit(req, res, "register", 8, 15 * 60 * 1000)) return;
    await handleRegister(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/auth/login") {
    if (!requireCsrf(req, res) || !limit(req, res, "login", 12, 15 * 60 * 1000)) return;
    await handleLogin(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/auth/logout") {
    if (!requireCsrf(req, res)) return;
    clearSession(req, res);
    sendJson(req, res, 200, { authenticated: false });
    return;
  }
  if (req.method !== "POST" || req.url !== "/render") {
    sendJson(req, res, 404, { error: "Render helper is running. POST /render to create an MP4." });
    return;
  }
  if (!requireCsrf(req, res)) return;
  if (!(await isAuthorized(req))) {
    sendJson(req, res, 401, { error: "Sign in to render video." });
    return;
  }
  if (Number(req.headers["content-length"] || 0) > MAX_UPLOAD_BYTES) {
    sendJson(req, res, 413, { error: "Render upload is too large." });
    return;
  }

  let workDir;
  try {
    workDir = await mkdtemp(join(tmpdir(), "toasty-render-"));
    const request = new Request(`http://${HOST}:${PORT}/render`, {
      method: "POST",
      headers: req.headers,
      body: Readable.toWeb(req),
      duplex: "half"
    });
    const form = await request.formData();
    const manifestPart = form.get("manifest");
    const manifest = JSON.parse(typeof manifestPart === "string" ? manifestPart : await manifestPart.text());
    validateManifest(manifest);
    const media = await writeMediaFiles({ form, workDir });
    const outputPath = await renderProduction({ manifest, media, workDir });
    const output = await readFile(outputPath);
    setCors(req, res);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${safeFileName(manifest.title || "toasty-production")}.mp4"`,
      "Content-Length": output.length
    });
    res.end(output);
  } catch (error) {
    console.error(error);
    sendJson(req, res, error.statusCode || 500, { error: creatorError(error) });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Toasty render helper listening on http://${HOST}:${PORT}`);
});

async function handleRegister(req, res) {
  if (!authConfigured()) return sendJson(req, res, 503, { error: "Studio authentication is not configured." });
  const body = await readJson(req);
  const name = cleanName(body?.name);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || "");
  if (!name || !email || !password) return sendJson(req, res, 400, { error: "Name, email, and password are required." });
  if (!EMAIL_PATTERN.test(email)) return sendJson(req, res, 400, { error: "Enter a valid email address." });
  if (password.length < 10) return sendJson(req, res, 400, { error: "Use a password with at least 10 characters." });
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);
  const result = await db("create_user", { id: userId, name, email, passwordHash });
  if (result.error === "duplicate_email") return sendJson(req, res, 409, { error: "An account with that email already exists." });
  if (!result.user) return sendJson(req, res, 500, { error: "Account could not be created." });
  setSession(req, res, result.user);
  sendJson(req, res, 201, { authenticated: true, user: result.user });
}

async function handleLogin(req, res) {
  if (!authConfigured()) return sendJson(req, res, 503, { error: "Studio authentication is not configured." });
  const body = await readJson(req);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || "");
  if (!email || !password) return sendJson(req, res, 400, { error: "Email and password are required." });
  const result = await db("get_user_by_email", { email });
  const generic = { error: "Incorrect email or password." };
  if (!result.user || result.user.status !== "active" || !(await verifyPassword(password, result.passwordHash))) {
    return sendJson(req, res, 401, generic);
  }
  const login = await db("mark_login", { id: result.user.id });
  const user = login.user || result.user;
  setSession(req, res, user);
  sendJson(req, res, 200, { authenticated: true, user });
}

function authConfigured() {
  return Boolean(SESSION_SECRET);
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(key).toString("hex")}`;
}

async function verifyPassword(password, stored = "") {
  const [method, salt, hash] = String(stored).split("$");
  if (method !== "scrypt" || !salt || !hash) return false;
  const candidate = Buffer.from(await scryptAsync(password, salt, 64));
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function setSession(req, res, user) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    expires
  })).toString("base64url");
  const signature = sign(payload);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${payload}.${signature}; ${cookieAttributes(req)}; Max-Age=${SESSION_SECONDS}`);
}

function clearSession(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; ${cookieAttributes(req)}; Max-Age=0`);
}

function cookieAttributes(req) {
  const secure = isLocalOrigin(req.headers.origin || "") ? "" : " Secure;";
  return `HttpOnly;${secure} SameSite=Lax; Path=/`;
}

async function readSession(req) {
  if (!authConfigured()) return null;
  const cookies = parseCookies(req.headers.cookie || "");
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const suppliedSignature = raw.slice(dot + 1);
  if (!safeStringEqual(suppliedSignature, sign(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(session.expires) <= Math.floor(Date.now() / 1000)) return null;
    const result = await db("get_user_by_id", { id: session.id });
    if (!result.user || result.user.status !== "active") return null;
    return result.user;
  } catch {
    return null;
  }
}

function publicSessionUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email, status: user.status } : null;
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

async function db(action, values = {}) {
  const result = await runJson("python3", [AUTH_DB_HELPER], { action, dbPath: AUTH_DB_PATH, ...values });
  if (result.error && result.error !== "duplicate_email") throw httpError(500, "Authentication storage is unavailable.");
  return result;
}

async function writeMediaFiles({ form, workDir }) {
  const media = new Map();
  const files = form.getAll("media");
  if (files.length > MAX_FILES) throw httpError(413, "Too many media files.");
  for (const file of files) {
    if (!file?.name || typeof file.arrayBuffer !== "function") continue;
    if (file.size > MAX_FILE_BYTES) throw httpError(413, "One media file is too large.");
    const [mediaId, ...nameParts] = file.name.split("__");
    if (!SAFE_ID.test(mediaId || "")) throw httpError(400, "Invalid media id.");
    const fileName = safeFileName(nameParts.join("__") || file.name);
    const filePath = join(workDir, `${mediaId}-${fileName}`);
    await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
    media.set(mediaId, filePath);
  }
  return media;
}

async function renderProduction({ manifest, media, workDir }) {
  const { width, height } = dimensionsFor(manifest.aspectRatio);
  const sceneFiles = [];
  for (const segment of manifest.timeline) {
    const scene = manifest.productionSpec.scenes.find((candidate) => candidate.id === segment.sceneId);
    const asset = manifest.assets.find((candidate) => candidate.id === segment.primaryVisualAssetId);
    const avatar = manifest.assets.find((candidate) => candidate.id === segment.avatarAssetId);
    const broll = manifest.assets.find((candidate) => candidate.id === segment.brollAssetId);
    const audioSource = manifest.assets.find((candidate) => candidate.id === segment.audioSourceAssetId);
    const output = join(workDir, `scene-${String(segment.order).padStart(2, "0")}.mp4`);
    await renderScene({
      segment,
      scene,
      assetPath: asset?.mediaId ? media.get(asset.mediaId) : null,
      avatarPath: avatar?.mediaId ? media.get(avatar.mediaId) : null,
      brollPath: broll?.mediaId ? media.get(broll.mediaId) : null,
      audioSourcePath: audioSource?.mediaId ? media.get(audioSource.mediaId) : null,
      manifest,
      width,
      height,
      output
    });
    sceneFiles.push(output);
  }

  const listPath = join(workDir, "scenes.txt");
  await writeFile(listPath, sceneFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  const silentVideo = join(workDir, "video-only.mp4");
  await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", silentVideo]);

  const narrationPath = manifest.narrationAudio?.mediaId ? media.get(manifest.narrationAudio.mediaId) : null;
  const outputPath = join(workDir, "toasty-production.mp4");
  if (narrationPath) {
    await run(FFMPEG, [
      "-y",
      "-i", silentVideo,
      "-i", narrationPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      "-movflags", "+faststart",
      outputPath
    ]);
  } else {
    await run(FFMPEG, ["-y", "-i", silentVideo, "-c", "copy", "-movflags", "+faststart", outputPath]);
  }
  return outputPath;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw httpError(400, "Invalid render manifest.");
  if (!Array.isArray(manifest.timeline) || manifest.timeline.length < 1 || manifest.timeline.length > MAX_SCENES) {
    throw httpError(400, "Invalid scene count.");
  }
  if (!Array.isArray(manifest.assets)) throw httpError(400, "Invalid asset list.");
  if (!manifest.productionSpec || !Array.isArray(manifest.productionSpec.scenes)) {
    throw httpError(400, "Invalid production spec.");
  }
  if (!["9:16", "16:9", "1:1"].includes(manifest.aspectRatio)) throw httpError(400, "Invalid aspect ratio.");
  const totalDuration = manifest.timeline.reduce((sum, segment) => {
    if (!SAFE_ID.test(segment.sceneId || "")) throw httpError(400, "Invalid scene id.");
    const duration = Number(segment.duration);
    if (!Number.isFinite(duration) || duration < 1 || duration > MAX_TOTAL_DURATION) throw httpError(400, "Invalid scene duration.");
    [
      segment.primaryVisualAssetId,
      segment.avatarAssetId,
      segment.brollAssetId,
      segment.audioSourceAssetId,
      segment.narrationMediaId
    ].filter(Boolean).forEach((id) => {
      if (!SAFE_ID.test(id)) throw httpError(400, "Invalid asset id.");
    });
    return sum + duration;
  }, 0);
  if (totalDuration > MAX_TOTAL_DURATION) throw httpError(400, "Render is too long.");
  manifest.assets.forEach((asset) => {
    if (asset.id && !SAFE_ID.test(asset.id)) throw httpError(400, "Invalid asset id.");
    if (asset.mediaId && !SAFE_ID.test(asset.mediaId)) throw httpError(400, "Invalid media id.");
  });
}

async function renderScene({ segment, scene, assetPath, avatarPath, brollPath, audioSourcePath, manifest, width, height, output }) {
  const duration = Math.max(1, Number(segment.duration) || 3);
  const caption = segment.caption || scene?.captionText || "";
  const brand = manifest.brandProfile || {};
  const color = normalizeColor(brand.primaryColor || "#ff7a29");
  const overlayPath = join(dirname(output), `overlay-${segment.order}.png`);
  await createOverlayPng({
    width,
    height,
    caption,
    title: titleForSegment({ segment, scene, manifest }),
    lowerThird: segment.lowerThird || "",
    watermark: segment.watermark !== false,
    brandName: brand.name || "Toasty Media",
    website: brand.website || brand.creatorHandle || "",
    color,
    output: overlayPath
  });
  const videoOnly = join(dirname(output), `scene-${String(segment.order).padStart(2, "0")}-video.mp4`);
  const filter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[base];[base][1:v]overlay=0:0`;

  if (segment.composition === "avatar-pip" && avatarPath && brollPath) {
    await renderPipScene({ avatarPath, brollPath, overlayPath, duration, width, height, output: videoOnly });
    await muxSceneAudio({ videoPath: videoOnly, audioPath: audioSourcePath, duration, output });
    return;
  }

  if (!assetPath || segment.composition === "text-card" || segment.composition === "intro-card" || segment.composition === "outro-card") {
    await run(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=${backgroundColor(brand)}:s=${width}x${height}:d=${duration}`,
      "-loop", "1",
      "-i", overlayPath,
      "-filter_complex", "[0:v][1:v]overlay=0:0",
      "-t", String(duration),
      ...videoOutputArgs(videoOnly)
    ]);
    await muxSceneAudio({ videoPath: videoOnly, audioPath: audioSourcePath, duration, output });
    return;
  }

  const loopArgs = isImage(assetPath) ? ["-loop", "1"] : ["-stream_loop", "-1"];
  await run(FFMPEG, [
    "-y",
    ...loopArgs,
    "-i", assetPath,
    "-loop", "1",
    "-i", overlayPath,
    "-t", String(duration),
    "-filter_complex", filter,
    ...videoOutputArgs(videoOnly)
  ]);
  await muxSceneAudio({ videoPath: videoOnly, audioPath: audioSourcePath, duration, output });
}

async function renderPipScene({ avatarPath, brollPath, overlayPath, duration, width, height, output }) {
  const brollLoop = isImage(brollPath) ? ["-loop", "1"] : ["-stream_loop", "-1"];
  const avatarLoop = isImage(avatarPath) ? ["-loop", "1"] : ["-stream_loop", "-1"];
  const pipWidth = Math.round(width * 0.32);
  const pipHeight = Math.round(pipWidth * 16 / 9);
  const filter = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[bg]`,
    `[1:v]scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=increase,crop=${pipWidth}:${pipHeight},setsar=1[pip]`,
    `[bg][pip]overlay=x=W-w-42:y=42:format=auto[pipbg]`,
    `[pipbg][2:v]overlay=0:0`
  ].join(";");
  await run(FFMPEG, [
    "-y",
    ...brollLoop,
    "-i", brollPath,
    ...avatarLoop,
    "-i", avatarPath,
    "-loop", "1",
    "-i", overlayPath,
    "-t", String(duration),
    "-filter_complex", filter,
    ...videoOutputArgs(output)
  ]);
}

async function createOverlayPng(spec) {
  await run("python3", [join(SCRIPT_DIR, "render-overlay.py"), JSON.stringify(spec)]);
}

function videoOutputArgs(output) {
  return [
    "-an",
    "-r", "30",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "veryfast",
    "-movflags", "+faststart",
    output
  ];
}

async function muxSceneAudio({ videoPath, audioPath, duration, output }) {
  if (audioPath) {
    try {
      await run(FFMPEG, [
        "-y",
        "-i", videoPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-t", String(duration),
        "-c:v", "copy",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-shortest",
        "-movflags", "+faststart",
        output
      ]);
      return;
    } catch {
      // Fall back to silent audio for videos with no readable audio stream.
    }
  }
  await run(FFMPEG, [
    "-y",
    "-i", videoPath,
    "-f", "lavfi",
    "-t", String(duration),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    "-movflags", "+faststart",
    output
  ]);
}

function dimensionsFor(aspectRatio) {
  if (aspectRatio === "16:9") return { width: 1280, height: 720 };
  if (aspectRatio === "1:1") return { width: 1080, height: 1080 };
  return { width: 720, height: 1280 };
}

function titleForSegment({ segment, scene, manifest }) {
  if (segment.quickRole === "intro") return scene?.scriptText || manifest.title;
  if (segment.quickRole === "outro") return scene?.scriptText || manifest.productionSpec?.cta || "";
  if (segment.composition === "text-card") return scene?.scriptText || manifest.title;
  return "";
}

function backgroundColor(brand) {
  return normalizeColor(brand.primaryColor || "#171210").replace("#", "0x");
}

function normalizeColor(color) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#ff7a29";
}

function isImage(filePath) {
  return /\.(png|jpe?g|webp|gif)$/i.test(filePath);
}

function safeFileName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "toasty-production";
}

function creatorError(error) {
  if (error.publicMessage) return error.publicMessage;
  if (/ENOENT/.test(error.message)) return "Render helper could not find FFmpeg.";
  if (/timed out/.test(error.message)) return "Render timed out. Try a shorter production or smaller media files.";
  if (/No such file|Invalid data|Error opening/.test(error.message)) return "One of the media files could not be rendered. Try replacing that scene asset.";
  return "Render failed. Check that the local render helper is running and the imported media files are playable.";
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Toasty-Render-Token, X-Toasty-CSRF");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

function sendJson(req, res, status, payload) {
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function isAuthorized(req) {
  if (await readSession(req)) return true;
  if (!API_TOKEN && isLocalOrigin(req.headers.origin)) return true;
  return Boolean(API_TOKEN) && req.headers["x-toasty-render-token"] === API_TOKEN;
}

function isLocalOrigin(origin = "") {
  return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
}

function requireCsrf(req, res) {
  const origin = req.headers.origin || "";
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    sendJson(req, res, 403, { error: "Origin is not allowed." });
    return false;
  }
  if (req.headers["x-toasty-csrf"] !== "1") {
    sendJson(req, res, 403, { error: "Request verification failed." });
    return false;
  }
  return true;
}

function limit(req, res, key, max, windowMs) {
  const now = Date.now();
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const bucketKey = `${key}:${ip}`;
  const bucket = rateBuckets.get(bucketKey) || [];
  const current = bucket.filter((time) => now - time < windowMs);
  current.push(now);
  rateBuckets.set(bucketKey, current);
  if (current.length > max) {
    sendJson(req, res, 429, { error: "Too many attempts. Try again shortly." });
    return false;
  }
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
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON request.");
  }
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function httpError(statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

function runJson(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `${command} exited with ${code}`));
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, FFMPEG_TIMEOUT_MS);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
  });
}
