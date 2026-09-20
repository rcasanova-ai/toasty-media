#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { groupSessions, isTransientFetchError, brandLabel } from "../js/session-library.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("Session library grouping");
{
  const now = Date.parse("2026-09-20T20:00:00Z");
  const grouped = groupSessions([
    { id: "1", status: "LIVE", title: "On air", lastActiveAt: "2026-09-20T19:00:00Z" },
    { id: "2", status: "OPEN", title: "Later", lastActiveAt: "2026-09-20T18:00:00Z" },
    { id: "3", status: "ENDED", title: "Yesterday", endedAt: "2026-09-19T12:00:00Z" },
    { id: "4", status: "ENDED", title: "Ancient", endedAt: "2026-01-01T12:00:00Z" }
  ], now);
  assert(grouped.live.map((s) => s.id).join() === "1", "LIVE rows land in Live");
  assert(grouped.upcoming.map((s) => s.id).join() === "2", "OPEN rows land in Upcoming, not a new backend draft state");
  assert(grouped.recent.map((s) => s.id).join() === "3", "ENDED within 7 days land in Recent");
  assert(grouped.past.map((s) => s.id).join() === "4", "older ENDED rows land in Past");
  assert(brandLabel("peeps") === "Toasty Peeps", "brandLabel uses existing theme ids");
}

console.log("Transient fetch classification");
{
  assert(isTransientFetchError(new TypeError("Failed to fetch")), "browser Failed to fetch is transient");
  assert(!isTransientFetchError(new Error("Sign in to Toasty Studio first.")), "app 401 messages are not retried");
}

console.log("Session gate no longer double-fetches /api/sessions");
{
  const src = readFileSync(join(ROOT, "js/session-manager.js"), "utf8");
  assert(!/Promise\.all\(\[fetchSessions\("active"\), fetchSessions\("ended"\)\]\)/.test(src), "gate does not fire parallel status-filtered session list calls");
  assert(/studioRequest\("\/api\/sessions", \{ method: "GET" \}\)/.test(src), "gate uses a single unfiltered GET /api/sessions");
  const api = readFileSync(join(ROOT, "js/studio-api.js"), "utf8");
  assert(/isTransientFetchError/.test(api) && /attempts/.test(api), "studioRequest retries Failed to fetch");
}

console.log("Studio chrome exists without fake nav");
{
  const html = readFileSync(join(ROOT, "studio/director.html"), "utf8");
  assert(/data-studio-nav="studio"/.test(html) && /data-studio-nav="sessions"/.test(html), "app header has Studio and Sessions");
  assert(/data-studio-nav="assets"/.test(html) && /data-studio-mode="ai"/.test(html), "Assets and Production remain wired to existing surfaces");
  assert(/id="studioAvatarMenu"/.test(html), "account actions live in an avatar menu");
  assert(/id="sessionGateLiveList"/.test(html) && /id="sessionGateUpcomingList"/.test(html), "session library has Live and Upcoming buckets");
  assert(/id="liveConsole" data-lv-view="producer"/.test(html), "producer workspace is the default live console, not Host");
  assert(/class="lv-transport" data-lv-only="producer"/.test(html), "Waiting/Live/TD/End transport is in the producer program pane");
  assert(/id="lvToolsTabs"/.test(html) && /data-tools-tab="hottie"/.test(html), "Graphics/Media/Audio/Brand/Hottie tabs exist");
}

console.log("session-library-test: all passed");
