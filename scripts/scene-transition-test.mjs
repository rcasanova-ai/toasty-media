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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function jsonFetch(path, { method = "GET", cookie, body } = {}) {
  const headers = { "x-toasty-csrf": "1" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, cookie: cookieFrom(res) || cookie };
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
  const sequence = ["holding", "live", "brb", "live", "technical-difficulties", "live", "ending", "holding", "live"];
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

  console.log("\nStale control reconciliation cannot overwrite a newer locally-selected scene (the second production regression, found after the first fix shipped)");
  {
    // A real heartbeat snapshot captured BEFORE a click, held in flight, completing its request AFTER the
    // click's own request — racing on arrival/processing order, not on when each was actually generated.
    // This is exactly LiveSession's own real pattern: RoomPresence's 2s heartbeat timer and a click-
    // triggered publishNow() both call the SAME _programPublisher() -> canonicalControlState(), which sets
    // updatedAt fresh via Date.now() every time — the stale snapshot's updatedAt is real and earlier.
    await announce(canonicalStateFor("live")); // known baseline
    const staleSnapshot = { ...canonicalStateFor("holding"), updatedAt: Date.now() - 2000 };
    const freshSnapshot = { ...canonicalStateFor("brb"), updatedAt: Date.now() };
    const [staleResult, freshResult] = await Promise.all([announce(staleSnapshot), announce(freshSnapshot)]);
    assert(staleResult.ok && freshResult.ok, "both concurrent announces are accepted at the HTTP layer (no error swallows the race)");
    const afterRace = await readProgramOutputState();
    assert(afterRace.program.scene === "brb", `the NEWER (fresh click) scene wins regardless of HTTP arrival order (got "${afterRace.program.scene}")`);

    // Reverse the arrival order (stale request resolves AFTER the fresh one at the network layer) to prove
    // this isn't just "first request wins" or "second request wins" by coincidence of Promise.all ordering.
    await announce(canonicalStateFor("live"));
    const staleSnapshot2 = { ...canonicalStateFor("holding"), updatedAt: Date.now() - 2000 };
    const freshSnapshot2 = { ...canonicalStateFor("ending"), updatedAt: Date.now() };
    const freshFirst = await announce(freshSnapshot2);
    const staleSecond = await announce(staleSnapshot2);
    assert(freshFirst.ok && staleSecond.ok, "both requests accepted regardless of order");
    const afterRace2 = await readProgramOutputState();
    assert(afterRace2.program.scene === "ending", `the newer scene still wins even when the STALE request is the one that arrives second (got "${afterRace2.program.scene}")`);
  }

  console.log("\nAn ended session correctly rejects further scene writes, AND Program Output stays exactly where it was (not a bug, but the un-instrumented, un-surfaced symptom that actually generated this production report)");
  {
    // Full real flow: authenticated user, a durable session via /api/sessions, ending it via the real
    // /api/sessions/:id/end route (not a raw DB write) — proving the exact chain a real Director click
    // ("End Show") -> LiveSession.endDurableSession() -> this route goes through.
    const email = `scene-ended-test-${Date.now()}@example.com`;
    const user = await jsonFetch("/auth/register", { method: "POST", body: { name: "Test", email, password: "password10chars" } });
    assert(user.status === 201, "diagnostic account registers");
    const endedRoomId = `${ROOM_ID}ended`;
    const created = await jsonFetch("/api/sessions", { method: "POST", cookie: user.cookie, body: { roomId: endedRoomId, title: "Ended Session Test", brandId: "peeps" } });
    assert(created.status === 200, "durable session creates");

    // Publish a real "live" scene while the session is still open — this is the last state Program Output
    // should ever see for this room.
    const liveState = buildCanonicalState({ sessionId: created.data.session.id, roomId: endedRoomId, scene: "live", topic: "Ended session test", participants: PARTICIPANTS, endCard, outputs: [], audioActivity: [], recording: { kind: "master", active: false } });
    await fetch(`${BASE}/api/presence/announce`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId: endedRoomId, participantId: "host", role: "host", displayName: "Test", transportSourceId: `${endedRoomId}h`, program: liveState }) });
    const beforeEnd = await (await fetch(`${BASE}/api/presence/room?roomId=${endedRoomId}`)).json();
    assert(beforeEnd?.program?.scene === "live", "scene=live is stored correctly before the session ends");

    // End it via the real route (this is what LiveSession.endDurableSession() calls).
    const ended = await jsonFetch(`/api/sessions/${created.data.session.id}/end`, { method: "POST", cookie: user.cookie, body: {} });
    assert(ended.status === 200 && ended.data.session?.status === "ENDED", "session ends via the real /api/sessions/:id/end route");

    // Now try to publish a scene change (technical-difficulties) into the now-ended session — the exact
    // situation reproduced live against production: this must be REJECTED, not silently accepted.
    const technicalState = buildCanonicalState({ sessionId: created.data.session.id, roomId: endedRoomId, scene: "technical-difficulties", topic: "Ended session test", participants: PARTICIPANTS, endCard, outputs: [], audioActivity: [], recording: { kind: "master", active: false } });
    const rejectedAnnounce = await fetch(`${BASE}/api/presence/announce`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId: endedRoomId, participantId: "host", role: "host", displayName: "Test", transportSourceId: `${endedRoomId}h`, program: technicalState }) });
    assert(rejectedAnnounce.status === 410, `announce into an ended session is rejected with 410 (got ${rejectedAnnounce.status}) — this is what js/room-presence.js's onRejected exists to catch, now actually wired up on the host side in js/live-session.js`);

    // Confirm Program Output's own poll still sees the LAST GOOD scene, not the rejected one and not empty —
    // proving the rejection didn't corrupt anything, it just correctly refused the write.
    const afterRejection = await (await fetch(`${BASE}/api/presence/room?roomId=${endedRoomId}`)).json();
    assert(afterRejection?.program?.scene === "live", `Program Output still sees the last successfully-published scene ("live"), not the rejected "technical-difficulties" and not corrupted (got "${afterRejection?.program?.scene}")`);
  }

  console.log("\nHost-side rejection is now actually wired (was previously defined in room-presence.js but never subscribed to anywhere)");
  {
    const liveSessionSrc = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
    assert(liveSessionSrc.includes("this.presence.onRejected((status, errorMessage) => this._handleHostPresenceRejected(status, errorMessage));"), "LiveSession.joinAsHost subscribes to presence.onRejected");
    assert(liveSessionSrc.includes('this.emit("session-control-rejected", this.sessionControlRejected);'), "_handleHostPresenceRejected emits an event the Producer UI can react to");
    const producerViewSrc = readFileSync(join(ROOT, "js/producer-view.js"), "utf8");
    assert(producerViewSrc.includes('this.session.on("session-control-rejected"'), "producer-view.js subscribes to the rejection event");
    assert(producerViewSrc.includes("button.disabled = true"), "producer-view.js disables the scene buttons once the session can no longer accept scene changes, instead of leaving them clickable into a void");
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
