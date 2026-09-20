// Audio activity nominates an active participant. It NEVER touches Program Output DOM.
// ProgramComposition receives activeParticipantId and decides layout.

export const ACTIVE_SPEAKER_THRESHOLD = 0.22;
export const ACTIVE_SPEAKER_HYSTERESIS = 0.12;
export const ACTIVE_SPEAKER_HOLD_MS = 1800;

export function nominateActiveSpeaker({
  levels = [],
  currentId = null,
  now = Date.now(),
  lastSwitchAt = 0
} = {}) {
  const ranked = [...levels]
    .filter((entry) => Number(entry?.level) >= ACTIVE_SPEAKER_THRESHOLD)
    .sort((a, b) => Number(b.level) - Number(a.level));
  const top = ranked[0] || null;
  if (!top) return { participantId: currentId, switched: false, lastSwitchAt };
  if (!currentId || currentId === top.participantId) {
    return {
      participantId: top.participantId,
      switched: currentId !== top.participantId,
      lastSwitchAt: currentId === top.participantId ? lastSwitchAt : now
    };
  }
  const currentLevel = Number(levels.find((entry) => entry.participantId === currentId)?.level || 0);
  if (top.level < currentLevel + ACTIVE_SPEAKER_HYSTERESIS) {
    return { participantId: currentId, switched: false, lastSwitchAt };
  }
  if (now - lastSwitchAt < ACTIVE_SPEAKER_HOLD_MS) {
    return { participantId: currentId, switched: false, lastSwitchAt };
  }
  return { participantId: top.participantId, switched: true, lastSwitchAt: now };
}
