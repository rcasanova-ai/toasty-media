#!/usr/bin/env node
// Canonical live-session control plane — Host, Guest, Producer, Program Output against a scratch
// presence server. BroadcastChannel is not the authority. Mute/scene/output heartbeat/audio ACK
// must round-trip through /api/presence/*.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SceneId,
  OutputConnection,
  SourceHealth,
  MediaCommandType,
  buildCanonicalState,
  createMediaCommand,
  applyMediaAckToSeat,
  summarizeOutputForProducer,
  recordingBlockReasonFromOutput,
  commandTargetsParticipant,
  OUTPUT_STALE_MS
} from "../js/session-control.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4201;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM_ID = `controltest${Date.now().toString(36)}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-control-test-"));
const dbPath = join(scratchDir, "toasty.sqlite");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function announce(participant) {
  const response = await fetch(`${BASE}/api/presence/announce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: ROOM_ID, ...participant })
  });
  if (!response.ok) throw new Error(`announce failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function leave(participantId) {
  const response = await fetch(`${BASE}/api/presence/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: ROOM_ID, participantId })
  });
  if (!response.ok) throw new Error(`leave failed: ${response.status}`);
}

async function room() {
  const response = await fetch(`${BASE}/api/presence/room?roomId=${ROOM_ID}`);
  if (!response.ok) throw new Error(`room read failed: ${response.status}`);
  return response.json();
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

const server = spawn("node", ["scripts/render-production-server.mjs"], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath },
  stdio: ["ignore", "pipe", "pipe"],
  cwd: ROOT
});
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

async function main() {
  console.log("Unit — canonical snapshot, pending media, output readiness");
  {
    const snapshot = buildCanonicalState({
      sessionId: "ls_test",
      roomId: ROOM_ID,
      scene: SceneId.HOLDING,
      participants: [
        { participantId: "host", role: "host", displayName: "Ricardo", transportSourceId: `${ROOM_ID}h`, micEnabled: true, cameraEnabled: true },
        { participantId: "guest-tukta", role: "guest", displayName: "Tukta", transportSourceId: `${ROOM_ID}gtukta`, micEnabled: true, cameraEnabled: true }
      ]
    });
    assertEqual(snapshot.scene, SceneId.HOLDING, "default scene is holding");
    assertEqual(snapshot.participants.length, 2, "canonical participants are Host + Guest");
    assertEqual(snapshot.participants[1].micEnabled, true, "guest mic is actual, not desired");

    const mute = createMediaCommand({ targetParticipantId: "guest-tukta", type: MediaCommandType.MUTE_MIC });
    assert(mute.id && mute.type === MediaCommandType.MUTE_MIC, "producer mute is a command, not a local icon toggle");
    assert(commandTargetsParticipant(mute, { participantId: "guest-tukta", transportSourceId: `${ROOM_ID}gtukta` }), "command targets the guest presence id");

    let seat = { id: `${ROOM_ID}gtukta`, mic: true, micPending: { wantEnabled: false } };
    seat = applyMediaAckToSeat(seat, { participantId: "guest-tukta", micEnabled: true });
    assertEqual(seat.mic, true, "stale heartbeat does not clear a pending mute");
    assert(seat.micPending, "pending stays until ACK matches desired state");
    seat = applyMediaAckToSeat(seat, { participantId: "guest-tukta", micEnabled: false });
    assertEqual(seat.mic, false, "ACK of actual mute updates Producer");
    assertEqual(seat.micPending, null, "pending clears only after matching ACK");

    const disconnected = summarizeOutputForProducer([]);
    assertEqual(disconnected.connection, OutputConnection.DISCONNECTED, "no output heartbeat is disconnected");
    assertEqual(disconnected.connected, false, "opening a window is not connected");
    const connecting = summarizeOutputForProducer([{
      outputId: "output-1",
      connection: OutputConnection.CONNECTING,
      updatedAt: Date.now(),
      scene: SceneId.HOLDING
    }]);
    assertEqual(connecting.connection, OutputConnection.CONNECTING, "first output announce is connecting");
    const liveOutput = summarizeOutputForProducer([{
      outputId: "output-1",
      connection: OutputConnection.CONNECTED,
      updatedAt: Date.now(),
      scene: SceneId.LIVE,
      expectedFeeds: 2,
      boundFeeds: 2,
      playingFeeds: 2,
      emptyFeeds: 0,
      audioEnabled: true
    }]);
    assertEqual(liveOutput.connection, OutputConnection.CONNECTED, "heartbeat makes output connected");
    assertEqual(liveOutput.videoReady, true, "VIDEO READY requires PLAYING feeds, not iframe existence");
    assertEqual(liveOutput.readyToRecord, true, "ready to record requires connected + live + playing + audio");
    const iframeOnly = summarizeOutputForProducer([{
      outputId: "output-1",
      connection: OutputConnection.CONNECTED,
      updatedAt: Date.now(),
      scene: SceneId.LIVE,
      expectedFeeds: 2,
      boundFeeds: 2,
      playingFeeds: 0,
      emptyFeeds: 0,
      audioEnabled: true
    }]);
    assertEqual(iframeOnly.videoReady, false, "bound iframes without PLAYING are not VIDEO READY");
    assert(recordingBlockReasonFromOutput(iframeOnly), "not ready to record when video is not playing");
    const stale = summarizeOutputForProducer([{
      outputId: "output-1",
      connection: OutputConnection.CONNECTED,
      updatedAt: Date.now() - OUTPUT_STALE_MS - 1,
      scene: SceneId.LIVE,
      expectedFeeds: 2,
      playingFeeds: 2,
      audioEnabled: true
    }]);
    assertEqual(stale.connection, OutputConnection.DISCONNECTED, "missed heartbeat disconnects Program Output");
    assertEqual(stale.readyToRecord, false, "stale output is not ready to record");
  }

  await waitForHealth();
  console.log(`\nServer up on ${BASE}, room=${ROOM_ID}\n`);

  console.log("1. Host joins and publishes STARTING SOON");
  let host = await announce({
    participantId: "host",
    role: "host",
    displayName: "Ricardo",
    title: "CEO",
    company: "Toasty",
    transportSourceId: `${ROOM_ID}h`,
    micEnabled: true,
    cameraEnabled: true,
    program: buildCanonicalState({
      sessionId: ROOM_ID,
      roomId: ROOM_ID,
      scene: SceneId.HOLDING,
      participants: [
        { participantId: "host", role: "host", displayName: "Ricardo", transportSourceId: `${ROOM_ID}h` }
      ]
    })
  });
  assertEqual(host.roster.length, 1, "host is on the participant roster");
  assertEqual(host.program.scene, SceneId.HOLDING, "canonical scene is STARTING SOON");
  assertEqual(host.outputs.length, 0, "Program Output is not connected because a window was not heartbeating");

  console.log("\n2. Guest joins — 2 participants canonical");
  let guest = await announce({
    participantId: "guest-tukta",
    role: "guest",
    displayName: "Tukta",
    transportSourceId: `${ROOM_ID}gtukta`,
    micEnabled: true,
    cameraEnabled: true
  });
  assertEqual(guest.roster.length, 2, "roster has Host + Guest");
  assert(guest.roster.every((entry) => entry.role !== "output"), "output is not a participant seat");

  console.log("\n3. Program Output connects and heartbeats");
  let output = await announce({
    participantId: "output-1",
    role: "output",
    displayName: "Program Output",
    outputStatus: {
      outputId: "output-1",
      sessionId: ROOM_ID,
      connection: OutputConnection.CONNECTED,
      connectedAt: Date.now(),
      scene: SceneId.HOLDING,
      expectedFeeds: 0,
      boundFeeds: 0,
      playingFeeds: 0,
      emptyFeeds: 0,
      audioEnabled: false
    }
  });
  assertEqual(output.roster.length, 2, "output announce still returns 2 participants");
  assertEqual(output.outputs.length, 1, "output is listed separately from participants");
  assertEqual(output.outputs[0].outputId, "output-1", "heartbeat carries outputId");
  host = await announce({
    participantId: "host",
    role: "host",
    displayName: "Ricardo",
    transportSourceId: `${ROOM_ID}h`,
    micEnabled: true,
    cameraEnabled: true,
    program: buildCanonicalState({
      sessionId: ROOM_ID,
      roomId: ROOM_ID,
      scene: SceneId.HOLDING,
      participants: [
        { participantId: "host", role: "host", displayName: "Ricardo", transportSourceId: `${ROOM_ID}h` },
        { participantId: "guest-tukta", role: "guest", displayName: "Tukta", transportSourceId: `${ROOM_ID}gtukta`, micEnabled: true }
      ]
    })
  });
  const producerView = summarizeOutputForProducer(host.outputs);
  assertEqual(producerView.connection, OutputConnection.CONNECTED, "Producer sees Program Output CONNECTED");
  assertEqual(host.roster.length, 2, "Producer sees 2 canonical participants");

  console.log("\n4. Guest mute → Producer state changes");
  guest = await announce({
    participantId: "guest-tukta",
    role: "guest",
    displayName: "Tukta",
    transportSourceId: `${ROOM_ID}gtukta`,
    micEnabled: false,
    cameraEnabled: true
  });
  const mutedGuest = guest.roster.find((entry) => entry.participantId === "guest-tukta");
  assertEqual(mutedGuest.micEnabled, false, "canonical micEnabled is false after guest mute");

  console.log("\n5. Guest unmute → Producer state changes");
  guest = await announce({
    participantId: "guest-tukta",
    role: "guest",
    displayName: "Tukta",
    transportSourceId: `${ROOM_ID}gtukta`,
    micEnabled: true,
    cameraEnabled: true
  });
  assertEqual(guest.roster.find((entry) => entry.participantId === "guest-tukta").micEnabled, true, "canonical micEnabled is true after guest unmute");

  console.log("\n6. Producer mute command → Guest executes → ACK → Producer state");
  const muteCommand = createMediaCommand({ targetParticipantId: "guest-tukta", type: MediaCommandType.MUTE_MIC });
  host = await announce({
    participantId: "host",
    role: "host",
    displayName: "Ricardo",
    transportSourceId: `${ROOM_ID}h`,
    micEnabled: true,
    cameraEnabled: true,
    commands: [muteCommand],
    program: host.program
  });
  guest = await announce({
    participantId: "guest-tukta",
    role: "guest",
    displayName: "Tukta",
    transportSourceId: `${ROOM_ID}gtukta`,
    micEnabled: true,
    cameraEnabled: true
  });
  assert(guest.commands.some((command) => command.id === muteCommand.id && command.type === MediaCommandType.MUTE_MIC), "guest receives mute-mic command");
  guest = await announce({
    participantId: "guest-tukta",
    role: "guest",
    displayName: "Tukta",
    transportSourceId: `${ROOM_ID}gtukta`,
    micEnabled: false,
    cameraEnabled: true,
    ackCommandIds: [muteCommand.id]
  });
  host = await announce({
    participantId: "host",
    role: "host",
    displayName: "Ricardo",
    transportSourceId: `${ROOM_ID}h`,
    micEnabled: true,
    cameraEnabled: true
  });
  const acked = applyMediaAckToSeat(
    { id: `${ROOM_ID}gtukta`, mic: true, micPending: { wantEnabled: false } },
    host.roster.find((entry) => entry.participantId === "guest-tukta")
  );
  assertEqual(acked.mic, false, "Producer reflects actual muted ACK, not the click");
  assertEqual(acked.micPending, null, "pending mute clears after ACK");
  assertEqual(guest.commands.length, 0, "acked command is no longer pending");

  console.log("\n7. STARTING SOON → LIVE → BRB → LIVE");
  for (const scene of [SceneId.LIVE, SceneId.BRB, SceneId.LIVE]) {
    host = await announce({
      participantId: "host",
      role: "host",
      displayName: "Ricardo",
      transportSourceId: `${ROOM_ID}h`,
      program: buildCanonicalState({
        sessionId: ROOM_ID,
        roomId: ROOM_ID,
        scene,
        participants: [
          { participantId: "host", role: "host", displayName: "Ricardo", transportSourceId: `${ROOM_ID}h` },
          { participantId: "guest-tukta", role: "guest", displayName: "Tukta", transportSourceId: `${ROOM_ID}gtukta`, micEnabled: false }
        ]
      })
    });
    output = await announce({
      participantId: "output-1",
      role: "output",
      displayName: "Program Output",
      outputStatus: {
        outputId: "output-1",
        connection: OutputConnection.CONNECTED,
        updatedAt: Date.now(),
        scene: host.program.scene,
        expectedFeeds: scene === SceneId.LIVE ? 2 : 0,
        boundFeeds: scene === SceneId.LIVE ? 2 : 0,
        playingFeeds: scene === SceneId.LIVE ? 2 : 0,
        emptyFeeds: 0,
        audioEnabled: false,
        sourceHealth: scene === SceneId.LIVE
          ? [
            { participantId: "host", health: SourceHealth.PLAYING, transportSourceId: `${ROOM_ID}h` },
            { participantId: "guest-tukta", health: SourceHealth.PLAYING, transportSourceId: `${ROOM_ID}gtukta` }
          ]
          : []
      }
    });
    assertEqual(output.program.scene, scene, `Program Output hydrates ${scene} from canonical program`);
    assertEqual(output.outputs[0].scene, scene, `output heartbeat scene is ${scene}`);
  }
  const liveParticipants = output.program.participants.map((item) => item.transportSourceId);
  assert(liveParticipants.includes(`${ROOM_ID}h`) && liveParticipants.includes(`${ROOM_ID}gtukta`), "Program Output receives Host + Guest source identities");

  console.log("\n8. Audio enable → ACK → Producer reflects ACK");
  output = await announce({
    participantId: "output-1",
    role: "output",
    displayName: "Program Output",
    outputStatus: {
      outputId: "output-1",
      connection: OutputConnection.CONNECTED,
      updatedAt: Date.now(),
      scene: SceneId.LIVE,
      expectedFeeds: 2,
      boundFeeds: 2,
      playingFeeds: 2,
      emptyFeeds: 0,
      audioEnabled: true,
      audioError: null
    }
  });
  host = await announce({
    participantId: "host",
    role: "host",
    displayName: "Ricardo",
    transportSourceId: `${ROOM_ID}h`
  });
  const audioAck = summarizeOutputForProducer(host.outputs);
  assertEqual(audioAck.audioReady, true, "Producer Audio enabled follows Program Output ACK");
  assertEqual(audioAck.readyToRecord, true, "ready to record after connected + live + playing + audio");
  assertEqual(recordingBlockReasonFromOutput(audioAck), null, "no recording block when acknowledged truth is ready");

  console.log("\n9. Disconnect Program Output → Producer shows disconnected");
  await leave("output-1");
  host = await announce({
    participantId: "host",
    role: "host",
    displayName: "Ricardo",
    transportSourceId: `${ROOM_ID}h`
  });
  const gone = summarizeOutputForProducer(host.outputs);
  assertEqual(gone.connection, OutputConnection.DISCONNECTED, "Producer shows disconnected after output leave");
  assert(recordingBlockReasonFromOutput(gone), "not ready to record while disconnected");

  console.log("\n10. Reconnect hydrates scene and participants");
  output = await announce({
    participantId: "output-1",
    role: "output",
    displayName: "Program Output",
    outputStatus: {
      outputId: "output-1",
      connection: OutputConnection.CONNECTED,
      updatedAt: Date.now(),
      scene: SceneId.LIVE,
      expectedFeeds: 2,
      playingFeeds: 2,
      audioEnabled: true
    }
  });
  assertEqual(output.program.scene, SceneId.LIVE, "reconnect hydrates LIVE scene");
  assertEqual(output.program.participants.length, 2, "reconnect hydrates Host + Guest identities");
  const listed = await room();
  assertEqual(listed.outputs.length, 1, "room GET exposes the reconnected output");
  assertEqual(listed.program.scene, SceneId.LIVE, "room GET hydrates canonical program");

  console.log("\nFrozen source contracts still hold");
  {
    const guestJs = readFileSync(join(ROOT, "js/guest.js"), "utf8");
    assert(guestJs.includes("stopPreview();"), "guest Join still releases native camera");
    assert(guestJs.includes("MediaCommandType.MUTE_MIC"), "guest executes mute-mic from canonical commands");
    const engine = readFileSync(join(ROOT, "js/video-engine.js"), "utf8");
    assert(engine.includes("view:true"), "guest publisher still uses bare &view");
    const liveSession = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
    assert(!/mountRoomFrame\(this\._containers\.roomPreview/.test(liveSession), "setLayout still does not remount scene=0");
    assert(liveSession.includes("createMediaCommand"), "Producer mute enqueues a command");
    const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
    assert(listener.includes('role: "output"'), "Program Output joins presence as output");
    assert(listener.includes("syncProgramRenderer"), "listener still uses Program Renderer");
    assert(listener.includes("Program audio failed"), "failed audio handshake stays visible");
    assert(listener.includes("await programAudio.resume()"), "audio handshake resumes AudioContext");
  }

  console.log("\nALL PASSED — Host/Guest/Producer/Program Output share one canonical control plane.");
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
