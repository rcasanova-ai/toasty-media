import { buildShowContext } from "./show-context.js";
import { ProducerActionType, normalizeActionType, normalizeAutonomy, ProducerAutonomy } from "./producer-persona.js";
import { buildProgramAssetCard } from "./program-renderer.js";

let uid = 0;
function nextId(prefix) { return `${prefix}-${Date.now().toString(36)}-${(uid++).toString(36)}`; }

export const ProducerEntryType = Object.freeze({
  AUDIENCE_QUESTIONS: "audience_questions",
  CONTEXT: "context",
  TRANSITION: "transition",
  TIMING: "timing",
  RESEARCH: "research",
  PRODUCTION_SUGGESTION: "production_suggestion",
  DIRECTIVE: "directive",
  ASSET_PROPOSAL: "asset_proposal",
  WORKING: "working",
  ERROR: "error"
});

// Simple constants, not billing infrastructure: a per-session dollar ceiling on paid-provider spend.
// Soft warning is just a UI color change; hard cutoff silently routes subsequent requests to the free
// heuristic provider for the rest of the session — never an error, never a Host-visible interruption.
export const SOFT_WARNING_USD = 0.25;
export const HARD_CUTOFF_USD = 1.00;

// The host/producer-facing panel is a live PRODUCER FEED, not a chat transcript — a list of typed
// entries, newest first. HostView and ProducerView both read this SAME instance (via session); neither
// keeps its own copy.
export class ProducerFeed {
  constructor() { this.entries = []; this._listeners = new Set(); }

  on(callback) { this._listeners.add(callback); return () => this._listeners.delete(callback); }
  _emit() { this._listeners.forEach((cb) => cb(this.entries)); }

  push(entry) {
    const full = { id: nextId("feed"), createdAt: Date.now(), pinned: false, dismissed: false, items: [], sources: [], ...entry };
    this.entries.unshift(full);
    this._emit();
    return full;
  }

  replace(id, patch) {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index === -1) return;
    this.entries[index] = { ...this.entries[index], ...patch };
    this._emit();
  }

  dismiss(id) { this.replace(id, { dismissed: true }); }
  togglePin(id) { const entry = this.entries.find((e) => e.id === id); if (entry) this.replace(id, { pinned: !entry.pinned }); }
  recent(limit = 10) { return this.entries.slice(0, limit); }
  visible() { return this.entries.filter((e) => !e.dismissed); }
  clear() { this.entries = []; this._emit(); }
}

// Orchestrator: turns a host instruction into a structured feed entry. This is the ONE place that
// checks aiProcessingAllowed — if the policy says no, the provider never even sees the instruction or
// ShowContext, let alone conversation content.
export class AIProducerService {
  constructor({ session, feed, provider }) {
    this.session = session;
    this.feed = feed;
    this.provider = provider;
    // Always available as the hard-cutoff escape hatch below, independent of whatever `provider` is
    // currently configured to (Fallback-wrapping-DeepSeek, or forced-heuristic via the Advanced toggle).
    this._heuristicProvider = new HeuristicAIProducerProvider();
    // Latency breakdown — dev-only, never rendered in Host/Producer UI (item 9: "expose timing in dev
    // diagnostics, NOT Host UI"). Inspect via session.aiProducerService.diagnostics() in devtools.
    this._diagnostics = [];
    // Token/cost totals ARE meant to surface in Producer's UI (ProducerView's diagnostics panel) — see
    // the class comment on ProducerFeed/renderFeedEntry for why that's still never visible in Host View.
    // Only real-provider (DeepSeek/Anthropic) answers contribute; heuristic answers carry no usage and
    // correctly add $0.
    this._sessionTotals = { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0, costKnown: true };
    this._listeners = new Set();
  }

  on(callback) { this._listeners.add(callback); return () => this._listeners.delete(callback); }
  _emit() { this._listeners.forEach((cb) => cb(this.sessionTotals())); }

  diagnostics() { return this._diagnostics.slice(-20); }
  // softWarning/hardCutoff are derived, not stored, so they can never drift out of sync with costUsd.
  sessionTotals() {
    const costUsd = this._sessionTotals.costUsd;
    return { ...this._sessionTotals, softWarning: costUsd >= SOFT_WARNING_USD, hardCutoff: costUsd >= HARD_CUTOFF_USD };
  }

  resetSessionTotals() {
    this._sessionTotals = { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0, costKnown: true };
    this._diagnostics = [];
    this._emit();
  }

  _recordUsage(usage) {
    if (!usage) return;
    const totals = this._sessionTotals;
    totals.requests += 1;
    totals.promptTokens += usage.promptTokens || 0;
    totals.cachedTokens += usage.cacheHitTokens || 0;
    totals.completionTokens += usage.completionTokens || 0;
    if (typeof usage.estimatedCostUsd === "number") totals.costUsd += usage.estimatedCostUsd;
    else totals.costKnown = false; // e.g. Anthropic path: real tokens, no verified price to convert with
    totals.lastProvider = usage.provider;
    totals.lastModel = usage.model;
    this._emit();
  }

  // instructionReadyAt lets the caller (HostView) mark when speech/typed input actually finished, so
  // the diagnostic captures "speech complete -> result rendered", not just the AI call itself.
  async handleInstruction(instructionText, { instructionReadyAt = performance.now() } = {}) {
    if (!instructionText?.trim()) return null;
    if (!this.session.policy.canAiProcess()) {
      return this.feed.push({
        type: ProducerEntryType.ERROR,
        title: "AI Producer unavailable",
        summary: "This session's policy doesn't allow AI processing of conversation content.",
        instruction: instructionText
      });
    }
    const context = buildShowContext(this.session);
    const contextBuiltAt = performance.now();
    const pending = this.feed.push({ type: ProducerEntryType.WORKING, title: "Thinking…", summary: "", instruction: instructionText });
    // Hard cost cutoff: once this session has spent $HARD_CUTOFF_USD on paid-provider calls, silently
    // route to the free heuristic from here on — never an error, never a pause in the show. Checked
    // fresh per request (not cached) so it engages the instant the running total crosses the line, and
    // self-enforces afterward since heuristic answers never add more cost.
    const activeProvider = this.sessionTotals().hardCutoff ? this._heuristicProvider : this.provider;
    // Persona/relationship/tone/autonomy — see js/producer-persona.js. Every provider (DeepSeek via the
    // backend, or the heuristic) gets the SAME persona object; only this line changes which provider
    // answers, never who Toasty Producer sounds like.
    const persona = this.session.persona();
    try {
      const providerCallStartedAt = performance.now();
      const result = await activeProvider.respond(instructionText, context, persona);
      const providerCallEndedAt = performance.now();
      result.action = normalizeActionType(result.action);
      this.feed.replace(pending.id, { ...result, instruction: instructionText, actionStatus: result.action === ProducerActionType.SEND_TO_PROGRAM ? "pending" : null });
      this._recordUsage(result.usage);
      // Autonomy enforcement lives HERE, client-side, never inside a provider response — a model saying
      // "send_to_program" only ever produces a draft unless autonomy is AUTONOMOUS. See sendEntryToProgram.
      if (result.action === ProducerActionType.SEND_TO_PROGRAM && normalizeAutonomy(persona.autonomy) === ProducerAutonomy.AUTONOMOUS) {
        this.sendEntryToProgram(pending.id);
      }
      // Purely a visual flag on the Host's audience list (see AudienceStore.markSurfaced) — never a
      // publish/routing action, so this is safe regardless of autonomy setting.
      if (result.action === ProducerActionType.SURFACE_QUESTION && result.sources?.length) {
        this.session.audience.markSurfaced(result.sources);
      }
      this._diagnostics.push({
        instruction: instructionText,
        contextBuildMs: Math.round(contextBuiltAt - instructionReadyAt),
        providerCallMs: Math.round(providerCallEndedAt - providerCallStartedAt),
        totalMs: Math.round(performance.now() - instructionReadyAt),
        usage: result.usage || null
      });
      return this.feed.entries.find((e) => e.id === pending.id);
    } catch (error) {
      // Never surface a provider name, HTTP status, or stack trace to the Host — FallbackAIProducerProvider
      // already tried the heuristic before this catch runs, so reaching here means even that failed.
      this.feed.replace(pending.id, {
        type: ProducerEntryType.ERROR,
        title: "AI Producer",
        summary: "Producer couldn't complete that request.",
        instruction: instructionText
      });
      throw error;
    }
  }

  // The ONLY path that ever exposes a Producer message beyond the host: called automatically for
  // AUTONOMOUS autonomy, or by a manual Host/Producer click for DRAFT_ONLY/ASK_HOST (see
  // renderFeedEntry's "Send to Program" button). Deliberately plugs into the EXISTING Program Output
  // ticker rather than any new renderer or external posting — see js/producer-persona.js's action model
  // notes on why external X/YT/TG posting isn't wired yet.
  sendEntryToProgram(entryId) {
    const entry = this.feed.entries.find((e) => e.id === entryId);
    if (!entry || entry.action !== ProducerActionType.SEND_TO_PROGRAM || entry.actionStatus === "sent") return;
    this.session.setTicker({ enabled: true, text: entry.summary });
    this.feed.replace(entryId, { actionStatus: "sent" });
  }
}

// ---------------------------------------------------------------------------
// Heuristic provider — genuine algorithmic reasoning over real ShowContext data (keyword relevance,
// near-duplicate clustering, already-covered detection). No LLM call, no canned outputs: every response
// is computed from whatever is actually in the agenda/transcript/audience feed at call time. This is
// the always-available fallback; AnthropicAIProducerProvider below is the real-LLM upgrade path.
// ---------------------------------------------------------------------------

export class HeuristicAIProducerProvider {
  // persona is accepted for interface parity with the LLM-backed providers (see AIProducerService.
  // handleInstruction, which passes the same persona object to whichever provider is active) but isn't
  // used to vary phrasing today: these responses are template-built from real ShowContext data, not
  // generated text, so there's little genuine persona expression to apply without it reading as noise.
  // Every response still defaults to the "private" action via normalizeActionType in handleInstruction.
  async respond(instruction, context, persona) {
    const intent = classifyIntent(instruction);
    if (intent === "audience_questions") return curateAudienceQuestions(instruction, context);
    if (intent === "quiet_participants") return focusGroupParticipation(context);
    if (intent === "research_probe") return focusGroupProbe(context);
    if (intent === "uncovered") return context.researchContext ? focusGroupCoverage(context) : findUncoveredContext(context);
    if (intent === "whats_next") return context.researchContext ? focusGroupNext(context) : whatsNext(context);
    if (intent === "transition") return buildTransition(instruction, context);
    if (intent === "timing") return topicTiming(context);
    if (intent === "recall_speaker") return recallSpeaker(instruction, context);
    return genericFallback(context);
  }
}

function classifyIntent(instructionRaw) {
  const instruction = instructionRaw.toLowerCase();
  // Caught by actually running the spec's own example phrasings, not just reading the code: "Anything
  // good from the audience?" has no word "question" in it at all, so the audience/good-or-best branch
  // has to stand on its own rather than being AND'd with the questions? branch.
  if (/\bquestions?\b/.test(instruction) && /(audience|chat|good|best|any)/.test(instruction)) return "audience_questions";
  if (/audience/.test(instruction) && /(good|best|interesting|anything|any)/.test(instruction)) return "audience_questions";
  if (/who (hasn'?t|has not) (spoken|talked)|quiet participant|bring .* in|not heard from/.test(instruction)) return "quiet_participants";
  if (/what should i (ask|probe)|what.*probe|who disagreed|disagree|push on|follow.?up/.test(instruction)) return "research_probe";
  if (/haven'?t covered|missed anything|anything (else|we)|what are we missing/.test(instruction)) return "uncovered";
  if (/what'?s next|next topic|coming up|ask next/.test(instruction)) return "whats_next";
  if (/transition|segue|move (us )?into|wrap.*into|into (vietnam|canada|thailand|closing)/.test(instruction)) return "transition";
  if (/how long|elapsed|time (on|spent)/.test(instruction)) return "timing";
  if (/remind me|what did .* say|said about/.test(instruction)) return "recall_speaker";
  return "generic";
}

function curateAudienceQuestions(instruction, context) {
  const mentionedTopic = matchAgendaTitleInText(instruction, context.agenda);
  const topic = mentionedTopic || context.currentTopic;
  let candidates = relevantQuestions(context, topic);
  if (topic && candidates.length === 0) candidates = relevantQuestions(context, null);

  const transcriptLineKw = context.transcript.map((line) => keywords(line.text));
  const notObviouslyAnswered = candidates.filter((m) => {
    const kw = keywords(m.message);
    return !transcriptLineKw.some((lineKw) => jaccard(kw, lineKw) >= 0.5);
  });
  const pool = notObviouslyAnswered.length ? notObviouslyAnswered : candidates;

  const groups = clusterSimilar(pool);
  const ranked = groups
    .map((group) => ({ ...group, rep: group.members.slice().sort((a, b) => b.score - a.score)[0] }))
    .sort((a, b) => (b.members.length - a.members.length) || (b.rep.score - a.rep.score));
  const top = ranked.slice(0, 3);
  const groupedAway = pool.length - groups.length;

  return {
    type: ProducerEntryType.AUDIENCE_QUESTIONS,
    title: `Questions · ${topic ? topic.title : "General"}`,
    summary: pool.length
      ? `${context.audienceMessages.length} messages reviewed · ${groupedAway} similar question${groupedAway === 1 ? "" : "s"} grouped`
      : `No audience questions yet${topic ? ` on ${topic.title}` : ""}.`,
    items: top.map((group) => ({ from: group.rep.displayName, text: group.rep.message })),
    sources: top.map((group) => group.rep.id)
  };
}

function findUncoveredContext(context) {
  const topic = context.currentTopic;
  if (!topic) return baseEntry(ProducerEntryType.CONTEXT, "Nothing marked current", "Mark a topic current in Run of Show first.");

  const points = [topic.notes, ...(topic.preparedQuestions || [])]
    .filter(Boolean)
    .flatMap((p) => p.split(/[;.]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const transcriptTexts = context.transcript.map((l) => l.text);
  const uncovered = points.filter((p) => maxJaccardAgainstTexts(p, transcriptTexts) < 0.3);

  if (uncovered.length) {
    return {
      type: ProducerEntryType.CONTEXT,
      title: `Not yet covered · ${topic.title}`,
      summary: `${uncovered.length} of ${points.length} prepared point(s) haven't come up yet.`,
      items: uncovered.map((text) => ({ text }))
    };
  }

  const usedIds = new Set(context.producerHistory.flatMap((h) => h.sources || []));
  const freshQuestions = relevantQuestions(context, topic).filter((q) => !usedIds.has(q.id)).slice(0, 2);
  if (freshQuestions.length) {
    return {
      type: ProducerEntryType.CONTEXT,
      title: `Not yet covered · ${topic.title}`,
      summary: "Prepared points look covered — audience still has live questions on this topic.",
      items: freshQuestions.map((q) => ({ from: q.displayName, text: q.message })),
      sources: freshQuestions.map((q) => q.id)
    };
  }

  return baseEntry(ProducerEntryType.CONTEXT, `Not yet covered · ${topic.title}`, "Looks like the prepared points on this topic have all come up.");
}

function focusGroupCoverage(context) {
  const questions = context.researchContext?.researchQuestions || [];
  if (!questions.length) return baseEntry(ProducerEntryType.CONTEXT, "Research coverage", "No research questions are attached to this session yet.");
  const transcriptTexts = context.transcript.map((l) => l.text);
  const uncovered = questions.filter((q) => maxJaccardAgainstTexts(q, transcriptTexts) < 0.22);
  return {
    type: ProducerEntryType.CONTEXT,
    title: "Research coverage",
    summary: uncovered.length ? `${uncovered.length} research question(s) are not clearly covered yet.` : "The current transcript touches every prepared research question.",
    items: uncovered.slice(0,4).map((text) => ({ text }))
  };
}

function focusGroupParticipation(context) {
  const turns = new Map();
  context.transcript.forEach((l) => turns.set(l.speaker, (turns.get(l.speaker) || 0) + 1));
  (context.guests || []).forEach((g) => { const n=g.displayName; if(n && !turns.has(n)) turns.set(n,0); });
  const ordered=[...turns.entries()].sort((a,b)=>a[1]-b[1]);
  if(!ordered.length) return baseEntry(ProducerEntryType.CONTEXT,"Participation","No participant transcript is available yet.");
  const low=ordered.filter(([,count])=>count<=Math.max(1,ordered[ordered.length-1][1]*0.4)).slice(0,3);
  return {
    type: ProducerEntryType.CONTEXT,
    title:"Bring someone in",
    summary: low.length ? `You have heard least from ${low.map(([name])=>name).join(", ")}.` : "Participation looks reasonably balanced.",
    items: low.map(([name,count])=>({from:name,text:`${count} captured turn${count===1?"":"s"} — ask directly for their view before moving on.`}))
  };
}

function focusGroupProbe(context) {
  const recent=context.transcript.slice(-20);
  const disagreementWords=/\b(but|however|disagree|different|not for me|wouldn'?t|would not|don'?t|do not)\b/i;
  const confusionWords=/\b(confus|unclear|not sure|don'?t understand|do not understand|complicated)\b/i;
  const disagreement=recent.filter(l=>disagreementWords.test(l.text)).slice(-3);
  const confusion=recent.filter(l=>confusionWords.test(l.text)).slice(-3);
  const items=[];
  confusion.forEach(l=>items.push({from:l.speaker,text:`Probe this: “${l.text}” Ask what they expected instead.`}));
  disagreement.forEach(l=>items.push({from:l.speaker,text:`Explore this difference: “${l.text}” Ask what would change their view.`}));
  if(!items.length && recent.length){
    const last=recent[recent.length-1];
    items.push({from:last.speaker,text:`Go one level deeper on: “${last.text}” Ask why that matters to them.`});
  }
  return {
    type:ProducerEntryType.RESEARCH,
    title:"Moderator probe",
    summary:items.length?"Best follow-up opportunities from the recent conversation.":"Not enough transcript yet to suggest a useful probe.",
    items:items.slice(0,4)
  };
}

function focusGroupNext(context) {
  const coverage=focusGroupCoverage(context);
  if(coverage.items?.length) return {
    type:ProducerEntryType.RESEARCH,
    title:"Ask next",
    summary:"Use the next uncovered research question.",
    items:[{text:coverage.items[0].text}]
  };
  return focusGroupProbe(context);
}

function whatsNext(context) {
  const next = context.agenda.find((a) => a.status === "upcoming");
  if (!next) return baseEntry(ProducerEntryType.TIMING, "What's next", "Nothing upcoming — this looks like the last topic.");
  return baseEntry(ProducerEntryType.TIMING, "What's next", next.notes ? `${next.title} — ${next.notes}` : next.title);
}

function buildTransition(instruction, context) {
  const mentioned = matchAgendaTitleInText(instruction, context.agenda);
  const target = mentioned || context.agenda.find((a) => a.status === "upcoming");
  const current = context.currentTopic;
  if (!target) return baseEntry(ProducerEntryType.TRANSITION, "Transition", "No upcoming topic to transition into — check Run of Show.");
  const toPhrase = target.notes ? `${target.title} — ${target.notes}` : target.title;
  return {
    type: ProducerEntryType.TRANSITION,
    title: `Transition · ${target.title}`,
    summary: `That's a natural place to pause on ${current ? current.title : "this"}. Coming up: ${toPhrase}.`,
    items: [{ text: `"So that covers ${current ? current.title : "this"} — let's move to ${target.title}."` }]
  };
}

function topicTiming(context) {
  const topic = context.currentTopic;
  if (!topic) return baseEntry(ProducerEntryType.TIMING, "Timing", "No topic is marked current right now.");
  return baseEntry(ProducerEntryType.TIMING, `Timing · ${topic.title}`, `On ${topic.title} for ${formatDuration(context.topicElapsedMs)}. Show elapsed: ${formatDuration(context.elapsedMs)}.`);
}

function recallSpeaker(instruction, context) {
  const speaker = context.speakers.find((s) => instruction.toLowerCase().includes(s.toLowerCase()));
  const keywordMatch = instruction.match(/about ([a-z0-9-]+)/i);
  const keyword = keywordMatch ? keywordMatch[1] : null;
  const lines = context.transcript.filter((l) =>
    (!speaker || l.speaker === speaker) && (!keyword || l.text.toLowerCase().includes(keyword.toLowerCase()))
  );
  if (!lines.length) {
    return baseEntry(ProducerEntryType.CONTEXT, "Nothing found", speaker ? `Nothing from ${speaker}${keyword ? ` about ${keyword}` : ""} in the recent transcript.` : "Couldn't tell who you meant — try naming them.");
  }
  return {
    type: ProducerEntryType.CONTEXT,
    title: speaker ? `${speaker} said` : "Found in transcript",
    summary: "",
    items: lines.map((l) => ({ from: l.speaker, text: l.text }))
  };
}

function genericFallback(context) {
  if (context.researchContext) {
    const objective=context.researchContext.objective || "the research objective";
    const speakers=context.speakers?.length||0;
    return baseEntry(
      ProducerEntryType.RESEARCH,
      "Research session status",
      `${speakers} speaker${speakers===1?"":"s"} captured. Keep the conversation tied to ${objective}.`
    );
  }
  const topic = context.currentTopic;
  return baseEntry(
    ProducerEntryType.PRODUCTION_SUGGESTION,
    "Show status",
    topic ? `On "${topic.title}" for ${formatDuration(context.topicElapsedMs)}. ${context.audienceMessages.length} audience messages so far.` : "No topic marked current yet."
  );
}

function relevantQuestions(context, topic) {
  const topicKw = topic ? keywords(`${topic.title} ${topic.notes}`) : null;
  return context.audienceMessages
    .filter((m) => m.type === "question")
    .map((m) => ({ ...m, score: topicKw ? overlapScore(keywords(m.message), topicKw) : 1 }))
    .filter((m) => !topicKw || m.score > 0)
    .sort((a, b) => b.score - a.score);
}

// 0.2 looks low for a similarity threshold, but word-level Jaccard on short paraphrased questions
// (7-10 keywords each) genuinely lands in the 0.15-0.3 range even for true near-duplicates — verified
// against the seeded demo script's grid-capacity questions, which only cluster starting around 0.2.
function clusterSimilar(pool) {
  const groups = [];
  pool.forEach((item) => {
    const itemKw = keywords(item.message);
    const group = groups.find((g) => jaccard(itemKw, g.kw) >= 0.2);
    if (group) { group.members.push(item); group.kw = unionSet(group.kw, itemKw); }
    else groups.push({ kw: itemKw, members: [item] });
  });
  return groups;
}

const STOPWORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "for", "and", "or", "but", "this", "that", "these", "those", "it", "its", "as", "at", "by", "with", "from", "about", "into", "if", "so", "we", "you", "your", "our", "they", "them", "i", "do", "does", "did", "not", "no", "also", "just", "can", "could", "would", "should", "will", "have", "has", "had", "what", "when", "where", "why", "how", "who", "which", "there"]);

// Deliberately crude single-suffix stemmer, not real NLP — just enough that "centre"/"centres" and
// "question"/"questions" land on the same keyword. A dedicated "es" rule (boxes -> box) was tried and
// removed: it stemmed "centres" to "centr" while singular "centre" stayed "centre", so plural and
// singular mentions of the same thing silently stopped matching each other — the one case this
// stemmer most needs to get right.
function normalizeWord(word) {
  if (word.length > 6 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function keywords(text) {
  return new Set(
    String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map(normalizeWord)
  );
}

function overlapScore(a, b) { let n = 0; a.forEach((w) => { if (b.has(w)) n++; }); return n; }
function jaccard(a, b) { if (!a.size && !b.size) return 0; let inter = 0; a.forEach((w) => { if (b.has(w)) inter++; }); const union = a.size + b.size - inter; return union === 0 ? 0 : inter / union; }
function unionSet(a, b) { const out = new Set(a); b.forEach((w) => out.add(w)); return out; }
function maxJaccardAgainstTexts(text, texts) { const kw = keywords(text); let max = 0; texts.forEach((t) => { const score = jaccard(kw, keywords(t)); if (score > max) max = score; }); return max; }
function matchAgendaTitleInText(text, agenda) { const lower = text.toLowerCase(); return agenda.find((a) => lower.includes(a.title.toLowerCase())) || null; }
function formatDuration(ms) { const totalSeconds = Math.max(0, Math.floor(ms / 1000)); const minutes = Math.floor(totalSeconds / 60); const seconds = totalSeconds % 60; return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`; }
function baseEntry(type, title, summary) { return { type, title, summary, items: [], sources: [] }; }

// ---------------------------------------------------------------------------
// Real-LLM provider — talks to Toasty's OWN backend (scripts/render-production-server.mjs's
// /api/ai-producer/respond), which holds the Anthropic key server-side and calls Claude from there.
// The browser never sees an API key. Mirrors js/render-client.js's local-vs-production endpoint
// resolution exactly, since this is the same server.
// ---------------------------------------------------------------------------

const LOCAL_AI_PRODUCER_ENDPOINT = "http://127.0.0.1:4174/api/ai-producer/respond";
const PRODUCTION_AI_PRODUCER_ENDPOINT = "https://render.toasty.media/api/ai-producer/respond";

function getAiProducerEndpoint() {
  if (window.TOASTY_AI_PRODUCER_ENDPOINT) return window.TOASTY_AI_PRODUCER_ENDPOINT;
  const host = window.location.hostname;
  return (host === "localhost" || host === "127.0.0.1" || host === "") ? LOCAL_AI_PRODUCER_ENDPOINT : PRODUCTION_AI_PRODUCER_ENDPOINT;
}

export class BackendAIProducerProvider {
  constructor({ timeoutMs = 12000 } = {}) {
    this.timeoutMs = timeoutMs;
  }

  // persona (relationship/tone/autonomy — see js/producer-persona.js) rides in the request body so the
  // backend can compose a persona-aware system prompt itself. The backend is still the ONLY place either
  // provider's API key lives; this never gives the browser a way to reach DeepSeek/Anthropic directly.
  async respond(instruction, context, persona) {
    let response;
    try {
      response = await fetch(getAiProducerEndpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction, context, persona }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new Error("ai-producer-backend-unreachable");
    }
    if (!response.ok) throw new Error(`ai-producer-backend-${response.status}`);
    const parsed = await response.json();
    if (!Object.values(ProducerEntryType).includes(parsed.type)) parsed.type = ProducerEntryType.PRODUCTION_SUGGESTION;
    // usage rides along on the entry for Producer diagnostics only (see AIProducerService._recordUsage
    // and renderFeedEntry, which never reads it) — it never enters the {type,title,summary,items,sources}
    // contract Host View actually renders from.
    return { type: parsed.type, title: parsed.title || "AI Producer", summary: parsed.summary || "", items: Array.isArray(parsed.items) ? parsed.items : [], action: parsed.action, sources: Array.isArray(parsed.sources) ? parsed.sources : [], usage: parsed.usage || null };
  }
}

// Tries the real backend first; ANY failure (unreachable, timeout, non-200, malformed JSON) falls back
// to the heuristic provider silently — the Host never sees a provider name, HTTP status, or stack trace
// (see AIProducerService.handleInstruction's own catch for the last-resort case where even that fails).
export class FallbackAIProducerProvider {
  constructor({ primary, fallback }) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async respond(instruction, context, persona) {
    try {
      return await this.primary.respond(instruction, context, persona);
    } catch (error) {
      console.warn("AI Producer backend unavailable, falling back to heuristic:", error?.message || error);
      return this.fallback.respond(instruction, context, persona);
    }
  }
}

export function createAIProducerProvider({ useBackend = true } = {}) {
  const heuristic = new HeuristicAIProducerProvider();
  return useBackend ? new FallbackAIProducerProvider({ primary: new BackendAIProducerProvider(), fallback: heuristic }) : heuristic;
}

// ---------------------------------------------------------------------------
// Shared render helper — HostView and ProducerView both use this so the feed renders identically in
// both places (only the mirror in ProducerView omits dismiss/pin controls).
// ---------------------------------------------------------------------------

const ACTION_LABELS = {
  [ProducerActionType.SURFACE_QUESTION]: "Surfaced for host",
  [ProducerActionType.DRAFT_AUDIENCE_REPLY]: "Draft audience reply",
  [ProducerActionType.SEND_TO_PROGRAM]: "Program Output"
};

export function renderFeedEntry(entry, {
  onDismiss,
  onPin,
  onSendToProgram,
  onTakeLive,
  onFindAnother,
  onDiscardProposal,
  onRetryResearch,
  onRemoveAsset,
  onApproveMoxieProposal,
  onDismissMoxieProposal,
  onPreview
} = {}) {
  const el = document.createElement("article");
  el.className = "lv-feed-entry";
  el.dataset.type = entry.type;
  if (entry.pinned) el.dataset.pinned = "true";

  const head = document.createElement("div");
  head.className = "lv-feed-entry-head";
  const title = document.createElement("span");
  title.className = "lv-feed-entry-title";
  title.textContent = entry.title || (entry.type === ProducerEntryType.WORKING ? "Thinking…" : "");
  head.appendChild(title);

  if (onDismiss || onPin) {
    const actions = document.createElement("span");
    actions.className = "lv-feed-entry-actions";
    if (onPin) {
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "lv-feed-mini-btn";
      pinBtn.textContent = entry.pinned ? "Unpin" : "Pin";
      pinBtn.addEventListener("click", () => onPin(entry.id));
      actions.appendChild(pinBtn);
    }
    if (onDismiss) {
      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "lv-feed-mini-btn";
      dismissBtn.textContent = "×";
      dismissBtn.setAttribute("aria-label", "Dismiss");
      dismissBtn.addEventListener("click", () => onDismiss(entry.id));
      actions.appendChild(dismissBtn);
    }
    head.appendChild(actions);
  }
  el.appendChild(head);

  if (entry.instruction) {
    const instructionEl = document.createElement("p");
    instructionEl.className = "lv-feed-entry-instruction";
    instructionEl.textContent = `“${entry.instruction}”`;
    el.appendChild(instructionEl);
  }

  if (entry.summary) {
    const summaryEl = document.createElement("p");
    summaryEl.className = "lv-feed-entry-summary";
    summaryEl.textContent = entry.summary;
    el.appendChild(summaryEl);
  }

  if (entry.items?.length) {
    const list = document.createElement("ul");
    list.className = "lv-feed-entry-items";
    entry.items.forEach((item) => {
      const li = document.createElement("li");
      if (item.from) {
        const star = entry.type === ProducerEntryType.AUDIENCE_QUESTIONS ? "★ " : "";
        const from = document.createElement("strong");
        from.textContent = `${star}${item.from}`;
        li.appendChild(from);
      }
      const text = document.createElement("span");
      text.textContent = item.text;
      li.appendChild(text);
      list.appendChild(li);
    });
    el.appendChild(list);
  }

  // PRIVATE (the default) never renders a badge — that's the normal, expected case and shouldn't
  // compete for attention. Only the three audience-facing actions get a visible marker, and only
  // SEND_TO_PROGRAM while still pending gets a confirm control — see AIProducerService.sendEntryToProgram
  // for why this button, not autonomy, is what actually gates anything reaching Program Output.
  const proposal = entry.proposal;
  if (proposal?.asset && !proposal.exhausted) {
    const preview = document.createElement("div");
    preview.className = "lv-feed-asset-preview";
    preview.appendChild(buildProgramAssetCard(proposal.asset));
    el.appendChild(preview);
  }

  if (entry.type === ProducerEntryType.ASSET_PROPOSAL || entry.retryDirectiveId || proposal?.exhausted) {
    const actionRow = document.createElement("div");
    actionRow.className = "lv-feed-entry-action lv-feed-entry-action--producer";
    if (proposal?.live && onRemoveAsset) {
      actionRow.appendChild(feedButton("REMOVE", () => onRemoveAsset(entry.id)));
    } else     if (proposal?.requiresApproval) {
      if (onPreview) actionRow.appendChild(feedButton("PREVIEW", () => onPreview(entry.id)));
      const sourceUrl = proposal.asset?.sourceUrl;
      if (sourceUrl) {
        actionRow.appendChild(feedButton("OPEN SOURCE", () => window.open(sourceUrl, "_blank", "noopener,noreferrer")));
      }
      if (onTakeLive) actionRow.appendChild(feedButton("TAKE LIVE", () => onTakeLive(entry.id), true));
      if (onFindAnother) actionRow.appendChild(feedButton("FIND ANOTHER", () => onFindAnother(entry.id)));
      if (onDiscardProposal) actionRow.appendChild(feedButton("DISMISS", () => onDiscardProposal(entry.id)));
    } else if (onRetryResearch && (entry.retryDirectiveId || proposal?.exhausted)) {
      actionRow.appendChild(feedButton("TRY AGAIN", () => onRetryResearch(entry.id)));
    }
    if (actionRow.childNodes.length) el.appendChild(actionRow);
  }

  // Moxie's own structured proposals (js/hottie-show-runner.js) — SEPARATE from the ASSET_PROPOSAL row
  // above (a Moxie proposal's action is already a complete ProgramController action, not a research
  // candidate). AUDIT REPAIR: this branch didn't exist before — PRODUCTION_SUGGESTION entries rendered
  // with no action row at all, so requiresApproval could never actually be satisfied by anything a
  // Producer could click. See js/live-producer.js's approveMoxieProposal for the execute() call this
  // triggers.
  if (entry.type === ProducerEntryType.PRODUCTION_SUGGESTION && proposal?.requiresApproval && !proposal?.executed) {
    const actionRow = document.createElement("div");
    actionRow.className = "lv-feed-entry-action lv-feed-entry-action--producer";
    if (proposal.doing) {
      const pending = document.createElement("span");
      pending.className = "lv-feed-action-badge";
      pending.textContent = "Applying…";
      actionRow.appendChild(pending);
    } else {
      if (onApproveMoxieProposal) actionRow.appendChild(feedButton("APPROVE", () => onApproveMoxieProposal(entry.id), true));
      if (onDismissMoxieProposal) actionRow.appendChild(feedButton("DISMISS", () => onDismissMoxieProposal(entry.id)));
    }
    if (actionRow.childNodes.length) el.appendChild(actionRow);
  }

  if (entry.action && entry.action !== ProducerActionType.PRIVATE) {
    const actionRow = document.createElement("div");
    actionRow.className = "lv-feed-entry-action";
    const badge = document.createElement("span");
    badge.className = "lv-feed-action-badge";
    badge.dataset.action = entry.action;
    badge.textContent = entry.actionStatus === "sent" ? "Sent to Program" : (ACTION_LABELS[entry.action] || entry.action);
    actionRow.appendChild(badge);
    if (entry.action === ProducerActionType.SEND_TO_PROGRAM && entry.actionStatus === "pending" && onSendToProgram) {
      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.className = "lv-feed-mini-btn";
      sendBtn.textContent = "Send to Program";
      sendBtn.addEventListener("click", () => onSendToProgram(entry.id));
      actionRow.appendChild(sendBtn);
    }
    el.appendChild(actionRow);
  }

  return el;
}

function feedButton(label, onClick, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = primary ? "lv-feed-mini-btn lv-feed-mini-btn--primary" : "lv-feed-mini-btn";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}
