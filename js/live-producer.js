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
import { detectHostDirective, detectImplicitProductionCue, DirectiveIntent, DirectiveStatus, HottieStatus, productionActionFromDirective, ensureAddressedText, inferResponseAudience, wantsProgramVisual, wantsAssetPrep, isHostSpeaker, extractAddressedCommand } from "./host-directive.js";
import { attributeTranscriptLine } from "./show-context.js";
import { programAssetFromCandidate, ProgramAssetStatus, serializeProgramAsset } from "./program-asset.js";
import { ProductionActionType } from "./production-controller.js";
import { ProgramLayout } from "./program-composition.js";
import { createResearchProvider } from "./hottie-research.js";
import { resolveSoundCommand } from "./soundboard.js";
import { ProductionEventType } from "./production-timeline.js";
import { ActionRiskLevel, HottieIntent, HottieActionBus, ProductionActionStatus, createProductionAction, ResponseAudience } from "./hottie-action.js";
import { resolveReferences, recallTranscript } from "./hottie-context.js";
import { createHottieVoicePlan, serializeHottieVoice, isHottieSelfEcho, conciseSpokenText } from "./hottie-voice.js";
import { createMomentMarker } from "./program-recording.js";
import { clusterAudienceQuestions } from "./audience-message.js";

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
    this.actions = new HottieActionBus();
    this.momentMarkers = [];
    this.hostCue = { state: HottieStatus.LISTENING, note: "Hottie is listening." };
    this.voicePlan = createHottieVoicePlan();
    this._speaking = false;
    this._lastSpoken = "";
    this._lastHeardCommand = "";
    this._spokenAt = 0;
    this._speakTimer = null;
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
    this.actions.clear();
    this.momentMarkers = [];
    this.cancelSpeech();
    this.setStatus(HottieStatus.LISTENING, { label: "LISTENING" }, "Hottie is listening.");
  }

  observe(line) {
    try {
      this._observeUnsafe(line);
    } catch (error) {
      console.error("[Hottie] observe failed open", error);
      this.setStatus(HottieStatus.ERROR, { label: "ERROR" }, "Hottie hit an error. The show continues.");
    }
  }

  _observeUnsafe(line) {
    if (!line?.text) return;
    if (!this.session.policy.canAiProcess()) return;
    if (isHottieSelfEcho(line, {
      speaking: this._speaking,
      lastSpoken: this._lastSpoken,
      lastHeardCommand: this._lastHeardCommand,
      spokenAt: this._spokenAt
    })) return;
    if (this._speaking && isHostSpeaker(line) && extractAddressedCommand(line.text)) {
      this.cancelSpeech();
    }

    const implicit = detectImplicitProductionCue(line);
    if (implicit) {
      this._pushSuggestion(implicit);
      this._sinceCheckpoint += 1;
      if (this._sinceCheckpoint >= CHECKPOINT_EVERY) this.checkpoint();
      return;
    }

    const directive = detectHostDirective(line, {
      participants: this.session.participants?.list?.() || []
    });
    if (directive) {
      this._dispatchDirective(directive, line);
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

  async handleManualRequest(text) {
    const addressed = ensureAddressedText(text);
    if (!addressed) return null;
    const line = {
      participantId: "host",
      role: "host",
      speaker: this.session.hostProfile?.displayName || this.session.participants?.list?.()?.find((p) => p.role === "host")?.displayName || "Host",
      text: addressed,
      timestamp: Date.now(),
      source: "typed"
    };
    ingestAttributedTranscript(this.session, line);
    await this.ready();
    return this.actions.now() || this.actions.items[0] || null;
  }

  _dispatchDirective(directive, line) {
    this.session.hostDirectives?.push(directive);
    this.session.showMemory?.rememberDirective(directive);
    this._emit({ type: ProducerEventType.HOST_DIRECTIVE, directive, line });
    this._lastHeardCommand = directive.rawText || "";
    this.setStatus(HottieStatus.HEARD, { label: "HEARD COMMAND", query: directive.payload?.query }, hostHeardNote(directive));
    const action = this.actions.push(createProductionAction({
      sessionId: this.session.roomId || this.session.sessionId || null,
      intent: directive.hottieIntent,
      payload: directive.payload,
      requestedBy: directive.speaker || "host",
      heardText: directive.rawText,
      riskLevel: directive.riskLevel,
      responseAudience: directive.responseAudience || inferResponseAudience(directive.rawText, { intent: directive.intent }),
      status: ProductionActionStatus.RECEIVED
    }));
    directive.actionId = action.id;
    this.session.showMemory?.rememberProductionAction(action);
    this.session.timeline?.record?.(ProductionEventType.HOTTIE_ACTION, {
      actionId: action.id,
      intent: action.intent,
      riskLevel: action.riskLevel,
      heardText: directive.rawText
    });

    const shouldResolve = directive.intent === DirectiveIntent.FIND
      || directive.intent === DirectiveIntent.ANSWER
      || directive.intent === DirectiveIntent.RECALL
      || directive.intent === DirectiveIntent.FACT_CHECK;
    if (shouldResolve) {
      const resolution = resolveReferences(directive.payload?.query || directive.rawText, this.session.showMemory?.resolverContext(this.session) || {});
      if (resolution.needsClarification) {
        this.actions.setStatus(action.id, ProductionActionStatus.FAILED, { preview: { clarification: resolution.clarification } });
        this._pushFeed({
          type: ProducerEntryType.DIRECTIVE,
          title: "Needs clarification",
          instruction: directive.rawText,
          summary: resolution.clarification,
          actionId: action.id,
          bucket: "now"
        });
        this.setStatus(HottieStatus.NEEDS_CLARIFICATION, { label: "NEEDS CLARIFICATION" }, resolution.clarification);
        return;
      }
      if (resolution.referents?.[0]?.label && /\b(that|this|it)\b/i.test(directive.payload?.query || "")) {
        directive.payload = { ...directive.payload, query: resolution.resolvedQuery, resolvedFrom: resolution.referents[0].label };
        this.actions.update(action.id, { payload: directive.payload });
      }
    }

    this.actions.setStatus(action.id, ProductionActionStatus.PROCESSING);
    this.voicePlan = createHottieVoicePlan({
      responseAudience: action.responseAudience,
      text: "",
      requestedBy: directive.speaker
    });

    if (directive.riskLevel === ActionRiskLevel.RED) {
      this._queueRedAction(directive, action);
      return;
    }

    const spokenResearch = directive.intent === DirectiveIntent.ANSWER
      || (
        (directive.intent === DirectiveIntent.FIND || directive.hottieIntent === HottieIntent.SEARCH_WEB)
        && action.responseAudience === ResponseAudience.PROGRAM
        && !wantsProgramVisual(directive.rawText)
        && !wantsAssetPrep(directive.rawText)
      );

    if (spokenResearch) {
      this.setStatus(HottieStatus.SEARCHING, { label: "SEARCHING", query: directive.payload?.query }, "Looking that up…");
      this._inflight = this.runSpokenResearch(directive, action);
      void this._inflight;
      return;
    }

    if (directive.intent === DirectiveIntent.FIND || directive.hottieIntent === HottieIntent.SEARCH_WEB || directive.hottieIntent === HottieIntent.SEARCH_IMAGE || directive.hottieIntent === HottieIntent.SHOW_URL || directive.hottieIntent === HottieIntent.SHOW_IMAGE) {
      this.setStatus(HottieStatus.SEARCHING, { label: "SEARCHING", query: directive.payload?.query }, "Hottie is searching…");
      this._inflight = this.runFindDirective(directive, { actionId: action.id });
      void this._inflight;
      return;
    }
    if (directive.intent === DirectiveIntent.FACT_CHECK) {
      this.setStatus(HottieStatus.SEARCHING, { label: "SEARCHING" }, "Checking that quietly…");
      this._inflight = this.runFactCheck(directive, action);
      void this._inflight;
      return;
    }
    if (directive.intent === DirectiveIntent.RECALL) {
      this.runRecall(directive, action);
      return;
    }
    if (directive.intent === DirectiveIntent.CLIP || directive.intent === DirectiveIntent.MARK) {
      this.runMomentMarker(directive, action);
      return;
    }
    if (directive.intent === DirectiveIntent.AUDIENCE || directive.hottieIntent === HottieIntent.READ_CHAT) {
      this.runReadChat(directive, action);
      return;
    }
    if (directive.intent === DirectiveIntent.RESPOND_CHAT) {
      this._queueAmberChatReply(directive, action);
      return;
    }
    if (directive.intent === DirectiveIntent.CHANGE_SCENE) {
      this._queueSceneChange(directive, action);
      return;
    }
    this._handleProductionDirective(directive, action);
  }

  _queueRedAction(directive, action) {
    this.actions.setStatus(action.id, ProductionActionStatus.AWAITING_APPROVAL);
    this._pushFeed({
      type: ProducerEntryType.PRODUCTION_SUGGESTION,
      title: "Needs confirmation",
      instruction: directive.rawText,
      summary: "This would change recording, destinations, or end the show. Confirm explicitly.",
      proposal: {
        type: directive.hottieIntent,
        action: { type: directive.hottieIntent, ...directive.payload },
        requiresApproval: true,
        riskLevel: ActionRiskLevel.RED
      },
      actionId: action.id,
      bucket: "ready"
    });
    this.setStatus(HottieStatus.AWAITING_APPROVAL, { label: "WAITING FOR APPROVAL" }, "Waiting for confirmation. The show continues.");
  }

  _queueSceneChange(directive, action) {
    const scene = directive.payload?.scene;
    if (!scene) {
      this.actions.setStatus(action.id, ProductionActionStatus.FAILED);
      this._pushFeed({
        type: ProducerEntryType.ERROR,
        title: "Couldn't resolve scene",
        instruction: directive.rawText,
        summary: "Say BRB, Starting Soon, Live, Ending, or Technical Difficulties.",
        actionId: action.id
      });
      this.setStatus(HottieStatus.NEEDS_CLARIFICATION, { label: "NEEDS CLARIFICATION" }, "Which scene?");
      return;
    }
    this.actions.setStatus(action.id, ProductionActionStatus.AWAITING_APPROVAL, { payload: { ...action.payload, scene } });
    this._pushFeed({
      type: ProducerEntryType.PRODUCTION_SUGGESTION,
      title: "Scene change ready",
      instruction: directive.rawText,
      summary: `Change Program scene to ${scene}.`,
      proposal: {
        type: "SET_SCENE",
        action: { type: "SET_SCENE", scene },
        requiresApproval: true,
        riskLevel: ActionRiskLevel.AMBER
      },
      actionId: action.id,
      bucket: "ready"
    });
    this.setStatus(HottieStatus.AWAITING_APPROVAL, { label: "WAITING FOR APPROVAL", query: scene }, "Scene change is ready for Producer approval.");
  }

  _queueAmberChatReply(directive, action) {
    this.actions.setStatus(action.id, ProductionActionStatus.AWAITING_APPROVAL);
    this._pushFeed({
      type: ProducerEntryType.PRODUCTION_SUGGESTION,
      title: "Draft chat reply",
      instruction: directive.rawText,
      summary: "Hottie will not post to public chat until you approve.",
      proposal: {
        type: ProductionActionType.POST_CHAT,
        action: { type: ProductionActionType.POST_CHAT, text: directive.payload?.query || "" },
        requiresApproval: true,
        riskLevel: ActionRiskLevel.AMBER
      },
      actionId: action.id,
      bucket: "ready"
    });
    this.setStatus(HottieStatus.AWAITING_APPROVAL, { label: "WAITING FOR APPROVAL" }, "Chat reply needs Producer approval.");
  }

  _pushSuggestion(cue) {
    this._pushFeed({
      type: ProducerEntryType.PRODUCTION_SUGGESTION,
      title: "Suggestion",
      instruction: cue.rawText,
      summary: "Possible producer request — not executed.",
      proposal: {
        type: cue.hottieIntent,
        action: { type: cue.hottieIntent, ...cue.payload },
        requiresApproval: true,
        implicit: true
      },
      bucket: "suggestions"
    });
  }

  runRecall(directive, action) {
    const hits = recallTranscript(this.session.transcript?.lines || [], {
      speakerName: directive.payload?.speakerName,
      topic: directive.payload?.topic,
      query: directive.payload?.query
    });
    if (!hits.length) {
      const found = /what you found/i.test(directive.rawText)
        ? this.session.showMemory?.researchResults?.slice(-1)[0]
        : null;
      if (found) {
        const spoken = conciseSpokenText(`I found ${found.title}. ${found.excerpt || found.sourceUrl || ""}`.trim());
        this._completeWithAudience(directive, action, {
          title: "From earlier",
          summary: spoken,
          items: [{ text: found.sourceUrl || found.title }],
          spoken
        });
        return;
      }
      this.actions.setStatus(action.id, ProductionActionStatus.FAILED);
      this._pushFeed({
        type: ProducerEntryType.CONTEXT,
        title: "Recall",
        instruction: directive.rawText,
        summary: "I couldn't find that in this session's transcript.",
        actionId: action.id
      });
      this.setStatus(HottieStatus.DONE, { label: "DONE" }, "Couldn't find that in the session transcript.");
      return;
    }
    const summary = hits.map((line) => `${line.speaker}: ${line.text}`).join(" ");
    this._completeWithAudience(directive, action, {
      title: "From earlier",
      summary: summary.slice(0, 280),
      items: hits.map((line) => ({ from: line.speaker, text: line.text })),
      spoken: conciseSpokenText(`${hits[0].speaker} said: ${hits[0].text}`),
      preview: { hits: hits.map((line) => ({ speaker: line.speaker, text: line.text, timestamp: line.timestamp })) }
    });
  }

  runMomentMarker(directive, action) {
    const marker = createMomentMarker({
      sessionId: this.session.roomId || null,
      timestamp: Date.now(),
      preRollSeconds: directive.payload?.preRollSeconds || 45,
      postRollSeconds: directive.payload?.postRollSeconds || 15,
      reason: directive.payload?.reason || directive.rawText,
      transcriptContext: (this.session.transcript?.recent?.(6) || []).map((line) => ({
        speaker: line.speaker,
        text: line.text,
        timestamp: line.timestamp
      }))
    });
    this.momentMarkers.push(marker);
    this.session.markers?.add(marker);
    this.session.timeline?.record?.(ProductionEventType.MARKER_ADDED, {
      markerId: marker.id,
      markerType: marker.type,
      label: marker.reason,
      source: "hottie"
    });
    this.session.productionLog?.record?.(ProductionActionType.MARKER, {
      markerId: marker.id,
      kind: "moment-marker",
      preRollSeconds: marker.preRollSeconds
    });
    this.actions.setStatus(action.id, ProductionActionStatus.COMPLETED, { preview: marker });
    this._pushFeed({
      type: ProducerEntryType.CONTEXT,
      title: "Moment marked",
      instruction: directive.rawText,
      summary: `Marked the last ${marker.preRollSeconds}s for later clip extraction.`,
      items: [{ text: `pre ${marker.preRollSeconds}s · post ${marker.postRollSeconds}s` }],
      actionId: action.id,
      bucket: "history"
    });
    this.setStatus(HottieStatus.DONE, { label: "DONE" }, "Marked that moment.");
  }

  runReadChat(directive, action) {
    const audience = this.session.audience?.recent?.(40) || [];
    const authorQuery = String(directive.payload?.author || "").toLowerCase();
    const named = authorQuery
      ? audience.filter((item) => String(item.displayName || "").toLowerCase().includes(authorQuery))
      : [];
    if (directive.payload?.speakAnswer && named[0]) {
      const spoken = conciseSpokenText(`${named[0].displayName} asked: ${named[0].message}`);
      this._completeWithAudience(directive, action, {
        type: ProducerEntryType.AUDIENCE_QUESTIONS,
        title: "Chat",
        summary: spoken,
        items: [{ from: named[0].displayName, text: named[0].message }],
        spoken
      });
      return;
    }
    const clusters = clusterAudienceQuestions(audience.map((item) => ({
      id: item.id,
      text: item.message,
      kind: item.type,
      author: item.displayName
    })));
    const top = clusters[0];
    const recentText = audience.slice(-4).map((item) => `${item.displayName}: ${item.message}`).join(" ");
    const summary = top
      ? `${top.count} viewers asked about ${top.theme}.`
      : (recentText ? `Chat is talking about: ${recentText}` : "No clustered audience questions yet.");
    this._completeWithAudience(directive, action, {
      type: ProducerEntryType.AUDIENCE_QUESTIONS,
      title: "Chat",
      summary,
      items: (top?.messages || audience.slice(-3)).slice(0, 3).map((item) => ({
        from: item.author || item.displayName,
        text: item.text || item.message
      })),
      spoken: conciseSpokenText(summary),
      preview: { clusters },
      bucket: directive.responseAudience === ResponseAudience.PROGRAM ? "ready" : "suggestions"
    });
  }

  async runFactCheck(directive, action) {
    const query = directive.payload?.claim || directive.payload?.query;
    this.actions.setStatus(action.id, ProductionActionStatus.PROCESSING);
    try {
      const provider = this.session.researchProvider || createResearchProvider({ preferSeeded: this.session.demoMode });
      const candidates = (await provider.search(query)).filter(Boolean);
      if (!candidates.length) {
        this.actions.setStatus(action.id, ProductionActionStatus.FAILED);
        this._pushFeed({
          type: ProducerEntryType.RESEARCH,
          title: "Fact check",
          instruction: directive.rawText,
          summary: "Couldn't find a reliable source.",
          actionId: action.id
        });
        this.setStatus(HottieStatus.ERROR, { label: "ERROR" }, "Couldn't find a reliable source.");
        return null;
      }
      const top = candidates[0];
      this.session.showMemory?.rememberResearch({
        query,
        title: top.title,
        sourceUrl: top.sourceUrl,
        timestamp: Date.now()
      });
      const spoken = conciseSpokenText(top.excerpt || top.title);
      this.actions.recordProvenance(action.id, { sources: candidates.slice(0, 3).map((item) => item.sourceUrl) });
      this._completeWithAudience(directive, action, {
        type: ProducerEntryType.RESEARCH,
        title: "Fact check",
        summary: top.excerpt || top.title,
        items: candidates.slice(0, 3).map((item) => ({ text: `${item.sourceName}: ${item.title}` })),
        sources: candidates.slice(0, 3).map((item) => item.sourceUrl),
        spoken,
        preview: { title: top.title, sourceUrl: top.sourceUrl, excerpt: top.excerpt, sources: candidates.slice(0, 3) }
      });
      return candidates;
    } catch (_) {
      this.actions.setStatus(action.id, ProductionActionStatus.FAILED);
      this._pushFeed({
        type: ProducerEntryType.ERROR,
        title: "Fact check",
        instruction: directive.rawText,
        summary: "Search unavailable.",
        actionId: action.id
      });
      this.setStatus(HottieStatus.ERROR, { label: "ERROR" }, "Search unavailable.");
      return null;
    }
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
    this._noticeRunOfShowTiming();
    this._noticeQuietParticipants();
    this._noticeUncoveredQuestions();
    this.session.proposeHottieLoop?.();
  }

  async runFindDirective(directive, { feedEntryId = null, actionId = null } = {}) {
    if (!this.session.policy.canAiProcess()) return null;
    const query = directive.payload?.query || directive.rawText;
    this.session.productionLog?.record(ProductionActionType.RESEARCH_REQUEST, {
      directiveId: directive.id,
      query
    });
    this.setStatus(HottieStatus.SEARCHING, { label: "SEARCHING", query }, "Hottie is searching…");
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
        this._failResearch(entryId, directive, query, actionId || directive.actionId);
        return null;
      }
      return this._proposeCandidate({ directive, query, candidates, index: 0, feedEntryId: entryId, actionId: actionId || directive.actionId });
    } catch (_) {
      this._failResearch(entryId, directive, query, actionId || directive.actionId);
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
    if (job?.directive?.actionId) this.actions.setStatus(job.directive.actionId, ProductionActionStatus.REJECTED);
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
      const liveAsset = serializeProgramAsset(this.session.assets.get(job.assetId));
      this.session.showMemory?.rememberAsset(liveAsset);
      if (job.directive?.actionId) {
        this.actions.setStatus(job.directive.actionId, ProductionActionStatus.LIVE, { preview: liveAsset });
        this.actions.recordProvenance(job.directive.actionId, {
          approval: { by: "producer", at: Date.now() },
          assetSelected: liveAsset?.id,
          result: "live"
        });
      }
      const outputConnected = this.session.programOutput?.connection === "connected" || this.session.programOutput?.connected;
      this.setStatus(
        HottieStatus.TAKING_LIVE,
        { label: "TAKING LIVE", title: liveAsset?.title },
        outputConnected ? "Taking it live." : "Program Output isn't connected. Preview is ready."
      );
      this.session.aiProducerFeed.replace(feedEntryId, {
        type: ProducerEntryType.ASSET_PROPOSAL,
        title: "On Program",
        instruction: job.directive.rawText,
        summary: liveAsset?.title,
        proposal: {
          type: "PROGRAM_ASSET_PROPOSAL",
          asset: liveAsset,
          suggestedLayout: job.suggestedLayout,
          requiresApproval: false,
          live: true
        },
        liveAssetId: job.assetId,
        bucket: "history"
      });
      this.setStatus(HottieStatus.DONE, { label: "DONE", title: liveAsset?.title }, "It's on Program.");
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
    let result;
    if (action.type === "SET_SCENE" && this.session.setScene) {
      this.session.setScene(action.scene);
      result = { ok: true, scene: action.scene };
    } else if (entry.proposal?.riskLevel === ActionRiskLevel.RED) {
      result = { ok: false, reason: "red-requires-explicit-studio-control" };
    } else {
      result = this.session.programController?.execute(action);
    }
    if (result?.ok) {
      if (entry.actionId) this.actions.setStatus(entry.actionId, ProductionActionStatus.COMPLETED);
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

  _proposeCandidate({ directive, query, candidates, index, feedEntryId, actionId = null }) {
    const candidate = candidates[index];
    if (!candidate) {
      this._failResearch(feedEntryId, directive, query, actionId);
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
      suggestedLayout,
      actionId: actionId || directive.actionId || null
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
      title: "Hottie found",
      instruction: directive.rawText,
      summary: asset.title,
      proposal,
      items: [
        { text: `${asset.sourceName} · ${asset.provenance.domain}` },
        asset.excerpt ? { text: asset.excerpt } : null
      ].filter(Boolean),
      bucket: "ready",
      actionId: actionId || directive.actionId || null
    });
    this._emit({ type: ProducerEventType.ASSET_PROPOSED, proposal, directive });
    const foundLabel = candidates.length > 1 ? `FOUND ${candidates.length} RESULTS` : "FOUND";
    if (actionId || directive.actionId) {
      this.actions.setStatus(actionId || directive.actionId, ProductionActionStatus.AWAITING_APPROVAL, {
        preview: serializeProgramAsset(asset)
      });
      this.actions.recordProvenance(actionId || directive.actionId, { sources: candidates.map((item) => item.sourceUrl) });
    }
    this.session.showMemory?.rememberResearch({
      query,
      title: asset.title,
      sourceUrl: asset.sourceUrl,
      timestamp: Date.now()
    });
    this.setStatus(HottieStatus.AWAITING_APPROVAL, { label: foundLabel, title: asset.title }, "Found it. Producer has the preview.");
    return proposal;
  }

  async runSpokenResearch(directive, action) {
    if (!this.session.policy.canAiProcess()) return null;
    const query = directive.payload?.query || directive.rawText;
    this.session.productionLog?.record(ProductionActionType.RESEARCH_REQUEST, {
      directiveId: directive.id,
      query,
      responseAudience: action.responseAudience
    });
    try {
      const provider = this.session.researchProvider || createResearchProvider({ preferSeeded: this.session.demoMode });
      const candidates = (await provider.search(query)).filter(Boolean);
      if (!candidates.length) {
        this.actions.setStatus(action.id, ProductionActionStatus.FAILED);
        this._pushFeed({
          type: ProducerEntryType.RESEARCH,
          title: "Answer",
          instruction: directive.rawText,
          summary: "I couldn't find a source I trust for that.",
          actionId: action.id
        });
        this.setStatus(HottieStatus.ERROR, { label: "ERROR" }, "Couldn't find a reliable source.");
        return null;
      }
      const top = candidates[0];
      this.session.showMemory?.rememberResearch({
        query,
        title: top.title,
        sourceUrl: top.sourceUrl,
        excerpt: top.excerpt,
        timestamp: Date.now()
      });
      this.actions.recordProvenance(action.id, { sources: candidates.slice(0, 3).map((item) => item.sourceUrl) });
      const spoken = composeSpokenAnswer(query, top);
      this._completeWithAudience(directive, action, {
        type: ProducerEntryType.RESEARCH,
        title: "Answer",
        summary: spoken,
        items: candidates.slice(0, 3).map((item) => ({ text: `${item.sourceName}: ${item.title}` })),
        sources: candidates.slice(0, 3).map((item) => item.sourceUrl),
        spoken,
        preview: { title: top.title, sourceUrl: top.sourceUrl, excerpt: top.excerpt }
      });
      return candidates;
    } catch (_) {
      this.actions.setStatus(action.id, ProductionActionStatus.FAILED);
      this._pushFeed({
        type: ProducerEntryType.ERROR,
        title: "Answer",
        instruction: directive.rawText,
        summary: "Search unavailable.",
        actionId: action.id
      });
      this.setStatus(HottieStatus.ERROR, { label: "ERROR" }, "Search unavailable.");
      return null;
    }
  }

  _completeWithAudience(directive, action, {
    type = ProducerEntryType.CONTEXT,
    title,
    summary,
    items = [],
    sources = null,
    spoken,
    preview,
    bucket = "ready"
  } = {}) {
    const audience = action.responseAudience || directive.responseAudience || ResponseAudience.PRIVATE_PRODUCER;
    this.actions.setStatus(action.id, ProductionActionStatus.COMPLETED, {
      preview: preview || { summary },
      spokenResponse: audience === ResponseAudience.PROGRAM ? spoken || summary : null,
      responseAudience: audience
    });
    this._pushFeed({
      type,
      title,
      instruction: directive.rawText,
      summary,
      items,
      sources,
      actionId: action.id,
      bucket,
      responseAudience: audience
    });
    if (audience === ResponseAudience.PROGRAM && (spoken || summary)) {
      this.speakProgram(spoken || summary, { action, requestedBy: directive.speaker });
      return;
    }
    this.voicePlan = createHottieVoicePlan({
      responseAudience: audience,
      text: "",
      requestedBy: directive.speaker
    });
    this.setStatus(HottieStatus.DONE, { label: "DONE" }, summary);
  }

  speakProgram(text, { action = null, requestedBy = "host" } = {}) {
    const spoken = conciseSpokenText(text);
    if (!spoken) return null;
    if (this._speaking) this.cancelSpeech();
    const plan = createHottieVoicePlan({
      responseAudience: ResponseAudience.PROGRAM,
      text: spoken,
      requestedBy
    });
    this._speaking = true;
    this._lastSpoken = plan.text;
    this._spokenAt = Date.now();
    this.voicePlan = plan;
    if (action) {
      this.actions.update(action.id, {
        spokenResponse: plan.text,
        responseAudience: ResponseAudience.PROGRAM
      });
    }
    if (!this.session.program) this.session.program = {};
    this.session.program.hottieVoice = serializeHottieVoice(plan);
    this.session.publishProgramState?.();
    this.setStatus(HottieStatus.SPEAKING, { label: "HOTTIE SPEAKING" }, "Hottie is speaking on Program Audio.");
    const ms = Math.min(14000, Math.max(1400, plan.text.split(/\s+/).length * 380));
    if (typeof setTimeout === "function") {
      this._speakTimer = setTimeout(() => this._finishSpeaking(plan.utteranceId), ms);
      this._speakTimer.unref?.();
    }
    return plan;
  }

  cancelSpeech() {
    if (this._speakTimer) {
      clearTimeout(this._speakTimer);
      this._speakTimer = null;
    }
    this._speaking = false;
    if (this.session.program) this.session.program.hottieVoice = null;
  }

  _finishSpeaking(utteranceId) {
    if (this.voicePlan?.utteranceId && utteranceId && this.voicePlan.utteranceId !== utteranceId) return;
    this._speakTimer = null;
    this._speaking = false;
    this.setStatus(HottieStatus.DONE, { label: "DONE" }, this._lastSpoken || "Done.");
  }

  _failResearch(feedEntryId, directive, query, actionId = null) {
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
    if (actionId || directive?.actionId) this.actions.setStatus(actionId || directive.actionId, ProductionActionStatus.FAILED);
    this.setStatus(HottieStatus.ERROR, { label: "ERROR" }, "Couldn't find a reliable source.");
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

  _noticeRunOfShowTiming() {
    const current = this.session.runOfShow?.current?.();
    if (!current) return;
    const next = this.session.runOfShow?.next?.();
    const elapsedMs = this.session.runOfShow?.currentElapsedMs?.() || 0;
    const remainingMs = current.estimatedMinutes ? Math.max(0, current.estimatedMinutes * 60000 - elapsedMs) : null;
    const key = `segment:${current.id}:${Math.floor(elapsedMs / 120000)}`;
    if (!this._notified.has(key)) {
      this._notified.add(key);
      this._pushFeed({
        type: ProducerEntryType.CONTEXT,
        title: `NOW: ${current.title}`,
        summary: `NEXT: ${next?.title || "—"}`,
        items: [
          { text: current.notes || "No notes/script for this segment." },
          ...(remainingMs != null ? [{ text: `${Math.ceil(remainingMs / 60000)} minute${Math.ceil(remainingMs / 60000) === 1 ? "" : "s"} remaining.` }] : [])
        ]
      });
      this._emit({ type: ProducerEventType.RUN_OF_SHOW_TIMING, topic: current, next, remainingMs });
    }
    if (remainingMs != null && remainingMs <= 120000) {
      const lowKey = `segment-low:${current.id}`;
      if (!this._notified.has(lowKey)) {
        this._notified.add(lowKey);
        this._pushFeed({
          type: ProducerEntryType.TIMING,
          title: "2 minutes remaining",
          summary: `${current.title} is almost out of time.`,
          items: current.notes ? [{ text: `Check you covered: ${current.notes}` }] : []
        });
      }
    }
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

  setStatus(state, proposal = null, hostNote = null) {
    const allowed = new Set(Object.values(HottieStatus));
    this.status = allowed.has(state) ? state : HottieStatus.LISTENING;
    this.proposal = proposal;
    this.hostCue = {
      state: this.status,
      note: hostNote || hostNoteFromStatus(this.status, proposal)
    };
    this.session.hottieStatus = { state: this.status, proposal, hostCue: this.hostCue };
    this.session.emit?.("hottie", this.session.hottieStatus);
  }

  _handleProductionDirective(directive, busAction = null) {
    this.setStatus(HottieStatus.HEARD, { label: intentFeedLabel(directive.intent), query: directive.payload?.query }, hostHeardNote(directive));
    const action = productionActionFromDirective(directive);
    if (!action) {
      this._pushDirective(directive);
      if (busAction) this.actions.setStatus(busAction.id, ProductionActionStatus.COMPLETED);
      this.setStatus(HottieStatus.DONE, { label: "DONE" }, "Heard that. Nothing to put on Program.");
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
        this.setStatus(HottieStatus.READY, { label: "SOUND", query: action.query }, "Couldn't play that cue.");
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
    if (busAction) {
      this.actions.setStatus(busAction.id, result?.ok ? ProductionActionStatus.COMPLETED : ProductionActionStatus.FAILED);
    }
    this._pushFeed({
      type: ProducerEntryType.PRODUCTION_SUGGESTION,
      title: summary.title,
      instruction: directive.rawText,
      summary: summary.line,
      proposal: { type: action.type, ...action, result },
      items: [{ text: `${action.type} executed by ProgramController.` }]
    });
    this.setStatus(result?.ok === false ? HottieStatus.READY : HottieStatus.DONE, {
      label: action.type,
      query: directive.payload?.query
    }, summary.line);
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

function hostHeardNote(directive) {
  const query = directive?.payload?.query;
  return query ? `Heard: ${query}` : "Heard command.";
}

function hostNoteFromStatus(state, proposal) {
  if (state === HottieStatus.LISTENING) return "Hottie is listening.";
  if (state === HottieStatus.HEARD) return "Heard command.";
  if (state === HottieStatus.SEARCHING || state === HottieStatus.RESEARCHING) return "Hottie is searching…";
  if (state === HottieStatus.FOUND) return "Found it. Producer has the preview.";
  if (state === HottieStatus.AWAITING_APPROVAL) return "Found it. Producer has the preview.";
  if (state === HottieStatus.NEEDS_CLARIFICATION) return "Couldn't identify which one you meant.";
  if (state === HottieStatus.ERROR) return "Couldn't complete that. The show continues.";
  if (state === HottieStatus.DONE) return proposal?.title ? `Done · ${proposal.title}` : "Done.";
  if (state === HottieStatus.SPEAKING) return "Hottie is speaking on Program Audio.";
  return proposal?.label || "Hottie is listening.";
}

function composeSpokenAnswer(query, candidate) {
  const excerpt = String(candidate?.excerpt || "").trim();
  const title = String(candidate?.title || "").trim();
  const source = String(candidate?.sourceName || "").trim();
  if (excerpt) {
    const lead = source ? `From ${source}: ` : "";
    return conciseSpokenText(`${lead}${excerpt}`);
  }
  if (title && source) return conciseSpokenText(`I found ${title} on ${source}.`);
  return conciseSpokenText(title || `I found a source for ${query}.`);
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
