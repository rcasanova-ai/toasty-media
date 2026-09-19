// The ONE composition model — pure and DOM-free on purpose, so it's testable without a browser and so
// every rendering surface (Participant View for Host/each Guest, Producer's own Program Preview, the
// Preview Live Stream tab, and any future broadcast output) computes layout from the SAME function instead
// of each independently deciding "who's visible and how" and inevitably drifting apart. Feed it a plain
// array of participants (see js/participant-registry.js's shape — participantId/role/connectionStatus/
// joinedAt/onProgram is all this reads) and get back a deterministic, stably-ordered layout.
//
// Two different composition modes, deliberately NOT unified into one function, because they answer
// different questions:
//   - composeParticipantView(participants, selfId) — "who should THIS specific viewer's main stage show,
//     given their own camera is a separate self-PiP, never one of these slots." Guest-facing AND
//     Host-facing use this identically; the only difference is which participantId is "self".
//   - composeProgram(participants) — "what does the AUDIENCE see," which has no self-PiP concept at all —
//     every on-Program participant is an equal slot, always including whoever is "self" from any given
//     viewer's perspective. Getting these two concepts confused was the exact bug already caught once
//     tonight ("the audience should never watch someone's self-view PiP").

export const ProgramLayout = Object.freeze({
  SINGLE: "single", // 1 total on-Program participant, full frame
  DUO: "duo",       // 2, two equal frames
  TRIO: "trio",     // 3, three equal vertical-ish panels (Toasty's signature 3-person default)
  QUAD: "quad",     // 4, balanced 2x2
  ASSET_FULL: "asset-full",               // ProgramAsset fills the stage
  ASSET_SPEAKER: "asset-speaker",         // ProgramAsset + one featured speaker
  ASSET_SPEAKER_PIP: "asset-speaker-pip"  // ProgramAsset full-frame, speaker as PiP
});

// Participant View only ever needs to know how many OTHER people are on the caller's main stage — self is
// always a separate PiP the caller renders on their own, never a slot from this list. Named distinctly
// from ProgramLayout (even though the CSS grid shapes end up similar) so a call site can never accidentally
// pass one where the other belongs.
export const RemoteLayout = Object.freeze({
  WAITING: "waiting",     // no one else connected yet
  ONE: "one-remote",      // 1 other participant, large
  TWO: "two-remote",      // 2 others, split equally
  THREE: "three-remote"   // 3 others, balanced
});

const MAX_ON_PROGRAM = 4;
const MAX_REMOTE_OTHERS = 3; // self + 3 others = the 4-participant cap (1 Host + 3 Guests)

function isConnected(participant) {
  return participant.connectionStatus === "connected" || participant.connectionStatus === undefined;
}

// Callers feed this TWO different joinedAt representations and both need to sort correctly together:
// js/participant-registry.js's createParticipant stamps a numeric Date.now(), but js/room-presence.js's
// roster (what js/guest.js's own composition calls are built from) carries the backend's ISO timestamp
// string (scripts/toasty-auth-db.py's utc_now()). A bare numeric subtraction on two ISO strings coerces to
// NaN and silently breaks the sort (Array.prototype.sort treats a NaN comparator result as "equal", so
// nothing would actually reorder) — normalizing here once means every other call site can stay agnostic
// about which shape its data came from.
function toTimestamp(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Host always first, everyone else by joinedAt ascending — the ONE ordering rule every composition in this
// module uses. Stable across recomposition: inserting or removing a participant only ever affects that
// participant's own slot and everyone AFTER them in join order, never reshuffles someone already
// positioned earlier. joinedAt ties (shouldn't happen in practice — see createParticipant's own comment on
// why it's always stamped once at genuine discovery) fall back to participantId for a fully deterministic
// sort regardless.
export function stableOrder(participants) {
  return [...participants].sort((a, b) => {
    if (a.role === "host" && b.role !== "host") return -1;
    if (b.role === "host" && a.role !== "host") return 1;
    const byJoin = toTimestamp(a.joinedAt) - toTimestamp(b.joinedAt);
    if (byJoin !== 0) return byJoin;
    return String(a.participantId).localeCompare(String(b.participantId));
  });
}

const PROGRAM_LAYOUT_BY_COUNT = { 1: ProgramLayout.SINGLE, 2: ProgramLayout.DUO, 3: ProgramLayout.TRIO, 4: ProgramLayout.QUAD };
const REMOTE_LAYOUT_BY_COUNT = { 0: RemoteLayout.WAITING, 1: RemoteLayout.ONE, 2: RemoteLayout.TWO, 3: RemoteLayout.THREE };

// Audience-facing composition. onProgram !== false is the "available sources vs sources currently taken to
// Program" distinction (see this pass's report) — every connected camera participant defaults onProgram:
// true (see createParticipant), so automatic composition includes everyone for now, but a Producer
// explicitly pulling someone off Program later is just flipping that one field, not rebuilding this
// function. screenShareActive is scaffolding only this pass (see js/live-session.js's existing
// toggleScreenShare, which already knows how to restore the prior layout on stop) — composeProgram doesn't
// yet special-case it, just accepts and threads the flag through so a caller can branch on it without this
// module's shape needing to change later.
function isLiveProgramAsset(asset) {
  return Boolean(asset) && (asset.status === "live" || asset.status === undefined);
}

export function composeProgram(participants, { screenShareActive = false, asset = null, assetLayout = null } = {}) {
  const ordered = stableOrder(participants.filter((p) => isConnected(p) && p.onProgram !== false));
  if (isLiveProgramAsset(asset)) {
    const requested = assetLayout || ProgramLayout.ASSET_SPEAKER;
    const speaker = ordered[0] || null;
    if (requested === ProgramLayout.ASSET_FULL || !speaker) {
      return { layout: ProgramLayout.ASSET_FULL, slots: [], asset, screenShareActive };
    }
    return {
      layout: requested === ProgramLayout.ASSET_SPEAKER_PIP ? ProgramLayout.ASSET_SPEAKER_PIP : ProgramLayout.ASSET_SPEAKER,
      slots: [speaker],
      asset,
      screenShareActive
    };
  }
  const slots = ordered.slice(0, MAX_ON_PROGRAM);
  const layout = PROGRAM_LAYOUT_BY_COUNT[slots.length] || (slots.length === 0 ? null : ProgramLayout.QUAD);
  return { layout, slots, asset: null, screenShareActive };
}

// Participant-View composition for ONE specific viewer. "others" is stably ordered the SAME way
// composeProgram orders its slots, so a Guest's main stage and the Producer's Program never disagree about
// who's "first" even though they're two different composition calls.
export function composeParticipantView(participants, selfParticipantId) {
  const others = stableOrder(participants.filter((p) => isConnected(p) && p.participantId !== selfParticipantId)).slice(0, MAX_REMOTE_OTHERS);
  return { layout: REMOTE_LAYOUT_BY_COUNT[others.length] ?? RemoteLayout.THREE, others };
}
