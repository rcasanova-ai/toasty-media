// Thin client for the Peeps Jam lifecycle API (see scripts/render-production-server.mjs's "PEEPS JAM
// LIFECYCLE" section). Organizer calls reuse studioRequest — same cookie/CSRF/session as the rest of
// Peeps/Studio (js/peeps-app-gate.js's own comment: "This is NOT a parallel login system"). Participant-
// facing invite calls are unauthenticated and go straight to the API host with no cookie/session at all.
import { studioRequest, studioApiEndpoint } from "./studio-api.js";

export async function getPrimaryOrganizationId() {
  const result = await studioRequest("/api/organizations", { method: "GET" });
  const orgs = result.organizations || [];
  if (!orgs.length) return null;
  const owned = orgs.find((org) => org.role === "owner") || orgs[0];
  return owned.id;
}

export const listJams = (organizationId) => studioRequest(`/api/jams?organizationId=${encodeURIComponent(organizationId)}`);
export const createJam = (fields) => studioRequest("/api/jams", { method: "POST", body: JSON.stringify(fields) });
export const getJam = (id) => studioRequest(`/api/jams/${encodeURIComponent(id)}`);
export const updateJam = (id, fields) => studioRequest(`/api/jams/${encodeURIComponent(id)}/update`, { method: "POST", body: JSON.stringify(fields) });
export const runJamSession = (id, options = {}) => studioRequest(`/api/jams/${encodeURIComponent(id)}/run-session`, { method: "POST", body: JSON.stringify(options) });
export const completeJam = (id) => studioRequest(`/api/jams/${encodeURIComponent(id)}/complete`, { method: "POST", body: "{}" });
export const reopenJam = (id) => studioRequest(`/api/jams/${encodeURIComponent(id)}/reopen`, { method: "POST", body: "{}" });
export const getJamResults = (id) => studioRequest(`/api/jams/${encodeURIComponent(id)}/results`);

export const addJamParticipant = (jamId, { email, displayName }) =>
  studioRequest(`/api/jams/${encodeURIComponent(jamId)}/participants`, { method: "POST", body: JSON.stringify({ email, displayName }) });
export const issueJamParticipantInvite = (participantId) =>
  studioRequest(`/api/jam-participants/${encodeURIComponent(participantId)}/invite`, { method: "POST", body: "{}" });
export const confirmJamParticipant = (participantId) =>
  studioRequest(`/api/jam-participants/${encodeURIComponent(participantId)}/confirm`, { method: "POST", body: "{}" });
export const removeJamParticipant = (participantId, { reason = "", status = "removed" } = {}) =>
  studioRequest(`/api/jam-participants/${encodeURIComponent(participantId)}/remove`, { method: "POST", body: JSON.stringify({ reason, status }) });
export const markJamParticipant = (participantId, action) =>
  studioRequest(`/api/jam-participants/${encodeURIComponent(participantId)}/${action}`, { method: "POST", body: "{}" });

export const addJamArtifact = (jamId, fields) =>
  studioRequest(`/api/jams/${encodeURIComponent(jamId)}/artifacts`, { method: "POST", body: JSON.stringify(fields) });
export const updateJamArtifact = (artifactId, fields) =>
  studioRequest(`/api/jam-artifacts/${encodeURIComponent(artifactId)}/update`, { method: "POST", body: JSON.stringify(fields) });

export const getStudioSessionJamContext = (sessionId) => studioRequest(`/api/sessions/${encodeURIComponent(sessionId)}/jam`);

// ---- Participant-facing (unauthenticated, invite-token gated) ----

async function inviteRequest(path, options = {}) {
  const response = await fetch(`${studioApiEndpoint()}${path}`, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* empty/binary */ }
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

export const getJamInvite = (token) => inviteRequest(`/api/jam-invites/${encodeURIComponent(token)}`);
export const acceptJamInvite = (token) => inviteRequest(`/api/jam-invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
export const submitJamConsent = (token, body) =>
  inviteRequest(`/api/jam-invites/${encodeURIComponent(token)}/consent`, { method: "POST", body: JSON.stringify(body) });
