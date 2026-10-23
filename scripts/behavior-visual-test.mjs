#!/usr/bin/env node
// Visual behavior: observable signals only, derived from scalar features. Synthetic feature series stand in for MediaPipe
// output (smile and brow blendshapes, head pose, hand and shoulder positions) and for frame-to-frame movement.
import { faceFeatures, headPoseFromMatrix, detectVisualEvents, blendshapeMap, motionBetween, boxFromLandmarks, poseFeatures, loadMediaPipe } from "../js/behavior/visual.js";
import { visualSamples } from "./lib/behavior-fixtures.mjs";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const types = (r) => r.events.map((e) => e.type);

console.log("\nFeatures from one MediaPipe result");
{
  const bs = blendshapeMap([{ categoryName: "mouthSmileLeft", score: 0.8 }, { categoryName: "mouthSmileRight", score: 0.6 }, { categoryName: "browInnerUp", score: 0.5 }, { categoryName: "jawOpen", score: 0.1 }]);
  const f = faceFeatures({ blendshapes: bs, box: boxFromLandmarks([{ x: 0.3, y: 0.2 }, { x: 0.5, y: 0.6 }]) });
  ok(Math.abs(f.smile - 0.7) < 1e-9 && f.brow === 0.5 && f.mouthOpen === 0.1, "smile, brows and mouth are read from blendshape scores");
  ok(Math.abs(f.x - 0.4) < 1e-9 && Math.abs(f.size - 0.4) < 1e-9, "face position and size come from the landmark box, and only the box is kept");
  const a = 25 * Math.PI / 180; // yaw about Y: r20 = -sin(yaw)
  const m = new Array(16).fill(0); m[0] = Math.cos(a); m[2] = -Math.sin(a); m[5] = 1; m[8] = Math.sin(a); m[10] = Math.cos(a); m[15] = 1;
  ok(Math.abs(headPoseFromMatrix(m).yaw - 25) < 0.01, "head yaw is recovered from the transformation matrix");
  ok(poseFeatures([...Array(13)].map((_, i) => ({ x: 0.4 + (i === 12 ? 0.2 : 0), y: 0.5, visibility: 1 })))?.width > 0.19, "shoulder width and position come from pose landmarks");
  ok(Object.keys(f).every((k) => typeof f[k] === "number"), "a face reduces to plain numbers: no landmarks, no embedding");
}

console.log("\nEvents");
{
  const caps = { face: true, hands: true, pose: false, motion: true };
  let r = detectVisualEvents(visualSamples(40, [{ t: 10, kind: "smile" }]), caps);
  ok(types(r).includes("smile") && r.events.find((e) => e.type === "smile").t === 10, "a smile is found where it starts");
  r = detectVisualEvents(visualSamples(40, [{ t: 12, kind: "brow" }]), caps);
  ok(types(r).includes("brow-raise"), "raised eyebrows are found");
  r = detectVisualEvents(visualSamples(40, [{ t: 20, kind: "turn" }]), caps);
  ok(types(r).includes("head-turn"), "a head turn is found");
  r = detectVisualEvents(visualSamples(40, [{ t: 20, kind: "nod" }], { step: 0.4 }), caps);
  ok(types(r).includes("head-nod"), "a head nod is found (oscillating pitch)");
  r = detectVisualEvents(visualSamples(40, [{ t: 18, kind: "lean" }]), caps);
  ok(types(r).includes("lean-in"), "leaning toward the camera is found (face grows)");
  r = detectVisualEvents(visualSamples(40, [{ t: 15, kind: "hands" }], { step: 0.5 }), caps);
  ok(types(r).includes("gesture"), "moving hands are a gesture");
  r = detectVisualEvents(visualSamples(40, [{ t: 25, kind: "burst" }]), caps);
  ok(types(r).includes("sudden-movement"), "a burst of movement in the picture is flagged");
  r = detectVisualEvents(visualSamples(40, []), caps);
  ok(r.events.length === 0, "a calm, steady picture produces no events (no reward for nothing)");
  r = detectVisualEvents(visualSamples(40, [{ t: 10, kind: "smile", slot: 1 }], { faces: 2 }), caps);
  ok(r.events.find((e) => e.type === "smile")?.data.slot === 1, "with two faces, a smile is tied to the face position (left to right), not to a name");
  ok(!types(detectVisualEvents(visualSamples(40, [{ t: 10, kind: "smile" }]), { face: false, motion: true })).includes("smile"), "when face tracking is off, face events are not invented");
  const still = visualSamples(40, [], { motion: 0.0005 }).map((s, i) => ({ ...s, motion: i < 10 ? 0.02 : 0.0005 }));
  ok(types(detectVisualEvents(still, { motion: true })).includes("stillness"), "a long hold after movement is reported as stillness");
}

console.log("\nMotion between frames");
{
  const w = 8, h = 8, a = new Uint8Array(w * h).fill(100), b = new Uint8Array(w * h).fill(100);
  ok(motionBetween(a, b, w, h).total === 0, "identical frames have no movement");
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) b[y * w + x] = 200;
  const m = motionBetween(a, b, w, h);
  ok(m.upper > 0.35 && m.lower === 0 && Math.abs(m.total - m.upper / 2) < 1e-9, "movement in the top half shows up as upper-frame movement only");
}

console.log("\nTracker unavailable");
{
  const r = await loadMediaPipe({ importer: async () => { throw new Error("blocked"); } });
  ok(!r.face && !r.hands && !r.pose && /unavailable/.test(r.notes[0]) && /movement was measured from the picture/.test(r.notes[0]), "if the tracker cannot load, the engine says so and falls back to movement");
}
console.log("\nAll visual checks passed.");
