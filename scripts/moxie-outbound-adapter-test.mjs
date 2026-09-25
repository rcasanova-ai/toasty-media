#!/usr/bin/env node
// Pure-logic tests for js/moxie-outbound-adapter.js — identity safety, honest capability reporting,
// entitlement/approval/rate-limit gating. No server, no DOM.
import {
  sendMoxieMessage,
  channelCapabilities,
  isRateLimited,
  OutboundChannel,
  AutonomyLevel,
  SendOutcome
} from "../js/moxie-outbound-adapter.js";
import { MOXIE_PUBLIC_IDENTITY } from "../js/audience-message.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log("Capability registry is honest — only Toasty internal is ever configured");
{
  const caps = channelCapabilities({ internalStore: { ingest: () => {} } });
  assertEqual(caps[OutboundChannel.TOASTY_INTERNAL].configured, true, "internal channel configured when a store is passed");
  for (const channel of [OutboundChannel.YOUTUBE, OutboundChannel.TELEGRAM, OutboundChannel.X]) {
    assertEqual(caps[channel].supported, false, `${channel} honestly reports unsupported`);
    assertEqual(caps[channel].configured, false, `${channel} honestly reports not configured`);
    assert(!("send" in caps[channel]), `${channel} has no send function to accidentally call`);
  }
  const noStore = channelCapabilities({});
  assertEqual(noStore[OutboundChannel.TOASTY_INTERNAL].configured, false, "internal channel is not configured without a store either");
}

console.log("\nUnsupported/unconfigured channels are refused, never faked");
{
  const store = { ingest: () => ({ ok: true }) };
  const toYoutube = sendMoxieMessage({ channel: OutboundChannel.YOUTUBE, text: "hi", aiEntitled: true, autonomy: AutonomyLevel.AUTONOMOUS, internalStore: store });
  assertEqual(toYoutube.outcome, SendOutcome.REFUSED_UNSUPPORTED_CHANNEL, "YouTube send is refused, not silently no-op'd as success");
  assertEqual(toYoutube.message, null, "no message object fabricated for a refused send");

  const notEntitled = sendMoxieMessage({ channel: OutboundChannel.TOASTY_INTERNAL, text: "hi", aiEntitled: false, autonomy: AutonomyLevel.AUTONOMOUS, internalStore: store });
  assertEqual(notEntitled.outcome, SendOutcome.REFUSED_ENTITLEMENT, "organization without AI entitlement is refused even for the internal channel");

  const noStoreConfigured = sendMoxieMessage({ channel: OutboundChannel.TOASTY_INTERNAL, text: "hi", aiEntitled: true, autonomy: AutonomyLevel.AUTONOMOUS });
  assertEqual(noStoreConfigured.outcome, SendOutcome.REFUSED_NOT_CONFIGURED, "internal channel without a store is refused, not sent into the void");
}

console.log("\nIdentity — Moxie always identifies itself, never impersonates the Host");
{
  const store = { ingest: (payload) => payload };
  const result = sendMoxieMessage({ channel: OutboundChannel.TOASTY_INTERNAL, text: "Great question!", sessionId: "ls_1", aiEntitled: true, autonomy: AutonomyLevel.AUTONOMOUS, internalStore: store });
  assertEqual(result.outcome, SendOutcome.SENT, "well-formed autonomous send succeeds");
  assertEqual(result.message.author, MOXIE_PUBLIC_IDENTITY, "sent message is authored as Moxie · Toasty Producer");
  assertEqual(result.message.metadata.impersonatesHost, false, "impersonatesHost is explicitly false");
  assertEqual(result.adapterResult.displayName, MOXIE_PUBLIC_IDENTITY, "the internal store actually receives the Moxie identity, not a blank/Host name");
}

console.log("\nAutonomy — draft_only and ask_host require explicit Host approval before sending");
{
  const store = { ingest: () => {} };
  const draftOnly = sendMoxieMessage({ channel: OutboundChannel.TOASTY_INTERNAL, text: "hi", aiEntitled: true, autonomy: AutonomyLevel.DRAFT_ONLY, internalStore: store });
  assertEqual(draftOnly.outcome, SendOutcome.QUEUED_FOR_APPROVAL, "draft_only never sends without approval");
  assert(draftOnly.message, "a draft is still produced for the Host to review");

  const askHostNoApproval = sendMoxieMessage({ channel: OutboundChannel.TOASTY_INTERNAL, text: "hi", aiEntitled: true, autonomy: AutonomyLevel.ASK_HOST, internalStore: store });
  assertEqual(askHostNoApproval.outcome, SendOutcome.QUEUED_FOR_APPROVAL, "ask_host without approvedByHost queues instead of sending");

  const askHostApproved = sendMoxieMessage({ channel: OutboundChannel.TOASTY_INTERNAL, text: "hi", aiEntitled: true, autonomy: AutonomyLevel.ASK_HOST, internalStore: store, approvedByHost: true });
  assertEqual(askHostApproved.outcome, SendOutcome.SENT, "ask_host with approvedByHost:true actually sends");

  const draftApproved = sendMoxieMessage({ channel: OutboundChannel.TOASTY_INTERNAL, text: "hi", aiEntitled: true, autonomy: AutonomyLevel.DRAFT_ONLY, internalStore: store, approvedByHost: true });
  assertEqual(draftApproved.outcome, SendOutcome.SENT, "draft_only still sends once the Host has explicitly approved it");
}

console.log("\nRate limiting");
{
  const now = 1_000_000;
  const empty = isRateLimited([], now);
  assertEqual(empty, false, "no recent sends is never rate limited");
  const recentButOld = isRateLimited([now - 120_000], now);
  assertEqual(recentButOld, false, "a send outside the 60s window does not count toward the limit");
  const sixRecent = Array.from({ length: 6 }, (_, i) => now - i * 1000);
  assertEqual(isRateLimited(sixRecent, now), true, "6 sends inside the window trips the rate limit");
  const store = { ingest: () => {} };
  const blocked = sendMoxieMessage({
    channel: OutboundChannel.TOASTY_INTERNAL, text: "hi", aiEntitled: true, autonomy: AutonomyLevel.AUTONOMOUS,
    internalStore: store, recentSendTimestamps: sixRecent, now
  });
  assertEqual(blocked.outcome, SendOutcome.REFUSED_RATE_LIMITED, "sendMoxieMessage itself refuses once rate limited");
}

console.log("\nAll Moxie outbound adapter tests passed.");
