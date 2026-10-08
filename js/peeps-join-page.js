// Peeps invitation acceptance (peeps/join/?token=…). The token is the only credential; the server checks it
// is valid, unexpired and unused, creates the account (or links the existing one) and activates access.
import { studioRequest } from "./studio-api.js";

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("token") || "";
const show = (id) => { for (const s of ["jnLoading", "jnForm", "jnBad", "jnDone"]) $(s).hidden = s !== id; };
let existing = false;

async function init() {
  if (!token) { $("jnBadText").textContent = "This invitation link is incomplete."; return show("jnBad"); }
  try {
    const info = await studioRequest(`/api/peeps/waitlist/invite/${encodeURIComponent(token)}`);
    existing = info.existingAccount;
    $("jnIntro").textContent = existing
      ? `Hi ${info.name}. You already have a Toasty account for ${info.email}. Accept to activate Peeps on it, then sign in as usual.`
      : `Hi ${info.name}. Set a password to create your account for ${info.email}.`;
    $("jnPwLabel").hidden = existing;
    show("jnForm");
  } catch (error) {
    $("jnBadText").textContent = error.message || "This invitation isn't valid.";
    show("jnBad");
  }
}

$("jnFormEl").addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = $("jnMessage");
  msg.hidden = true;
  $("jnSubmit").disabled = true;
  try {
    const result = await studioRequest(`/api/peeps/waitlist/invite/${encodeURIComponent(token)}/accept`, { method: "POST", body: JSON.stringify({ password: $("jnPassword").value }) });
    $("jnDoneText").textContent = result.authenticated ? "Your account is active and you're signed in." : "Peeps is now active on your account. Sign in with your existing password.";
    $("jnGo").textContent = result.authenticated ? "Open Peeps" : "Go to Peeps and sign in";
    show("jnDone");
  } catch (error) {
    msg.textContent = error.message || "Could not accept the invitation.";
    msg.dataset.state = "error";
    msg.hidden = false;
    $("jnSubmit").disabled = false;
  }
});

init();
