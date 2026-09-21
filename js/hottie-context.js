// Conversational reference resolution for live production speech.
// "pull THAT up" / "what did SHE say" must bind to session entities, never guess.

const DEICTIC = /\b(that|this|it|those|these|the other|the same|his|her|she|he|him|them|their)\b/i;
const ARTICLEISH = /\b(article|repo|repository|link|url|page|site|paper|source|story)\b/i;
const IMAGEISH = /\b(picture|photo|image|shot|graphic)\b/i;
const PERSONISH = /\b(he|she|him|her|his|their|they)\b/i;

export const REFERENCE_CONFIDENCE = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low"
});

const STOP = new Set(["that", "this", "with", "from", "about", "have", "been", "they", "them", "their", "what", "when", "hottie", "toasty"]);

export function tokenizeMeaningful(text) {
  return [...new Set(String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9.-]{2,}/g) || [])]
    .filter((word) => !STOP.has(word));
}

export function extractEntitiesFromText(text, { speaker = "", timestamp = Date.now() } = {}) {
  const raw = String(text || "");
  const entities = [];
  const urls = raw.match(/https?:\/\/[^\s)]+/gi) || [];
  urls.forEach((url) => {
    entities.push({ type: "url", value: url, label: url, timestamp, speaker, confidence: 1 });
  });
  const quoted = raw.match(/[“"]([^”"]{3,80})[”"]/g) || [];
  quoted.forEach((chunk) => {
    const value = chunk.replace(/[“”"]/g, "").trim();
    if (value) entities.push({ type: "quote", value, label: value, timestamp, speaker, confidence: 0.8 });
  });
  const proper = raw.match(/\b[A-Z][A-Za-z0-9.+-]{2,}(?:\s+[A-Z][A-Za-z0-9.+-]{2,}){0,3}\b/g) || [];
  proper.forEach((value) => {
    if (/^(Hottie|Toasty|Host|I|We)$/i.test(value)) return;
    entities.push({ type: "name", value, label: value, timestamp, speaker, confidence: 0.55 });
  });
  return entities;
}

export function resolveReferences(text, context = {}) {
  const raw = String(text || "").trim();
  const deictic = DEICTIC.test(raw);
  const wantsArticle = ARTICLEISH.test(raw);
  const wantsImage = IMAGEISH.test(raw);
  const wantsPerson = PERSONISH.test(raw);
  const participants = context.participants || [];
  const entities = [...(context.entities || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const research = [...(context.researchResults || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const programAsset = context.programAsset || null;
  const transcript = context.transcript || [];

  const bits = tokenizeMeaningful(raw).filter((word) => !["article", "picture", "photo", "image", "one", "repo", "source"].includes(word));
  if (bits.length >= 2) {
    return {
      text: raw,
      resolvedQuery: raw,
      referents: [],
      confidence: 1,
      confidenceBand: REFERENCE_CONFIDENCE.HIGH,
      needsClarification: false,
      clarification: null
    };
  }

  if (!deictic && !/\bthe (other|same|last)\b/i.test(raw)) {
    return {
      text: raw,
      resolvedQuery: raw,
      referents: [],
      confidence: 1,
      confidenceBand: REFERENCE_CONFIDENCE.HIGH,
      needsClarification: false,
      clarification: null
    };
  }

  const candidates = [];
  if (programAsset?.title) {
    candidates.push({
      type: wantsImage ? "image" : "asset",
      value: programAsset.title,
      label: programAsset.title,
      sourceUrl: programAsset.sourceUrl,
      confidence: 0.72
    });
  }
  research.forEach((item) => {
    candidates.push({
      type: item.type || "research",
      value: item.query || item.title,
      label: item.title || item.query,
      sourceUrl: item.sourceUrl,
      confidence: 0.8
    });
  });
  entities.forEach((item) => {
    if (wantsArticle && item.type === "image") return;
    if (wantsImage && item.type === "url") return;
    candidates.push({ ...item, confidence: Math.min(0.7, item.confidence || 0.5) });
  });

  if (wantsPerson) {
    const speakers = [...new Set(transcript.slice(-12).map((line) => line.speaker).filter((name) => name && name !== context.currentSpeaker))];
    speakers.forEach((name) => {
      const person = participants.find((p) => p.displayName === name);
      candidates.push({
        type: "person",
        value: name,
        label: name,
        participantId: person?.participantId || null,
        confidence: speakers.length === 1 ? 0.85 : 0.4
      });
    });
  }

  const unique = [];
  const seen = new Set();
  candidates.forEach((item) => {
    const key = `${item.type}:${String(item.value || "").toLowerCase()}`;
    if (!item.value || seen.has(key)) return;
    seen.add(key);
    unique.push(item);
  });

  if (!unique.length) {
    return {
      text: raw,
      resolvedQuery: raw,
      referents: [],
      confidence: 0.2,
      confidenceBand: REFERENCE_CONFIDENCE.LOW,
      needsClarification: true,
      clarification: "I heard the request but couldn't resolve what 'that' refers to."
    };
  }

  if (unique.length > 1 && (unique[0].confidence < 0.75 || unique[0].confidence - unique[1].confidence < 0.2) && unique[1].confidence > 0.45) {
    const a = unique[0].label;
    const b = unique[1].label;
    return {
      text: raw,
      resolvedQuery: raw,
      referents: unique.slice(0, 3),
      confidence: 0.35,
      confidenceBand: REFERENCE_CONFIDENCE.LOW,
      needsClarification: true,
      clarification: `Do you mean ${a} or ${b}?`
    };
  }

  const best = unique[0];
  const resolvedQuery = raw
    .replace(/\b(that|this|it|the other one|the other)\b/gi, best.label)
    .replace(/\b(look|pull|find|show)\s+\1\b/gi, `$1 ${best.label}`);
  return {
    text: raw,
    resolvedQuery: resolvedQuery || best.label,
    referents: [best],
    confidence: best.confidence,
    confidenceBand: best.confidence >= 0.7 ? REFERENCE_CONFIDENCE.HIGH : REFERENCE_CONFIDENCE.MEDIUM,
    needsClarification: best.confidence < 0.45,
    clarification: best.confidence < 0.45 ? `Do you mean ${best.label}?` : null
  };
}

export function recallTranscript(transcript = [], { speakerName = "", topic = "", query = "", limit = 5 } = {}) {
  const speaker = String(speakerName || "").toLowerCase();
  const topicBits = tokenizeMeaningful(topic || query);
  const matches = (transcript || []).filter((line) => {
    if (speaker && !String(line.speaker || "").toLowerCase().includes(speaker)) return false;
    if (!topicBits.length) return Boolean(speaker);
    const hay = String(line.text || "").toLowerCase();
    return topicBits.some((bit) => hay.includes(bit));
  });
  return matches.slice(-limit);
}
