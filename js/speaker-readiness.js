// Speaker readiness (Event Growth layer, section 5). Pure functions — no DOM, no fetch — mirroring
// js/session-policy.js's SessionPolicy pattern: every consuming surface (planner readiness review,
// reminder scheduler, "you're ready for EVENT NAME" tech-check screen) calls these instead of each
// re-deriving its own notion of "ready", so there is exactly one definition of READY in the codebase.

import { requiredConsentKeysFor, consentSatisfiesRequirements } from "./consent-policy.js";

export const ReadinessItem = Object.freeze({
  PROFILE: "profile",
  PHOTO: "photo",
  CONSENT: "consent",
  RELEASE: "release",
  TECH_CHECK: "tech_check",
  CALENDAR: "calendar",
  SESSION_LINK: "session_link"
});

function hasProfile(speaker) {
  return Boolean(speaker?.displayName && speaker?.title && speaker?.bioShort);
}

function hasPhoto(speaker) {
  return Boolean(speaker?.headshotReference);
}

// "Release" is distribution/replay consent specifically — distinct from the broader recording consent
// bundled under CONSENT below, per section 6's "do not bundle every optional permission into one giant
// checkbox" and the mission's own checklist listing CONSENT and RELEASE as two separate rows.
function latestConsent(consentRecords, participantId) {
  return (consentRecords || [])
    .filter((record) => record.participantId === participantId && !record.revokedAt)
    .sort((a, b) => new Date(b.acceptedAt) - new Date(a.acceptedAt))[0] || null;
}

function hasConsent(consentRecords, speaker, requirementConfig) {
  const record = latestConsent(consentRecords, speaker?.id);
  if (!record) return false;
  return consentSatisfiesRequirements(record.requiredAcceptances, requirementConfig);
}

function hasRelease(consentRecords, speaker) {
  const record = latestConsent(consentRecords, speaker?.id);
  return Boolean(record?.requiredAcceptances?.includes("distribution_replay"));
}

function hasTechCheck(techCheck) {
  return Boolean(techCheck?.cameraOk && techCheck?.micOk && techCheck?.browserSupported);
}

// Calendar/session-link are organizer-provided facts, not derived — passed in explicitly rather than
// guessed from other fields, since nothing else in the Speaker row implies them.
export function computeSpeakerReadiness({ speaker, techCheck, consentRecords, requirementConfig, calendarConfirmed = false, sessionLinkSent = false } = {}) {
  const items = {
    [ReadinessItem.PROFILE]: hasProfile(speaker),
    [ReadinessItem.PHOTO]: hasPhoto(speaker),
    [ReadinessItem.CONSENT]: hasConsent(consentRecords, speaker, requirementConfig),
    [ReadinessItem.RELEASE]: hasRelease(consentRecords, speaker),
    [ReadinessItem.TECH_CHECK]: hasTechCheck(techCheck),
    [ReadinessItem.CALENDAR]: Boolean(calendarConfirmed),
    [ReadinessItem.SESSION_LINK]: Boolean(sessionLinkSent)
  };
  const ready = Object.values(items).every(Boolean);
  return { items, ready };
}

export function requiredConsentKeysForSpeaker(sessionPlan) {
  return requiredConsentKeysFor({
    sessionType: sessionPlan?.sessionType,
    transcriptionEnabled: sessionPlan?.capturePolicy === "transcript" || sessionPlan?.capturePolicy === "recording_and_transcript",
    aiProcessingEnabled: Boolean(sessionPlan?.aiProcessingAllowed)
  });
}

const REMINDER_KIND = Object.freeze({
  PROFILE_INCOMPLETE: "profile_incomplete",
  CONSENT_INCOMPLETE: "consent_incomplete",
  TECH_CHECK_INCOMPLETE: "tech_check_incomplete",
  SESSION_IN_7_DAYS: "session_in_7_days",
  SESSION_TOMORROW: "session_tomorrow",
  SESSION_IN_1_HOUR: "session_in_1_hour"
});
export { REMINDER_KIND as ReminderKind };

// Which reminders currently apply, given readiness + how far away the session is. Never returns more
// than one "incomplete item" reminder per item and never returns a time-based reminder for an item that
// is already complete — the whole point is "do not spam" (section 5's explicit requirement).
export function dueReminders({ readiness, now = Date.now(), scheduledAtMs, sentReminderKinds = [] } = {}) {
  const sent = new Set(sentReminderKinds);
  const due = [];
  const add = (kind) => { if (!sent.has(kind)) due.push(kind); };

  if (!readiness?.items?.[ReadinessItem.PROFILE]) add(REMINDER_KIND.PROFILE_INCOMPLETE);
  if (!readiness?.items?.[ReadinessItem.CONSENT]) add(REMINDER_KIND.CONSENT_INCOMPLETE);
  if (!readiness?.items?.[ReadinessItem.TECH_CHECK]) add(REMINDER_KIND.TECH_CHECK_INCOMPLETE);

  if (Number.isFinite(scheduledAtMs)) {
    const msUntil = scheduledAtMs - now;
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    if (!readiness?.ready) {
      if (msUntil <= 7 * day && msUntil > day) add(REMINDER_KIND.SESSION_IN_7_DAYS);
      if (msUntil <= day && msUntil > hour) add(REMINDER_KIND.SESSION_TOMORROW);
      if (msUntil <= hour && msUntil > 0) add(REMINDER_KIND.SESSION_IN_1_HOUR);
    }
  }
  return due;
}
