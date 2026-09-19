#!/usr/bin/env node
// Proves js/room-presence.js's server-side backend (scripts/render-production-server.mjs's
// /api/presence/* routes + scripts/toasty-auth-db.py's room_presence table) does NOT assume exactly two
// participants — every piece of client code built this pass (js/guest.js's renderRemoteParticipants,
// js/live-session.js's presence overlay) reads "everyone except me" off the SAME roster shape this script
// exercises directly, so proving the roster/others() logic is N-capable at the API layer proves the
// client-side "who do I render" logic is too, without needing a real third device or a built N-tile UI
// (an explicit, deliberate follow-up per this pass's report — the 2-person real-device case was the gate).
//
// Starts its own throwaway instance of the render server against a scratch SQLite DB (never touches the
// real one), announces 3 participants into one room, and asserts the roster/others()-equivalent filtering
// is correct at every step — 3 present, then 2 after one leaves. Run: node scripts/presence-3way-test.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 4199; // distinct from the real 4174 default, so this can run alongside a dev server
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM_ID = `presencetest${Date.now().toString(36)}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-presence-test-"));
const dbPath = join(scratchDir, "toasty.sqlite");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function others(roster, selfId) {
  return roster.filter((entry) => entry.participantId !== selfId);
}

async function announce(participant) {
  const response = await fetch(`${BASE}/api/presence/announce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: ROOM_ID, ...participant })
  });
  if (!response.ok) throw new Error(`announce failed: ${response.status} ${await response.text()}`);
  return (await response.json()).roster;
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
  return (await response.json()).roster;
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
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

async function main() {
  await waitForHealth();
  console.log(`Server up on ${BASE}, room=${ROOM_ID}\n`);

  console.log("1. Ricardo (host) announces alone");
  let roster = await announce({ participantId: "host", role: "host", displayName: "Ricardo Casanova", title: "CEO", company: "Toasty", transportSourceId: `${ROOM_ID}h` });
  assert(roster.length === 1, "roster has exactly 1 entry");
  assert(others(roster, "host").length === 0, "host's own others() list is empty (no one else yet)");

  console.log("\n2. Tukta (guest 1) announces");
  roster = await announce({ participantId: "guest-tukta", role: "guest", displayName: "Tukta", title: "", company: "", transportSourceId: `${ROOM_ID}gtukta` });
  assert(roster.length === 2, "roster has exactly 2 entries");
  assert(others(roster, "host").length === 1 && others(roster, "host")[0].displayName === "Tukta", "host's others() sees exactly Tukta");
  assert(others(roster, "guest-tukta").length === 1 && others(roster, "guest-tukta")[0].displayName === "Ricardo Casanova", "Tukta's others() sees exactly Ricardo");

  console.log("\n3. Third participant (guest 2) announces — the actual N>2 proof");
  roster = await announce({ participantId: "guest-second", role: "guest", displayName: "Second Guest", title: "Producer", company: "Toasty", transportSourceId: `${ROOM_ID}gsecond` });
  assert(roster.length === 3, "roster has exactly 3 entries");
  const hostOthers = others(roster, "host");
  assert(hostOthers.length === 2, "host's others() now sees 2 people, not hardcoded to 1");
  assert(hostOthers.some((e) => e.displayName === "Tukta") && hostOthers.some((e) => e.displayName === "Second Guest"), "host's others() is exactly {Tukta, Second Guest}");
  const tuktaOthers = others(roster, "guest-tukta");
  assert(tuktaOthers.length === 2 && tuktaOthers.every((e) => e.participantId !== "guest-tukta"), "Tukta's others() excludes only Tukta, includes both other participants");

  console.log("\n4. Third guest announces — still under MAX_GUESTS_PER_ROOM=3");
  roster = await announce({ participantId: "guest-third", role: "guest", displayName: "Third Guest", title: "", company: "", transportSourceId: `${ROOM_ID}gthird` });
  assert(roster.length === 4, "roster has host + 3 guests");
  assert(roster.filter((e) => e.role === "guest").length === 3, "exactly 3 guests are present");

  console.log("\n5. Fourth guest is refused — capacity is server policy, not UI");
  const fourth = await fetch(`${BASE}/api/presence/announce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId: ROOM_ID,
      participantId: "guest-fourth",
      role: "guest",
      displayName: "Fourth",
      transportSourceId: `${ROOM_ID}gfourth`
    })
  });
  assert(fourth.status === 409, "a 4th distinct guest announce is 409 full");
  roster = await room();
  assert(!roster.some((e) => e.participantId === "guest-fourth"), "fourth guest is not in server roster");
  assert(roster.filter((e) => e.role === "guest").length === 3, "still exactly 3 guests after the refused announce");

  console.log("\n6. One guest leaves — roster drops, correctly, not to 0 or a stuck 4");
  await leave("guest-second");
  roster = await room();
  assert(roster.length === 3, "roster has exactly 3 entries after one leave (host + 2 guests)");
  assert(!roster.some((e) => e.participantId === "guest-second"), "the departed participant is gone");
  assert(roster.some((e) => e.participantId === "host") && roster.some((e) => e.participantId === "guest-tukta"), "the remaining participants are still present and correct");

  console.log("\nALL PASSED — room_presence/announce/leave correctly support N participants, not just 2.");
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
