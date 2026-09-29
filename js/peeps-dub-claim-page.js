// Controller for peeps/dub-claim.html — section 27's "invite an unclaimed Dub to claim it after a real
// interaction" flow. Public, unauthenticated GET (studioApiEndpoint()/studioRequest — same pattern as
// every other Peeps page); claiming itself needs a real signed-in Toasty account, so this offers inline
// sign-in/register rather than js/peeps-public-auth.js (that module redirects to /peeps/app/ on success,
// which would abandon the claim in progress here).
import { getDubClaim, claimDub } from "./peeps-jam-api.js";
import { studioRequest } from "./studio-api.js";

const token = new URLSearchParams(window.location.search).get("token") || "";
const $ = (id) => document.getElementById(id);
const STEPS = ["stepLoading", "stepError", "stepClaim", "stepDone"];

function showStep(id) {
  for (const step of STEPS) $(step).classList.toggle("is-active", step === id);
}

function fail(message) {
  $("errorMessage").textContent = message || "This claim link could not be loaded.";
  showStep("stepError");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const BREADCRUMB_LABEL = {
  "invite.sent": "Invited to a Jam",
  "invite.accepted": "Accepted the invite",
  "consent.recorded": "Consent recorded",
  "participant.joined": "Joined a live session",
  "participant.attended": "Attended a session",
  "participant.completed": "Completed a session",
  "payment.paid": "Payment released",
  "dub.claim_invited": "Invited to claim this Dub"
};

function renderBreadcrumbs(events) {
  if (!events.length) {
    $("breadcrumbList").innerHTML = `<p class="eg-status">No Breadcrumbs recorded yet.</p>`;
    return;
  }
  $("breadcrumbList").innerHTML = events.map((event) => {
    const label = BREADCRUMB_LABEL[event.type] || event.type;
    const date = new Date(event.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    return `<div class="eg-tech-item"><span>${escapeHtml(label)}</span><span class="muted">${escapeHtml(date)}</span></div>`;
  }).join("");
}

async function refreshAuthState() {
  try {
    const session = await studioRequest("/auth/session", { method: "GET" });
    $("signedOutPanel").hidden = Boolean(session.authenticated);
    $("signedInPanel").hidden = !session.authenticated;
    return Boolean(session.authenticated);
  } catch {
    return false;
  }
}

async function doClaim() {
  const statusEl = $("claimStatus");
  statusEl.textContent = "Claiming…";
  statusEl.classList.remove("is-error");
  try {
    await claimDub(token);
    showStep("stepDone");
  } catch (error) {
    statusEl.textContent = error.message || "Could not claim this Dub.";
    statusEl.classList.add("is-error");
  }
}

$("signInBtn").addEventListener("click", async () => {
  const statusEl = $("claimStatus");
  statusEl.textContent = "Signing in…";
  statusEl.classList.remove("is-error");
  try {
    await studioRequest("/auth/login", { method: "POST", body: JSON.stringify({ email: $("authEmail").value, password: $("authPassword").value }) });
    await refreshAuthState();
    await doClaim();
  } catch (error) {
    statusEl.textContent = error.message || "Sign in failed.";
    statusEl.classList.add("is-error");
  }
});

$("registerBtn").addEventListener("click", async () => {
  const statusEl = $("claimStatus");
  statusEl.textContent = "Creating your account…";
  statusEl.classList.remove("is-error");
  try {
    await studioRequest("/auth/register", { method: "POST", body: JSON.stringify({ name: $("authName").value, email: $("authEmail").value, password: $("authPassword").value }) });
    await refreshAuthState();
    await doClaim();
  } catch (error) {
    statusEl.textContent = error.message || "Could not create an account.";
    statusEl.classList.add("is-error");
  }
});

$("claimBtn").addEventListener("click", doClaim);

async function init() {
  if (!token) {
    fail("No claim token was provided — check the link you were sent.");
    return;
  }
  let result;
  try {
    result = await getDubClaim(token);
  } catch (error) {
    fail(error.message);
    return;
  }
  $("dubName").textContent = result.dub?.displayName ? `Claim your Dub, ${result.dub.displayName}` : "Claim your Dub";
  renderBreadcrumbs(result.breadcrumbs || []);
  await refreshAuthState();
  showStep("stepClaim");
}

init();
