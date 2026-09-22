#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PORT = 4279;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `${command} exited ${code}`));
      resolve(stdout);
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      // Server still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("render helper did not start");
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

const tmp = await mkdtemp(join(tmpdir(), "toasty-finalize-test-"));
let server;
try {
  const dbPath = join(tmp, "auth.sqlite");
  server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      TOASTY_RENDER_PORT: String(PORT),
      TOASTY_AUTH_DB: dbPath,
      TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"),
      TOASTY_SESSION_SECRET: "recording-finalization-test-secret",
      TOASTY_RENDER_MAX_FILE_BYTES: String(20 * 1024 * 1024),
      TOASTY_RENDER_MAX_UPLOAD_BYTES: String(25 * 1024 * 1024)
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let serverErrors = "";
  server.stderr.on("data", (chunk) => { serverErrors += chunk.toString(); });
  await waitForHealth();

  const register = await fetch(`http://127.0.0.1:${PORT}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Toasty-CSRF": "1" },
    body: JSON.stringify({ name: "Recorder Test", email: "recorder@example.com", password: "password10chars" })
  });
  assert.equal(register.status, 201, await register.text());
  const cookie = cookieFrom(register);
  assert(cookie.includes("toasty_session="), "registration produced auth cookie");

  const sourcePath = join(tmp, "source.webm");
  await run(FFMPEG, [
    "-y",
    "-f", "lavfi",
    "-i", "testsrc=size=320x180:rate=30:duration=1.5",
    "-f", "lavfi",
    "-i", "sine=frequency=880:duration=1.5",
    "-c:v", "libvpx-vp9",
    "-c:a", "libopus",
    "-shortest",
    sourcePath
  ]);
  const source = await readFile(sourcePath);
  assert(source.length > 0, "source WebM exists");

  const manifest = {
    kind: "master-program",
    recordingId: "rec-finalize-test",
    files: {
      source: "session/source/rec-finalize-test.webm",
      master: "session/master/rec-finalize-test.mp4"
    }
  };
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.append("source", new Blob([source], { type: "video/webm" }), "rec-finalize-test.webm");
  const finalized = await fetch(`http://127.0.0.1:${PORT}/api/recordings/finalize`, {
    method: "POST",
    headers: { "X-Toasty-CSRF": "1", Cookie: cookie },
    body: form
  });
  if (finalized.status !== 200) {
    throw new Error(await finalized.text());
  }
  assert.equal(finalized.headers.get("content-type"), "video/mp4");
  const mp4 = Buffer.from(await finalized.arrayBuffer());
  assert(mp4.length > 0, "MP4 master returned");
  assert(source.length > 0, "source WebM remains available after finalization");

  const masterPath = join(tmp, "master.mp4");
  await writeFile(masterPath, mp4);
  const probeRaw = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height:format=duration",
    "-of", "json",
    masterPath
  ]);
  const probe = JSON.parse(probeRaw);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.codec_name, "h264", "MP4 video is H.264");
  assert.equal(audio.codec_name, "aac", "MP4 audio is AAC");
  assert.equal(video.width, 320, "MP4 width preserved");
  assert.equal(video.height, 180, "MP4 height preserved");
  assert(Number(probe.format.duration) >= 1, "MP4 has playable duration");

  const badForm = new FormData();
  badForm.set("manifest", JSON.stringify({ kind: "master-program", recordingId: "rec-bad" }));
  badForm.append("source", new Blob(["not a webm"], { type: "video/webm" }), "rec-bad.webm");
  const failed = await fetch(`http://127.0.0.1:${PORT}/api/recordings/finalize`, {
    method: "POST",
    headers: { "X-Toasty-CSRF": "1", Cookie: cookie },
    body: badForm
  });
  assert.equal(failed.status, 500, "bad source fails finalization");
  assert(source.length > 0, "successful browser source would still be preserved by the client on failure");

  console.log("ALL PASSED — recording finalization returns H.264/AAC MP4 and preserves source WebM.");
} finally {
  if (server) server.kill("SIGTERM");
  await rm(tmp, { recursive: true, force: true });
}
