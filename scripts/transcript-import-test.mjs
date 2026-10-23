#!/usr/bin/env node
import { parseTranscript } from "../js/transcript-import.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const srt = "1\n00:00:01,500 --> 00:00:04,000\nHost: Welcome back.\n\n2\n00:00:05,000 --> 00:00:09,250\n<i>Honestly</i> I think so.\n";
const a = parseTranscript(srt);
ok(a.length === 2 && a[0].t === 1.5 && a[0].end === 4 && a[0].speaker === "Host" && a[0].text === "Welcome back." && a[1].text === "Honestly I think so.", "SRT with speakers and markup");
ok(parseTranscript("WEBVTT\n\n00:01:02.000 --> 00:01:05.000\nGuest: Hi there\n")[0].t === 62, "WebVTT with minutes");
const j = parseTranscript(JSON.stringify({ lines: [{ speaker: "Host", text: "Hello", timestamp: 1000500 }, { speaker: "Guest", text: "Hi", timestamp: 1004000 }] }), { recordingStartMs: 1000000 });
ok(j.length === 2 && j[0].t === 0.5 && j[1].t === 4, "Toasty transcript JSON with epoch timestamps");
const t = parseTranscript("[00:12] Host: First line\n[01:30] Guest: Second line\nno time here");
ok(t.length === 2 && t[0].t === 12 && t[1].t === 90 && t[1].speaker === "Guest", "plain text with [mm:ss] stamps");
ok(parseTranscript("").length === 0 && parseTranscript("nothing useful").length === 0, "empty or untimed text gives nothing");
console.log("ALL PASSED — transcript files are read into timed lines.");
