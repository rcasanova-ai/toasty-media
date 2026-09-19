// Public /peeps/ sales page helpers. This file must NEVER hide or redirect the sales page —
// unauthenticated visitors are supposed to read it. It only offers Studio sign-in (same
// /auth/login + /auth/session as js/studio-auth.js) so "Open Peeps" is not a dead end after
// js/peeps-app-gate.js bounces an anonymous /peeps/app/ visit back here.
import { studioRequest } from "./studio-api.js";

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "peepsAuth",
    "peepsSignInToggle",
    "peepsSignOut",
    "peepsAuthForm",
    "peepsAuthEmail",
    "peepsAuthPassword",
    "peepsAuthMessage",
    "peepsAuthClose"
  ].forEach((id) => { els[id] = document.getElementById(id); });

  if (!els.peepsSignInToggle) return;

  els.peepsSignInToggle.addEventListener("click", () => openAuth());
  els.peepsSignOut?.addEventListener("click", logout);
  els.peepsAuthClose?.addEventListener("click", () => els.peepsAuth?.close());
  els.peepsAuthForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    login();
  });

  refreshNav();
});

async function refreshNav() {
  try {
    const session = await studioRequest("/auth/session", { method: "GET" });
    setSignedIn(Boolean(session.authenticated));
  } catch {
    setSignedIn(false);
  }
}

function setSignedIn(signedIn) {
  if (els.peepsSignInToggle) els.peepsSignInToggle.hidden = signedIn;
  if (els.peepsSignOut) els.peepsSignOut.hidden = !signedIn;
}

function openAuth() {
  if (!els.peepsAuth) return;
  if (els.peepsAuthMessage) {
    els.peepsAuthMessage.textContent = "";
    els.peepsAuthMessage.dataset.state = "neutral";
  }
  els.peepsAuth.showModal();
  els.peepsAuthEmail?.focus();
}

async function login() {
  setBusy(true);
  setMessage("");
  try {
    const session = await studioRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: els.peepsAuthEmail.value,
        password: els.peepsAuthPassword.value
      })
    });
    if (session.authenticated) {
      window.location.assign("./app/");
      return;
    }
    setMessage("Sign in did not succeed.", true);
  } catch (error) {
    setMessage(error.message || "Sign in failed.", true);
  } finally {
    if (els.peepsAuthPassword) els.peepsAuthPassword.value = "";
    setBusy(false);
  }
}

async function logout() {
  els.peepsSignOut.disabled = true;
  try {
    await studioRequest("/auth/logout", { method: "POST", body: "{}" });
  } catch {
    // Still return the public page to a signed-out nav state.
  } finally {
    els.peepsSignOut.disabled = false;
    setSignedIn(false);
  }
}

function setBusy(busy) {
  els.peepsAuthForm?.querySelectorAll("input, button").forEach((el) => { el.disabled = busy; });
}

function setMessage(message, isError = false) {
  if (!els.peepsAuthMessage) return;
  els.peepsAuthMessage.textContent = message;
  els.peepsAuthMessage.dataset.state = isError ? "error" : "neutral";
}
