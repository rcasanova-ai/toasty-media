#!/usr/bin/env node
// Pure-logic tests for js/email-service.js.
import { createEmailService, renderEmail, EmailTemplate, DevLogEmailProvider } from "../js/email-service.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("Templates render provider-neutral subject/body");
{
  const invite = renderEmail(EmailTemplate.SPEAKER_INVITE, { eventName: "Q3 Launch", inviteUrl: "https://toasty.media/i/abc" });
  assert(invite.subject.includes("Q3 Launch"), "speaker invite subject includes event name");
  assert(invite.body.includes("https://toasty.media/i/abc"), "speaker invite body includes the invite URL");

  let threw = false;
  try { renderEmail("not_a_real_template", {}); } catch (_) { threw = true; }
  assert(threw, "unknown template throws instead of silently rendering blank mail");
}

console.log("\nDev-mode provider never fails and is not disguised as a real vendor");
{
  const sent = [];
  const spy = { name: "spy", send: async (mail) => { sent.push(mail); return { ok: true, provider: "spy" }; } };
  const service = createEmailService({ provider: spy });
  const result = await service.sendEmail({ to: "alice@example.com", template: EmailTemplate.SPEAKER_INVITE, data: { eventName: "Launch", inviteUrl: "https://x/y" } });
  assert(result.ok === true, "send resolves ok with a spy provider");
  assert(sent.length === 1 && sent[0].to === "alice@example.com", "provider actually receives the recipient");

  const defaultService = createEmailService();
  assert(defaultService.provider === "dev_log", "default provider is honestly named dev_log, not a fake vendor name");
  const devResult = await defaultService.sendEmail({ to: "bob@example.com", template: EmailTemplate.SESSION_REMINDER, data: { eventName: "Launch", whenText: "tomorrow" } });
  assert(devResult.provider === "dev_log", "dev provider result is tagged as dev_log so callers can't mistake it for a real send");

  let missingRecipientThrew = false;
  try { await defaultService.sendEmail({ template: EmailTemplate.SESSION_REMINDER, data: {} }); } catch (_) { missingRecipientThrew = true; }
  assert(missingRecipientThrew, "sending without a recipient throws rather than silently dropping mail");
}

console.log("\nEvery workflow email in the spec has a template");
{
  const required = [
    "speaker_invite", "sponsor_invite", "profile_incomplete_reminder", "consent_incomplete_reminder",
    "tech_check_reminder", "session_reminder", "registration_confirmation", "event_reminder",
    "replay_available", "sponsor_approval_request"
  ];
  for (const key of required) {
    assert(Object.values(EmailTemplate).includes(key), `template "${key}" is registered`);
  }
}

console.log("\nAll email service tests passed.");
