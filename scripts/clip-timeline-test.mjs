#!/usr/bin/env node
import { planTimeline, captionWords, captionChunks, computeFrame, EASE } from "../js/clip-timeline.js";
import { getTemplate, applyOverrides } from "../js/clip-templates.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

const tpl = getTemplate("energy-burst");
const plan = planTimeline(tpl, 20);
console.log("\nTimeline plan");
ok(plan.intro === 2.2 && plan.clip === 20 && plan.outro === 2.4 && Math.abs(plan.total - 24.6) < 1e-9, "intro + clip + outro add up");
ok(planTimeline(getTemplate("minimal-cut"), 15).total === 15, "a template with no intro or outro is just the clip");

console.log("\nCaption timing");
{
  const lines = [{ t: 100, end: 104, text: "Honestly the biggest mistake is hiring for resume." }, { t: 104.5, text: "Not curiosity at all." }];
  const w = captionWords(lines, 100, 110);
  ok(w.length === 12 && w[0].start === 0 && w.every((x, i) => i === 0 || x.start >= w[i - 1].start - 1e-9), "words are in order, relative to the clip start");
  ok(w[7].end <= 4.01, "a line's words stay inside the line's time");
  ok(captionWords(lines, 104.5, 110).every((x) => x.start >= 0) && captionWords(lines, 104.5, 110).length <= 5, "words before the clip start are left out");
  const chunks = captionChunks(w, "kinetic");
  ok(chunks.every((c) => c.words.length <= 3), "kinetic captions show at most 3 words at a time");
  ok(captionChunks(w, "bar").every((c) => c.words.length <= 8), "bar captions show a readable line");
}

console.log("\nFrames");
{
  const words = captionWords([{ t: 0, end: 6, text: "This is the whole point of the show right here." }], 0, 20);
  const frame = (t, extra = {}) => computeFrame({ tpl: extra.tpl || tpl, plan: extra.plan || plan, words, t, vars: { title: "Why hiring fails" }, spec: extra.spec || {} });
  const f0 = frame(0.5), f1 = frame(2.2 + 1.5), f2 = frame(2.2 + 20 + 1), f3 = frame(999);
  ok(f0.phase === "intro" && f0.intro.title === "Why hiring fails" && f0.intro.rows.length >= 1, "the first seconds are the rolling title");
  ok(f1.phase === "clip" && Math.abs(f1.clipT - 1.5) < 1e-9, "then the clip, with its own clock");
  ok(f2.phase === "outro" && f2.outro.text === "Toasty Media", "then the branded outro");
  ok(f3.t === plan.total && f3.phase === "outro", "time is clamped to the end");
  const rows = frame(1.0).intro.rows; ok(rows.every((r) => r.k >= 0 && r.k <= 1.2), "rolling rows ease into place");
  const zoomEarly = frame(2.2 + 0.1).camera.scale, zoomLate = frame(2.2 + 19.9).camera.scale;
  ok(zoomLate > zoomEarly && zoomLate <= 1.1 * 1.17 + 1e-6, `the camera zooms in over the clip (${zoomEarly.toFixed(3)} to ${zoomLate.toFixed(3)})`);
  const punch = frame(2.2 + 0.2 * 20 + 0.5).camera.scale; ok(punch > frame(2.2 + 0.2 * 20 - 0.9).camera.scale, "a punch-in lifts the zoom briefly");
  const cap = frame(2.2 + 1.2).captions;
  ok(cap && cap.style === "kinetic" && cap.words.some((w) => w.state === "active") && cap.words.length <= 3, "kinetic captions mark the active word");
  ok(frame(2.2 + 15).captions === null, "no caption on screen when nobody is speaking");
  const tr = frame(2.2 + 0.05).transition; ok(tr && tr.kind === "wipe" && tr.from === "intro" && tr.to === "clip", "a wipe straddles the intro/clip boundary");
  ok(frame(10).transition === null, "no transition mid-clip");
  ok(frame(2.2 + 10).overlays.progressBar > 0.45 && frame(2.2 + 10).overlays.progressBar < 0.55, "the progress bar tracks the clip");
  const lt = frame(2.2 + 2, { spec: { lowerThird: { name: "Jane Doe", role: "CEO" } } }).overlays.lowerThird; ok(lt && lt.name === "Jane Doe" && lt.alpha > 0.9, "lower third fades in");
  ok(frame(2.2 + 9, { spec: { lowerThird: { name: "Jane Doe", role: "CEO" } } }).overlays.lowerThird === null, "and out");
  const cu = frame(2.2 + 5.5, { spec: { custom: [{ text: "Subscribe", at: 5, dur: 3, position: "center" }] } }).overlays.custom; ok(cu.length === 1 && cu[0].text === "Subscribe", "custom text appears at its time");
  const noCap = applyOverrides(tpl, { captions: { style: "none" } }); ok(computeFrame({ tpl: noCap, plan, words, t: 2.2 + 1.2 }).captions === null, "captions can be turned off");
}
ok(EASE.inOut(0) === 0 && EASE.inOut(1) === 1 && EASE.inOut(0.5) === 0.5, "easing hits its endpoints");
console.log("ALL PASSED — the clip timeline is deterministic and fully described before anything is drawn.");
