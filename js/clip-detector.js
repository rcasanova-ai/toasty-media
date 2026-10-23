// Moxie clip detection. Pure and local: no network, no paid service. The same code runs live (rolling window over the
// streaming transcript and audio events while recording) and in batch (a finished recording or an upload).
//
// Inputs, all timed in SECONDS from the start of the recording:
//   transcript lines  { t, end?, speaker, text }
//   audio events      { t, end?, type: "laughter" | "silence" | "spike" | "overlap", level? }   (see js/audio-events.js)
// Output: bookmarks { id, start, end, title, category, score, reason, speakers, source, open? }
//
// This is a transparent heuristic, not a model: every bookmark carries the reason it was chosen, so a producer can judge
// it. It looks for the moments listed in the brief: strong opinions, insights, jokes and group laughter, awkward silences
// and nervous laughter, surprise, arguments, emotional moments, banter and interruptions, then widens each moment to
// include the build-up before it and the reaction after it.

export const CLIP_CATEGORIES = Object.freeze({
  "strong-opinion": "Strong opinion",
  insight: "Insight",
  joke: "Joke",
  laughter: "Group laughter",
  "awkward-silence": "Awkward silence",
  "nervous-laughter": "Nervous laughter",
  surprise: "Surprise",
  argument: "Disagreement",
  emotional: "Emotional moment",
  banter: "Banter",
  interruption: "Interruption",
  "clip-that": "Clipped on request"
});

const LEX = {
  opinion: [/\b(i (really )?(think|believe|feel|disagree|refuse)|honestly|frankly|unpopular opinion|hot take|the truth is|let me be (clear|honest)|here'?s my (take|problem)|i('m| am) (convinced|sure)|never|always|worst|best|overrated|underrated|ridiculous|nonsense|absolutely)\b/i, 1],
  insight: [/\b(the (reason|key|secret|real|whole) (is|thing|problem|point|issue)|what (most|many) people|here'?s the thing|it turns out|what i('ve)? learned|the lesson|the difference (is|between)|because (it|they|that)|that'?s why|the trick is|think of it (as|like)|in other words)\b/i, 1],
  surprise: [/\b(wait[, ]|no way|what\?!|you'?re kidding|seriously\?|i (had no idea|didn'?t (know|expect|see))|that'?s (insane|crazy|wild|incredible|unbelievable)|oh my (god|gosh)|whoa|shut up|are you serious|can'?t believe)\b/i, 1],
  emotional: [/\b(i (love|hate|miss|cried|was (scared|terrified|proud|heartbroken|devastated|overwhelmed))|heartbreaking|grateful|thank you so much|changed my life|my (mom|dad|mother|father|wife|husband|kid|son|daughter)|passed away|tears|afraid|ashamed|proud of)\b/i, 1],
  joke: [/\b(joke|funny|hilarious|kidding|punchline|roast|that'?s what she said|walks into a bar|you had to be there|i('m| am) dying)\b/i, 1],
  laughText: [/\b(ha(ha)+|hehe+|lol|lmao|rofl)\b|\[(laughter|laughs|laughing)\]|\((laughter|laughs|laughing)\)/i, 1],
  disagree: [/\b(i disagree|that'?s (not true|wrong|ridiculous|not (right|fair))|no,? (no|that'?s)|you'?re wrong|come on|but that'?s|actually,? (no|that)|i don'?t (buy|agree)|that doesn'?t make sense)\b/i, 1],
  hedge: [/\b(um+|uh+|i guess|i mean|sort of|kind of|you know|well\.\.\.|awkward)\b/i, 1],
  clipThat: [/\bclip (that|this|it)\b/i, 1]
};

const WORDS = (text) => (String(text || "").trim().match(/\S+/g) || []).length;
const SENTENCE_END = /[.!?]["')\]]?\s*$/;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;

// "Moxie, clip that" / "hey Moxie clip that" / "clip that, Moxie". Returns { lookbackSeconds? } or null.
export function parseClipCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[“”"']/g, "");
  const wake = "(?:hey\\s+|ok\\s+|okay\\s+)?(?:moxie|moxy|moxi|moxey)";
  const patterns = [
    new RegExp(`^(?:.{0,40}?\\b)?${wake}\\s*[,:.!?\\-—]?\\s*(?:please\\s+)?clip\\s+(?:that|this|it)\\b`),
    new RegExp(`\\bclip\\s+(?:that|this|it)\\b\\s*[,.]?\\s*(?:please\\s*)?[,.]?\\s*${wake}\\b`)
  ];
  if (!patterns.some((p) => p.test(lower))) return null;
  const secs = lower.match(/(?:last|past|previous)\s+(\d{1,3})\s*(?:seconds?|secs?|s)\b/);
  const mins = lower.match(/(?:last|past|previous)\s+(\d{1,2})\s*(?:minutes?|mins?)\b/);
  return { lookbackSeconds: secs ? clamp(Number(secs[1]), 5, 180) : mins ? clamp(Number(mins[1]) * 60, 5, 180) : null };
}

function firstSentence(text, max = 64) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  let out = (m ? m[1] : s);
  if (out.length > max) out = out.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return out;
}

// Per-line signals. Returns { score, category, reason } for the strongest signal on that line (0 when none).
export function scoreLine(line, prev = null, next = null) {
  const text = String(line.text || "");
  const words = WORDS(text);
  const hits = [];
  const test = (key, category, points, reason) => { if (LEX[key][0].test(text)) hits.push({ category, points, reason }); };
  if (words >= 7) test("opinion", "strong-opinion", 40, "States a firm opinion");
  if (words >= 8) test("insight", "insight", 42, "Explains or reveals something");
  test("surprise", "surprise", 44, "Surprised reaction");
  test("emotional", "emotional", 46, "Personal or emotional statement");
  test("joke", "joke", 44, "Joke or humour");
  test("laughText", "laughter", 48, "Laughter in the transcript");
  test("disagree", "argument", 46, "Pushes back or disagrees");
  if (/[!?]{2,}|!$/.test(text) && words <= 14) hits.push({ category: "surprise", points: 30, reason: "Emphatic delivery" });
  if (words >= 8 && words <= 40 && SENTENCE_END.test(text) && hits.length) hits.forEach((h) => { h.points += 6; });
  if (words < 3) hits.forEach((h) => { h.points -= 10; });
  if (prev && prev.speaker && line.speaker && prev.speaker !== line.speaker && LEX.disagree[0].test(text)) hits.push({ category: "argument", points: 12, reason: "Replies against the previous speaker" });
  // Cut off mid-sentence, or the next speaker starts before this one finishes.
  const interrupted = /(—|--|-)\s*$/.test(text) || (next && line.end != null && next.t < line.end - 0.25 && next.speaker !== line.speaker);
  if (interrupted) hits.push({ category: "interruption", points: 44, reason: "Cut off by another speaker" });
  if (!hits.length) return { score: 0, category: null, reason: "" };
  hits.sort((a, b) => b.points - a.points);
  const bonus = Math.min(14, (hits.length - 1) * 7);
  return { score: clamp(hits[0].points + bonus, 0, 100), category: hits[0].category, reason: hits[0].reason + (hits.length > 1 ? ` and ${hits.slice(1, 3).map((h) => h.reason.toLowerCase()).join(", ")}` : "") };
}

// Candidate moments: line peaks, audio-event peaks, and patterns across several lines (banter, argument, awkward silence).
function findPeaks(lines, events) {
  const peaks = [];
  lines.forEach((line, i) => {
    const s = scoreLine(line, lines[i - 1], lines[i + 1]);
    if (s.score > 0) peaks.push({ t: line.t, end: line.end ?? line.t + Math.max(2, WORDS(line.text) * 0.4), score: s.score, category: s.category, reason: s.reason, speakers: [line.speaker], lineIndex: i });
  });
  // Laughter: strongest when it follows a spoken line (the thing that was funny).
  for (const ev of events) {
    if (ev.type === "laughter") {
      const dur = (ev.end ?? ev.t + 1.5) - ev.t;
      const before = lines.filter((l) => l.t <= ev.t + 0.5 && (l.end ?? l.t + 3) >= ev.t - 6).slice(-1)[0];
      peaks.push({ t: ev.t, end: ev.end ?? ev.t + 1.5, score: clamp(44 + dur * 6 + (before ? 10 : 0), 0, 100), category: "laughter", reason: `Laughter lasting ${round1(dur)} s${before ? " right after a line" : ""}`, speakers: before ? [before.speaker] : [], lineIndex: before ? lines.indexOf(before) : null });
    } else if (ev.type === "spike") {
      peaks.push({ t: ev.t, end: ev.end ?? ev.t + 1, score: 38, category: "surprise", reason: "Sudden loud reaction", speakers: [], lineIndex: null });
    } else if (ev.type === "overlap") {
      peaks.push({ t: ev.t, end: ev.end ?? ev.t + 2, score: 40, category: "interruption", reason: "People talking over each other", speakers: [], lineIndex: null });
    }
  }
  // Awkward silence: a long gap in the middle of a conversation, stronger if a hedge or nervous laugh follows.
  for (let i = 1; i < lines.length; i++) {
    const gapStart = lines[i - 1].end ?? lines[i - 1].t + Math.max(2, WORDS(lines[i - 1].text) * 0.4);
    const gap = lines[i].t - gapStart;
    if (gap >= 3.5 && gap <= 12) {
      const laughAfter = events.some((e) => e.type === "laughter" && e.t >= lines[i].t - 1 && e.t <= lines[i].t + 4);
      const hedge = LEX.hedge[0].test(lines[i].text);
      peaks.push({ t: Math.max(gapStart, lines[i].t - 6), end: lines[i].t + 2, score: clamp(36 + gap * 2 + (hedge ? 8 : 0) + (laughAfter ? 10 : 0), 0, 90), category: laughAfter ? "nervous-laughter" : "awkward-silence", reason: `${round1(gap)} s of silence${laughAfter ? " broken by nervous laughter" : hedge ? " followed by a hesitant reply" : ""}`, speakers: [lines[i - 1].speaker, lines[i].speaker].filter(Boolean), lineIndex: i });
    }
  }
  // Banter: several quick, short turns that alternate between at least two people.
  for (let i = 0; i + 3 < lines.length; i++) {
    const run = lines.slice(i, i + 4);
    const quick = run.every((l, k) => WORDS(l.text) <= 12 && (k === 0 || l.t - (run[k - 1].end ?? run[k - 1].t + 2) <= 2.5));
    const alternates = run.every((l, k) => k === 0 || l.speaker !== run[k - 1].speaker);
    if (quick && alternates && new Set(run.map((l) => l.speaker)).size >= 2) {
      peaks.push({ t: run[0].t, end: run[3].end ?? run[3].t + 3, score: 52 + (run.some((l) => LEX.laughText[0].test(l.text)) ? 12 : 0), category: "banter", reason: "Fast back-and-forth between speakers", speakers: [...new Set(run.map((l) => l.speaker))], lineIndex: i });
      i += 2;
    }
  }
  // Disagreement across speakers.
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].speaker !== lines[i + 1].speaker && LEX.disagree[0].test(lines[i + 1].text) && (LEX.opinion[0].test(lines[i].text) || WORDS(lines[i].text) >= 6)) {
      peaks.push({ t: lines[i].t, end: lines[i + 1].end ?? lines[i + 1].t + 4, score: 60, category: "argument", reason: "One speaker pushes back on another", speakers: [lines[i].speaker, lines[i + 1].speaker], lineIndex: i });
    }
  }
  return peaks;
}

// Widen a peak to the whole moment: the build-up before it (back to a natural pause) and the reaction after it.
function expand(peak, lines, events, duration, limits) {
  let start = peak.t, end = peak.end;
  if (peak.lineIndex != null && lines[peak.lineIndex]) {
    let i = peak.lineIndex;
    while (i > 0 && start - (lines[i - 1].t) <= limits.maxBuildup && (lines[i].t - (lines[i - 1].end ?? lines[i - 1].t + 2)) < 3.5) { i--; start = lines[i].t; if (peak.t - start >= limits.maxBuildup) break; }
    let j = peak.lineIndex;
    while (j + 1 < lines.length && lines[j + 1].t - end <= limits.reactionGap && lines[j + 1].t - peak.end <= limits.maxReaction) { j++; end = Math.max(end, lines[j].end ?? lines[j].t + Math.max(2, WORDS(lines[j].text) * 0.4)); }
  } else {
    start = peak.t - limits.defaultBuildup;
    end = peak.end + limits.defaultReaction;
  }
  // include laughter / reaction that trails the moment
  for (const ev of events) if ((ev.type === "laughter" || ev.type === "spike") && ev.t >= end - 0.5 && ev.t <= end + 3) end = Math.max(end, (ev.end ?? ev.t + 1.5) + 0.6);
  start = Math.max(0, start - 0.5);
  end = Math.min(duration ?? Infinity, end + 1);
  if (end - start < limits.minLength) { const pad = (limits.minLength - (end - start)) / 2; start = Math.max(0, start - pad); end = Math.min(duration ?? Infinity, end + pad + Math.max(0, pad - start)); }
  if (end - start > limits.maxLength) end = start + limits.maxLength;
  return { start: round1(start), end: round1(end) };
}

const DEFAULT_LIMITS = { maxBuildup: 14, reactionGap: 3, maxReaction: 14, defaultBuildup: 6, defaultReaction: 6, minLength: 10, maxLength: 75, mergeLength: 40 };

function titleFor(peak, lines) {
  const line = peak.lineIndex != null ? lines[peak.lineIndex] : null;
  const label = CLIP_CATEGORIES[peak.category] || "Moment";
  if (line && ["strong-opinion", "insight", "surprise", "emotional", "joke", "argument", "interruption"].includes(peak.category)) return firstSentence(line.text);
  if (peak.category === "laughter") return line ? `Everyone laughs: “${firstSentence(line.text, 48)}”` : "Group laughter";
  if (peak.category === "banter") return `${peak.speakers.slice(0, 2).join(" and ")}: quick banter`;
  if (peak.category === "awkward-silence" || peak.category === "nervous-laughter") return peak.category === "nervous-laughter" ? "The awkward pause, then nervous laughter" : "An awkward pause";
  return label;
}

let counter = 0;
const nextId = () => `clip-${Date.now().toString(36)}-${(++counter).toString(36)}`;

// Batch (and the live window) analysis. Overlapping moments merge into one; the best N are returned in time order.
export function detectClips({ lines = [], events = [], duration = null, minScore = 45, max = 12, limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const sorted = [...lines].filter((l) => l && Number.isFinite(l.t)).sort((a, b) => a.t - b.t);
  const evs = [...events].filter((e) => e && Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  const end = duration ?? Math.max(0, ...sorted.map((l) => l.end ?? l.t + 3), ...evs.map((e) => e.end ?? e.t + 2));
  const peaks = findPeaks(sorted, evs).filter((p) => p.score >= minScore);
  const moments = peaks.map((p) => ({ ...expand(p, sorted, evs, end, lim), peak: p, parts: [p] }));
  moments.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const m of moments) {
    const last = merged[merged.length - 1];
    // Only genuinely overlapping moments are one moment; adjacent ones stay separate clips. If joining them would be too long,
    // keep the stronger one.
    if (last && m.start < last.end) {
      if (Math.max(last.end, m.end) - last.start <= lim.mergeLength) {
        last.end = Math.max(last.end, m.end);
        last.parts.push(...m.parts);
        if (m.peak.score > last.peak.score) last.peak = m.peak;
      } else if (m.end - last.end >= lim.minLength) {
        merged.push({ ...m, start: last.end });          // keep both: the later clip starts where the earlier one ends
      } else if (m.peak.score > last.peak.score) merged[merged.length - 1] = { ...m };
    } else merged.push({ ...m });
  }
  const out = merged.map((m) => {
    const categories = [...new Set(m.parts.map((p) => p.category))];
    const score = clamp(Math.round(m.peak.score + Math.min(12, (categories.length - 1) * 6) + Math.min(6, (m.parts.length - 1) * 2)), 0, 100);
    const speakers = [...new Set(m.parts.flatMap((p) => p.speakers))].filter(Boolean);
    const reasons = [...new Set(m.parts.sort((a, b) => b.score - a.score).map((p) => p.reason))].slice(0, 3);
    return { id: nextId(), start: m.start, end: round1(m.end), title: titleFor(m.peak, sorted), category: m.peak.category, categories, score, reason: reasons.join("; "), speakers, source: "auto" };
  });
  return out.sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.start - b.start);
}

// Live detector: keeps a rolling window of recent context, emits new bookmarks as moments complete, and handles the
// spoken "Moxie, clip that" command (bookmark the preceding context, keep capturing until the moment concludes).
export class ClipDetector {
  constructor({ windowSeconds = 150, minScore = 45, settleSeconds = 6, concludeSilence = 2.5, maxOpenSeconds = 90, defaultLookback = 30, onBookmark, onClose } = {}) {
    Object.assign(this, { windowSeconds, minScore, settleSeconds, concludeSilence, maxOpenSeconds, defaultLookback, onBookmark, onClose });
    this.lines = [];
    this.events = [];
    this.bookmarks = [];
    this.open = [];
    this.lastSpeechEnd = 0;
    this.lastEvalAt = -Infinity;
  }

  addTranscript(line) {
    if (!line || !String(line.text || "").trim()) return null;
    const entry = { ...line, end: line.end ?? line.t + Math.max(1.5, WORDS(line.text) * 0.4) };
    const cmd = parseClipCommand(entry.text);
    this.lines.push(entry);
    this.lastSpeechEnd = Math.max(this.lastSpeechEnd, entry.end);
    this._trim(entry.t);
    return cmd ? this.requestClip(entry.t, { lookbackSeconds: cmd.lookbackSeconds, speaker: entry.speaker, commandLine: entry }) : null;
  }

  addAudioEvent(ev) {
    if (!ev) return;
    this.events.push(ev);
    if (ev.type === "laughter" || ev.type === "spike") this.lastSpeechEnd = Math.max(this.lastSpeechEnd, ev.end ?? ev.t + 1);
  }

  _trim(now) {
    const cutoff = now - this.windowSeconds * 3;
    this.lines = this.lines.filter((l) => l.t >= cutoff);
    this.events = this.events.filter((e) => e.t >= cutoff);
  }

  // Start from the last natural pause (within 60 s) so the clip includes the build-up to what was just said.
  _lookbackStart(now, requested, commandLine) {
    if (requested) return Math.max(0, now - requested);
    const lines = this.lines.filter((l) => l.t <= now && l !== commandLine);
    let start = Math.max(0, now - this.defaultLookback);
    for (let i = lines.length - 1; i > 0; i--) {
      const gap = lines[i].t - (lines[i - 1].end ?? lines[i - 1].t + 2);
      if (now - lines[i - 1].t > 60) break;
      if (gap >= 4 && now - lines[i].t >= 8) { start = Math.min(start, lines[i].t - 0.5); break; }
    }
    return Math.max(0, Math.min(start, now - 8));
  }

  requestClip(now, { lookbackSeconds = null, speaker = "", commandLine = null } = {}) {
    const bm = {
      id: nextId(), start: round1(this._lookbackStart(now, lookbackSeconds, commandLine)), end: round1(now + 2), title: "Clipped on request",
      category: "clip-that", categories: ["clip-that"], score: 100, reason: `${speaker ? speaker + " asked" : "Asked"} Moxie to clip it`, speakers: speaker ? [speaker] : [], source: "command", open: true
    };
    // Title from the last substantial line before the command.
    const prior = [...this.lines].reverse().find((l) => l !== commandLine && l.t < now && WORDS(l.text) >= 4);
    if (prior) bm.title = firstSentence(prior.text);
    this.bookmarks.push(bm);
    this.open.push(bm);
    this.onBookmark?.(bm, { open: true });
    return bm;
  }

  // Call regularly with the current recording time. Closes clip-that bookmarks once the moment concludes (silence after
  // the last speech or reaction, a long run, or an explicit stop) and returns the newly detected auto bookmarks.
  tick(now) {
    const closed = [];
    for (const bm of [...this.open]) {
      const quiet = now - this.lastSpeechEnd >= this.concludeSilence && now - bm.start > 5;
      const tooLong = now - bm.start >= this.maxOpenSeconds;
      if (quiet || tooLong) {
        bm.end = round1(Math.min(now, quiet ? this.lastSpeechEnd + 1.2 : now));
        if (bm.end - bm.start < 8) bm.end = round1(bm.start + 8);
        bm.open = false;
        this.open = this.open.filter((o) => o !== bm);
        closed.push(bm);
        this.onClose?.(bm);
      } else bm.end = round1(now + 1);
    }
    const fresh = [];
    if (now - this.lastEvalAt >= 3) {
      this.lastEvalAt = now;
      const recentStart = now - this.windowSeconds;
      const lines = this.lines.filter((l) => l.t >= recentStart);
      const events = this.events.filter((e) => e.t >= recentStart);
      // Only moments that have settled (their reaction had time to arrive) are bookmarked.
      const quietNow = now - this.lastSpeechEnd >= 3;
      const found = detectClips({ lines, events, duration: now, minScore: this.minScore, max: 20 }).filter((c) => quietNow || now - c.end >= this.settleSeconds);
      for (const c of found) {
        if (this.bookmarks.some((b) => b.start < c.end && c.start < b.end)) continue;
        this.bookmarks.push(c);
        fresh.push(c);
        this.onBookmark?.(c, { open: false });
      }
    }
    return { closed, fresh };
  }

  // Everything recorded: the stopped recording's final pass also catches moments that never settled while live.
  finish(now) {
    for (const bm of [...this.open]) { bm.end = round1(Math.max(bm.end, Math.min(now, this.lastSpeechEnd + 1.2))); bm.open = false; this.onClose?.(bm); }
    this.open = [];
    const found = detectClips({ lines: this.lines, events: this.events, duration: now, minScore: this.minScore, max: 20 });
    for (const c of found) {
      if (this.bookmarks.some((b) => b.start < c.end && c.start < b.end)) continue;
      this.bookmarks.push(c);
      this.onBookmark?.(c, { open: false });
    }
    return this.bookmarks.sort((a, b) => a.start - b.start);
  }
}
