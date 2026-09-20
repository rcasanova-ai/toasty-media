#!/usr/bin/env node
// End card (Program Output outro CTA) resolution — session override > profile default > tasteful
// fallback — plus QR target resolution and sanitization. Also guards the video-geometry and ticker-
// contrast CSS fixes against regression (string-match, matching this codebase's existing convention for
// asserting on CSS content — see program-renderer-test.mjs).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEndCard, resolveQrTarget, sanitizeEndCard, defaultEndCard, END_CARD_SOCIAL_PLATFORMS } from "../js/end-card.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("CTA resolution: session override > profile default > fallback");
{
  const fallback = resolveEndCard({});
  assert(fallback.headline === defaultEndCard().headline, "no session, no profile -> tasteful fallback");

  const profileOnly = resolveEndCard({ profileEndCard: { headline: "Profile Default Headline" } });
  assert(profileOnly.headline === "Profile Default Headline", "profile set, no session -> profile default wins");

  const sessionOverride = resolveEndCard({
    profileEndCard: { headline: "Profile Default Headline" },
    sessionEndCard: { headline: "Session Override Headline" }
  });
  assert(sessionOverride.headline === "Session Override Headline", "both set -> session override wins over profile default");

  const emptySessionDoesNotMaskProfile = resolveEndCard({
    profileEndCard: { headline: "Profile Default Headline" },
    sessionEndCard: {}
  });
  assert(emptySessionDoesNotMaskProfile.headline === "Profile Default Headline", "an empty session override object does not mask a real profile default");

  const emptySessionAndProfileFallsThrough = resolveEndCard({ profileEndCard: {}, sessionEndCard: {} });
  assert(emptySessionAndProfileFallsThrough.headline === defaultEndCard().headline, "both present but empty -> falls through to tasteful fallback");
}

console.log("\nQR target resolution");
{
  assert(resolveQrTarget({ qrTarget: "https://example.com/custom", website: "toasty.media" }) === "https://example.com/custom", "explicit qrTarget wins over website");
  assert(resolveQrTarget({ website: "toasty.media/peeps" }) === "toasty.media/peeps", "falls back to website when qrTarget is unset");
  assert(resolveQrTarget({}) === "", "empty when neither qrTarget nor website is set");
}

console.log("\nSanitization");
{
  const card = sanitizeEndCard({
    headline: "x".repeat(500),
    message: "y".repeat(1000),
    website: "z".repeat(500),
    socials: { x: "https://x.com/a", notarealplatform: "https://evil.example/should-be-dropped" },
    showQr: "truthy-string",
    qrImage: "  data:image/png;base64,AAA  "
  });
  assert(card.headline.length === 120, "headline is capped at 120 chars");
  assert(card.message.length === 400, "message is capped at 400 chars");
  assert(card.website.length === 300, "website is capped at 300 chars");
  assert(card.socials.x === "https://x.com/a", "known social platform is kept");
  assert(!("notarealplatform" in card.socials), "unknown social platform key is dropped, not just left un-rendered");
  assert(Object.keys(card.socials).every((k) => END_CARD_SOCIAL_PLATFORMS.includes(k)), "every surviving social key is a recognized platform");
  assert(card.showQr === true, "showQr is coerced to a real boolean");
  assert(card.qrImage === "data:image/png;base64,AAA", "qrImage is trimmed");
}

console.log("\nVideo geometry containment (CSS regression guard)");
{
  const css = readFileSync(join(ROOT, "css/program-output.css"), "utf8");
  assert(/\.po-canvas\s*\{[^}]*grid-template-columns:\s*1fr/.test(css), ".po-canvas declares an explicit single column track");
  assert(/\.po-stage\s*\{[^}]*min-width:\s*0/.test(css), ".po-stage (a grid item of .po-canvas) has min-width:0 so it cannot be forced wider by content");
  assert(/\.po-stage\s*\{[^}]*overflow:\s*hidden/.test(css), ".po-stage clips its own content");
  assert(css.includes('grid-template-columns: minmax(0, 1fr); }') && css.match(/grid-template-columns: minmax\(0, 1fr\);/g).length >= 2, "single-tile layouts (1/fullmedia/screen-only/screen-dominant/asset-full) use minmax(0, 1fr), not bare 1fr");
  assert(!/data-layout="1"\][^{]*\{\s*grid-template-columns:\s*1fr;/.test(css.replace(/minmax\(0, 1fr\)/g, "MINMAX")), "layout=1 no longer uses a bare (unguarded) 1fr column track");
  assert(/\.po-tile-video\s*\{[^}]*overflow:\s*hidden/.test(css), ".po-tile-video clips its video/iframe child directly, not just via an ancestor");
  assert(/max-width:\s*100%/.test(css) && /max-height:\s*100%/.test(css), "video/iframe have explicit max-width/max-height as a second line of defense");
}

console.log("\nTicker contrast (CSS regression guard)");
{
  const css = readFileSync(join(ROOT, "css/program-output.css"), "utf8");
  const trackRule = css.slice(css.indexOf(".po-ticker-track"), css.indexOf(".po-ticker-track") + 600);
  assert(trackRule.includes("color: var(--studio-cream)"), "ticker text uses --studio-cream (brand-aware contrast against --studio-surface), not the fixed-light --po-video-text");
  assert(!trackRule.includes("color: var(--po-video-text)"), "ticker text no longer uses the always-light video-scrim color variable");
}

console.log("\nAll end card + geometry/ticker regression checks passed.");
