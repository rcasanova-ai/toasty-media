// Resolves an organization's active BrandProfile into a real theme object and registers it with
// js/brand-themes.js's dynamic registry, so every surface that already knows how to apply a themeId
// STRING (director/guest/listener/dashboard, all via applyBrandTheme) picks up a real customer's own
// brand with no separate rendering path. See scripts/render-production-server.mjs's
// GET /api/organizations/:id/brand-profile (public/guest-safe — a Studio guest or Program Output window
// has no Toasty account) and js/studio-auth.js's own branding.brandProfile (already inline on
// /auth/session for an organization-locked account, so the authenticated shell never needs this fetch).
import { composeDynamicTheme, registerDynamicTheme, isDynamicBrandId } from "./brand-themes.js";
import { studioApiEndpoint } from "./studio-api.js";

const pending = new Map();

// hint = a BrandProfile already in hand (e.g. from /auth/session's branding.brandProfile) — skips the
// fetch entirely. Safe to call repeatedly for the same id; concurrent callers share one in-flight fetch.
export async function ensureOrgTheme(themeId, hint) {
  if (!isDynamicBrandId(themeId)) return null;
  if (pending.has(themeId)) return pending.get(themeId);
  const organizationId = themeId.slice("org:".length);
  const promise = (async () => {
    const brandProfile = hint !== undefined ? hint : await fetchActiveBrandProfile(organizationId);
    if (!brandProfile) return null;
    const theme = composeDynamicTheme(themeId, brandProfile);
    registerDynamicTheme(theme);
    return theme;
  })();
  pending.set(themeId, promise);
  return promise;
}

async function fetchActiveBrandProfile(organizationId) {
  try {
    const response = await fetch(`${studioApiEndpoint()}/api/organizations/${encodeURIComponent(organizationId)}/brand-profile`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.brandProfile || null;
  } catch {
    return null;
  }
}
