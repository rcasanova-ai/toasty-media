import assert from "node:assert/strict";
import { createEditDecisionList, validateEditDecisionList } from "../js/clip-edl.js";

const source = { sourceId: "episode-1", duration: 180, format: "9:16",
  clips: [{ start: 10, end: 18, title: "First moment" }, { start: 34, end: 40, title: "Second moment" }],
  transcript: [{ t: 10, end: 12, text: "Hello everyone" }, { t: 34, end: 36, text: "This is useful" }],
  template: { captions: { style: "karaoke" }, transition: { kind: "wipe" } } };
const edl = createEditDecisionList(source);
assert.equal(edl.version, 1);
assert.equal(edl.output.duration, 14);
assert.equal(edl.output.width, 1080);
assert.equal(edl.edits[1].timelineStart, 8);
assert.equal(edl.edits[0].captions[0].text, "Hello");
assert.equal(edl.style.transition.kind, "wipe");
assert.deepEqual(validateEditDecisionList(edl).edits.map(e => e.source), edl.edits.map(e => e.source));
assert.throws(() => createEditDecisionList({ ...source, format: "invalid" }), /format/);
assert.throws(() => createEditDecisionList({ ...source, clips: [{ start: -1, end: 2 }] }), /bounds/);
assert.throws(() => createEditDecisionList({ ...source, clips: [{ start: 5, end: 181 }] }), /bounds/);
assert.throws(() => validateEditDecisionList({ version: 2 }), /version/);
console.log("Toasty EDL tests passed");
