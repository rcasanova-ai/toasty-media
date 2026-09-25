#!/usr/bin/env node
// Pure-logic tests for js/consent-policy.js + js/speaker-readiness.js — no server, no DOM.
import {
  requiredConsentKeysFor,
  consentSatisfiesRequirements,
  sanitizeConsentKeyList,
  RequiredConsentKey,
  OptionalConsentKey
} from "../js/consent-policy.js";
import {
  computeSpeakerReadiness,
  dueReminders,
  ReadinessItem,
  ReminderKind
} from "../js/speaker-readiness.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log("Consent policy — required keys are configurable by session type, optional stays optional");
{
  const defaultKeys = requiredConsentKeysFor({ sessionType: "default" });
  assert(defaultKeys.includes(RequiredConsentKey.RECORDING), "default session type requires recording consent");
  assert(!defaultKeys.includes(RequiredConsentKey.CONFIDENTIALITY), "default session type does not require confidentiality");

  const focusGroupKeys = requiredConsentKeysFor({ sessionType: "focus_group" });
  assert(focusGroupKeys.includes(RequiredConsentKey.CONFIDENTIALITY), "focus group requires confidentiality");
  assert(focusGroupKeys.includes(RequiredConsentKey.RESEARCH_PARTICIPATION), "focus group requires research participation consent");

  const withTranscription = requiredConsentKeysFor({ sessionType: "default", transcriptionEnabled: true });
  assert(withTranscription.includes(RequiredConsentKey.TRANSCRIPTION), "transcription consent only required when transcription is actually enabled");
  const withoutTranscription = requiredConsentKeysFor({ sessionType: "default", transcriptionEnabled: false });
  assert(!withoutTranscription.includes(RequiredConsentKey.TRANSCRIPTION), "transcription consent not required when transcription is off");

  assert(!Object.values(OptionalConsentKey).some((key) => defaultKeys.includes(key)), "optional permissions never leak into the required set");
}

console.log("\nConsent policy — satisfaction check");
{
  const config = { sessionType: "default" };
  const complete = ["terms_of_service", "privacy_policy", "recording", "distribution_replay", "marketing_communications"];
  assert(consentSatisfiesRequirements(complete, config), "all required keys present (plus an unrelated optional one) satisfies requirements");
  const missingOne = ["terms_of_service", "privacy_policy", "recording"];
  assert(!consentSatisfiesRequirements(missingOne, config), "missing distribution_replay fails requirements");
  assert(!consentSatisfiesRequirements([], config), "empty acceptances never satisfies requirements");

  assertEqual(sanitizeConsentKeyList(["recording", "made_up_key", "marketing_communications"]), ["recording", "marketing_communications"], "unknown keys are dropped, known keys kept");
}

console.log("\nSpeaker readiness — not ready until every required item is complete");
{
  const speaker = { id: "spk_1", displayName: "Alice", title: "VP Eng", bioShort: "Builds things.", headshotReference: "img.png" };
  const consentRecords = [{
    participantId: "spk_1",
    acceptedAt: "2026-01-01T00:00:00Z",
    revokedAt: null,
    requiredAcceptances: ["terms_of_service", "privacy_policy", "recording", "distribution_replay"]
  }];
  const techCheck = { cameraOk: true, micOk: true, browserSupported: true };

  const fullyReady = computeSpeakerReadiness({
    speaker, techCheck, consentRecords, requirementConfig: { sessionType: "default" },
    calendarConfirmed: true, sessionLinkSent: true
  });
  assertEqual(fullyReady.ready, true, "every item complete => ready");
  assertEqual(fullyReady.items[ReadinessItem.CONSENT], true, "consent item true when required keys satisfied");
  assertEqual(fullyReady.items[ReadinessItem.RELEASE], true, "release item true when distribution_replay accepted");

  const noTechCheck = computeSpeakerReadiness({
    speaker, techCheck: null, consentRecords, requirementConfig: { sessionType: "default" },
    calendarConfirmed: true, sessionLinkSent: true
  });
  assertEqual(noTechCheck.ready, false, "missing tech check => not ready, even with everything else complete");
  assertEqual(noTechCheck.items[ReadinessItem.TECH_CHECK], false, "tech_check item reflects the actual missing check");
  assertEqual(noTechCheck.items[ReadinessItem.PROFILE], true, "other items stay true independently");

  const revokedConsent = computeSpeakerReadiness({
    speaker, techCheck,
    consentRecords: [{ ...consentRecords[0], revokedAt: "2026-01-02T00:00:00Z" }],
    requirementConfig: { sessionType: "default" }, calendarConfirmed: true, sessionLinkSent: true
  });
  assertEqual(revokedConsent.ready, false, "a revoked consent record no longer counts toward readiness");

  const noProfile = computeSpeakerReadiness({
    speaker: { id: "spk_2" }, techCheck, consentRecords: [], requirementConfig: { sessionType: "default" }
  });
  assertEqual(noProfile.ready, false, "blank speaker is never accidentally marked ready");
}

console.log("\nReminders — configurable, never spam the same kind twice");
{
  const notReady = { ready: false, items: { [ReadinessItem.PROFILE]: false, [ReadinessItem.CONSENT]: false, [ReadinessItem.TECH_CHECK]: false } };
  const now = Date.parse("2026-06-01T00:00:00Z");

  const farOut = dueReminders({ readiness: notReady, now, scheduledAtMs: now + 10 * 24 * 60 * 60 * 1000 });
  assert(farOut.includes(ReminderKind.PROFILE_INCOMPLETE), "incomplete-item reminders fire regardless of how far away the session is");
  assert(!farOut.includes(ReminderKind.SESSION_IN_7_DAYS), "the 7-day time reminder does not fire 10 days out");

  const sevenDaysOut = dueReminders({ readiness: notReady, now, scheduledAtMs: now + 5 * 24 * 60 * 60 * 1000 });
  assert(sevenDaysOut.includes(ReminderKind.SESSION_IN_7_DAYS), "7-day reminder fires inside the 7-day window");

  const oneHourOut = dueReminders({ readiness: notReady, now, scheduledAtMs: now + 30 * 60 * 1000 });
  assert(oneHourOut.includes(ReminderKind.SESSION_IN_1_HOUR), "1-hour reminder fires inside the 1-hour window");
  assert(!oneHourOut.includes(ReminderKind.SESSION_TOMORROW), "does not also fire the tomorrow reminder an hour out");

  const alreadySent = dueReminders({
    readiness: notReady, now, scheduledAtMs: now + 5 * 24 * 60 * 60 * 1000,
    sentReminderKinds: [ReminderKind.PROFILE_INCOMPLETE, ReminderKind.SESSION_IN_7_DAYS]
  });
  assert(!alreadySent.includes(ReminderKind.PROFILE_INCOMPLETE), "a reminder kind already sent is not repeated");
  assert(!alreadySent.includes(ReminderKind.SESSION_IN_7_DAYS), "time-based reminders also respect the sent list");
  assert(alreadySent.includes(ReminderKind.CONSENT_INCOMPLETE), "other still-due reminder kinds keep firing");

  const ready = { ready: true, items: { [ReadinessItem.PROFILE]: true, [ReadinessItem.CONSENT]: true, [ReadinessItem.TECH_CHECK]: true } };
  const readySoon = dueReminders({ readiness: ready, now, scheduledAtMs: now + 30 * 60 * 1000 });
  assertEqual(readySoon, [], "a fully ready speaker gets no reminders at all, even minutes before the session");
}

console.log("\nAll speaker readiness / consent policy tests passed.");
