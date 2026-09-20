// Focus Group uses Studio primitives — not a second video/audio/recording stack.

import { createFocusGroupContext, defaultFocusGroupAgenda, analyzeFocusGroupTranscript, buildFocusGroupDeliveryPack } from "./focus-group.js";
import { ArtifactType, createSessionArtifact } from "./session-artifact.js";
import { HottieProposalType } from "./hottie-show-runner.js";

export function attachFocusGroupToSession(session, overrides = {}) {
  const context = createFocusGroupContext(overrides);
  const agenda = defaultFocusGroupAgenda(context);
  session.focusGroupContext = { ...context, agenda, startedAt: Date.now() };
  session.researchContext = {
    id: context.id,
    title: context.title,
    objective: context.objective,
    researchQuestions: context.researchQuestions,
    discussionGuide: agenda,
    participants: (session.participants?.list?.() || []).map((item) => ({
      participantId: item.participantId,
      displayName: item.displayName,
      role: item.role
    })),
    themes: [],
    uncoveredQuestions: context.researchQuestions || [],
    timeRemainingMinutes: agenda.reduce((sum, item) => sum + (item.estimatedMinutes || 0), 0)
  };
  if (session.runOfShow && typeof session.runOfShow.load === "function") {
    try { session.runOfShow.load(agenda.map((item) => ({ title: item.title, estimatedMinutes: item.estimatedMinutes, preparedQuestions: item.preparedQuestions }))); } catch (_) {}
  }
  return session.focusGroupContext;
}

export function focusGroupUsesStudioPrimitives() {
  return {
    session: "LiveSession",
    composition: "ProgramComposition",
    renderer: "ProgramRenderer",
    audio: "ProgramAudioMixer",
    recording: "MasterRecorder",
    transcript: "TranscriptStore",
    hottie: "HottieShowRunner",
    artifacts: "SessionArtifactStore"
  };
}

export function buildFocusGroupInsightArtifact(session) {
  const lines = session?.transcript?.lines || [];
  const context = session?.focusGroupContext || {};
  const pack = buildFocusGroupDeliveryPack(lines, context);
  const analysis = analyzeFocusGroupTranscript(lines, context);
  return createSessionArtifact({
    type: ArtifactType.FOCUS_GROUP_INSIGHTS,
    sessionId: session?.durableSession?.id || session?.roomId,
    title: context.title || "Focus group insights",
    payload: {
      pack,
      analysis,
      quotes: analysis.evidenceQuotes,
      themes: Object.keys(analysis.stats?.signalCounts || {}),
      findings: pack.topFindings
    }
  });
}

export function focusGroupHottieProposals(session) {
  const context = session?.focusGroupContext;
  if (!context) return [];
  return [
    { type: HottieProposalType.ASK_FOLLOW_UP, question: context.researchQuestions?.[0] || "" },
    { type: HottieProposalType.BRING_QUIET_PARTICIPANT },
    { type: HottieProposalType.MOVE_TOPIC },
    { type: HottieProposalType.FLAG_DISAGREEMENT },
    { type: HottieProposalType.MARK_INSIGHT },
    { type: HottieProposalType.MARK_QUOTE },
    { type: HottieProposalType.MARK_MOMENT }
  ];
}
