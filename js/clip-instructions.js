// Moxie reads a plain-English editing instruction and turns it into VALIDATED clip parameters. It never writes or runs code:
// the output is a patch of enumerated styles and bounded numbers, applied on top of a template and re-validated
// (js/clip-templates.js). Everything it understood is reported back in words, and so is anything it did not, so the producer
// sees exactly what changed.
//
//   "Give this clip an energetic opening with rolling text, subtle zooms, upbeat music, and a Toasty outro."
//   "Make it vertical, add captions, no music, trim it to start at 0:12 and end at 0:41"
//   "Title: Why hiring fails. Lower third for Jane Doe, CEO."
import { ASPECTS, STARTER_TEMPLATES, validateTemplate } from "./clip-templates.js";

const has = (s, ...res) => res.some((r) => (r instanceof RegExp ? r.test(s) : s.includes(r)));
const secs = (str) => {
  const m = String(str).match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.\d+)?$|^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?$/);
  if (!m) return null;
  if (m[4] != null) return Number(m[4]);
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
};

// Returns { template?, aspect?, overrides, spec: { title?, subtitle?, lowerThird?, custom[], trim? }, understood[], ignored[] }.
export function interpretInstruction(input, { clip = null, templates = STARTER_TEMPLATES } = {}) {
  const raw = String(input || "").trim();
  const s = raw.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const out = { template: null, aspect: null, overrides: {}, spec: { custom: [] }, understood: [], ignored: [] };
  if (!s) return out;
  const note = (msg) => out.understood.push(msg);
  const o = out.overrides;
  const set = (path, value) => { let cur = o; const keys = path.split("."); keys.slice(0, -1).forEach((k) => { cur = cur[k] ??= {}; }); cur[keys[keys.length - 1]] = value; };

  // Quoted or labelled text first so it is not misread as a style word.
  const title = raw.match(/\btitle\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^.\n;]+))/i) || raw.match(/\b(?:call it|titled|title it)\s+(?:"([^"]+)"|'([^']+)'|([^.\n;]+))/i);
  if (title) { out.spec.title = (title[1] || title[2] || title[3] || title[4] || title[5] || title[6]).trim(); note(`Title: “${out.spec.title}”`); }
  const sub = raw.match(/\bsubtitle\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^.\n;]+))/i);
  if (sub) { out.spec.subtitle = (sub[1] || sub[2] || sub[3]).trim(); note(`Subtitle: “${out.spec.subtitle}”`); }
  const lt = raw.match(/\blower[- ]third\s+(?:for|with|of)\s+(?:"([^"]+)"|'([^']+)'|([^.\n;]+))/i);
  if (lt) { const [name, role] = (lt[1] || lt[2] || lt[3]).split(/\s*,\s*/); out.spec.lowerThird = { name: name.trim(), role: (role || "").trim() }; set("overlays.lowerThird", true); note(`Lower third: ${name.trim()}${role ? ", " + role.trim() : ""}`); }
  for (const m of raw.matchAll(/\badd (?:the )?(?:text|words|caption|message)\s+(?:"([^"]+)"|'([^']+)')(?:\s+(?:at|from)\s+([\d:.]+)(?:\s*(?:s|sec|seconds?))?)?/gi)) {
    const at = m[3] != null ? secs(m[3]) : null;
    out.spec.custom.push({ text: (m[1] || m[2]).trim(), at: at ?? 1, dur: 3, position: has(s, "top") ? "top" : "center" });
    note(`Text overlay: “${(m[1] || m[2]).trim()}”${at != null ? ` at ${at}s` : ""}`);
  }

  // Template by name, then by vibe words (best keyword score wins).
  const byName = templates.find((t) => s.includes(t.name.toLowerCase()));
  if (byName) { out.template = byName.id; note(`Template: ${byName.name}`); }
  else {
    let best = null;
    for (const t of templates) { const score = t.keywords.reduce((n, k) => n + (s.includes(k) ? (k.includes(" ") ? 2 : 1) : 0), 0); if (score && (!best || score > best.score)) best = { t, score }; }
    if (best) { out.template = best.t.id; note(`Style: ${best.t.name} (matched “${best.t.keywords.find((k) => s.includes(k))}”)`); }
  }

  // Aspect.
  if (has(s, "9:16", /\bvertical\b/, "tiktok", "reels", "shorts", "portrait", "story format")) { out.aspect = "9:16"; note("Format: vertical 9:16"); }
  else if (has(s, "1:1", /\bsquare\b/, "instagram post")) { out.aspect = "1:1"; note("Format: square 1:1"); }
  else if (has(s, "16:9", /\blandscape\b/, "widescreen", "youtube")) { out.aspect = "16:9"; note("Format: landscape 16:9"); }

  // Intro / outro.
  if (has(s, /\bno intro\b/, "skip the intro", "without an intro")) { set("intro.kind", "none"); note("No intro"); }
  else if (has(s, "rolling text", "rolling title", "rolling intro", "animated title", "animated opening", "text rolls", "opening with rolling")) { set("intro.kind", "rolling-title"); note("Intro: rolling text"); }
  else if (has(s, "logo sting", "logo intro", "logo opening")) { set("intro.kind", "logo-sting"); note("Intro: logo sting"); }
  else if (has(s, /\b(intro|opening|open with)\b/, "title card")) { set("intro.kind", has(s, "energetic", "punchy", "fast") ? "rolling-title" : "title-card"); note("Intro: added"); }
  if (has(s, /\bno outro\b/, "skip the outro", "without an outro")) { set("outro.kind", "none"); note("No outro"); }
  else if (has(s, "toasty outro", "branded outro", "brand outro", "end card", "branded ending", "branded end")) { set("outro.kind", "brand-end"); note("Outro: Toasty branded end card"); }
  else if (has(s, "call to action", "cta", "follow outro")) { set("outro.kind", "cta"); note("Outro: call to action"); }
  else if (has(s, /\boutro\b|\bending\b/)) { set("outro.kind", "brand-end"); note("Outro: added"); }

  // Camera.
  if (has(s, "no zoom", "without zoom", "static camera", "no camera movement")) { set("camera.zoomFrom", 1); set("camera.zoomTo", 1); note("No zoom"); }
  else if (has(s, "dramatic zoom", "big zoom", "heavy zoom", "strong zoom", "punch in", "punch-in")) { set("camera.zoomFrom", 1); set("camera.zoomTo", 1.2); set("camera.punchIns", [{ at: 0.35, dur: 1.2, scale: 1.2 }, { at: 0.75, dur: 1.2, scale: 1.2 }]); note("Camera: dramatic zoom with punch-ins"); }
  else if (has(s, "subtle zoom", "slow zoom", "gentle zoom", "slight zoom", "subtle zooms")) { set("camera.zoomFrom", 1); set("camera.zoomTo", 1.06); note("Camera: subtle slow zoom"); }
  else if (has(s, /\bzoom/)) { set("camera.zoomFrom", 1); set("camera.zoomTo", 1.1); note("Camera: zoom"); }
  if (has(s, /\bpan(ning)?\b/)) { set("camera.panX", 0.05); note("Camera: slow pan"); }

  // Captions.
  if (has(s, "no captions", "without captions", "no subtitles")) { set("captions.style", "none"); note("No captions"); }
  else if (has(s, "kinetic caption", "kinetic text", "animated caption", "word by word")) { set("captions.style", "kinetic"); note("Captions: kinetic, word by word"); }
  else if (has(s, "karaoke")) { set("captions.style", "karaoke"); note("Captions: karaoke highlight"); }
  else if (has(s, /\b(captions?|subtitles?)\b/)) { set("captions.style", has(s, "energetic", "punchy") ? "kinetic" : "bar"); note("Captions: on"); }
  if (has(s, "big caption", "large caption", "bigger caption")) { set("captions.size", 0.08); note("Captions: larger"); }
  if (has(s, /captions? (at )?(the )?top/)) set("captions.position", "top");
  if (has(s, /captions? (in )?(the )?(middle|center|centre)/)) set("captions.position", "center");

  // Music and audio.
  if (has(s, "no music", "without music", "silent", "no background music")) { set("music.style", "none"); note("No music"); }
  else if (has(s, "upbeat", "energetic music", "happy music", "fun music", "peppy")) { set("music.style", "upbeat"); note("Music: upbeat"); }
  else if (has(s, "chill", "lofi", "lo-fi", "calm music", "relaxed music", "soft music", "mellow")) { set("music.style", "chill"); note("Music: chill"); }
  else if (has(s, "cinematic", "epic music", "orchestral", "dramatic music")) { set("music.style", "cinematic"); note("Music: cinematic"); }
  else if (has(s, "tense", "suspense", "serious music")) { set("music.style", "tense"); note("Music: tense"); }
  else if (has(s, /\b(background )?music\b/)) { set("music.style", "upbeat"); note("Music: on (upbeat)"); }
  if (has(s, "quieter music", "lower the music", "softer music", "music quieter", "music lower")) { set("music.gainDb", -28); note("Music: quieter"); }
  if (has(s, "louder music", "music louder", "turn up the music")) { set("music.gainDb", -14); note("Music: louder"); }
  if (has(s, "enhance the audio", "clean up the audio", "improve the audio", "fix the audio", "clean audio", "normalize", "normalise")) { set("audio.enhance", true); note("Audio: enhanced"); }
  if (has(s, "no audio enhancement", "don't enhance", "do not enhance", "raw audio", "leave the audio")) { set("audio.enhance", false); note("Audio: left as recorded"); }

  // Transitions, frame, logo.
  if (has(s, "wipe")) { set("transition.kind", "wipe"); note("Transition: wipe"); }
  else if (has(s, "slide transition", "slide in")) { set("transition.kind", "slide"); note("Transition: slide"); }
  else if (has(s, "zoom transition")) { set("transition.kind", "zoom"); note("Transition: zoom"); }
  else if (has(s, "fade")) { set("transition.kind", "fade"); note("Transition: fade"); }
  else if (has(s, "no transition", "hard cut")) { set("transition.kind", "none"); note("Transition: hard cut"); }
  if (has(s, "fast transition", "quick transition", "snappy")) { set("transition.seconds", 0.25); note("Transitions: faster"); }
  if (has(s, "slow transition", "smooth transition")) { set("transition.seconds", 0.8); note("Transitions: slower"); }
  if (has(s, "progress bar")) { set("overlays.progressBar", true); note("Progress bar"); }
  if (has(s, "letterbox", "black bars", "cinema bars")) { set("overlays.frame", "letterbox"); note("Letterbox frame"); }
  if (has(s, /\b(add|with|my|our|include)\b.{0,12}\blogo\b/)) { set("overlays.logo", true); note("Logo overlay"); }
  if (has(s, /\b(no|without|remove)\b.{0,10}\blogo\b/)) { set("overlays.logo", false); note("No logo"); }

  // Trimming.
  const range = s.match(/(?:start(?:ing)?(?: at)?|from)\s+([\d:.]+)\s*(?:s|sec|seconds?)?\s*(?:,|and)?\s*(?:end(?:ing)?(?: at)?|to|until|through)\s+([\d:.]+)/);
  if (range) { const a = secs(range[1]), b = secs(range[2]); if (a != null && b != null && b > a) { out.spec.trim = { start: a, end: b }; note(`Trim: ${a}s to ${b}s (of the source)`); } }
  const first = s.match(/\b(?:first|opening)\s+(\d{1,3})\s*(?:s|sec|seconds?)\b/);
  if (first && clip && !has(s, /cut|trim|remove|drop|skip/)) { out.spec.trim = { start: clip.start, end: Math.min(clip.end, clip.start + Number(first[1])) }; note(`Trim: only the first ${first[1]} seconds`); }
  const cutStart = s.match(/\b(?:cut|trim|remove|drop|skip)\s+(?:off\s+)?(?:the\s+)?first\s+(\d{1,3})\s*(?:s|sec|seconds?)\b/);
  if (cutStart && clip) { out.spec.trim = { ...(out.spec.trim || { start: clip.start, end: clip.end }), start: (out.spec.trim?.start ?? clip.start) + Number(cutStart[1]) }; note(`Trim: cut the first ${cutStart[1]} seconds`); }
  const cutEnd = s.match(/\b(?:cut|trim|remove|drop)\s+(?:off\s+)?(?:the\s+)?last\s+(\d{1,3})\s*(?:s|sec|seconds?)\b/);
  if (cutEnd && clip) { out.spec.trim = { ...(out.spec.trim || { start: clip.start, end: clip.end }), end: (out.spec.trim?.end ?? clip.end) - Number(cutEnd[1]) }; note(`Trim: cut the last ${cutEnd[1]} seconds`); }
  const under = s.match(/\b(?:under|within|no (?:longer|more) than|at most|max(?:imum)?(?: of)?|less than)\s+(\d{1,3})\s*(?:s|sec|seconds?)\b/);
  if (under && clip) { const cap = Number(under[1]); const t0 = out.spec.trim?.start ?? clip.start; const t1 = out.spec.trim?.end ?? clip.end; if (t1 - t0 > cap) { out.spec.trim = { start: t0, end: t0 + cap }; note(`Trim: keep at most ${cap} seconds`); } }

  // Anything left that reads like an instruction but matched nothing is reported, not guessed at.
  if (!out.understood.length) out.ignored.push(raw);
  for (const m of raw.matchAll(/\b(?:and|with|plus)\s+([a-z' -]{4,40}?)(?:[,.;]|$)/gi)) {
    const phrase = m[1].trim().toLowerCase();
    if (!has(s.replace(phrase, ""), phrase) && !out.understood.some((u) => u.toLowerCase().includes(phrase.split(" ")[0])) && /\b(effect|animation|sticker|filter|voice|emoji|green screen|slow motion|reverse)\b/.test(phrase)) out.ignored.push(phrase);
  }
  // Validation: the patch can only ever express things the renderer supports.
  const probe = validateTemplate(out.overrides);
  out.validated = { aspect: out.aspect && out.aspect in ASPECTS ? out.aspect : null, overrides: o, resolved: probe };
  return out;
}
