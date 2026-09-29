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
export const requestDoughWithdrawal = (amount, method, destination) =>
  studioRequest("/api/peeps/dough/withdrawals", { method: "POST", body: JSON.stringify({ amount, method, destination }) });

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

// Authorizing introductions is payment-gated (x402, section 9). This drives the full round trip: try the
// authorize call; if it comes back 402, pay through whichever provider the response names — currently
// always the demo provider on a deployment with no real Solana recipient configured (see
// handlePeepsRequestAuthorize's own comment) — and retry once with the proof attached. A deployment with
// real payment infrastructure would need a real wallet-signing flow here instead; this throws a clear
// error rather than pretending to pay in that case.
export async function authorizePeepsIntroductions(requestId, candidates) {
  const path = `/api/peeps/requests/${encodeURIComponent(requestId)}/authorize`;
  const first = await rawPost(path, { candidates });
  if (first.status !== 402) {
    if (!first.ok) throw new Error(first.data.error || "Could not authorize introductions.");
    return first.data;
  }
  if (!first.data.demo) {
    throw new Error("This deployment requires a real x402/Solana payment, which this page does not yet support submitting.");
  }
  const demoPay = await studioRequest("/api/peeps/demo-payments/authorize", { method: "POST", body: JSON.stringify({ requestId }) });
  const second = await rawPost(path, { candidates }, {
    "X-Payment-Signature": demoPay.paymentSignature,
    "X-Solana-Transaction-Signature": demoPay.transactionSignature,
    "X-Payment-Asset": demoPay.asset,
    "X-Payment-Amount": String(demoPay.amount),
    "X-Payer-Wallet": demoPay.payerWallet,
    "X-Approval-Source": demoPay.approvalSource
  });
  if (!second.ok) throw new Error(second.data.error || "Could not authorize introductions.");
  return second.data;
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
