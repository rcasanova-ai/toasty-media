// Plain-English instructions -> changes to the edit settings. Local and rule-based (no language model, no network): each phrase
// is matched against an explicit list of supported instructions, and every instruction is answered either with what changed or
// with a plain statement that it cannot be done. Nothing is guessed at and nothing is silently ignored.
//
//   "Less zooming." "Make the captions bigger." "Remove the music." "Make it faster." "Use fewer transitions."
//   "Start with the strongest statement." "Make it 30 seconds." "Use the Toasty branding."
import { interpretInstruction } from "../clip-instructions.js";

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const has = (s, ...res) => res.some((r) => (r instanceof RegExp ? r.test(s) : s.includes(r)));

// Things people ask for that this editor cannot do. Each gets an honest answer.
const UNSUPPORTED = [
  [/\b(filter|instagram filter|vhs|glitch|retro look)\b/, "Visual filters beyond the three styles' own color grade"],
  [/\b(emoji|sticker|gif|meme)\b/, "Stickers, emoji and GIFs"],
  [/\b(green screen|remove (the )?background|blur (the )?background|virtual background)\b/, "Background removal or replacement"],
  [/\b(slow motion|slow-mo|reverse|speed ramp|time ?lapse)\b/, "Slow motion, reverse and speed ramps"],
  [/\b(voice ?over|narrat|dub|translate|different voice|change (my|the) voice|ai voice|text to speech)\b/, "Voice-overs, dubbing and voice changes"],
  [/\b(remove|cut out|take out) (the )?(um|uh|filler|ums|uhs)\b/, "Removing individual filler words (the transcript timing is per sentence, so a cut inside a word would be a guess); long pauses are removed instead"],
  [/\b(younger|older|retouch|beautify|smooth (my )?skin|whiten|teeth)\b/, "Retouching people"],
  [/\b(subtitle|caption)s? in (spanish|french|german|chinese|japanese|portuguese|italian|another language|\w+ language)\b/, "Translated captions"],
  [/\b(upload|post|publish|share|send) (it |this |the video )?(to|on)\b/, "Posting to other services (nothing leaves this computer)"],
  [/\b(generate|create|make up|invent|fake|ai[- ]generated) (new )?(footage|video|scenes?|images?|people)\b/, "Generated footage (only your own recording and your own B-roll are used)"]
];

export function parseInstruction(input, { state = {}, hasBroll = false } = {}) {
  const raw = String(input || "").trim();
  const s = raw.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  const out = { style: null, aspect: null, params: {}, applied: [], unsupported: [], count: null, kind: "none" };
  if (!s) return out;
  const P = state.params || {};
  const apply = (msg) => out.applied.push(msg);
  const set = (k, v) => { out.params[k] = v; };
  const get = (k, d) => (out.params[k] !== undefined ? out.params[k] : P[k] ?? d);

  // existing local understanding for titles, lower thirds and the format
  const base = interpretInstruction(raw);
  if (base.spec.title) { set("title", base.spec.title); apply(`Title: “${base.spec.title}”`); }
  if (base.spec.lowerThird) { set("lowerThird", base.spec.lowerThird); apply(`Lower third: ${base.spec.lowerThird.name}${base.spec.lowerThird.role ? ", " + base.spec.lowerThird.role : ""}`); }
  if (base.aspect) { out.aspect = base.aspect; apply(`Format: ${base.aspect}`); }

  // style
  if (has(s, "cinematic", "documentary", "film look", "dramatic")) { out.style = "cinematic"; apply("Style: Cinematic"); }
  else if (has(s, "high energy", "high-energy", "energetic", "punchy", "hype", "tiktok", "reels", "shorts", "more energy")) { out.style = "energy"; apply("Style: High Energy"); }
  else if (has(s, "professional", "corporate", "clean professional", "business") && !has(s, /audio sound professional|sound professional/)) { out.style = "clean"; apply("Style: Clean Professional"); }
  // "but keep the editing subtle" / "subtle" calms effects
  if (has(s, /\b(subtle|subtly|restrained|understated|keep (it|the editing) (simple|light))\b/)) { set("zoom", Math.min(get("zoom", 1), 0.6)); set("transitions", Math.min(get("transitions", 1), 0.6)); set("graphics", Math.min(get("graphics", 1), 0.6)); apply("Subtle editing: fewer zooms, transitions and graphics"); }

  // length
  const mins = s.match(/(\d+(?:\.\d+)?|a|one|two|three)\s*(?:-|\s)?(?:minutes?|mins?)\b/), secs = s.match(/(\d{1,3})\s*(?:-|\s)?(?:seconds?|secs?|s)\b(?!\w)/);
  if (secs) { set("targetSeconds", Number(secs[1])); apply(`Length: about ${secs[1]} seconds`); }
  else if (mins) { const n = /^\d/.test(mins[1]) ? Number(mins[1]) : mins[1] === "a" ? 1 : NUM[mins[1]] || 1; set("targetSeconds", n * 60); apply(`Length: about ${n} minute${n === 1 ? "" : "s"}`); }
  const cnt = s.match(/\b(\d+|two|three|four|five|six)\s+(?:\w+\s+){0,2}clips?\b/);
  if (cnt) { const n = NUM[cnt[1]] || Number(cnt[1]); if (n >= 1 && n <= 6) { out.count = n; set("count", n); apply(`${n} separate clip${n === 1 ? "" : "s"}`); } }

  // pace
  if (has(s, /\b(faster|quicker|snappier|tighter|speed (it )?up|more pace|more punch)\b/)) { set("pace", get("pace", 1) * 1.25); apply("Faster: tighter cuts and shorter shots"); }
  else if (has(s, /\b(slower|more relaxed|more breathing|let it breathe|calmer pace|slow(er)? pacing)\b/)) { set("pace", get("pace", 1) / 1.25); apply("Slower: more room around the speech"); }
  if (has(s, /\b(awkward pauses?|dead air|silences?|long pauses?|remove (the )?pauses?|cut (the )?pauses?)\b/) && has(s, /\b(remove|cut|trim|tighten|get rid|without|no|fix|delete)\b/)) { set("pace", Math.max(get("pace", 1), 1.2)); apply("Pauses: tightened (long gaps in speech are cut)"); }

  // zoom
  if (has(s, /\b(no|stop|without|remove|disable)\b.{0,12}\bzoom/, /\bzoom(s|ing)? off\b/)) { set("zoom", 0); apply("Zoom: off"); }
  else if (has(s, /\b(less|fewer|lighter|reduce|gentler)\b.{0,14}\bzoom/, /\btoo much zoom/, /\bzoom(ing|s)? (less|down)\b/)) { set("zoom", +(get("zoom", 1) * 0.5).toFixed(2)); apply("Zoom: reduced by half"); }
  else if (has(s, /\b(more|extra|stronger|bigger)\b.{0,14}\b(zoom|punch)/)) { set("zoom", Math.min(2, +(get("zoom", 1) * 1.5).toFixed(2))); apply("Zoom: increased"); }

  // transitions
  if (has(s, /\b(no|without|remove|zero)\b.{0,12}\btransitions?\b/, /\bhard cuts? only\b/)) { set("transitions", 0); apply("Transitions: none (hard cuts only)"); }
  else if (has(s, /\b(fewer|less|reduce|minimal|lighter)\b.{0,14}\btransitions?\b/)) { set("transitions", +(get("transitions", 1) * 0.5).toFixed(2)); apply("Transitions: halved"); }
  else if (has(s, /\b(more|extra|add)\b.{0,14}\btransitions?\b/)) { set("transitions", Math.min(2, +(Math.max(get("transitions", 1), 1) * 1.5).toFixed(2))); apply("Transitions: increased"); }

  // general calm-down
  if (has(s, /\b(less busy|simpler|calmer|tone it down|fewer effects|less effects|less over ?edited|not so busy|minimal effects)\b/)) { set("zoom", +(get("zoom", 1) * 0.5).toFixed(2)); set("graphics", +(get("graphics", 1) * 0.5).toFixed(2)); set("typography", +(get("typography", 1) * 0.6).toFixed(2)); set("transitions", +(get("transitions", 1) * 0.5).toFixed(2)); apply("Fewer effects overall: zooms, graphics, key phrases and transitions are reduced"); }

  // captions
  if (has(s, /\b(no|remove|without|hide|turn off)\b.{0,10}\b(captions?|subtitles?)\b/)) { set("captions", false); apply("Captions: off"); }
  else if (has(s, /\b(add|show|turn on|with)\b.{0,10}\b(captions?|subtitles?)\b/)) { set("captions", true); apply("Captions: on"); }
  if (has(s, /\b(bigger|larger|huge|increase)\b.{0,12}\b(captions?|subtitles?|text|words|font)\b/, /\b(captions?|subtitles?|text|words)\b.{0,12}\b(bigger|larger)\b/)) { set("captionScale", +(Math.min(1.8, get("captionScale", 1) * 1.3)).toFixed(2)); apply("Captions: 30% bigger"); }
  else if (has(s, /\b(smaller|reduce|decrease)\b.{0,12}\b(captions?|subtitles?|text|words|font)\b/, /\b(captions?|subtitles?|text|words)\b.{0,12}\bsmaller\b/)) { set("captionScale", +(Math.max(0.6, get("captionScale", 1) * 0.8)).toFixed(2)); apply("Captions: smaller"); }

  // music and sound
  if (has(s, /\b(no|remove|without|turn off|drop|lose|kill)\b.{0,10}\b(background )?music\b/)) { set("music", false); apply("Music: removed"); }
  else if (has(s, /\b(add|with|use|include|turn on)\b.{0,10}\b(background )?music\b/)) { set("music", true); apply("Music: on"); }
  if (has(s, /\b(quieter|lower|softer|reduce|turn down)\b.{0,12}\bmusic\b/, /\bmusic\b.{0,12}\b(quieter|lower|softer)\b/)) { set("musicGainDb", Math.max(-40, (get("musicGainDb", state.musicGainDb ?? -22)) - 4)); apply("Music: 4 dB quieter"); }
  else if (has(s, /\b(louder|higher|turn up|more)\b.{0,12}\bmusic\b/, /\bmusic\b.{0,12}\blouder\b/)) { set("musicGainDb", Math.min(-10, (get("musicGainDb", state.musicGainDb ?? -22)) + 4)); apply("Music: 4 dB louder"); }
  if (has(s, /\b(no|remove|without|turn off)\b.{0,12}\b(sound effects?|sfx|whooshes|sounds?)\b/)) { set("sfx", false); apply("Sound effects: off"); }
  else if (has(s, /\b(add|with|more)\b.{0,12}\b(sound effects?|sfx|whooshes)\b/)) { set("sfx", true); apply("Sound effects: on"); }
  if (has(s, /\b(audio|sound|voice)\b.{0,24}\b(professional|clean|clear|better|balanced|loud|louder|normali[sz]e|consistent)\b/, /\b(professional|clean|clear|balanced)\b.{0,14}\b(audio|sound)\b/, /\bfix (the )?audio\b/)) apply("Audio: the voice is always leveled to -16 LUFS with gentle compression, a peak limiter and ducked music, and the exported file is measured");

  // structure
  if (has(s, /\b(start|open|begin|lead) with the (strongest|best|most (powerful|interesting|compelling))\b/, /\bcold open\b/, /\bstart with (a |the )?hook\b/, /\bstrongest statement first\b/)) { set("startWithStrongest", true); apply("Start with the strongest statement"); }
  if (has(s, /\bno intro\b/, "skip the intro", "without an intro", "remove the intro")) { set("intro", false); apply("Intro: none"); } else if (has(s, /\b(add|with) (an? )?(intro|title card)\b/)) { set("intro", true); apply("Intro: on"); }
  if (has(s, /\bno outro\b/, "skip the outro", "without an outro", "remove the outro", "no end card")) { set("outro", false); apply("Outro: none"); } else if (has(s, /\b(add|with) (an? )?(outro|end card)\b/)) { set("outro", true); apply("Outro: on"); }
  if (has(s, /\b(use|add|with|include|apply)\b.{0,16}\b(toasty )?brand(ing)?\b/, /\btoasty (logo|branding|brand)\b/, /\b(add|with|show) (the |my |our )?logo\b/) && !has(s, /\bno\b.{0,10}\bbrand/)) { set("branding", "full"); apply("Toasty branding: logo sting, corner logo and branded end card"); }
  else if (has(s, /\b(no|remove|without)\b.{0,10}\b(brand(ing)?|logo)\b/)) { set("branding", "none"); apply("Branding: removed"); }
  if (has(s, /\b(no|remove|fewer|without)\b.{0,12}\b(graphics|callouts?|lower thirds?|overlays?)\b/)) { set("graphics", 0); apply("Graphics: off"); }
  if (has(s, /\b(no|remove|without|stop)\b.{0,12}\b(key ?phrases?|kinetic|animated text|text animations?|word animations?)\b/)) { set("typography", 0); apply("Animated text: off"); }
  if (has(s, /\b(b-?roll|cutaways?)\b/) && !has(s, /\b(no|without|remove)\b.{0,6}\b(b-?roll|cutaways?)\b/)) { if (hasBroll) { set("broll", true); apply("B-roll: use matching clips from your library where the words match"); } else out.unsupported.push("B-roll: your library has no clips yet. Add some under “B-roll from my files” and ask again"); }
  if (has(s, /\b(no|without|remove)\b.{0,6}\b(b-?roll|cutaways?)\b/)) { set("broll", false); apply("B-roll: off"); }

  // unsupported requests, stated plainly
  for (const [re, what] of UNSUPPORTED) if (re.test(s)) out.unsupported.push(`${what} are not supported.`.replace(/ are not supported\.$/, /^(Removing|Posting|Background|Slow|Generated|Retouching|Voice|Translated|Stickers|Visual)/.test(what) ? " is not supported." : " are not supported."));
  // anything else that looked like an instruction but matched nothing
  if (!out.applied.length && !out.unsupported.length) out.unsupported.push(`“${raw}” is not something I can turn into an edit yet. Try: less zooming, bigger captions, remove the music, make it faster, fewer transitions, start with the strongest statement, make it 30 seconds, use the Toasty branding.`);
  out.kind = out.applied.length ? "changed" : "none";
  return out;
}

// Merge a parsed instruction into the session's settings. Returns the new settings and the reply to show.
export function applyInstruction(settings, text, opts = {}) {
  const parsed = parseInstruction(text, { state: settings, hasBroll: opts.hasBroll });
  const next = { ...settings, params: { ...settings.params, ...parsed.params } };
  if (parsed.style) next.style = parsed.style;
  if (parsed.aspect) next.aspect = parsed.aspect;
  return { settings: next, applied: parsed.applied, unsupported: parsed.unsupported, changed: parsed.applied.length > 0 };
}
