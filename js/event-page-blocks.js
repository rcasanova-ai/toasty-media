// Shared shape between the Event Page editor (js/event-page-editor.js, which BUILDS this array from a
// structured form) and the public/preview renderer (js/event-page-renderer.js, which only ever READS
// it). Every block type here is a subset of the server's own LANDING_BLOCK_TYPES allowlist
// (scripts/render-production-server.mjs) — this file must stay in sync with that list, not invent types
// the server would silently drop.
//
// Deliberately NOT a generic page builder: the editor never lets an organizer type raw HTML or add
// arbitrary block types. It fills exactly these known fields; this module just turns that structured
// data into the same block array shape on both ends.

export function buildLandingBlocks(form) {
  const blocks = [];
  blocks.push({
    type: "hero",
    content: {
      title: form.title || "",
      shortDescription: form.shortDescription || "",
      heroImageUrl: form.heroImageUrl || "",
      scheduledAt: form.scheduledAt || "",
      timezone: form.timezone || "",
      sessionType: form.sessionType || ""
    }
  });
  if (form.longDescription) {
    blocks.push({ type: "description", content: { body: form.longDescription } });
  }
  if (Array.isArray(form.featuredSpeakers) && form.featuredSpeakers.length) {
    blocks.push({ type: "speakers", content: { items: form.featuredSpeakers } });
  }
  if (Array.isArray(form.featuredSponsors) && form.featuredSponsors.length) {
    blocks.push({ type: "sponsors", content: { items: form.featuredSponsors } });
  }
  if (form.ctaPrimary?.label && form.ctaPrimary?.url) {
    blocks.push({ type: "cta", content: { primary: form.ctaPrimary, secondary: form.ctaSecondary?.label && form.ctaSecondary?.url ? form.ctaSecondary : null } });
  }
  if (form.replayEnabled) {
    blocks.push({ type: "replay", content: { enabled: true } });
  }
  blocks.push({
    type: "share",
    content: {
      shareTitle: form.shareTitle || form.title || "",
      shareDescription: form.shareDescription || form.shortDescription || ""
    }
  });
  return blocks;
}

// Public speaker/sponsor fields an organizer can choose to feature on the event page — never email,
// links, pronunciation notes, location, peepsPersonId, selectionReason, or anything a speaker listed in
// their own hiddenFields. This is the ONLY place speaker/sponsor data becomes visible to an
// unauthenticated visitor, so the allowlist is intentionally narrow.
export function speakerToFeatured(speaker) {
  const hidden = new Set(speaker.hiddenFields || []);
  const pick = (key, value) => (hidden.has(key) ? "" : value || "");
  return {
    id: speaker.id,
    displayName: speaker.displayName || "",
    sessionRole: speaker.sessionRole || "",
    title: pick("title", speaker.title),
    company: pick("company", speaker.company),
    bioShort: pick("bioShort", speaker.bioShort),
    headshotReference: pick("headshotReference", speaker.headshotReference)
  };
}

export function sponsorToFeatured(sponsor) {
  return {
    id: sponsor.id,
    companyName: sponsor.companyName || "",
    website: sponsor.website || "",
    logoReference: sponsor.logoReference || ""
  };
}

export function blockOf(blocks, type) {
  return (blocks || []).find((b) => b.type === type) || null;
}
