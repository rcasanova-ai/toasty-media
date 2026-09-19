// Continuous live-producer awareness. Deterministic: consumes attributed transcript lines,
// compact show memory, Run of Show, and research context. Does NOT call an LLM per sentence.
//
// LLM reasoning stays in AIProducerService.handleInstruction (explicit Host typed/spoken
// requests). This module fires structured events when something useful happens; this slice
// surfaces a subset of those events privately on the existing ProducerFeed.

import { ProducerEntryType } from "./ai-producer.js";
import { detectHostDirective, DirectiveIntent } from "./host-directive.js";
import { attributeTranscriptLine } from "./show-context.js";

export const ProducerEventType = Object.freeze({
  HOST_DIRECTIVE: "host_directive",
  TOPIC_CHANGED: "topic_changed",
  RUN_OF_SHOW_TIMING: "run_of_show_timing",
  AUDIENCE_QUESTION_CLUSTER: "audience_question_cluster",
  RESEARCH_QUESTION_UNCOVERED: "research_question_uncovered",
  PARTICIPANT_QUIET: "participant_quiet",
  DISAGREEMENT: "disagreement",
  PRODUCER_REQUEST: "producer_request",
  CONTEXT_CHECKPOINT: "context_checkpoint"
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
  }

  observe(line) {
    if (!line?.text) return;
    if (!this.session.policy.canAiProcess()) return;

    const directive = detectHostDirective(line);
    if (directive) {
      this.session.hostDirectives?.push(directive);
      this.session.showMemory?.rememberDirective(directive);
      this._pushDirective(directive);
      this._emit({ type: ProducerEventType.HOST_DIRECTIVE, directive, line });
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
    const researchNote = directive.intent === DirectiveIntent.FIND
      ? "Research action is not wired yet."
      : "Action is recognized; execution is not wired yet.";
    this._pushFeed({
      type: ProducerEntryType.DIRECTIVE,
      title: "Host directive recognized",
      instruction: directive.rawText,
      summary: `${intentLabel}: “${query}”`,
      items: [{ text: researchNote }],
      sources: [directive.id]
    });
  }

  _pushFeed(entry) {
    this.session.aiProducerFeed?.push({
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
  return "Directive";
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
