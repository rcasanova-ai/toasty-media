// Moxie structured production loop. Proposes; ProgramController executes.
// Never edits Program Output DOM. Guest speech is context, never control.

import { ProductionActionType } from "./production-controller.js";
import { CompositionMode } from "./program-composition.js";
import { clusterAudienceQuestions, analyzeAudienceMessage, hottiePublicReply } from "./audience-message.js";
import { ProducerEntryType } from "./ai-producer.js";

export const MoxieProposalType = Object.freeze({
  SET_SPOTLIGHT: ProductionActionType.SET_SPOTLIGHT,
  CLEAR_SPOTLIGHT: ProductionActionType.CLEAR_SPOTLIGHT,
  SET_LAYOUT: ProductionActionType.SET_LAYOUT,
  SET_SHARE_LAYOUT: ProductionActionType.SET_SHARE_LAYOUT,
  TAKE_ASSET: ProductionActionType.TAKE_ASSET,
  REMOVE_ASSET: ProductionActionType.REMOVE_ASSET,
  PLAY_AUDIO: ProductionActionType.PLAY_AUDIO,
  STOP_AUDIO: ProductionActionType.STOP_AUDIO,
  SHOW_RESEARCH: "SHOW_RESEARCH",
  RETURN_TO_PARTICIPANTS: "RETURN_TO_PARTICIPANTS",
  SURFACE_CHAT: "SURFACE_CHAT",
  POST_CHAT: "POST_CHAT",
  ASK_FOLLOW_UP: "ASK_FOLLOW_UP",
  PROBE_PARTICIPANT: "PROBE_PARTICIPANT",
  BRING_QUIET_PARTICIPANT: "BRING_QUIET_PARTICIPANT",
  MOVE_TOPIC: "MOVE_TOPIC",
  FLAG_DISAGREEMENT: "FLAG_DISAGREEMENT",
  MARK_INSIGHT: "MARK_INSIGHT",
  MARK_QUOTE: "MARK_QUOTE",
  MARK_MOMENT: "MARK_MOMENT"
});

export function collectMoxieContext(session) {
  const participants = session?.participants?.list?.() || [];
  const composition = {
    mode: session?.program?.compositionMode || CompositionMode.BALANCED,
    spotlightParticipantId: session?.program?.spotlightParticipantId || null,
    activeParticipantId: session?.program?.activeParticipantId || null,
    shareLayout: session?.program?.shareLayout || null,
    assetId: session?.assets?.live?.()?.id || null
  };
  const audience = (session?.audience?.recent?.() || []).map((item) => ({
    id: item.id,
    author: item.displayName,
    text: item.message,
    kind: item.type,
    timestamp: item.timestamp
  }));
  return {
    transcript: session?.transcript?.recent?.(40) || [],
    showContext: session?.showMemory?.compact?.() || {},
    runOfShow: session?.runOfShow?.current?.() || null,
    participants,
    composition,
    assets: (session?.assets?.list?.() || []).map((item) => ({ id: item.id, status: item.status, title: item.title })),
    timeline: session?.timeline?.recent?.(40) || session?.productionLog?.recent?.(40) || [],
    audience,
    research: session?.researchContext || null,
    focusGroup: session?.focusGroupContext || null
  };
}

export function proposeMoxieActions(context = {}) {
  const proposals = [];
  const composition = context.composition || {};
  const guests = (context.participants || []).filter((item) => item.role === "guest");
  const stats = context.showContext?.speakers || [];
  const spoken = new Set(stats.filter((item) => item.turnCount > 0).map((item) => item.participantId));

  guests.forEach((guest) => {
    if (spoken.has(guest.participantId) || spoken.has(guest.displayName)) return;
    if (stats.length < 2) return;
    proposals.push({
      type: MoxieProposalType.BRING_QUIET_PARTICIPANT,
      noticed: `${guest.displayName || "Guest"} has not spoken.`,
      recommends: `Spotlight ${guest.displayName || "the quiet guest"} for a beat.`,
      action: { type: ProductionActionType.SET_SPOTLIGHT, participantId: guest.participantId },
      requiresApproval: true
    });
  });

  const clusters = clusterAudienceQuestions(context.audience || []);
  if (clusters[0]?.count >= 2) {
    const top = clusters[0];
    proposals.push({
      type: MoxieProposalType.SURFACE_CHAT,
      noticed: `${top.count} viewers asked about ${top.theme}.`,
      recommends: "Surface the clustered audience question.",
      action: { type: ProductionActionType.SURFACE_CHAT, theme: top.theme, messageIds: top.messages.map((item) => item.id) },
      requiresApproval: true
    });
  }

  if (composition.assetId) {
    proposals.push({
      type: MoxieProposalType.RETURN_TO_PARTICIPANTS,
      noticed: "A Program Asset is live.",
      recommends: "Return to participants when the beat is done.",
      action: { type: ProductionActionType.REMOVE_ASSET, assetId: composition.assetId },
      requiresApproval: true
    });
  }

  const focus = context.focusGroup;
  if (focus?.researchQuestions?.length) {
    proposals.push({
      type: MoxieProposalType.ASK_FOLLOW_UP,
      noticed: "Focus group research question still in play.",
      recommends: `Ask: ${focus.researchQuestions[0]}`,
      action: { type: MoxieProposalType.ASK_FOLLOW_UP, question: focus.researchQuestions[0] },
      requiresApproval: true
    });
  }

  return proposals.slice(0, 6);
}

export function formatMoxieProposalFeed(proposal) {
  return {
    type: ProducerEntryType.PRODUCTION_SUGGESTION,
    title: proposal.recommends || proposal.type,
    summary: proposal.noticed,
    proposal: {
      type: proposal.type,
      action: proposal.action,
      requiresApproval: proposal.requiresApproval !== false,
      doing: false
    },
    items: [
      { text: `Noticed: ${proposal.noticed}` },
      { text: `Recommends: ${proposal.recommends}` },
      { text: "Requires approval before ProgramController executes." }
    ]
  };
}

export function hottieMayExecute(proposal, { autonomy = "suggest" } = {}) {
  if (!proposal?.action) return false;
  if (proposal.requiresApproval === false) return true;
  return autonomy === "auto" || autonomy === "autonomous";
}

export { analyzeAudienceMessage, hottiePublicReply };
