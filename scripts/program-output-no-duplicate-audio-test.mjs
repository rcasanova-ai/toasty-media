#!/usr/bin/env node
// Regression test for the "severe echo / doubled audio" master-recording bug.
//
// Root cause: js/listener.js's syncProgramAudio() used to hand ownedStreamFor()'s native
// MediaStream (the SAME physical host mic already published into the VDO room) to
// programMixer.addParticipant({ stream }), which connectStream()s it into ProgramAudioBus's
// ctx.destination. But video-engine.js's mountProgramFrame (Program Output's scene=0 VDO
// iframe) is deliberately unmuted and already autoplays every participant's voice into that
// same tab destination. Wiring the owned stream's audio in too meant every voice reached the
// tab (and therefore any tab-audio-share recording) twice through two different-latency paths.
//
// This locks in: (1) syncProgramAudio never passes a MediaStream into the audio mixer for any
// participant — VDO's own unmuted autoplay is the sole audio path; (2) ownedStreamFor stays
// wired for video-tile rendering only; (3) ProgramAudioMixer itself still supports connectStream
// for legitimate non-VDO sources (soundboard/catalogue), so the mixer plumbing is untouched.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProgramAudioMixer } from "../js/program-audio-mixer.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function syncProgramAudioSource() {
  const src = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  const start = src.indexOf("function syncProgramAudio(");
  assert(start !== -1, "syncProgramAudio exists");
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

console.log("\nsyncProgramAudio never re-feeds a participant MediaStream into the program audio graph");
{
  const fn = syncProgramAudioSource();
  assert(!/addParticipant\(\{[^}]*stream:/s.test(fn), "no addParticipant call passes a stream (would duplicate VDO's own unmuted autoplay)");
  assert(!/ownedStreamFor\(/.test(fn), "syncProgramAudio no longer reads ownedStreamFor at all — that stream stays video-tile-only");
  assert(/transportLimited:\s*true/.test(fn), "host and participants are still tracked, explicitly marked as arriving via VDO, not this mixer");
}

console.log("\nownedStreamFor remains wired for video tiles (not removed outright)");
{
  const src = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  assert(src.includes("resolveOwnedStream: ownedStreamFor"), "renderLiveStage still resolves native video for the host tile");
}

console.log("\nProgramAudioMixer.addParticipant with no stream never touches the audio bus (behavioral)");
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
  mixer.addParticipant({ participantId: "g-1", label: "Guest", transportLimited: true });
  assert(connectCalls === 0, "no MediaStream was connected into the bus for either participant");
  const state = mixer.state();
  assert(state.sourceCount === 2, "both participants are still tracked for diagnostics (expected 2, got " + state.sourceCount + ")");
  assert(state.connectedCount === 0, "neither is marked connected — their audio arrives via VDO's own autoplay, not this mixer");
}

console.log("\nALL PASSED — Program Output no longer double-mixes participant audio.");
