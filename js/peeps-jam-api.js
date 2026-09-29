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

export const bookJam = (jamId, fields) => studioRequest(`/api/jams/${encodeURIComponent(jamId)}/book`, { method: "POST", body: JSON.stringify(fields) });
export const getJamPrep = (jamId, { role = "organizer", participantId = "" } = {}) => {
  const qs = new URLSearchParams({ role, ...(participantId ? { participantId } : {}) });
  return studioRequest(`/api/jams/${encodeURIComponent(jamId)}/prep?${qs.toString()}`);
};
export const getJamPackage = (jamId, participantId = "") =>
  studioRequest(`/api/jams/${encodeURIComponent(jamId)}/package${participantId ? `?participantId=${encodeURIComponent(participantId)}` : ""}`);
export const replaceJamParticipant = (jamId, removedParticipantId, reason = "") =>
  studioRequest(`/api/jams/${encodeURIComponent(jamId)}/replace-participant`, { method: "POST", body: JSON.stringify({ removedParticipantId, reason }) });
export const settleJam = (jamId) => studioRequest(`/api/jams/${encodeURIComponent(jamId)}/settle`, { method: "POST", body: "{}" });

// ---- Dough ----
export const getDough = () => studioRequest("/api/peeps/dough");
export const createDoughFundingIntent = (amount, method) =>
  studioRequest("/api/peeps/dough/funding-intents", { method: "POST", body: JSON.stringify({ amount, method }) });
export const confirmDoughFunding = (intentId, transactionSignature) =>
  studioRequest(`/api/peeps/dough/funding-intents/${encodeURIComponent(intentId)}/confirm`, { method: "POST", body: JSON.stringify({ transactionSignature }) });
export const requestDoughWithdrawal = (amount, method, destination) =>
  studioRequest("/api/peeps/dough/withdrawals", { method: "POST", body: JSON.stringify({ amount, method, destination }) });
export const setJamParticipantCompensation = (participantId, amount) =>
  studioRequest(`/api/jam-participants/${encodeURIComponent(participantId)}/compensation`, { method: "POST", body: JSON.stringify({ amount }) });

// ---- Peeps agent-to-human transaction lifecycle (request -> research -> candidates -> introductions) ----

export const createPeepsRequest = (fields) => studioRequest("/api/peeps/requests", { method: "POST", body: JSON.stringify(fields) });
export const getPeepsRequest = (id) => studioRequest(`/api/peeps/requests/${encodeURIComponent(id)}`);
export const listPeepsRequests = (organizationId) => studioRequest(`/api/peeps/requests?organizationId=${encodeURIComponent(organizationId)}`);
export const replacePeepsCandidate = (requestId, candidateId) =>
  studioRequest(`/api/peeps/requests/${encodeURIComponent(requestId)}/replace-candidate`, { method: "POST", body: JSON.stringify({ candidateId }) });

async function rawPost(path, body, headers = {}) {
  const response = await fetch(`${studioApiEndpoint()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Toasty-CSRF": "1", ...headers },
    body: JSON.stringify(body)
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* empty/binary */ }
  return { status: response.status, ok: response.ok, data: payload };
}

// Authorizing introductions is payment-gated, but the server now always tries Dough first (section 9) —
// a normal person never sees x402/wallet language here. Three outcomes: it just works (Dough covered
// it), Dough balance is too low (a structured, human-readable shortfall the caller can turn into an
// "Add Dough" prompt), or — only for a deployment/caller that skips Dough entirely and submits its own
// x402 proof headers directly (agents, section 7) — a raw payment-required error. This function itself
// never signs or submits a wallet transaction; that stays exclusively in js/peeps-jam-api.js's Advanced/
// crypto surface for callers who explicitly want it.
export async function authorizePeepsIntroductions(requestId, candidates, { compensationAmount } = {}) {
  const path = `/api/peeps/requests/${encodeURIComponent(requestId)}/authorize`;
  const result = await rawPost(path, { candidates, compensationAmount });
  if (result.status === 402) {
    const error = new Error(result.data.message || result.data.error || "Payment is required to authorize this introduction.");
    if (result.data.doughShortfall) {
      error.doughShortfall = result.data.doughShortfall;
      error.fundUrl = result.data.fundUrl;
    }
    throw error;
  }
  if (!result.ok) throw new Error(result.data.error || "Could not authorize introductions.");
  return result.data;
}

export const issueDubClaimInvite = (dubId, organizationId) =>
  studioRequest(`/api/dubs/${encodeURIComponent(dubId)}/claim-invite`, { method: "POST", body: JSON.stringify({ organizationId }) });
export const claimDub = (token) => studioRequest(`/api/dub-claims/${encodeURIComponent(token)}/claim`, { method: "POST", body: "{}" });

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

export const getDubClaim = (token) => inviteRequest(`/api/dub-claims/${encodeURIComponent(token)}`);

// ---- Peeps introduction execution (contact -> outreach -> response -> booking -> ready for session) ----
const enc = encodeURIComponent;
export const getPeepsIntroduction = (id) => studioRequest(`/api/peeps/introductions/${enc(id)}`);
export const getPeepsIntroductionSlots = (id) => studioRequest(`/api/peeps/introductions/${enc(id)}/slots`);
export const retryPeepsOutreach = (id) => studioRequest(`/api/peeps/introductions/${enc(id)}/retry-outreach`, { method: "POST", body: "{}" });
export const findPeepsReplacement = (id) => studioRequest(`/api/peeps/introductions/${enc(id)}/find-replacement`, { method: "POST", body: "{}" });
export const approvePeepsReplacement = (openingId, fields) => studioRequest(`/api/peeps/openings/${enc(openingId)}/approve`, { method: "POST", body: JSON.stringify(fields) });
export const bookPeepsIntroduction = (id, fields = {}) => studioRequest(`/api/peeps/introductions/${enc(id)}/book`, { method: "POST", body: JSON.stringify(fields) });
export const setPeepsRequesterAvailability = (requestId, availability) => studioRequest(`/api/peeps/requests/${enc(requestId)}/availability`, { method: "POST", body: JSON.stringify(availability) });
export const getPeepsBooking = (id) => studioRequest(`/api/peeps/bookings/${enc(id)}`);
export const getPeepsBookingPrep = (id, role = "organizer") => studioRequest(`/api/peeps/bookings/${enc(id)}/prep?role=${role}`);
export const editPeepsBookingPlan = (id, fields) => studioRequest(`/api/peeps/bookings/${enc(id)}/plan`, { method: "POST", body: JSON.stringify(fields) });
export const cancelPeepsBooking = (id, reason = "") => studioRequest(`/api/peeps/bookings/${enc(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
export const rebuildPeepsBooking = (id) => studioRequest(`/api/peeps/bookings/${enc(id)}/rebuild`, { method: "POST", body: "{}" });
export const retryPeepsMessage = (id) => studioRequest(`/api/peeps/messages/${enc(id)}/retry`, { method: "POST", body: "{}" });

// Unauthenticated, response-token-gated calls for the external person's page (peeps/respond.html). No
// cookies are sent: the token in the URL is the only credential, and it reaches exactly one introduction.
export async function peepsRespond(token, action = "", body) {
  const response = await fetch(`${studioApiEndpoint()}/api/peeps/respond/${enc(token)}${action ? `/${action}` : ""}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "omit",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* empty */ }
  if (!response.ok) {
    const error = new Error(payload.error || "Something went wrong. Please try again.");
    error.status = response.status;
    throw error;
  }
  return payload;
}
export const peepsRespondCalendarUrl = (token) => `${studioApiEndpoint()}/api/peeps/respond/${enc(token)}/calendar.ics`;

// ---- Post-session: completion -> Breadcrumbs -> outcome -> settlement ----
export const getPeepsLifecycle = (requestId) => studioRequest(`/api/peeps/requests/${enc(requestId)}/lifecycle`);
export const reconcilePeepsRequest = (requestId) => studioRequest(`/api/peeps/requests/${enc(requestId)}/reconcile`, { method: "POST", body: "{}" });
export const evaluatePeepsOutcome = (requestId, fields = {}) => studioRequest(`/api/peeps/requests/${enc(requestId)}/outcome`, { method: "POST", body: JSON.stringify(fields) });
export const settlePeepsRequest = (requestId) => studioRequest(`/api/peeps/requests/${enc(requestId)}/settle`, { method: "POST", body: "{}" });
export const corroboratePeepsBreadcrumb = (id) => studioRequest(`/api/peeps/breadcrumbs/${enc(id)}/corroborate`, { method: "POST", body: "{}" });
export const submitJamTranscript = (jamId, fields) => studioRequest(`/api/jams/${enc(jamId)}/transcript`, { method: "POST", body: JSON.stringify(fields) });
