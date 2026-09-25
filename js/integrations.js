// Integration registry (Event Growth layer, section 1: Settings -> Integrations). A small, extensible
// card system — new providers are added here as data, not as new UI code. Toasty stays the product;
// Santati (and anything after it) is always an OPTIONAL connection, never something Toasty becomes.
//
// IntegrationStatus is honest by construction: "coming_soon" never implies a working connection, and
// nothing in this module performs or claims real connectivity for a coming_soon entry. The one real
// connector this repo already has (Google Drive — see scripts/render-production-server.mjs's
// /integrations/google-drive/* routes) is intentionally NOT modeled here: it already has its own working
// UI path and status flow; duplicating it into this registry would just create two sources of truth.

export const IntegrationStatus = Object.freeze({
  COMING_SOON: "coming_soon",
  CONNECTED: "connected",
  NOT_CONNECTED: "not_connected"
});

export const IntegrationCategory = Object.freeze({
  CRM: "crm",
  COMMUNICATION: "communication",
  VIDEO: "video",
  SOCIAL: "social",
  CALENDAR: "calendar",
  PAYMENTS: "payments",
  BLOCKCHAIN: "blockchain"
});

// Future entries (Slack, YouTube, LinkedIn, X, Telegram, Google Calendar, Stripe, Solana, ...) get added
// here the same way Santati was: id, name, category, description, status, and either a learnMoreUrl (for
// coming_soon) or the real connect/status route once one exists (see the Google Drive precedent above
// for what a real entry eventually needs).
export const INTEGRATIONS = Object.freeze([
  Object.freeze({
    id: "santati",
    name: "Santati",
    category: IntegrationCategory.CRM,
    description: "CRM + relationship intelligence for Toasty audience, participants, and event signals.",
    status: IntegrationStatus.COMING_SOON,
    learnMoreUrl: "https://santati.com",
    connectLabel: "Coming soon: Connect Santati"
  })
]);

export function getIntegration(id) {
  return INTEGRATIONS.find((integration) => integration.id === id) || null;
}

export function isConnectable(integration) {
  return integration?.status !== IntegrationStatus.COMING_SOON;
}

// What the Santati sync boundary will eventually be allowed to send once a real connector exists
// (section 22). Declared here as a contract, not implemented — no network call is made from this file.
export const SANTATI_FUTURE_SYNC_RECORD_TYPES = Object.freeze([
  "attendee",
  "speaker",
  "sponsor_contact",
  "registration",
  "attendance",
  "watch_time",
  "cta_click",
  "question",
  "event_topic",
  "sponsor_interaction",
  "conversion_event",
  "peeps_identity_reference"
]);
