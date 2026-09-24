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
  DUO: "duo",       // 2, two equal frames — the accepted 2-person Program Output
  TRIO: "trio",     // 3, three equal vertical-ish panels (Toasty's signature 3-person default)
  QUAD: "quad",     // 4, balanced 2x2
  SPOTLIGHT: "spotlight",
  ACTIVE_SPEAKER: "active-speaker",
  SCREEN_ONLY: "screen-only",
  SCREEN_SPEAKER: "screen-speaker",
  SCREEN_STRIP: "screen-strip",
  ASSET_FULL: "asset-full",               // ProgramAsset fills the stage
  ASSET_SPEAKER: "asset-speaker",         // ProgramAsset + one featured speaker
  ASSET_SPEAKER_PIP: "asset-speaker-pip"  // ProgramAsset full-frame, speaker as PiP
});

export const CompositionMode = Object.freeze({
  BALANCED: "balanced",
  ACTIVE_SPEAKER: "active-speaker",
  SPOTLIGHT: "spotlight"
});

export const ShareLayout = Object.freeze({
  SCREEN_ONLY: "screen-only",
  SCREEN_SPEAKER: "screen-speaker",
  SCREEN_STRIP: "screen-strip"
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

export function dedupeProgramParticipants(participants = []) {
  const byIdentity = new Map();
  for (const participant of participants || []) {
    if (!participant?.participantId) continue;
    const isHost = participant.participantId === "host" || participant.role === "host";
    const key = isHost ? "host" : `participant:${participant.participantId}`;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, participant);
      continue;
    }
    byIdentity.set(key, {
      ...existing,
      ...participant,
      participantId: isHost ? "host" : existing.participantId,
      role: isHost ? "host" : (existing.role || participant.role),
      displayName: existing.displayName || participant.displayName,
      title: existing.title || participant.title,
      company: existing.company || participant.company,
      transportSourceId: existing.transportSourceId || participant.transportSourceId,
      videoSource: existing.videoSource?.kind !== "none" ? existing.videoSource : participant.videoSource,
      audioSource: existing.audioSource?.kind !== "none" ? existing.audioSource : participant.audioSource,
      joinedAt: Math.min(toTimestamp(existing.joinedAt), toTimestamp(participant.joinedAt)) || existing.joinedAt || participant.joinedAt
    });
  }
  return [...byIdentity.values()];
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

export function compositionOptionsFromState(state = {}) {
  state = state || {};
  const screenShare = state.screenShare || null;
  return {
    screenShareActive: Boolean(screenShare?.active || state.screenShareActive),
    screenShare,
    asset: state.asset || null,
    assetLayout: state.assetLayout || null,
    mode: state.compositionMode || CompositionMode.BALANCED,
    activeParticipantId: state.activeParticipantId || null,
    spotlightParticipantId: state.spotlightParticipantId || null,
    shareLayout: state.shareLayout || null
  };
}

function resultShape({ layout, slots, asset = null, screen = null, featuredId = null, mode, shareLayout, screenShareActive }) {
  return {
    layout,
    slots,
    asset,
    screen,
    featuredId,
    mode: mode || CompositionMode.BALANCED,
    shareLayout: shareLayout || null,
    screenShareActive: Boolean(screenShareActive)
  };
}

function featuredFirst(ordered, featuredId) {
  if (!featuredId) return ordered;
  const featured = ordered.find((entry) => entry.participantId === featuredId);
  if (!featured) return ordered;
  return [featured, ...ordered.filter((entry) => entry.participantId !== featuredId)];
}

function screenSourceFrom(options) {
  const share = options.screenShare;
  // Gate on share.active (now only true once VDO.Ninja confirms the publish — see
  // js/screen-share-source.js), NOT on bare transportSourceId: that id exists the instant a share is
  // requested, well before any real connection, which used to switch Program layout to a screen
  // composition even when the picker was cancelled or the publish never connected.
  if (share && (share.active || share.stream)) {
    return {
      participantId: share.participantId ? `screen-${share.participantId}` : "screen",
      role: "screen",
      ownerParticipantId: share.ownerParticipantId || share.participantId || "host",
      transportSourceId: share.transportSourceId || null,
      displayName: share.displayName || "Screen"
    };
  }
  if (options.screenShareActive) {
    return { participantId: "screen", role: "screen", ownerParticipantId: "host", transportSourceId: null, displayName: "Screen" };
  }
  return null;
}

export function composeProgram(participants, options = {}) {
  const opts = {
    screenShareActive: false,
    screenShare: null,
    asset: null,
    assetLayout: null,
    mode: CompositionMode.BALANCED,
    activeParticipantId: null,
    spotlightParticipantId: null,
    shareLayout: null,
    ...options
  };
  const ordered = stableOrder(dedupeProgramParticipants(participants).filter((p) => isConnected(p) && p.onProgram !== false));
  const screen = screenSourceFrom(opts);
  const screenShareActive = Boolean(screen);
  const mode = Object.values(CompositionMode).includes(opts.mode) ? opts.mode : CompositionMode.BALANCED;

  if (isLiveProgramAsset(opts.asset)) {
    const requested = opts.assetLayout || ProgramLayout.ASSET_SPEAKER;
    const speaker = ordered[0] || null;
    if (requested === ProgramLayout.ASSET_FULL || !speaker) {
      return resultShape({ layout: ProgramLayout.ASSET_FULL, slots: [], asset: opts.asset, screen: null, mode, screenShareActive });
    }
    return resultShape({
      layout: requested === ProgramLayout.ASSET_SPEAKER_PIP ? ProgramLayout.ASSET_SPEAKER_PIP : ProgramLayout.ASSET_SPEAKER,
      slots: [speaker],
      asset: opts.asset,
      featuredId: speaker.participantId,
      mode,
      screenShareActive
    });
  }

  if (screen) {
    const shareLayout = Object.values(ShareLayout).includes(opts.shareLayout) ? opts.shareLayout : ShareLayout.SCREEN_SPEAKER;
    if (shareLayout === ShareLayout.SCREEN_ONLY || ordered.length === 0) {
      return resultShape({ layout: ProgramLayout.SCREEN_ONLY, slots: [], screen, mode, shareLayout, screenShareActive });
    }
    if (shareLayout === ShareLayout.SCREEN_STRIP) {
      return resultShape({
        layout: ProgramLayout.SCREEN_STRIP,
        slots: ordered.slice(0, MAX_ON_PROGRAM),
        screen,
        mode,
        shareLayout,
        screenShareActive
      });
    }
    const speakerId = opts.spotlightParticipantId || opts.activeParticipantId || ordered[0]?.participantId;
    const speakerSlots = featuredFirst(ordered, speakerId).slice(0, 1);
    return resultShape({
      layout: ProgramLayout.SCREEN_SPEAKER,
      slots: speakerSlots,
      screen,
      featuredId: speakerSlots[0]?.participantId || null,
      mode,
      shareLayout: ShareLayout.SCREEN_SPEAKER,
      screenShareActive
    });
  }

  if (mode === CompositionMode.SPOTLIGHT && opts.spotlightParticipantId) {
    const slots = featuredFirst(ordered, opts.spotlightParticipantId).slice(0, MAX_ON_PROGRAM);
    if (slots.length >= 2 && slots[0].participantId === opts.spotlightParticipantId) {
      return resultShape({
        layout: ProgramLayout.SPOTLIGHT,
        slots,
        featuredId: slots[0].participantId,
        mode,
        screenShareActive
      });
    }
  }

  if (mode === CompositionMode.ACTIVE_SPEAKER && opts.activeParticipantId) {
    const slots = featuredFirst(ordered, opts.activeParticipantId).slice(0, MAX_ON_PROGRAM);
    if (slots.length >= 2 && slots[0].participantId === opts.activeParticipantId) {
      return resultShape({
        layout: ProgramLayout.ACTIVE_SPEAKER,
        slots,
        featuredId: slots[0].participantId,
        mode,
        screenShareActive
      });
    }
  }

  const slots = ordered.slice(0, MAX_ON_PROGRAM);
  const layout = PROGRAM_LAYOUT_BY_COUNT[slots.length] || (slots.length === 0 ? null : ProgramLayout.QUAD);
  return resultShape({ layout, slots, asset: null, mode: CompositionMode.BALANCED, screenShareActive });
}

// Participant-View composition for ONE specific viewer. "others" is stably ordered the SAME way
// composeProgram orders its slots, so a Guest's main stage and the Producer's Program never disagree about
// who's "first" even though they're two different composition calls.
export function composeParticipantView(participants, selfParticipantId) {
  const others = stableOrder(participants.filter((p) => isConnected(p) && p.participantId !== selfParticipantId)).slice(0, MAX_REMOTE_OTHERS);
  return { layout: REMOTE_LAYOUT_BY_COUNT[others.length] ?? RemoteLayout.THREE, others };
}
