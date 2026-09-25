// Moxie outbound audience adapter (Event Growth layer, section 20). The repo already has a real,
// provider-neutral INBOUND/internal audience model (js/audience-message.js: AudienceAdapter,
// MOXIE_PUBLIC_IDENTITY, hottiePublicReply, Producer approval flow) and a working Toasty-internal
// audience store. What does NOT exist yet is a clean OUTBOUND interface for actually posting a Moxie
// reply to a real external chat platform (YouTube live chat, Telegram, X) — this module is that
// interface plus an honest capability registry. It does not fake external-platform support: only the
// Toasty-internal channel is actually implemented here; every other channel reports
// supported/configured truthfully and refuses to pretend a send happened.

import { hottiePublicReply, MOXIE_PUBLIC_IDENTITY } from "./audience-message.js";

export const OutboundChannel = Object.freeze({
  TOASTY_INTERNAL: "TOASTY_INTERNAL",
  YOUTUBE: "YOUTUBE",
  TELEGRAM: "TELEGRAM",
  X: "X"
});

export const AutonomyLevel = Object.freeze({
  // Mirrors scripts/render-production-server.mjs's aiProducerAutonomyNote() vocabulary — same three
  // levels, same meaning, so a Host who understands autonomy for private Producer notes already
  // understands it here: a draft always needs a human click, ask_host prompts for yes/no, autonomous
  // sends immediately. Keep these two lists of the same three values in sync by hand (same single-file
  // deploy constraint that already applies to producer-persona.js/AI_PRODUCER_BASELINE_PERSONA).
  DRAFT_ONLY: "draft_only",
  ASK_HOST: "ask_host",
  AUTONOMOUS: "autonomous"
});

export const SendOutcome = Object.freeze({
  SENT: "sent",
  QUEUED_FOR_APPROVAL: "queued_for_approval",
  REFUSED_UNSUPPORTED_CHANNEL: "refused_unsupported_channel",
  REFUSED_NOT_CONFIGURED: "refused_not_configured",
  REFUSED_ENTITLEMENT: "refused_entitlement",
  REFUSED_RATE_LIMITED: "refused_rate_limited",
  FAILED: "failed"
});

// Capability registry — the honest inventory. `send` is a real function only for the one channel this
// repo actually has a working internal audience store for (js/audience.js's AudienceStore /
// js/audience-message.js's AudienceAdapter). Every other entry is a scaffold: `configured` always false
// until a real provider credential/adapter exists, and `send` is intentionally absent rather than a stub
// that quietly no-ops — calling code must check `configured` before ever attempting to send.
export function channelCapabilities({ internalStore } = {}) {
  return {
    [OutboundChannel.TOASTY_INTERNAL]: {
      supported: true,
      configured: Boolean(internalStore),
      description: "Toasty's own internal audience chat store."
    },
    [OutboundChannel.YOUTUBE]: {
      supported: false,
      configured: false,
      description: "YouTube Live Chat API adapter not implemented yet."
    },
    [OutboundChannel.TELEGRAM]: {
      supported: false,
      configured: false,
      description: "Telegram Bot API adapter not implemented yet."
    },
    [OutboundChannel.X]: {
      supported: false,
      configured: false,
      description: "X API adapter not implemented yet; X's posting API terms/cost make this the least likely to ship first."
    }
  };
}

// Fixed, small window — Moxie posting into a live audience chat is a broadcast action, not a private
// Producer note; a runaway loop here is audience-visible and reputational, not just noisy. Callers pass
// their own recent-send timestamps rather than this module owning any storage.
const RATE_LIMIT_MAX_SENDS = 6;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export function isRateLimited(recentSendTimestamps = [], now = Date.now()) {
  const withinWindow = recentSendTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  return withinWindow.length >= RATE_LIMIT_MAX_SENDS;
}

function requiresApproval(autonomy) {
  return autonomy !== AutonomyLevel.AUTONOMOUS;
}

// The single entry point every caller (Host UI, AI Producer send_to_program action, a future scheduled
// digest) should use instead of touching a channel adapter directly — this is what makes "never
// impersonate the Host" and "respect BYOK/AI entitlement" structural guarantees instead of conventions
// every call site has to remember on its own.
export function sendMoxieMessage({
  channel,
  text,
  sessionId = null,
  inReplyTo = null,
  autonomy = AutonomyLevel.DRAFT_ONLY,
  aiEntitled = false,
  internalStore = null,
  recentSendTimestamps = [],
  now = Date.now(),
  approvedByHost = false
} = {}) {
  const capabilities = channelCapabilities({ internalStore });
  const capability = capabilities[channel];
  const audit = { channel, sessionId, requestedAt: now, identity: MOXIE_PUBLIC_IDENTITY };

  if (!capability?.supported) {
    return { outcome: SendOutcome.REFUSED_UNSUPPORTED_CHANNEL, audit, message: null };
  }
  if (!aiEntitled) {
    return { outcome: SendOutcome.REFUSED_ENTITLEMENT, audit, message: null };
  }
  if (!capability.configured) {
    return { outcome: SendOutcome.REFUSED_NOT_CONFIGURED, audit, message: null };
  }
  if (isRateLimited(recentSendTimestamps, now)) {
    return { outcome: SendOutcome.REFUSED_RATE_LIMITED, audit, message: null };
  }

  const message = hottiePublicReply({ text, inReplyTo, sessionId });
  if (!message) return { outcome: SendOutcome.FAILED, audit, message: null };
  // hottiePublicReply already sets identity/impersonatesHost:false — asserted again here because this
  // is the actual send boundary, not just message construction; a future refactor of that helper must
  // not silently remove the guarantee this function exists to enforce.
  if (message.metadata.impersonatesHost || message.author !== MOXIE_PUBLIC_IDENTITY) {
    return { outcome: SendOutcome.FAILED, audit: { ...audit, error: "identity_guard_failed" }, message: null };
  }

  if (requiresApproval(autonomy) && !approvedByHost) {
    return { outcome: SendOutcome.QUEUED_FOR_APPROVAL, audit, message };
  }

  if (channel === OutboundChannel.TOASTY_INTERNAL) {
    const adapterResult = internalStore?.ingest
      ? internalStore.ingest({ platform: "toasty", displayName: message.author, message: message.text, type: message.kind, timestamp: message.timestamp })
      : null;
    return { outcome: SendOutcome.SENT, audit: { ...audit, sentAt: now }, message, adapterResult };
  }

  // Unreachable while only TOASTY_INTERNAL is configured=true above, but kept explicit rather than
  // falling through silently — an adapter added later without wiring a real send path here fails loudly.
  return { outcome: SendOutcome.REFUSED_NOT_CONFIGURED, audit, message: null };
}
