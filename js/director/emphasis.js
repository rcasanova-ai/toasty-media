// Which words and statements deserve emphasis. Every score is built from signals that can be pointed at: how rare and weighty the
// word is, whether it is a number or an absolute, how significant Moxie found the sentence it sits in, and whether the voice
// itself rose, jumped in pitch or slowed down on it. Nothing here claims to know what anyone felt.
const STOP = new Set("a an the and or but if so of to in on at for with as is are was were be been being it its this that these those i you he she we they me my your our their there here then than just very really about from by not no do does did have has had will would can could should what which who when where how also".split(" "));
const ABSOLUTE = /^(never|always|every|everyone|everything|nothing|nobody|only|biggest|best|worst|most|least|huge|massive|impossible|ridiculous|incredible|critical|secret|mistake|truth|real|wrong|stop|zero|free|entire|whole)$/i;
const CONTRAST = /^(but|however|instead|actually|except|unless)$/i;
const NUMERIC = /^[$€£]?\d[\d,.]*(%|k|m|x)?$|^(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|percent)$/i;
const clean = (w) => String(w).replace(/^[^\w$€£]+|[^\w%]+$/g, "");

export function isContentWord(w) { const c = clean(w).toLowerCase(); return c.length > 2 && !STOP.has(c); }

// words: [{text,start,end,line}] (source time). unitSig: (srcTime) -> 0..1 significance of the sentence at that time.
// voiceEvents: audio-track events [{type,t,end,strength}]. Returns the words with `emphasis` 0..1 and `why[]`.
export function scoreWords(words, { unitSig = () => 0.3, voiceEvents = [] } = {}) {
  const freq = new Map();
  for (const w of words) { const c = clean(w.text).toLowerCase(); freq.set(c, (freq.get(c) || 0) + 1); }
  const voice = voiceEvents.filter((e) => ["intensity-rise", "pitch-jump", "speech-slower", "pitch-variation"].includes(e.type));
  return words.map((w, i) => {
    const c = clean(w.text), lc = c.toLowerCase(), why = []; let s = 0;
    if (!isContentWord(w.text)) return { ...w, emphasis: 0, why };
    if (NUMERIC.test(c)) { s += 0.5; why.push("number"); }
    if (ABSOLUTE.test(c)) { s += 0.4; why.push("absolute or superlative"); }
    if (CONTRAST.test(c)) { s += 0.15; why.push("contrast"); }
    if (i > 0 && /^(not|never|no|don't|dont|doesn't|isn't|won't)$/i.test(clean(words[i - 1].text)) && c.length > 2) { s += 0.2; why.push("negated"); }
    if (/[A-Z]/.test(c[0]) && i > 0 && !/[.!?]$/.test(words[i - 1].text) && c.length > 2) { s += 0.25; why.push("proper noun"); }
    if (c.length >= 8) { s += 0.12; why.push("long word"); }
    if (freq.get(lc) === 1) { s += 0.1; why.push("appears once"); }
    const sig = unitSig((w.start + w.end) / 2); if (sig > 0.5) { s += 0.25 * sig; why.push("in a significant sentence"); }
    const v = voice.find((e) => e.t <= w.end + 0.15 && e.end >= w.start - 0.15);
    if (v) { s += 0.3 + 0.2 * (v.strength || 0); why.push(`voice: ${v.type.replace("-", " ")}`); }
    if (/[!?]$/.test(w.text)) { s += 0.1; why.push("ends in ! or ?"); }
    return { ...w, emphasis: Math.min(1, s), why };
  });
}

// Short phrase around the best word of a sentence, for a pull-out title: the sentence's own words, never invented.
export function keyPhrase(wordsOfLine, maxWords = 6) {
  if (!wordsOfLine.length) return null;
  let best = 0; wordsOfLine.forEach((w, i) => { if ((w.emphasis || 0) > (wordsOfLine[best].emphasis || 0)) best = i; });
  // a phrase never crosses a sentence boundary: stay inside the sentence the best word is in
  let lo = best, hi = best;
  while (lo > 0 && !/[.!?]$/.test(wordsOfLine[lo - 1].text)) lo--;
  while (hi < wordsOfLine.length - 1 && !/[.!?]$/.test(wordsOfLine[hi].text)) hi++;
  let a = best, b = best;
  while (b - a + 1 < maxWords) {
    const left = a > lo ? (wordsOfLine[a - 1].emphasis || 0) + (isContentWord(wordsOfLine[a - 1].text) ? 0.2 : 0) : -1, right = b < hi ? (wordsOfLine[b + 1].emphasis || 0) + (isContentWord(wordsOfLine[b + 1].text) ? 0.2 : 0) : -1;
    if (left < 0 && right < 0) break;
    if (right >= left) b++; else a--;
    if (/[,;:]$/.test(wordsOfLine[b].text) && b - a + 1 >= 3) break;
  }
  while (a < b && !isContentWord(wordsOfLine[a].text)) a++;
  while (b > a && !isContentWord(wordsOfLine[b].text)) b--;
  const slice = wordsOfLine.slice(a, b + 1);
  return { text: slice.map((w) => w.text).join(" ").replace(/[,;:.!?]+$/, "").replace(/^[^\w$€£"“]+/, ""), start: slice[0].start, end: slice[slice.length - 1].end, words: slice };
}

// Numbers worth a stat card, taken verbatim from the transcript: "73%", "$2 million", "three steps".
export function findStats(lines) {
  const out = [];
  const re = /(\$?\d[\d,.]*\s?(?:%|percent|million|billion|thousand|k|x)?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:times|steps|things|reasons|ways|rules|questions|mistakes|people|hours|days|weeks|months|years)\b)(?:\s+(?:of\s+)?([a-z][a-z' -]{2,28}))?/gi;
  (lines || []).forEach((l, i) => {
    for (const m of String(l.text || "").matchAll(re)) {
      const value = m[1].trim(); if (!/\d|percent/i.test(value) && !/^(one|two|three|four|five|six|seven|eight|nine|ten)/i.test(value)) continue;
      const label = (m[2] || "").trim().split(/\s+/).slice(0, 4).join(" ");
      if (/^\d{1,2}$/.test(value) && !label) continue;                 // a bare small number is rarely a statistic
      out.push({ line: i, t: l.t, value, label, text: m[0].trim() });
      break;
    }
  });
  return out;
}

// "first ... second ... third ...": steps for a simple diagram, each a few of the speaker's own words.
export function findSteps(lines) {
  const order = { first: 1, second: 2, third: 3, fourth: 4, finally: 4 };
  const hits = [];
  (lines || []).forEach((l, i) => {
    for (const m of String(l.text || "").matchAll(/\b(first|second|third|fourth|finally)\b[,:]?\s+((?:[\w'-]+\s*){2,5})/gi)) {
      hits.push({ line: i, t: l.t, order: order[m[1].toLowerCase()], label: m[2].trim().replace(/[.,;:]+$/, "").replace(/\s+(is|are|was|and|to|the|a|of)$/i, ""), index: m.index });
    }
  });
  const seq = []; let want = 1;
  for (const h of hits) if (h.order === want) { seq.push(h); want++; }
  return seq.length >= 3 && seq[seq.length - 1].t - seq[0].t <= 40 ? seq.slice(0, 4) : [];
}
