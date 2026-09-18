#!/usr/bin/env node
// Proves js/program-composition.js's stable-ordering and layout-selection rules directly, without a
// browser or backend — pure functions in, plain assertions out. Covers exactly the roster-change sequence
// and participant-facing filtering this pass's report specified. Run: node scripts/program-composition-test.mjs

import { composeProgram, composeParticipantView, ProgramLayout, RemoteLayout } from "../js/program-composition.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function assertOrder(slots, expectedIds, message) {
  assertEqual(slots.map((p) => p.participantId).join(","), expectedIds.join(","), message);
}

function p(id, role, joinedAt, extra = {}) {
  return { participantId: id, role, connectionStatus: "connected", joinedAt, onProgram: true, ...extra };
}

console.log("Program composition — roster change sequence");

// [Host] -> layout1 (single)
{
  const host = p("host", "host", 0);
  const { layout, slots } = composeProgram([host]);
  assertEqual(layout, ProgramLayout.SINGLE, "[Host] -> single");
  assertOrder(slots, ["host"], "[Host] slot order");
}

// [Host, A] -> layout2 (duo)
{
  const host = p("host", "host", 0);
  const a = p("A", "guest", 1);
  const { layout, slots } = composeProgram([host, a]);
  assertEqual(layout, ProgramLayout.DUO, "[Host,A] -> duo");
  assertOrder(slots, ["host", "A"], "[Host,A] slot order");
}

// [Host, A, B] -> layout3 (trio)
{
  const host = p("host", "host", 0);
  const a = p("A", "guest", 1);
  const b = p("B", "guest", 2);
  const { layout, slots } = composeProgram([host, a, b]);
  assertEqual(layout, ProgramLayout.TRIO, "[Host,A,B] -> trio");
  assertOrder(slots, ["host", "A", "B"], "[Host,A,B] slot order");
}

// [Host, A, B, C] -> layout4 (quad)
{
  const host = p("host", "host", 0);
  const a = p("A", "guest", 1);
  const b = p("B", "guest", 2);
  const c = p("C", "guest", 3);
  const { layout, slots } = composeProgram([host, a, b, c]);
  assertEqual(layout, ProgramLayout.QUAD, "[Host,A,B,C] -> quad");
  assertOrder(slots, ["host", "A", "B", "C"], "[Host,A,B,C] slot order");
}

// kick B -> [Host, A, C] -> layout3 (trio), A and C keep their relative order (stable — B's removal
// doesn't reshuffle anyone who was already positioned)
{
  const host = p("host", "host", 0);
  const a = p("A", "guest", 1);
  const c = p("C", "guest", 3);
  const { layout, slots } = composeProgram([host, a, c]);
  assertEqual(layout, ProgramLayout.TRIO, "kick B -> [Host,A,C] -> trio");
  assertOrder(slots, ["host", "A", "C"], "kick B -> stable order preserved (A before C)");
}

// C leaves -> [Host, A] -> layout2 (duo)
{
  const host = p("host", "host", 0);
  const a = p("A", "guest", 1);
  const { layout, slots } = composeProgram([host, a]);
  assertEqual(layout, ProgramLayout.DUO, "C leaves -> [Host,A] -> duo");
  assertOrder(slots, ["host", "A"], "C leaves -> slot order");
}

// Rejoin C -> a genuinely NEW join (fresh joinedAt), so C goes to the END of the current order, not back
// to its old middle position — "do not jump participants around unnecessarily" applies to EXISTING
// participants staying put, not to treating a rejoin as if it never left.
{
  const host = p("host", "host", 0);
  const a = p("A", "guest", 1);
  const cRejoined = p("C", "guest", 100); // fresh joinedAt, well after A's
  const { layout, slots } = composeProgram([host, a, cRejoined]);
  assertEqual(layout, ProgramLayout.TRIO, "C rejoins -> [Host,A,C] -> trio");
  assertOrder(slots, ["host", "A", "C"], "C rejoins -> lands after A (stable ordering by real joinedAt)");
}

console.log("\nParticipant-facing filtering (composeParticipantView) — self is never a slot");
{
  const host = p("host", "host", 0);
  const a = p("A", "guest", 1);
  const b = p("B", "guest", 2);
  const c = p("C", "guest", 3);
  const all = [host, a, b, c];

  const hostView = composeParticipantView(all, "host");
  assertEqual(hostView.layout, RemoteLayout.THREE, "Host's view -> three-remote");
  assertOrder(hostView.others, ["A", "B", "C"], "Host sees A,B,C (not self)");

  const aView = composeParticipantView(all, "A");
  assertEqual(aView.layout, RemoteLayout.THREE, "A's view -> three-remote");
  assertOrder(aView.others, ["host", "B", "C"], "A sees Host,B,C (not self)");

  const bView = composeParticipantView(all, "B");
  assertOrder(bView.others, ["host", "A", "C"], "B sees Host,A,C (not self)");

  const cView = composeParticipantView(all, "C");
  assertOrder(cView.others, ["host", "A", "B"], "C sees Host,A,B (not self)");
}

console.log("\nEdge cases");
{
  const host = p("host", "host", 0);
  const solo = composeParticipantView([host], "host");
  assertEqual(solo.layout, RemoteLayout.WAITING, "Host alone -> waiting (no one else)");
  assertEqual(solo.others.length, 0, "Host alone -> zero others");

  const empty = composeProgram([]);
  assertEqual(empty.layout, null, "empty roster -> no layout");

  // onProgram: false is filtered out of composeProgram but NOT out of composeParticipantView — a
  // participant taken off Program is still someone another participant is talking to.
  const offProgram = p("D", "guest", 4, { onProgram: false });
  const programWithOffProgram = composeProgram([host, offProgram]);
  assertEqual(programWithOffProgram.layout, ProgramLayout.SINGLE, "onProgram:false excluded from Program");
  const participantViewIgnoresOnProgram = composeParticipantView([host, offProgram], "host");
  assertEqual(participantViewIgnoresOnProgram.others.length, 1, "onProgram:false still visible in Participant View");

  // disconnected participants excluded from both.
  const disconnected = p("E", "guest", 5, { connectionStatus: "disconnected" });
  const programWithDisconnected = composeProgram([host, disconnected]);
  assertEqual(programWithDisconnected.layout, ProgramLayout.SINGLE, "disconnected excluded from Program");
  const viewWithDisconnected = composeParticipantView([host, disconnected], "host");
  assertEqual(viewWithDisconnected.others.length, 0, "disconnected excluded from Participant View");
}

console.log("\nMixed joinedAt representations — a real bug this pass found and fixed");
{
  // js/guest.js builds its participant list from js/room-presence.js's roster, which carries the
  // backend's ISO timestamp STRING (scripts/toasty-auth-db.py's utc_now()), never the numeric
  // Date.now() js/participant-registry.js's createParticipant stamps. A bare numeric subtraction on two
  // ISO strings coerces to NaN, which Array.prototype.sort treats as "equal" — silently leaving the
  // Guest-side ordering unsorted/undefined instead of throwing anything. Host is always numeric 0
  // (participant-stage.js's synthetic host-as-participant entry), so this also proves the two
  // representations sort correctly against EACH OTHER, not just within their own type.
  const host = p("host", "host", 0); // numeric, as participant-stage.js constructs it
  const guestA = { participantId: "A", role: "guest", connectionStatus: "connected", onProgram: true, joinedAt: "2026-09-18T21:04:09+00:00" };
  const guestB = { participantId: "B", role: "guest", connectionStatus: "connected", onProgram: true, joinedAt: "2026-09-18T21:05:00+00:00" };
  const { slots } = composeProgram([host, guestB, guestA]); // deliberately passed out of order
  assertOrder(slots, ["host", "A", "B"], "ISO-string joinedAt sorts correctly (and against numeric Host)");
}

console.log("\nAll program-composition tests passed.");
