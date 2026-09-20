#!/usr/bin/env node
// Program Output server-sync regression.
// Proves the already-open listener path consumes canonical /api/presence/room
// program revisions. This deliberately does not use BroadcastChannel, localStorage,
// or storage events.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProgramServerSubscriber } from "../js/program-server-sync.js";
import { SceneId, buildCanonicalState } from "../js/session-control.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4206;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM_ID = `serversync${Date.now().toString(36)}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-program-server-sync-"));
const dbPath = join(scratchDir, "toasty.sqlite");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok - ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

async function announceProgram(program) {
  const response = await fetch(`${BASE}/api/presence/announce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId: ROOM_ID,
      participantId: "host",
      role: "host",
      displayName: "Ricardo",
      transportSourceId: `${ROOM_ID}h`,
      micEnabled: true,
      cameraEnabled: true,
      program
    })
  });
  if (!response.ok) throw new Error(`announce failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function state(partial = {}) {
  return buildCanonicalState({
    sessionId: ROOM_ID,
    roomId: ROOM_ID,
    scene: SceneId.HOLDING,
    topic: "Server sync",
    participants: [],
    ...partial
  });
}

const server = spawn("node", ["scripts/render-production-server.mjs"], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath },
  stdio: ["ignore", "pipe", "pipe"],
  cwd: ROOT
});
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

async function main() {
  await waitForHealth();
  console.log(`Program Output server sync test: ${BASE}, room=${ROOM_ID}`);

  const received = [];
  const attemptedBindings = [];
  const subscriber = new ProgramServerSubscriber({
    roomId: ROOM_ID,
    endpoint: BASE,
    intervalMs: 60_000,
    onProgram: (program) => {
      received.push(program);
      for (const participant of program.participants || []) {
        if (participant.transportSourceId) {
          attemptedBindings.push(`${participant.participantId}:${participant.transportSourceId}`);
        }
      }
    }
  });

  await announceProgram(state({ scene: SceneId.HOLDING }));
  await subscriber.poll({ force: true });
  assertEqual(subscriber.pollCount, 1, "subscriber records first poll count");
  assertEqual(subscriber.lastHttpStatus, 200, "subscriber records last poll HTTP status");
  assertEqual(received.length, 1, "listener consumes initial server snapshot");
  assertEqual(received[0].revision, 1, "initial snapshot is server revision 1");
  assertEqual(received[0].scene, SceneId.HOLDING, "revision 1 is STARTING SOON");

  await announceProgram(state({ scene: SceneId.LIVE, live: true }));
  await subscriber.poll();
  assertEqual(received.length, 2, "same listener consumes LIVE update without reload");
  assertEqual(received[1].revision, 2, "LIVE update is server revision 2");
  assertEqual(received[1].scene, SceneId.LIVE, "revision 2 is LIVE");

  await announceProgram(state({
    scene: SceneId.LIVE,
    live: true,
    ticker: { enabled: true, text: "SERVER TICKER", speed: 12 }
  }));
  await subscriber.poll();
  assertEqual(received.length, 3, "same listener consumes ticker update without reload");
  assertEqual(received[2].revision, 3, "ticker update is server revision 3");
  assertEqual(received[2].ticker.text, "SERVER TICKER", "revision 3 carries ticker text");

  await announceProgram(state({
    scene: SceneId.LIVE,
    live: true,
    ticker: { enabled: true, text: "SERVER TICKER", speed: 12 },
    participants: [
      { participantId: "host", role: "host", displayName: "Ricardo", transportSourceId: `${ROOM_ID}h`, onProgram: true }
    ]
  }));
  await subscriber.poll();
  assertEqual(received.length, 4, "same listener consumes participant source update without reload");
  assertEqual(received[3].revision, 4, "participant source update is server revision 4");
  assertEqual(received[3].participants[0].transportSourceId, `${ROOM_ID}h`, "revision 4 carries Host transportSourceId");
  assert(attemptedBindings.includes(`host:${ROOM_ID}h`), "listener path attempts binding from authoritative participant source");

  const listenerSource = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  assert(listenerSource.includes("ProgramServerSubscriber"), "Program Output listener uses server subscriber");
  assert(listenerSource.includes("serverSync.start()"), "Program Output keeps polling server truth after load");
  assert(listenerSource.indexOf("void startOutputDebugMedia();") < listenerSource.indexOf("init().catch"), "debug overlay starts before listener init can fail");
  assert(listenerSource.includes("lastPollHttpStatus"), "debug overlay exposes poll HTTP status");

  const diagnosticsSource = readFileSync(join(ROOT, "js/media-diagnostics.js"), "utf8");
  assert(diagnosticsSource.includes("subscriber"), "debug overlay shows subscriber creation state");
  assert(diagnosticsSource.includes("polls "), "debug overlay shows poll count");

  const liveSessionSource = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(liveSessionSource.includes("_publishProgramControlWithoutPresence"), "Producer has a server publish fallback before Host presence exists");
  assert(liveSessionSource.includes('studioRequest("/api/presence/announce"'), "fallback uses the existing presence announce endpoint");

  subscriber.stop();
  console.log("\nAll Program Output server sync tests passed.");
}

main()
  .then(() => {
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\n${error.message}`);
    console.error("\n--- server output ---");
    console.error(serverOutput);
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
