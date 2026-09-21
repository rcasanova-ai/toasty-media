// Reserved Hottie voice path. A producer stays quiet unless addressed.
// Do not synthesize speech here — TTS is wired later if infrastructure exists.

export const HottieVoiceMode = Object.freeze({
  TEXT_ONLY: "TEXT_ONLY",
  PRIVATE_HOST_AUDIO: "PRIVATE_HOST_AUDIO",
  PROGRAM_AUDIO: "PROGRAM_AUDIO"
});

export function createHottieVoicePlan({
  mode = HottieVoiceMode.TEXT_ONLY,
  text = "",
  requestedBy = "host"
} = {}) {
  const allowed = Object.values(HottieVoiceMode).includes(mode) ? mode : HottieVoiceMode.TEXT_ONLY;
  return {
    mode: allowed,
    text: String(text || "").slice(0, 400),
    requestedBy,
    speak: false,
    reason: allowed === HottieVoiceMode.TEXT_ONLY
      ? "Hottie stays silent unless a host/producer deliberately invokes audio."
      : "TTS is reserved. Status and copy are delivered as text until a voice provider is connected."
  };
}

export function shouldSpeakOnProgram(utterance) {
  return /\b(tell (everyone|the audience|them)|say it (out loud|on (air|program))|announce)\b/i.test(String(utterance || ""));
}
