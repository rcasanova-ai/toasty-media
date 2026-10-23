#!/usr/bin/env node
import { musicEvents, MUSIC_STYLES } from "../js/clip-music.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
for (const style of Object.keys(MUSIC_STYLES)) {
  const ev = musicEvents(style, 30);
  const kinds = new Set(ev.map((e) => e.kind));
  ok(ev.length > 20 && ev.every((e) => e.t >= 0 && e.t < 30 && e.dur > 0 && (e.freq == null || (e.freq > 20 && e.freq < 4000))), `${style}: ${ev.length} well-formed events inside 30 s`);
  ok(kinds.has("bass") && (kinds.has("pad") || kinds.has("stab")), `${style}: has a bass line and harmony (${[...kinds].join(", ")})`);
}
ok(musicEvents("nope", 10).length === 0 && musicEvents("upbeat", 0).length === 0, "unknown style or zero length gives nothing");
ok(musicEvents("upbeat", 20).every((e, i, a) => i === 0 || e.t >= a[i - 1].t), "events are time-ordered");
console.log("ALL PASSED — music scores are well-formed data (the audio itself is rendered and measured in the browser test).");
