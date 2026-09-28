#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanMicAudioConstraint, CLEAN_MIC_TARGET } from "../js/microphone-capture.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log("\nCanonical clean microphone constraints");
{
  assertEqual(CLEAN_MIC_TARGET.channelCount, 1, "target microphone channel count is mono");
  assertEqual(CLEAN_MIC_TARGET.sampleRate, 48000, "target microphone sample rate is 48 kHz");
  assertEqual(CLEAN_MIC_TARGET.echoCancellation, true, "browser echo cancellation is enabled");
  assertEqual(CLEAN_MIC_TARGET.noiseSuppression, true, "browser noise suppression is enabled");
  assertEqual(CLEAN_MIC_TARGET.autoGainControl, false, "browser auto gain control is disabled");
  const constraint = cleanMicAudioConstraint("mic-123");
  assertEqual(constraint.echoCancellation, true, "constraint requests echo cancellation");
  assertEqual(constraint.noiseSuppression, true, "constraint requests noise suppression");
  assertEqual(constraint.autoGainControl, false, "constraint disables AGC");
  assertEqual(constraint.channelCount.ideal, 1, "constraint requests mono");
  assertEqual(constraint.sampleRate.ideal, 48000, "constraint requests 48 kHz");
  assertEqual(constraint.deviceId.exact, "mic-123", "device selection is preserved exactly");
}

console.log("\nEvery Toasty-owned getUserMedia mic path uses the canonical constraint");
{
  const devicePicker = read("js/device-picker.js");
  const recording = read("js/recording.js");
  const ptt = read("js/talk-to-producer.js");
  const speakerInvite = read("js/speaker-invite-page.js");
  assert(devicePicker.includes("cleanMicAudioConstraint(deviceId)"), "host/guest preview picker uses clean mic constraints");
  assert(recording.includes("cleanMicAudioConstraint(deviceId)"), "isolated recorder uses clean mic constraints");
  assert(ptt.includes("audio: cleanMicAudioConstraint()"), "Talk to Moxie push-to-talk uses clean mic constraints");
  assert(speakerInvite.includes("audio: cleanMicAudioConstraint()"), "speaker tech check uses clean mic constraints");
  assert(!devicePicker.includes("channelCount: { ideal: 2 }"), "device picker no longer requests stereo");
  assert(!recording.includes("autoGainControl: { ideal: true }"), "isolated recorder no longer requests browser AGC");
  assert(!ptt.includes("autoGainControl: { ideal: true }"), "push-to-talk no longer requests browser AGC");
}

console.log("\nRecording path does not add another DSP layer");
{
  const programRecording = read("js/program-recording.js");
  const videoEngine = read("js/video-engine.js");
  const live = read("js/live-session.js");
  const listener = read("js/listener.js");
  assert(!programRecording.includes("createDynamicsCompressor"), "Program Output recording has no compressor/limiter before MediaRecorder");
  assert(!programRecording.includes("createGain()"), "Program Output recording has no gain stage before MediaRecorder");
  assert(programRecording.includes("this.masterStream = capture"), "MediaRecorder records the original browser capture stream");
  assert(!videoEngine.includes('stereo:"2"'), "host/guest VDO publishers do not force stereo");
  assert(!/audioMixer\.addParticipant\(\{\s*participantId:\s*["']host["'][\s\S]{0,180}stream:\s*this\._hostPreviewStream/.test(live), "Director does not route Host mic into ProgramAudioBus");
  assert(!/addParticipant\(\{[^}]*stream:/s.test(listener.slice(listener.indexOf("function syncProgramAudio("), listener.indexOf("\nfunction ", listener.indexOf("function syncProgramAudio(") + 1))), "Program Output does not feed participant streams into ProgramAudioBus");
}

console.log("\nClean mic metering is available before and after Toasty processing");
{
  const mic = read("js/microphone-capture.js");
  const host = read("js/host-prejoin.js");
  const guest = read("js/guest.js");
  const live = read("js/live-session.js");
  assert(mic.includes("createCleanMicMeterPair"), "meter pair helper exists");
  assert(mic.includes("clean-mic-pre"), "pre-processing meter label exists");
  assert(mic.includes("clean-mic-post"), "post-processing meter label exists");
  assert(mic.includes("averageDbfs: [-18, -12]"), "meter documents normal speech RMS target");
  assert(mic.includes("peakDbfs: [-9, -6]"), "meter documents normal speech peak target");
  assert(host.includes("createCleanMicMeterPair"), "host preview starts clean mic meters");
  assert(guest.includes("createCleanMicMeterPair"), "guest preview starts clean mic meters");
  assert(live.includes("_startHostCleanMicMeters"), "joined Host session starts clean mic meters");
  assert(live.includes("_stopHostCleanMicMeters"), "joined Host session disposes clean mic meters");
  assert(host.includes("_stopMicMeters()"), "host disposes mic meters on stream/device change");
  assert(guest.includes("stopGuestMicMeters()"), "guest disposes mic meters on stream/device change");
}

console.log("\nALL PASSED — microphone capture chain is standardized and unstacked.");
