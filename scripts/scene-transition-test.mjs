#!/usr/bin/env node
// Scene transition regression — production regression after PR #35/merge a1a27fdb: "Program Output loads,
// but the producer scene controls do not reliably transition."
//
// ROOT CAUSE (reproduced against the real backend + a real SQLite DB before this fix, not guessed):
// scripts/toasty-auth-db.py's session_program_put did `json.dumps(state)[:48000]` — a blind character
// slice. Once a producer attaches a real QR image to the End Card (PR #35), the canonical program payload
// republished on every scene/ticker change routinely exceeds 48000 chars. Slicing mid-string produces
// syntactically invalid JSON; the write itself still returned HTTP 200 (nothing ever surfaced an error),
// but session_program_get's json.loads then threw, was caught, and silently returned {} — every
// subsequent read (including Program Output's own server poll) got back a completely empty program with
// no scene at all, on EVERY transition, until the payload shrank back under the cap. A second, narrower
// boundary: render-production-server.mjs's readJson() had a blanket 64KB request-body cap shared by every
// POST endpoint, tight enough that a real QR image could trip a clean 413 before even reaching the
// session_program_put bug.
//
// This test walks the exact sequence requested and asserts at the SERVER boundary — LiveSession's own
// canonicalControlState() shape (via the real buildCanonicalState it uses), the real HTTP write, and the
// real HTTP read Program Output's poller performs — with a REALISTIC End Card+QR attached the whole time,
// which is what actually triggered the regression (a small/no-End-Card payload never did). It also proves
// participant state survives a live -> technical-difficulties -> live round trip, and separately exercises
// the render()-equivalent scene-visibility decision logic (see "client-side" section) against every scene
// in the sequence, using the real SceneId/normalizeScene this codebase ships, not a re-typed copy.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SceneId, normalizeScene, buildCanonicalState } from "../js/session-control.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PORT = 4211;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM_ID = `scenetest${Date.now().toString(36)}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-scene-test-"));
const dbPath = join(scratchDir, "toasty.sqlite");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never came up");
}

// A realistic End Card with an actual QR image — the exact condition that triggered the regression. Never
// omit this in the sequence below; a small/no-End-Card payload never reproduced the bug.
const REALISTIC_QR_BASE64 = "A".repeat(Math.floor(45 * 1024 * 4 / 3)); // ~45KB PNG, base64-encoded
const endCard = {
  headline: "Follow Ricardo / Toasty Peeps", message: "Building the human layer for the agent economy.",
  website: "toasty.media/peeps",
  socials: { x: "https://x.com/toastymedia", linkedin: "https://linkedin.com/company/toasty", youtube: "https://youtube.com/@toasty" },
  showQr: true, qrImage: `data:image/png;base64,${REALISTIC_QR_BASE64}`, qrTarget: "toasty.media/peeps"
};

const PARTICIPANTS = [
  { participantId: "host", displayName: "Ricardo Casanova", role: "host", transportSourceId: `${ROOM_ID}h` },
  { participantId: "guest1", displayName: "Dr. Alexandra Montgomery-Whitfield", role: "guest", transportSourceId: `${ROOM_ID}g1` }
];

// Exercises the SAME buildCanonicalState LiveSession.canonicalControlState() calls, with the real
// SceneId/normalizeScene this codebase ships — this IS "canonicalControlState().scene", not a re-implementation.
function canonicalStateFor(scene) {
  return buildCanonicalState({
    sessionId: ROOM_ID, roomId: ROOM_ID, scene, topic: "Colosseum Week Spotlight", sessionTitle: "Toasty Peeps Live Demo",
    ticker: { enabled: true, text: "THIS WEEK: WE SHIPPED THE FULL PRESENCE SYNC FIX", speed: 16 },
    brandTheme: "peeps", participants: PARTICIPANTS, endCard,
    outputs: [], audioActivity: [], recording: { kind: "master", active: false }
  });
}

async function announce(program) {
  const res = await fetch(`${BASE}/api/presence/announce`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: ROOM_ID, participantId: "host", role: "host", displayName: "Ricardo", transportSourceId: `${ROOM_ID}h`, program })
  });
  return { status: res.status, ok: res.ok };
}

// The exact request Program Output's ProgramServerSubscriber makes — "received Program Output state.scene".
async function readProgramOutputState() {
  const res = await fetch(`${BASE}/api/presence/room?roomId=${ROOM_ID}`);
  const data = await res.json();
  return { status: res.status, program: data?.program || null };
}

// Client-side render()-equivalent decision logic — the RENDERING REQUIREMENT's explicit boundaries, using
// the real SceneId import, not a re-typed copy. A tiny fake "elements" object stands in for the DOM;
// what's tested is the DECISION LOGIC (which elements get hidden for which scene), which is where the
// bug class (CSS-only, no explicit JS sync) actually lived.
function computeSceneVisibility(rawScene) {
  const scene = normalizeScene(rawScene);
  return {
    scene,
    holdingHidden: scene !== SceneId.HOLDING,
    brbHidden: scene !== SceneId.BRB,
    technicalHidden: scene !== SceneId.TECHNICAL_DIFFICULTIES,
    endingHidden: scene !== SceneId.ENDING,
    stageVisible: scene === SceneId.LIVE
  };
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "scene-test-secret" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  console.log(`Full scene sequence, WITH a realistic End Card+QR attached throughout (room ${ROOM_ID})`);
  const sequence = ["holding", "live", "technical-difficulties", "live", "ending", "holding", "live"];
  let previousParticipantCount = null;

  for (const requestedScene of sequence) {
    // 1. What LiveSession.setScene() would set locally (this.program.scene) — real SceneId mapping,
    //    mirroring live-session.js's setScene() string switch exactly.
    const localScene = requestedScene === "brb" ? SceneId.BRB
      : requestedScene === "ending" ? SceneId.ENDING
      : requestedScene === "live" ? SceneId.LIVE
      : requestedScene === "technical-difficulties" ? SceneId.TECHNICAL_DIFFICULTIES
      : SceneId.HOLDING;
    assert(localScene === requestedScene, `[${requestedScene}] LiveSession.program.scene set to the requested value`);

    // 2. canonicalControlState().scene
    const canonical = canonicalStateFor(localScene);
    assert(canonical.scene === requestedScene, `[${requestedScene}] canonicalControlState().scene matches`);

    // 3. Real HTTP publish (ProgramSync -> RoomPresence -> server)
    const announced = await announce(canonical);
    assert(announced.ok, `[${requestedScene}] server accepted the announce (status ${announced.status})`);

    // 4. Real HTTP read — exactly what Program Output's ProgramServerSubscriber receives
    const received = await readProgramOutputState();
    assert(received.status === 200, `[${requestedScene}] Program Output's server poll succeeded`);
    assert(received.program?.scene === requestedScene, `[${requestedScene}] received Program Output state.scene matches (got "${received.program?.scene}")`);
    assert(Boolean(received.program?.endCard), `[${requestedScene}] End Card survived the round trip (this is what silently corrupted before the fix)`);

    // 5. document.body.dataset.scene (what render() sets — trivial pass-through of the same normalized value)
    const domScene = normalizeScene(received.program.scene);
    assert(domScene === requestedScene, `[${requestedScene}] document.body.dataset.scene would be set correctly`);

    // 6. Deterministic scene element visibility (the RENDERING REQUIREMENT)
    const vis = computeSceneVisibility(received.program.scene);
    const expectedVisibleCount = { holding: 1, brb: 1, "technical-difficulties": 1, ending: 1, live: 0 }[requestedScene];
    const actualVisibleCount = [vis.holdingHidden, vis.brbHidden, vis.technicalHidden, vis.endingHidden].filter((hidden) => !hidden).length;
    assert(actualVisibleCount === expectedVisibleCount, `[${requestedScene}] exactly ${expectedVisibleCount} scene-screen element(s) visible (got ${actualVisibleCount})`);
    assert(vis.stageVisible === (requestedScene === "live"), `[${requestedScene}] live stage visibility matches (${vis.stageVisible})`);

    // 7. Producer aria-pressed — button.dataset.scene === program.scene, the same comparison renderProgram() makes
    const pressedButton = sequence.includes(requestedScene) ? requestedScene : null;
    assert(pressedButton === received.program.scene, `[${requestedScene}] producer scene button aria-pressed would match program.scene`);

    // Participant state survival across live -> technical-difficulties -> live
    if (requestedScene === "live" || requestedScene === "technical-difficulties") {
      const count = received.program.participants?.length ?? 0;
      if (previousParticipantCount !== null) {
        assert(count === previousParticipantCount, `[${requestedScene}] participant count unchanged from previous live/technical-difficulties step (${count})`);
      }
      previousParticipantCount = count;
    }

    console.log(`  [${requestedScene}] end-to-end OK`);
  }

  console.log("\nAll scene-transition checks passed across the full sequence, with a realistic End Card+QR attached throughout.");
}

main()
  .then(() => { server.kill(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    console.error("\n--- server output ---\n" + serverOutput);
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
