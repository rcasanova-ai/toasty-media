// Audio activity nominates an active participant. It NEVER touches Program Output DOM.
// ProgramComposition receives activeParticipantId and decides layout.

export const ACTIVE_SPEAKER_THRESHOLD = 0.22;
export const ACTIVE_SPEAKER_HYSTERESIS = 0.12;
export const ACTIVE_SPEAKER_HOLD_MS = 1800;
export const ACTIVE_SPEAKER_ATTACK_MS = 320;
export const ACTIVE_SPEAKER_RELEASE_MS = 900;
export const ACTIVE_SPEAKER_SILENCE_TIMEOUT_MS = 2800;

export function nominateActiveSpeaker({
  levels = [],
  currentId = null,
  now = Date.now(),
  lastSwitchAt = 0,
  threshold = ACTIVE_SPEAKER_THRESHOLD,
  hysteresis = ACTIVE_SPEAKER_HYSTERESIS,
  holdMs = ACTIVE_SPEAKER_HOLD_MS
} = {}) {
  const ranked = [...levels]
    .filter((entry) => Number(entry?.level) >= threshold)
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
  if (top.level < currentLevel + hysteresis) {
    return { participantId: currentId, switched: false, lastSwitchAt };
  }
  if (now - lastSwitchAt < holdMs) {
    return { participantId: currentId, switched: false, lastSwitchAt };
  }
  return { participantId: top.participantId, switched: true, lastSwitchAt: now };
}

export class ActiveSpeakerController {
  constructor({
    threshold = ACTIVE_SPEAKER_THRESHOLD,
    hysteresis = ACTIVE_SPEAKER_HYSTERESIS,
    holdMs = ACTIVE_SPEAKER_HOLD_MS,
    attackMs = ACTIVE_SPEAKER_ATTACK_MS,
    silenceTimeoutMs = ACTIVE_SPEAKER_SILENCE_TIMEOUT_MS
  } = {}) {
    this.threshold = threshold;
    this.hysteresis = hysteresis;
    this.holdMs = holdMs;
    this.attackMs = attackMs;
    this.silenceTimeoutMs = silenceTimeoutMs;
    this.levels = new Map();
    this.risingSince = new Map();
    this.lastHeardAt = new Map();
    this.currentId = null;
    this.lastSwitchAt = 0;
  }

  note(participantId, level, now = Date.now()) {
    if (!participantId) return { participantId: this.currentId, switched: false, lastSwitchAt: this.lastSwitchAt };
    const value = Number(level) || 0;
    this.levels.set(participantId, value);
    if (value >= this.threshold) {
      if (!this.risingSince.has(participantId)) this.risingSince.set(participantId, now);
      this.lastHeardAt.set(participantId, now);
    } else {
      this.risingSince.delete(participantId);
    }

    const eligible = [...this.levels.entries()].map(([id, raw]) => {
      const roseAt = this.risingSince.get(id);
      const held = Boolean(roseAt && now - roseAt >= this.attackMs);
      return { participantId: id, level: held ? raw : 0 };
    });

    const nomination = nominateActiveSpeaker({
      levels: eligible,
      currentId: this.currentId,
      now,
      lastSwitchAt: this.lastSwitchAt,
      threshold: this.threshold,
      hysteresis: this.hysteresis,
      holdMs: this.holdMs
    });

    if (!nomination.participantId && this.currentId) {
      const heard = this.lastHeardAt.get(this.currentId) || 0;
      if (now - heard < this.silenceTimeoutMs) {
        return { participantId: this.currentId, switched: false, lastSwitchAt: this.lastSwitchAt };
      }
    }

    if (nomination.switched || (!this.currentId && nomination.participantId)) {
      this.currentId = nomination.participantId;
      this.lastSwitchAt = nomination.lastSwitchAt;
    }
    return {
      participantId: this.currentId,
      switched: Boolean(nomination.switched),
      lastSwitchAt: this.lastSwitchAt
    };
  }

  snapshot() {
    return [...this.levels.entries()].map(([participantId, level]) => ({
      participantId,
      audioLevel: level,
      speaking: level >= this.threshold
    }));
  }
}
