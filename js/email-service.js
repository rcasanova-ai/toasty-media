// Email service abstraction (Event Growth layer, section 24). Workflow logic (speaker invites, sponsor
// invites, reminders, registration confirmations) is written against sendEmail()/EmailTemplate, never
// against a specific vendor's SDK — a real provider is a second adapter added later, not a rewrite.
//
// No provider is wired in yet. Without one configured, sendEmail() logs the fully-rendered email and
// resolves successfully rather than throwing — the rest of the product (invite issuance, reminder
// scheduling) should work end-to-end in development without a live mail account. This is intentionally
// the same "log/mock in dev, never fake a real send" posture as js/moxie-outbound-adapter.js's
// unconfigured channels: DEV_LOG is a real, honest EmailProvider, not a stand-in that pretends success
// with no record.

export const EmailTemplate = Object.freeze({
  SPEAKER_INVITE: "speaker_invite",
  SPONSOR_INVITE: "sponsor_invite",
  PROFILE_INCOMPLETE_REMINDER: "profile_incomplete_reminder",
  CONSENT_INCOMPLETE_REMINDER: "consent_incomplete_reminder",
  TECH_CHECK_REMINDER: "tech_check_reminder",
  SESSION_REMINDER: "session_reminder",
  REGISTRATION_CONFIRMATION: "registration_confirmation",
  EVENT_REMINDER: "event_reminder",
  REPLAY_AVAILABLE: "replay_available",
  SPONSOR_APPROVAL_REQUEST: "sponsor_approval_request"
});

const TEMPLATE_BUILDERS = {
  [EmailTemplate.SPEAKER_INVITE]: ({ eventName, inviteUrl }) => ({
    subject: `You've been invited as a speaker for ${eventName}`,
    body: `You've been invited as a speaker for:\n${eventName}\n\nComplete your speaker profile so your name, title, links, and on-screen information are accurate.\n\n${inviteUrl}`
  }),
  [EmailTemplate.SPONSOR_INVITE]: ({ eventName, inviteUrl }) => ({
    subject: `Complete your sponsor kit for ${eventName}`,
    body: `You've been added as a sponsor for:\n${eventName}\n\nComplete your sponsor kit (logo, campaign URL, promo code, talking points) so your sponsorship is ready for the session.\n\n${inviteUrl}`
  }),
  [EmailTemplate.PROFILE_INCOMPLETE_REMINDER]: ({ eventName, inviteUrl }) => ({
    subject: `Your speaker profile for ${eventName} is still incomplete`,
    body: `A reminder to finish your speaker profile for ${eventName}.\n\n${inviteUrl}`
  }),
  [EmailTemplate.CONSENT_INCOMPLETE_REMINDER]: ({ eventName, inviteUrl }) => ({
    subject: `Action needed: consent for ${eventName}`,
    body: `We still need your consent/release on file before ${eventName}.\n\n${inviteUrl}`
  }),
  [EmailTemplate.TECH_CHECK_REMINDER]: ({ eventName, inviteUrl }) => ({
    subject: `Run a quick tech check before ${eventName}`,
    body: `Test your camera, mic, and connection before ${eventName} so show day is one less thing to worry about.\n\n${inviteUrl}`
  }),
  [EmailTemplate.SESSION_REMINDER]: ({ eventName, whenText }) => ({
    subject: `${eventName} is ${whenText}`,
    body: `${eventName} is ${whenText}. See you there.`
  }),
  [EmailTemplate.REGISTRATION_CONFIRMATION]: ({ eventName, whenText }) => ({
    subject: `You're registered for ${eventName}`,
    body: `You're registered for ${eventName}, ${whenText}. We'll send a reminder before it starts.`
  }),
  [EmailTemplate.EVENT_REMINDER]: ({ eventName, whenText, landingUrl }) => ({
    subject: `${eventName} starts ${whenText}`,
    body: `${eventName} starts ${whenText}.\n\n${landingUrl || ""}`
  }),
  [EmailTemplate.REPLAY_AVAILABLE]: ({ eventName, replayUrl }) => ({
    subject: `Replay available: ${eventName}`,
    body: `The replay for ${eventName} is now available.\n\n${replayUrl}`
  }),
  [EmailTemplate.SPONSOR_APPROVAL_REQUEST]: ({ eventName, sponsorName }) => ({
    subject: `Sponsor kit ready for review: ${sponsorName} (${eventName})`,
    body: `${sponsorName}'s sponsor kit for ${eventName} is ready for Host/Producer approval before it goes live.`
  })
};

export function renderEmail(template, data = {}) {
  const builder = TEMPLATE_BUILDERS[template];
  if (!builder) throw new Error(`Unknown email template: ${template}`);
  return builder(data);
}

// A dev-mode provider that never fails, never silently drops mail, and never fakes a real vendor send —
// it is the honest default when no real provider is configured.
export const DevLogEmailProvider = {
  name: "dev_log",
  async send({ to, subject, body }) {
    console.log(`[email:dev_log] to=${to} subject=${JSON.stringify(subject)}\n${body}`);
    return { ok: true, provider: "dev_log" };
  }
};

export function createEmailService({ provider = DevLogEmailProvider } = {}) {
  return {
    provider: provider.name,
    async sendEmail({ to, template, data = {} }) {
      if (!to) throw new Error("sendEmail requires a recipient.");
      const { subject, body } = renderEmail(template, data);
      const result = await provider.send({ to, subject, body });
      return { to, template, subject, ...result };
    }
  };
}
