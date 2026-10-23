#!/usr/bin/env node
// The behavioral timeline: one clock for every signal, and a hard refusal to hold anything that looks like a face template.
import { BehaviorTimeline, TRACKS } from "../js/behavior/timeline.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const throws = (fn, m) => { try { fn(); } catch (_) { return ok(true, m); } throw new Error("FAILED: " + m); };

console.log("\nOne timeline");
const tl = new BehaviorTimeline({ duration: 60, source: "upload" });
const a = tl.add("transcript", { type: "unit", t: 3, end: 6, speaker: "Ana", data: { text: "Hello." } });
const b = tl.add("audio", { type: "laughter", t: 5.5, end: 7, strength: 0.8 });
const c = tl.add("face", { type: "smile", t: 5.8, end: 6.8, strength: 1.4, slot: 0 });
tl.add("gesture", { type: "gesture", t: 40, end: 42, strength: 0.5 });
ok(a.id && b.id && c.id && new Set([a.id, b.id, c.id]).size === 3, "every event gets a unique id");
ok(c.strength === 1, "strength is clamped to 0..1");
ok(tl.query(null, 5, 6.5).map((e) => e.type).sort().join() === "laughter,smile,unit", "a query across tracks returns what overlaps one moment");
ok(tl.query("gesture", 0, 10).length === 0 && tl.query(["gesture"], 39, 41).length === 1, "queries can be limited to tracks");
ok(tl.get(b.id) === b, "events can be looked up by id");
tl.add("audio", { type: "pause", t: 70, end: 71 });
ok(tl.duration === 71, "the duration grows to cover late events");
throws(() => tl.add("audio", { type: "x", t: NaN }), "a missing time is refused");
throws(() => tl.add("nope", { type: "x", t: 1 }), "an unknown track is refused");
ok(TRACKS.includes("interaction") && TRACKS.includes("boundaries") && TRACKS.includes("turns"), "tracks for turns, interaction and clip boundaries exist");

console.log("\nCapabilities");
tl.setCapability("face", true, "faces tracked");
ok(tl.has("face") && !tl.has("hands"), "a signal that was not analysed is reported as unavailable");
throws(() => tl.setCapability("emotion", true), "there is no capability for inferring emotion");

console.log("\nNo biometrics");
const json = tl.toJSON();
ok(json.version === 1 && json.tracks.face[0].type === "smile", "the timeline serialises");
throws(() => tl.add("face", { type: "x", t: 1, data: { landmarks: [1, 2] } }) && tl.toJSON(), "a landmarks field cannot be serialised");
const t2 = new BehaviorTimeline(); t2.add("face", { type: "x", t: 1, data: { points: Array.from({ length: 128 }, (_, i) => i / 128) } });
throws(() => t2.toJSON(), "a long numeric vector (a face embedding) cannot be serialised");
const t3 = new BehaviorTimeline(); t3.add("face", { type: "x", t: 1, data: { embedding: [0.1] } });
throws(() => t3.toJSON(), "an embedding field cannot be serialised");
console.log("\nAll timeline checks passed.");
