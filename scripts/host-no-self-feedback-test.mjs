#!/usr/bin/env node
// Regression test for the Host/Director-side half of the "severe self-echo/feedback" bug.
//
// Root cause: js/live-session.js's joinAsHost() used to hand this._hostPreviewStream (the Host's own
// LIVE microphone, the exact same physical mic VDO's mountDirectorFrame independently publishes into
// the room) to this.audioMixer.addParticipant({ stream }). audioMixer shares its bus with
// this.programAudio (new ProgramAudioMixer({ bus: this.programAudio, ... })), and
// ProgramAudioBus.ensure() unconditionally wires programGain -> monitorGain -> ctx.destination, i.e.
// the Host's own speakers. The AudioContext starts suspended (silent), but the first PLAY_AUDIO
// command anywhere in the session calls ProgramAudioBus.play(), which resumes it — from that moment
// the Host hears their own live voice played back through their own speakers, which their live mic
// (VDO's independent capture) picks up again and republishes: a genuine feedback loop, not just
// wasted CPU. See js/listener.js's syncProgramAudio and scripts/program-output-no-duplicate-audio-
// test.mjs — the IDENTICAL bug pattern, found and fixed there first, but never ported to
// live-session.js until this pass. This test closes that gap by scoping the same source-level
// assertion to joinAsHost specifically.
//
// This locks in: joinAsHost never passes a MediaStream into the audio mixer for the Host — VDO's own
// unmuted per-guest &view=<id> tiles and the Host's own genuine outbound publish are the only real
// audio paths; the Host is still tracked in the mixer (transportLimited bookkeeping) for diagnostics/
// state purposes only.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProgramAudioMixer } from "../js/program-audio-mixer.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function joinAsHostSource() {
  const src = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  const start = src.indexOf("joinAsHost({");
  assert(start !== -1, "joinAsHost exists");
  // The next top-level "  setHostState(" (two-space indented method) marks the end of this method body.
  const end = src.indexOf("\n  setHostState(", start);
  assert(end !== -1, "found the end of joinAsHost's body");
  return src.slice(start, end);
}

console.log("\njoinAsHost never feeds the Host's own live mic into the shared program audio graph");
{
  const fn = joinAsHostSource();
  assert(!/audioMixer\.addParticipant\(\{[^}]*stream:/s.test(fn), "audioMixer.addParticipant never passes a stream for the host (would feed back through the Host's own speakers)");
  assert(/audioMixer\.addParticipant\(\{[^}]*transportLimited:\s*true/s.test(fn), "the host is still tracked in the mixer, explicitly marked transport-limited, not silently dropped");
}

console.log("\nProgramAudioMixer.addParticipant with no stream never touches the audio bus (behavioral, same assertion as the Program Output regression test)");
{
  let connectCalls = 0;
  const bus = {
    connectStream: () => { connectCalls += 1; return { ok: true }; },
    disconnectStream() {},
    captureStream: () => ({ getAudioTracks: () => [{ kind: "audio" }] }),
    current: null
  };
  const mixer = new ProgramAudioMixer({ bus });
  mixer.addParticipant({ participantId: "host", label: "Host", transportLimited: true });
  assert(connectCalls === 0, "no MediaStream was connected into the bus for the host");
  const state = mixer.state();
  assert(state.sourceCount === 1 && state.connectedCount === 0, "the host is tracked for diagnostics but not connected to the audible/recordable graph");
}

console.log("\nALL PASSED — Director/Host page no longer feeds the Host's own mic back through their own speakers.");
