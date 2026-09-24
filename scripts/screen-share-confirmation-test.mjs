#!/usr/bin/env node
// Regression test for the demo-readiness screen-share bug: a screen share used to read as "active"
// (and therefore get composed into Program Output) the instant a transportSourceId was generated,
// BEFORE VDO.Ninja ever confirmed the publish actually connected. Cancelling the OS display picker, or
// a publish that silently never connects, left the UI/Program stuck showing a "live" screen share.
//
// This proves the fix directly against the pure functions involved (js/screen-share-source.js,
// js/program-composition.js) without needing a browser or a real VDO.Ninja connection — the same shape
// as scripts/program-composition-test.mjs.
// Run: node scripts/screen-share-confirmation-test.mjs

import { createScreenShareSource, screenShareFromPresence, isScreenShareAvailable, ScreenShareState } from "../js/screen-share-source.js";
import { composeProgram, compositionOptionsFromState, ProgramLayout } from "../js/program-composition.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function p(id, role, joinedAt) {
  return { participantId: id, role, connectionStatus: "connected", joinedAt, onProgram: true };
}

console.log("A pending share (transportSourceId exists, not yet confirmed) must NOT read as live");
{
  const pending = createScreenShareSource({
    ownerParticipantId: "host",
    transportSourceId: "room123s",
    state: ScreenShareState.BINDING,
    active: false
  });
  assert(pending.active === false, "pending share is not active");
  assert(pending.state === ScreenShareState.BINDING, "pending share keeps its BINDING state");
  assert(!isScreenShareAvailable(pending), "isScreenShareAvailable is false while pending");

  const host = p("host", "host", 0);
  const composed = composeProgram([host], compositionOptionsFromState({ screenShare: pending }));
  assert(composed.screen === null, "composeProgram does not add a screen source for a pending share");
  assert(composed.screenShareActive === false, "screenShareActive is false for a pending share");
  assert(composed.layout !== ProgramLayout.SCREEN_ONLY, "layout does not switch to a screen layout while pending");
}

console.log("\nA confirmed share (active:true after push-connection:true) reads as live");
{
  const confirmed = createScreenShareSource({
    ownerParticipantId: "host",
    transportSourceId: "room123s",
    state: ScreenShareState.BOUND,
    active: true
  });
  assert(confirmed.active === true, "confirmed share is active");
  assert(isScreenShareAvailable(confirmed), "isScreenShareAvailable is true once confirmed");

  const host = p("host", "host", 0);
  const composed = composeProgram([host], compositionOptionsFromState({ screenShare: confirmed }));
  assert(composed.screen !== null, "composeProgram adds a screen source once confirmed");
  assert(composed.layout === ProgramLayout.SCREEN_SPEAKER, "layout switches to a screen layout (default SCREEN_SPEAKER) once confirmed");
}

console.log("\nA failed share (timeout / cancelled picker) is distinguishable from a merely-inactive one");
{
  const failed = createScreenShareSource({ ownerParticipantId: "host", state: ScreenShareState.FAILED, active: false, reason: "timed out" });
  assert(failed.state === ScreenShareState.FAILED, "FAILED state survives construction while inactive — this is the exact bug: it used to get stomped to INACTIVE");
  assert(failed.active === false, "a failed share is not active");
  assert(failed.reason === "timed out", "failure reason is preserved for the UI to surface");
}

console.log("\nPresence only reports a share as active once the owner confirmed it");
{
  const pendingEntry = { participantId: "host", displayName: "Ricardo", screenShare: { active: false, participantId: "host", transportSourceId: "room123s", state: "binding" } };
  const fromPending = screenShareFromPresence(pendingEntry);
  assert(fromPending.active === false, "a peer sees a pending share as not active");

  const confirmedEntry = { participantId: "host", displayName: "Ricardo", screenShare: { active: true, participantId: "host", transportSourceId: "room123s", state: "bound" } };
  const fromConfirmed = screenShareFromPresence(confirmedEntry);
  assert(fromConfirmed.active === true, "a peer sees a confirmed share as active");
  assert(fromConfirmed.state === "bound", "a peer sees the real confirmed state, not a hardcoded EXPECTED");
}

console.log("\nCamera/screen stay separate publishers regardless of share state (do-not-regress)");
{
  // createScreenShareSource never touches anything camera-related — it only ever describes the SECOND,
  // independent screen-push transport. This is a cheap structural guard alongside
  // scripts/broadcast-visual-production-test.mjs's fuller "camera must not use VDO screenshare replace" suite.
  const share = createScreenShareSource({ ownerParticipantId: "host", transportSourceId: "room123s", state: ScreenShareState.BOUND, active: true });
  assert(share.ownerParticipantId === "host", "share still carries its owner");
  assert(share.transportSourceId !== "host", "screen transport id is never the camera's own id");
}

console.log("\nAll screen-share confirmation tests passed.");
