#!/usr/bin/env node
// Behavioural test of the locked product model: BACKSTAGE / RECORD / LIVE, one Program capture feeding
// every consumer, Go Live auto-records, End Live only ends recordings Go Live started, destination
// failures are isolated. Runs the REAL ProgramFeed + ProgramOrchestrator with fake capture/recorder/broadcast.
import { readFileSync } from "node:fs";
import { ProgramFeed } from "../js/program-feed.js";
import { ProgramOrchestrator, StudioMode, RecordingOrigin } from "../js/program-orchestrator.js";

function assert(c, m) { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); }
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeTrack(kind) { const l = {}; return { kind, readyState: "live", stop() { this.readyState = "ended"; }, addEventListener(e, f) { l[e] = f; }, fire(e) { l[e]?.(); } }; }
function makeRig({ goLiveRejects = false, recorderRejects = false } = {}) {
  const log = { captures: 0, recorderStarts: [], recorderStops: [], broadcastStarts: [], broadcastStops: 0 };
  const tracks = [];
  const feed = new ProgramFeed({ acquire: async () => {
    log.captures += 1;
    const v = fakeTrack("video"), a = fakeTrack("audio"); tracks.push(v, a);
    return { getVideoTracks: () => [v], getAudioTracks: () => [a], getTracks: () => [v, a] };
  } });
  let push = () => {};
  const broadcaster = {
    onUpdate(fn) { push = fn; },
    async start({ destinations, stream }) {
      if (goLiveRejects) throw new Error("X is not connected yet.");
      log.broadcastStarts.push({ destinations, stream });
      push({ destinations: destinations.map((d) => ({ destination: d, label: d, state: "connecting", error: "" })) });
    },
    async stop() { log.broadcastStops += 1; push({ destinations: studio.snapshot().destinations.map((d) => ({ ...d, state: d.state === "error" ? "error" : "stopped" })) }); }
  };
  const recorder = {
    async start({ stream, origin }) { if (recorderRejects) throw new Error("recorder boom"); log.recorderStarts.push({ stream, origin }); return { startedAt: Date.now() }; },
    async stop({ origin }) { log.recorderStops.push(origin); return { ok: true }; }
  };
  const studio = new ProgramOrchestrator({ feed, recorder, broadcaster });
  const dest = (name, state, error = "") => push({ destinations: [{ destination: name, label: name, state, error }] });
  return { studio, feed, log, dest, tracks };
}

async function main() {
  console.log("\nBACKSTAGE is the default and nothing but destinations/recording moves it");
  {
    const { studio, feed, log } = makeRig();
    assert(studio.mode === StudioMode.BACKSTAGE, "Studio starts Backstage");
    assert(!studio.recording.active && log.captures === 0 && !feed.active, "nothing is recorded or captured Backstage");
    const src = readFileSync(new URL("../js/director.js", import.meta.url), "utf8");
    assert(!/connection\??\.live/.test(src), "director never reads a connection 'live' flag");
    const m = src.match(/elements\.topLiveState\.textContent\s*=\s*([^\n]+)/);
    assert(m && /mode === "live"/.test(m[1]), "the status chip text derives from orchestrator mode only");
    const chrome = src.slice(src.indexOf("function renderStudioChrome"), src.indexOf("function formatElapsed"));
    assert(!/programOutput|screenshare|av\b|guests|connection/.test(chrome), "status chrome cannot read camera/guest/screen/Program Output/connection state");
    const chip = src.slice(src.indexOf("function renderBroadcastChip"), src.indexOf("function setBroadcastChip"));
    assert(chip.includes('mode === "live"') && !/program\.live/.test(chip), "the ON AIR sign needs a real LIVE mode, not a Program scene");
  }

  console.log("\nManual Record: Backstage -> Recording -> Backstage (no external output)");
  {
    const { studio, feed, log } = makeRig();
    await studio.startRecording();
    assert(studio.mode === StudioMode.RECORD && studio.recording.origin === RecordingOrigin.MANUAL, "Record shows RECORD with manual origin");
    assert(log.broadcastStarts.length === 0 && studio.destinations.size === 0, "nothing is sent externally");
    await studio.stopRecording();
    assert(studio.mode === StudioMode.BACKSTAGE && log.recorderStops.length === 1, "stopping Record returns to Backstage and finalizes");
    assert(!feed.active, "Program capture is released when nothing consumes it");
  }

  console.log("\nGo Live: X starts receiving -> LIVE -> recording automatically starts, ONE capture");
  {
    const { studio, feed, log, dest } = makeRig();
    await studio.goLive(["x"]);
    assert(studio.mode === StudioMode.BACKSTAGE, "while X is still connecting Studio is NOT live");
    assert(!studio.recording.active, "no recording until a destination is actually live");
    dest("x", "live"); await tick();
    assert(studio.mode === StudioMode.LIVE, "Studio is LIVE once X is actually receiving");
    assert(studio.recording.active && studio.recording.origin === RecordingOrigin.LIVE_AUTO, "recording auto-started with origin live-auto");
    assert(log.captures === 1, "exactly ONE Program capture (one picker) for broadcast + recording");
    assert(log.recorderStarts[0].stream === log.broadcastStarts[0].stream, "broadcast and recording consume the SAME stream object");
    assert(feed.holders.includes("broadcast") && feed.holders.includes("recording"), "feed is retained by both consumers");

    console.log("\nEnd Live: stop X, finalize the automatic recording, back Backstage");
    await studio.endLive();
    assert(log.broadcastStops === 1, "external broadcast stopped");
    assert(log.recorderStops.length === 1 && log.recorderStops[0] === RecordingOrigin.LIVE_AUTO, "the live-auto recording was finalized");
    assert(studio.mode === StudioMode.BACKSTAGE && !studio.recording.active && !feed.active, "Studio returns to Backstage with capture released");
  }

  console.log("\nManual Record -> Live -> End Live: the manual recording CONTINUES");
  {
    const { studio, feed, log, dest } = makeRig();
    await studio.startRecording();
    await studio.goLive(["x"]); dest("x", "live"); await tick();
    assert(log.captures === 1, "going Live while recording does not capture Program again");
    assert(log.recorderStarts.length === 1, "no second recording is started");
    assert(studio.mode === StudioMode.LIVE && studio.recording.origin === RecordingOrigin.MANUAL, "mode is LIVE; recording still owned as manual");
    await studio.endLive();
    assert(log.recorderStops.length === 0 && studio.recording.active, "End Live did NOT stop the manual recording");
    assert(studio.mode === StudioMode.RECORD, "Studio falls back to RECORD, not Backstage");
    assert(feed.active && feed.holders.length === 1 && feed.holders[0] === "recording", "only the recording still holds Program");
    await studio.stopRecording();
    assert(log.recorderStops.length === 1 && !feed.active, "the producer can then stop their own recording");
  }

  console.log("\nMultistream: one Program, isolated destinations");
  {
    const { studio, log, dest } = makeRig();
    await studio.goLive(["x", "youtube"]);
    assert(log.captures === 1 && log.broadcastStarts.length === 1 && log.broadcastStarts[0].destinations.length === 2, "ONE capture and ONE broadcast job feed both destinations");
    dest("x", "live"); dest("youtube", "live"); await tick();
    dest("youtube", "error", "YouTube rejected the stream."); await tick();
    assert(studio.mode === StudioMode.LIVE, "YouTube failing leaves Studio LIVE because X is still live");
    const yt = studio.snapshot().destinations.find((d) => d.destination === "youtube");
    const x = studio.snapshot().destinations.find((d) => d.destination === "x");
    assert(yt.state === "error" && x.state === "live", "YouTube is ERROR, X stays LIVE");
    assert(studio.recording.active && log.recorderStops.length === 0, "recording continues");
    dest("x", "error", "dropped"); await tick(); await tick();
    assert(studio.mode === StudioMode.RECORD, "when zero destinations remain live Studio leaves LIVE");
    assert(studio.recording.active && log.recorderStops.length === 0, "the recording is kept — footage is never discarded because a destination dropped");
    assert(/All destinations ended/.test(studio.snapshot().notice), "the producer is told why");
  }

  console.log("\nFailure paths");
  {
    const { studio, feed, log } = makeRig({ goLiveRejects: true });
    let threw = false; try { await studio.goLive(["x"]); } catch (_) { threw = true; }
    assert(threw && studio.mode === StudioMode.BACKSTAGE && !studio.recording.active, "a rejected Go Live stays Backstage and records nothing");
    assert(!feed.active, "and releases the Program capture it opened");
  }
  {
    const { studio, dest } = makeRig({ recorderRejects: true });
    await studio.goLive(["x"]); dest("x", "live"); await tick(); await tick();
    assert(studio.mode === StudioMode.LIVE, "if the automatic recording cannot start, the broadcast still runs");
    assert(/automatic recording could not start/.test(studio.snapshot().recordingError), "and the failure is surfaced, not silent");
  }
  {
    const { studio, feed, log, dest, tracks } = makeRig();
    await studio.goLive(["x"]); dest("x", "live"); await tick();
    tracks[0].fire("ended"); await tick(); await tick();
    assert(studio.mode === StudioMode.BACKSTAGE && !studio.recording.active && log.broadcastStops >= 1, "browser 'Stop sharing' ends the broadcast and saves the recording");
    assert(log.recorderStops.length === 1 && !feed.active, "recording was finalized, capture released");
  }
  {
    const feed = new ProgramFeed({ acquire: (() => { let n = 0; return async () => { n += 1; await tick(); const v = fakeTrack("video"); return { getVideoTracks: () => [v], getAudioTracks: () => [], getTracks: () => [v], n }; }; })() });
    const [a, b] = await Promise.all([feed.retain("recording"), feed.retain("broadcast")]);
    assert(a === b && feed.captureCount === 1, "two consumers asking at once still cause ONE capture");
    feed.release("recording"); assert(feed.active, "capture stays open while another consumer holds it");
    feed.release("broadcast"); assert(!feed.active, "capture closes when the last consumer releases");
  }
  console.log("\nALL PASSED — Backstage / Record / Live model, single Program capture, auto-record, isolated destinations.");
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
