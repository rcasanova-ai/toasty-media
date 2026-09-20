// Continuous live-producer awareness. Deterministic: consumes attributed transcript lines,
// compact show memory, Run of Show, and research context. Does NOT call an LLM per sentence.
//
// LLM reasoning stays in AIProducerService.handleInstruction (explicit Host typed/spoken
// requests). This module fires structured events when something useful happens; this slice
// surfaces a subset of those events privately on the existing ProducerFeed.
//
// FIND directives are executed here as structured research → ProgramAsset proposal. TAKE LIVE
// is NOT executed here — ProgramController is the only path onto Program Output.

import { ProducerEntryType } from "./ai-producer.js";
import { detectHostDirective, DirectiveIntent, DirectiveStatus, HottieStatus, productionActionFromDirective } from "./host-directive.js";
import { attributeTranscriptLine } from "./show-context.js";
import { programAssetFromCandidate, ProgramAssetStatus, serializeProgramAsset } from "./program-asset.js";
import { ProductionActionType } from "./production-controller.js";
import { ProgramLayout } from "./program-composition.js";
import { createResearchProvider } from "./hottie-research.js";
import { resolveSoundCommand } from "./soundboard.js";
import { ProductionEventType } from "./production-timeline.js";

export const ProducerEventType = Object.freeze({
  HOST_DIRECTIVE: "host_directive",
  TOPIC_CHANGED: "topic_changed",
  RUN_OF_SHOW_TIMING: "run_of_show_timing",
  AUDIENCE_QUESTION_CLUSTER: "audience_question_cluster",
  RESEARCH_QUESTION_UNCOVERED: "research_question_uncovered",
  PARTICIPANT_QUIET: "participant_quiet",
  DISAGREEMENT: "disagreement",
  PRODUCER_REQUEST: "producer_request",
  CONTEXT_CHECKPOINT: "context_checkpoint",
  ASSET_PROPOSED: "asset_proposed"
});

const DISAGREEMENT = /\b(i disagree|disagree|that'?s not (true|right)|i wouldn'?t use|not for me)\b/i;
const CHECKPOINT_EVERY = 4;

export function ingestAttributedTranscript(session, rawLine) {
  if (!session?.policy?.canTranscribe()) return null;
  const attributed = attributeTranscriptLine(rawLine, session.participants);
  if (!attributed?.text) return null;
  const line = session.transcript.append(attributed);
  session.showMemory?.observe(line);
  session.liveProducer?.observe(line);
  return line;
}

export class LiveProducerController {
  constructor(session) {
    this.session = session;
    this._listeners = new Set();
    this._notified = new Set();
    this._sinceCheckpoint = 0;
    this._lastTopicId = session?.runOfShow?.current()?.id || null;
    this._researchJobs = new Map();
    this._inflight = Promise.resolve();
    this.status = HottieStatus.LISTENING;
  }

  onEvent(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _emit(event) {
    this._listeners.forEach((callback) => callback(event));
  }

  resetNotices() {
    this._notified.clear();
    this._sinceCheckpoint = 0;
    this._researchJobs.clear();
  }

  observe(line) {
    if (!line?.text) return;
    if (!this.session.policy.canAiProcess()) return;

    const directive = detectHostDirective(line, {
      participants: this.session.participants?.list?.() || []
    });
    if (directive) {
      this.session.hostDirectives?.push(directive);
      this.session.showMemory?.rememberDirective(directive);
      this._emit({ type: ProducerEventType.HOST_DIRECTIVE, directive, line });
      if (directive.intent === DirectiveIntent.FIND) {
        this.setStatus(HottieStatus.RESEARCHING, { label: "FIND", query: directive.payload?.query });
        this._inflight = this.runFindDirective(directive);
        void this._inflight;
      } else {
        this._handleProductionDirective(directive);
      }
      this._sinceCheckpoint += 1;
      if (this._sinceCheckpoint >= CHECKPOINT_EVERY) this.checkpoint();
      return;
    }

    if (DISAGREEMENT.test(line.text) && line.role !== "host") {
      const key = `disagree:${line.id}`;
      if (!this._notified.has(key)) {
        this._notified.add(key);
        this._pushFeed({
          type: ProducerEntryType.CONTEXT,
          title: "Disagreement",
          summary: `${line.speaker} pushed back.`,
          items: [{ from: line.speaker, text: line.text }]
        });
        this._emit({ type: ProducerEventType.DISAGREEMENT, line });
      }
    }

    this._sinceCheckpoint += 1;
    if (this._sinceCheckpoint >= CHECKPOINT_EVERY) this.checkpoint();
  }

  async ready() {
    await this._inflight;
  }

  onShowAgendaChanged() {
    if (!this.session.policy.canAiProcess()) return;
    const topic = this.session.runOfShow?.current();
    const topicId = topic?.id || null;
    if (topicId === this._lastTopicId) return;
    this._lastTopicId = topicId;
    this._notified.forEach((key) => {
      if (key.startsWith("quiet:") || key.startsWith("uncovered:")) this._notified.delete(key);
    });
    this._emit({ type: ProducerEventType.TOPIC_CHANGED, topicId, title: topic?.title || "" });
  }

  checkpoint() {
    this._sinceCheckpoint = 0;
    if (!this.session.policy.canAiProcess()) return;
    this._emit({ type: ProducerEventType.CONTEXT_CHECKPOINT });
    this._noticeQuietParticipants();
    this._noticeUncoveredQuestions();
    this.session.proposeHottieLoop?.();
  }

  async runFindDirective(directive, { feedEntryId = null } = {}) {
    if (!this.session.policy.canAiProcess()) return null;
    const query = directive.payload?.query || directive.rawText;
    this.session.productionLog?.record(ProductionActionType.RESEARCH_REQUEST, {
      directiveId: directive.id,
      query
    });
    this.setStatus(HottieStatus.RESEARCHING, { label: "FIND", query });
    const working = feedEntryId
      ? this.session.aiProducerFeed.replace(feedEntryId, {
        type: ProducerEntryType.WORKING,
        title: "Looking for a source…",
        instruction: directive.rawText,
        summary: `Find: “${query}”`,
        proposal: null
      })
      : this._pushFeed({
        type: ProducerEntryType.WORKING,
        title: "Looking for a source…",
        instruction: directive.rawText,
        summary: `Find: “${query}”`
      });
    const entryId = feedEntryId || working?.id;
    try {
      const provider = this.session.researchProvider || createResearchProvider({ preferSeeded: this.session.demoMode });
      const candidates = (await provider.search(query)).filter(Boolean);
      if (!candidates.length) {
        this._failResearch(entryId, directive, query);
        return null;
      }
      return this._proposeCandidate({ directive, query, candidates, index: 0, feedEntryId: entryId });
    } catch (_) {
      this._failResearch(entryId, directive, query);
      return null;
    }
  }

  findAnother(feedEntryId) {
    const job = [...this._researchJobs.values()].find((item) => item.feedEntryId === feedEntryId);
    if (!job) return null;
    const nextIndex = job.index + 1;
    if (nextIndex >= job.candidates.length) {
      this.session.aiProducerFeed.replace(feedEntryId, {
        type: ProducerEntryType.RESEARCH,
        title: "No other source",
        instruction: job.directive.rawText,
        summary: "I don’t have another source I trust enough to put on screen.",
        items: [{ text: job.query }],
        proposal: { ...job, exhausted: true, asset: null },
        retryDirectiveId: job.directive.id
      });
      return null;
    }
    this.session.productionLog?.record(ProductionActionType.SELECT_CANDIDATE, {
      directiveId: job.directive.id,
      index: nextIndex,
      sourceUrl: job.candidates[nextIndex]?.sourceUrl
    });
    if (job.assetId) this.session.assets?.update(job.assetId, { status: ProgramAssetStatus.DISCARDED });
    return this._proposeCandidate({ ...job, index: nextIndex, feedEntryId });
  }

  discardProposal(feedEntryId) {
    const job = [...this._researchJobs.values()].find((item) => item.feedEntryId === feedEntryId);
    if (job?.assetId) this.session.assets?.update(job.assetId, { status: ProgramAssetStatus.DISCARDED });
    this.session.productionLog?.record(ProductionActionType.DISCARD, {
      feedEntryId,
      assetId: job?.assetId || null
    });
    this.session.aiProducerFeed.dismiss(feedEntryId);
    if (job) this._researchJobs.delete(job.directive.id);
    return { ok: true };
  }

  takeProposalLive(feedEntryId) {
    const job = [...this._researchJobs.values()].find((item) => item.feedEntryId === feedEntryId);
    if (!job?.assetId) return { ok: false, reason: "missing-proposal" };
    const result = this.session.programController?.execute({
      type: ProductionActionType.TAKE_ASSET,
      assetId: job.assetId,
      layout: job.suggestedLayout
    });
    if (result?.ok) {
      this.setStatus(HottieStatus.ON_AIR, { label: "TAKE LIVE", title: serializeProgramAsset(this.session.assets.get(job.assetId))?.title });
      this.session.aiProducerFeed.replace(feedEntryId, {
        type: ProducerEntryType.ASSET_PROPOSAL,
        title: "On Program",
        instruction: job.directive.rawText,
        summary: serializeProgramAsset(this.session.assets.get(job.assetId))?.title,
        proposal: {
          type: "PROGRAM_ASSET_PROPOSAL",
          asset: serializeProgramAsset(this.session.assets.get(job.assetId)),
          suggestedLayout: job.suggestedLayout,
          requiresApproval: false,
          live: true
        },
        liveAssetId: job.assetId
      });
    }
    return result;
  }

  // Hottie's own structured proposals (js/hottie-show-runner.js's PRODUCTION_SUGGESTION feed entries) —
  // a separate approval path from the research/asset TAKE LIVE above, since a Hottie proposal's action is
  // already a fully-formed ProgramController action object (SET_SPOTLIGHT/SURFACE_CHAT/etc. — see
  // proposeHottieActions), not a research candidate that needs an asset looked up first.
  //
  // AUDIT FINDING (repair): entry.proposal.action was built and carried on every proposal feed entry, but
  // no UI ever called ProgramController.execute with it — js/ai-producer.js's renderFeedEntry only renders
  // an action row for ASSET_PROPOSAL/retry entries, never PRODUCTION_SUGGESTION, so the Producer had no
  // control that could ever call this. This method plus renderFeedEntry's new PRODUCTION_SUGGESTION branch
  // (see that file) is the missing wire — same "find the feed entry, execute via ProgramController, then
  // update the feed" shape as takeProposalLive above. Hottie itself never calls this or execute() directly
  // — approval is a human click, exactly like TAKE LIVE.
  approveHottieProposal(feedEntryId) {
    const entry = this.session.aiProducerFeed.entries.find((item) => item.id === feedEntryId);
    const action = entry?.proposal?.action;
    if (!entry || entry.type !== ProducerEntryType.PRODUCTION_SUGGESTION || !action || entry.proposal.doing) {
      return { ok: false, reason: "missing-proposal" };
    }
    this.session.aiProducerFeed.replace(feedEntryId, { proposal: { ...entry.proposal, doing: true } });
    const result = this.session.programController?.execute(action);
    if (result?.ok) {
      this.session.productionLog?.record(action.type, { feedEntryId, approved: true });
      this.session.timeline?.record?.(ProductionEventType.HOTTIE_ACTION, {
        feedEntryId,
        type: action.type,
        approved: true
      });
      this.session.aiProducerFeed.replace(feedEntryId, {
        proposal: { ...entry.proposal, doing: false, requiresApproval: false, executed: true }
      });
    } else {
      // Executed but rejected (e.g. an action type execute() doesn't support) — reset "doing" so the
      // Producer can see it's still pending rather than silently stuck, but don't hide the reason.
      this.session.aiProducerFeed.replace(feedEntryId, { proposal: { ...entry.proposal, doing: false } });
    }
    return result || { ok: false, reason: "unsupported" };
  }

  dismissHottieProposal(feedEntryId) {
    this.session.aiProducerFeed.dismiss(feedEntryId);
    return { ok: true };
  }

  removeLiveAsset(feedEntryId) {
    const result = this.session.programController?.execute({ type: ProductionActionType.REMOVE_ASSET });
    if (feedEntryId) this.session.aiProducerFeed.dismiss(feedEntryId);
    return result;
  }

  retryResearch(feedEntryId) {
    const job = [...this._researchJobs.values()].find((item) => item.feedEntryId === feedEntryId);
    const directive = job?.directive || this.session.hostDirectives?.items?.slice(-1)[0];
    if (!directive) return null;
    return this.runFindDirective(directive, { feedEntryId });
  }

  _proposeCandidate({ directive, query, candidates, index, feedEntryId }) {
    const candidate = candidates[index];
    if (!candidate) {
      this._failResearch(feedEntryId, directive, query);
      return null;
    }
    const asset = this.session.assets.add(programAssetFromCandidate(candidate, {
      createdBy: "hottie",
      directiveId: directive.id,
      status: ProgramAssetStatus.PROPOSED
    }));
    const suggestedLayout = this.session.participants?.list()?.some((p) => p.role === "host")
      ? ProgramLayout.ASSET_SPEAKER
      : ProgramLayout.ASSET_FULL;
    const proposal = {
      type: "PROGRAM_ASSET_PROPOSAL",
      asset: serializeProgramAsset(asset),
      suggestedLayout,
      reason: `Source for “${query}”`,
      requiresApproval: true,
      candidateIndex: index,
      candidateCount: candidates.length
    };
    this._researchJobs.set(directive.id, {
      directive,
      query,
      candidates,
      index,
      feedEntryId,
      assetId: asset.id,
      suggestedLayout
    });
    if (directive.status) directive.status = DirectiveStatus.QUEUED;
    this.session.productionLog?.record(ProductionActionType.ASSET_PROPOSAL, {
      directiveId: directive.id,
      assetId: asset.id,
      sourceUrl: asset.sourceUrl
    });
    this.session.timeline?.record?.(ProductionEventType.ASSET_PROPOSED, {
      directiveId: directive.id,
      assetId: asset.id,
      sourceUrl: asset.sourceUrl
    });
    this.session.aiProducerFeed.replace(feedEntryId, {
      type: ProducerEntryType.ASSET_PROPOSAL,
      title: "I found this",
      instruction: directive.rawText,
      summary: asset.title,
      proposal,
      items: [{ text: `${asset.sourceName} · ${asset.provenance.domain}` }]
    });
    this._emit({ type: ProducerEventType.ASSET_PROPOSED, proposal, directive });
    this.setStatus(HottieStatus.FOUND, { label: "FOUND", title: asset.title });
    return proposal;
  }

  _failResearch(feedEntryId, directive, query) {
    if (directive) {
      this._researchJobs.set(directive.id, {
        directive,
        query,
        candidates: [],
        index: 0,
        feedEntryId,
        assetId: null,
        suggestedLayout: ProgramLayout.ASSET_SPEAKER
      });
    }
    this.session.aiProducerFeed.replace(feedEntryId, {
      type: ProducerEntryType.RESEARCH,
      title: "No trusted source",
      instruction: directive?.rawText,
      summary: "I couldn’t find a source I trust enough to put on screen.",
      items: [{ text: query }],
      retryDirectiveId: directive?.id
    });
  }

  _noticeQuietParticipants() {
    const guests = (this.session.participants?.list() || []).filter((p) => p.role === "guest");
    if (!guests.length) return;
    const stats = this.session.showMemory?.speakerStats() || [];
    const spokenIds = new Set(stats.filter((s) => s.turnCount > 0).map((s) => s.participantId));
    if (spokenIds.size < 3) return;
    guests.forEach((guest) => {
      if (spokenIds.has(guest.participantId)) return;
      const key = `quiet:${guest.participantId}`;
      if (this._notified.has(key)) return;
      this._notified.add(key);
      const name = guest.displayName || "Guest";
      this._pushFeed({
        type: ProducerEntryType.CONTEXT,
        title: "Quiet participant",
        summary: `You have not heard from ${name} during this topic.`,
        items: [{ from: name, text: "No captured turns yet." }]
      });
      this._emit({ type: ProducerEventType.PARTICIPANT_QUIET, participantId: guest.participantId, speaker: name });
    });
  }

  _noticeUncoveredQuestions() {
    const research = this.session.researchContext?.researchQuestions || [];
    const prepared = this.session.runOfShow?.current()?.preparedQuestions || [];
    const questions = [...research, ...prepared].map((q) => String(q || "").trim()).filter(Boolean);
    if (!questions.length) return;
    const transcriptTexts = (this.session.transcript?.lines || []).map((l) => l.text);
    questions.forEach((question) => {
      if (isRoughlyCovered(question, transcriptTexts)) return;
      const key = `uncovered:${question.toLowerCase()}`;
      if (this._notified.has(key)) return;
      this._notified.add(key);
      this._pushFeed({
        type: ProducerEntryType.CONTEXT,
        title: "Not yet covered",
        summary: "Research question not clearly covered:",
        items: [{ text: question }]
      });
      this._emit({ type: ProducerEventType.RESEARCH_QUESTION_UNCOVERED, question });
    });
  }

  _pushDirective(directive) {
    const query = directive.payload?.query || directive.rawText;
    const intentLabel = intentFeedLabel(directive.intent);
    this._pushFeed({
      type: ProducerEntryType.DIRECTIVE,
      title: "Host directive recognized",
      instruction: directive.rawText,
      summary: `${intentLabel}: “${query}”`,
      items: [{ text: "Action is recognized; execution is not wired yet." }],
      sources: [directive.id]
    });
  }

  setStatus(state, proposal = null) {
    this.status = Object.values(HottieStatus).includes(state) ? state : HottieStatus.LISTENING;
    this.proposal = proposal;
    this.session.hottieStatus = { state: this.status, proposal };
    this.session.emit?.("hottie", this.session.hottieStatus);
  }

  _handleProductionDirective(directive) {
    this.setStatus(HottieStatus.THINKING, { label: intentFeedLabel(directive.intent), query: directive.payload?.query });
    const action = productionActionFromDirective(directive);
    if (!action) {
      this._pushDirective(directive);
      this.setStatus(HottieStatus.LISTENING);
      return;
    }
    if (action.type === ProductionActionType.PLAY_AUDIO) {
      const items = this.session.catalogue?.soundboardItems?.() || [];
      const cue = resolveSoundCommand(action.query || directive.rawText, items);
      if (!cue || cue.missing) {
        this._pushFeed({
          type: ProducerEntryType.DIRECTIVE,
          title: "Sound not available",
          instruction: directive.rawText,
          summary: cue?.missing
            ? `${cue.displayName} is catalogued but has no licensed recording yet.`
            : "I don’t have a catalogue cue that matches that.",
          items: [{ text: action.query || directive.rawText }]
        });
        this.setStatus(HottieStatus.READY, { label: "SOUND", query: action.query });
        return;
      }
      action.assetId = cue.id;
    }
    if (action.type === ProductionActionType.TAKE_ASSET && !action.assetId) {
      const liveJob = [...this._researchJobs.values()].find((item) => item.assetId);
      action.assetId = liveJob?.assetId;
    }
    const result = this.session.programController?.execute({ ...action, initiator: "host" });
    const summary = productionSummary(action, result);
    this._pushFeed({
      type: ProducerEntryType.PRODUCTION_SUGGESTION,
      title: summary.title,
      instruction: directive.rawText,
      summary: summary.line,
      proposal: { type: action.type, ...action, result },
      items: [{ text: `${action.type} executed by ProgramController.` }]
    });
    this.setStatus(result?.ok === false ? HottieStatus.READY : HottieStatus.ON_AIR, {
      label: action.type,
      query: directive.payload?.query
    });
    if (directive.status) directive.status = result?.ok === false ? DirectiveStatus.RECOGNIZED : DirectiveStatus.COMPLETED;
  }

  _pushFeed(entry) {
    return this.session.aiProducerFeed?.push({
      action: "private",
      ...entry
    });
  }
}

function intentFeedLabel(intent) {
  if (intent === DirectiveIntent.FIND) return "Find";
  if (intent === DirectiveIntent.RECALL) return "Recall";
  if (intent === DirectiveIntent.UNCOVERED) return "Coverage";
  if (intent === DirectiveIntent.QUIET) return "Participation";
  if (intent === DirectiveIntent.AUDIENCE) return "Audience";
  if (intent === DirectiveIntent.SET_SPOTLIGHT) return "SPOTLIGHT";
  if (intent === DirectiveIntent.CLEAR_SPOTLIGHT || intent === DirectiveIntent.SET_LAYOUT) return "BALANCED";
  if (intent === DirectiveIntent.SET_ACTIVE_SPEAKER_MODE) return "ACTIVE SPEAKER";
  if (intent === DirectiveIntent.SET_SHARE_LAYOUT) return "SHOW SCREEN";
  if (intent === DirectiveIntent.STOP_SHARE) return "RETURN TO GUESTS";
  if (intent === DirectiveIntent.TAKE_ASSET) return "TAKE LIVE";
  if (intent === DirectiveIntent.REMOVE_ASSET) return "REMOVE ASSET";
  if (intent === DirectiveIntent.PLAY_AUDIO) return "PLAY STING";
  return "Directive";
}

function productionSummary(action, result) {
  if (action.type === ProductionActionType.SET_SPOTLIGHT) {
    return { title: "SPOTLIGHT", line: result?.ok ? `Spotlight ${action.participantId}` : "Could not resolve that participant." };
  }
  if (action.type === ProductionActionType.SET_LAYOUT) return { title: "SWITCH TO BALANCED", line: "Balanced participant layout." };
  if (action.type === ProductionActionType.SET_ACTIVE_SPEAKER_MODE) return { title: "FOLLOW SPEAKER", line: "Active speaker mode." };
  if (action.type === ProductionActionType.SET_SHARE_LAYOUT) return { title: "SHOW SCREEN", line: `Share layout ${action.shareLayout}.` };
  if (action.type === ProductionActionType.STOP_SHARE) return { title: "RETURN TO GUESTS", line: "Restored the prior participant composition." };
  if (action.type === ProductionActionType.PLAY_AUDIO) return { title: "PLAY STING", line: result?.ok ? `Playing ${action.assetId}` : "Catalogue cue is not playable." };
  if (action.type === ProductionActionType.TAKE_ASSET) return { title: "TAKE LIVE", line: result?.ok ? "Asset is on Program." : "No approved asset to take live." };
  if (action.type === ProductionActionType.REMOVE_ASSET) return { title: "REMOVE ASSET", line: result?.ok ? "Asset removed from Program." : "Nothing live to remove." };
  return { title: action.type, line: result?.ok ? "Executed." : result?.reason || "Not executed." };
}

function tokenize(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []);
}

function isRoughlyCovered(question, transcriptTexts) {
  const q = tokenize(question);
  if (!q.size) return false;
  return transcriptTexts.some((text) => {
    const t = tokenize(text);
    let hit = 0;
    q.forEach((word) => { if (t.has(word)) hit += 1; });
    return hit / q.size >= 0.6;
  });
}
