// Optional B-roll from the user's OWN files. Footage is never invented and never used just to fill a gap: a clip is placed only
// where a word the speaker says matches one of that clip's tags (its file name words, or tags the user typed). Where nothing
// matches, the original camera, typography or graphics carry the moment.
const STOP = new Set("the and for with from this that into your our video clip footage broll b roll mp4 mov webm m4v final new copy untitled img".split(" "));
const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, "");
export const tagsFromName = (name) => [...new Set(String(name).replace(/\.[a-z0-9]{2,4}$/i, "").split(/[^A-Za-z0-9]+/).map(norm).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)))];

// library: [{ id, name, duration, tags[] }]; words: plan words (output time); returns [{ start, end, clip, srcStart, word, reason }]
export function placeBroll({ library, words, segments, contentSeconds, maxShare = 0.25, minGap = 3, hold = 2.4 }) {
  const out = [];
  if (!library?.length || !words?.length) return { items: out, notes: library?.length ? ["No spoken word matched the tags of your B-roll, so none was used."] : [] };
  let used = 0; const usedClips = new Map();
  for (const w of words) {
    const key = norm(w.text); if (key.length < 3) continue;
    const clip = library.find((c) => (c.tags || tagsFromName(c.name)).some((t) => t === key || (t.length > 4 && key.startsWith(t)) || (key.length > 4 && t.startsWith(key))));
    if (!clip) continue;
    const seg = segments.find((s) => w.start >= s.outStart && w.start < s.outEnd); if (!seg) continue;
    const start = Math.max(seg.outStart + 0.3, w.start - 0.1), len = Math.min(hold, clip.duration || hold, seg.outEnd - start - 0.2);
    if (len < 1) continue;
    if (out.length && start < out[out.length - 1].end + minGap) continue;
    if ((used + len) / Math.max(1, contentSeconds) > maxShare) continue;
    const n = usedClips.get(clip.id) || 0; usedClips.set(clip.id, n + 1);
    out.push({ start: +start.toFixed(3), end: +(start + len).toFixed(3), clip: clip.id, name: clip.name, srcStart: Math.min(Math.max(0, (clip.duration || len) - len), n * len), word: w.text, reason: `the speaker says “${w.text}”, a tag of ${clip.name}` });
    used += len;
  }
  return { items: out, notes: out.length ? [] : ["No spoken word matched the tags of your B-roll, so none was used."] };
}
