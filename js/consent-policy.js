// Canonical consent/release keys and per-session-type requirements (Event Growth layer, section 6).
// This is the canonical source; scripts/render-production-server.mjs keeps its own copy of the known-key
// allowlist (CONSENT_KNOWN_KEYS) because it is deployed as one self-contained file with no relative
// imports (same precedent as js/producer-persona.js vs. that script's own AI_PRODUCER_BASELINE_PERSONA —
// see that file's top comment). Keep the two lists in sync by hand.
//
// Required acceptances and optional permissions are DELIBERATELY separate lists — never bundle an
// optional permission (promotional reuse, marketing email, retaining profile data) into the same
// checkbox as a required one (recording consent, distribution consent).

export const RequiredConsentKey = Object.freeze({
  TERMS_OF_SERVICE: "terms_of_service",
  PRIVACY_POLICY: "privacy_policy",
  RECORDING: "recording",
  TRANSCRIPTION: "transcription",
  AI_PROCESSING: "ai_processing",
  DISTRIBUTION_REPLAY: "distribution_replay",
  CONFIDENTIALITY: "confidentiality",
  RESEARCH_PARTICIPATION: "research_participation",
  DATA_USE: "data_use",
  CLIENT_RELEASE: "client_release"
});

export const OptionalConsentKey = Object.freeze({
  PROMOTIONAL_CLIPS: "promotional_clips",
  RETAIN_PROFILE: "retain_profile",
  PEEPS_PROFILE: "peeps_profile",
  MARKETING_COMMUNICATIONS: "marketing_communications"
});

export const CONSENT_KNOWN_KEYS = new Set([
  ...Object.values(RequiredConsentKey),
  ...Object.values(OptionalConsentKey)
]);

export const ParticipantType = Object.freeze({
  SPEAKER: "speaker",
  GUEST: "guest",
  FOCUS_GROUP_PARTICIPANT: "focus_group_participant",
  PANELIST: "panelist",
  SPONSOR_REPRESENTATIVE: "sponsor_representative",
  RESEARCH_PARTICIPANT: "research_participant"
});

// Baseline required set every participant type shares, before session-type-specific additions below.
const BASELINE_REQUIRED = [
  RequiredConsentKey.TERMS_OF_SERVICE,
  RequiredConsentKey.PRIVACY_POLICY,
  RequiredConsentKey.RECORDING,
  RequiredConsentKey.DISTRIBUTION_REPLAY
];

// Configurable by session type (section 6's explicit requirement). A session's capture policy
// (js/session-policy.js's CapturePolicy — NONE/TRANSCRIPT/RECORDING/RECORDING_AND_TRANSCRIPT) decides
// whether TRANSCRIPTION/AI_PROCESSING are even shown, let alone required — callers pass that in.
const SESSION_TYPE_REQUIREMENTS = Object.freeze({
  default: BASELINE_REQUIRED,
  focus_group: [...BASELINE_REQUIRED, RequiredConsentKey.CONFIDENTIALITY, RequiredConsentKey.RESEARCH_PARTICIPATION, RequiredConsentKey.DATA_USE],
  research_interview: [...BASELINE_REQUIRED, RequiredConsentKey.CONFIDENTIALITY, RequiredConsentKey.RESEARCH_PARTICIPATION, RequiredConsentKey.DATA_USE],
  client_engagement: [...BASELINE_REQUIRED, RequiredConsentKey.CONFIDENTIALITY, RequiredConsentKey.CLIENT_RELEASE]
});

export function requiredConsentKeysFor({ sessionType = "default", transcriptionEnabled = false, aiProcessingEnabled = false } = {}) {
  const base = SESSION_TYPE_REQUIREMENTS[sessionType] || SESSION_TYPE_REQUIREMENTS.default;
  const keys = new Set(base);
  if (transcriptionEnabled) keys.add(RequiredConsentKey.TRANSCRIPTION);
  if (aiProcessingEnabled) keys.add(RequiredConsentKey.AI_PROCESSING);
  return [...keys];
}

// True only when every key this session type/config actually requires is present AND true-valued in the
// submitted requiredAcceptances list. A key the config doesn't require is simply not checked — an
// extra/unknown key submitted alongside real ones does not itself invalidate consent.
export function consentSatisfiesRequirements(requiredAcceptances, requirementConfig) {
  const submitted = new Set(Array.isArray(requiredAcceptances) ? requiredAcceptances : []);
  const needed = requiredConsentKeysFor(requirementConfig);
  return needed.every((key) => submitted.has(key));
}

export function sanitizeConsentKeyList(list) {
  return (Array.isArray(list) ? list : []).filter((key) => CONSENT_KNOWN_KEYS.has(key));
}
