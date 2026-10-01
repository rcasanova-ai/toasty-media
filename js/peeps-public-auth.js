// Public /peeps/ sales page helpers. This file must NEVER hide or redirect the sales page —
// unauthenticated visitors are supposed to read it. It only offers Studio sign-in (same
// /auth/login + /auth/session as js/studio-auth.js) and swaps the page between its two paths:
// signed out → Join the Waitlist / Sign in; signed in → Open Peeps / Guided demo. The app routes
// themselves stay protected by js/peeps-app-gate.js; nothing here grants access.
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
    "peepsAuthClose",
    "peepsOpenApp",
    "peepsOpenDemo",
    "peepsJoinNav",
    "peepsWelcomeName"
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
    setSignedIn(Boolean(session.authenticated), session.user);
  } catch {
    setSignedIn(false);
  }
}

function setSignedIn(signedIn, user = null) {
  if (els.peepsSignInToggle) els.peepsSignInToggle.hidden = signedIn;
  if (els.peepsSignOut) els.peepsSignOut.hidden = !signedIn;
  if (els.peepsOpenApp) els.peepsOpenApp.hidden = !signedIn;
  if (els.peepsOpenDemo) els.peepsOpenDemo.hidden = !signedIn;
  if (els.peepsJoinNav) els.peepsJoinNav.hidden = signedIn;
  if (els.peepsWelcomeName) {
    const first = String(user?.name || "").trim().split(/\s+/)[0];
    els.peepsWelcomeName.textContent = signedIn && first ? `, ${first}` : "";
  }
  document.querySelectorAll("[data-auth-show]").forEach((el) => {
    el.hidden = el.dataset.authShow === (signedIn ? "out" : "in");
  });
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
      els.peepsAuth?.close();
      setSignedIn(true, session.user);
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
