// Shared logic for the small account-flow landing pages that real emails link to: verify-email.html,
// reset-password.html, accept-invite.html, and the "forgot password" mode on studio/index.html. Each page
// calls exactly one of the exported init functions.
import { studioRequest } from "./studio-api.js";

function readToken() {
  return new URLSearchParams(window.location.search).get("token") || "";
}

function setStatus(el, message, isError = false) {
  el.textContent = message;
  el.dataset.state = isError ? "error" : "neutral";
}

export async function initVerifyEmail() {
  const statusEl = document.getElementById("flowStatus");
  const actionEl = document.getElementById("flowAction");
  const token = readToken();
  if (!token) {
    setStatus(statusEl, "This verification link is missing its token.", true);
    return;
  }
  try {
    await studioRequest("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
    setStatus(statusEl, "Your email is verified.");
    actionEl.innerHTML = `<a class="public-button" href="./">Go to Studio</a>`;
  } catch (error) {
    setStatus(statusEl, error.message, true);
  }
}

export function initResetPassword() {
  const statusEl = document.getElementById("flowStatus");
  const form = document.getElementById("resetForm");
  const token = readToken();
  if (!token) {
    setStatus(statusEl, "This reset link is missing its token.", true);
    form.hidden = true;
    return;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const newPassword = document.getElementById("newPassword").value;
    const confirm = document.getElementById("confirmPassword").value;
    if (newPassword !== confirm) {
      setStatus(statusEl, "Passwords don't match.", true);
      return;
    }
    setStatus(statusEl, "Updating password...");
    form.querySelectorAll("input, button").forEach((el) => { el.disabled = true; });
    try {
      await studioRequest("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) });
      setStatus(statusEl, "Password updated. You can sign in now.");
      form.hidden = true;
      document.getElementById("flowAction").innerHTML = `<a class="public-button" href="./">Sign in</a>`;
    } catch (error) {
      setStatus(statusEl, error.message, true);
      form.querySelectorAll("input, button").forEach((el) => { el.disabled = false; });
    }
  });
}

export async function initAcceptInvite() {
  const statusEl = document.getElementById("flowStatus");
  const actionEl = document.getElementById("flowAction");
  const token = readToken();
  if (!token) {
    setStatus(statusEl, "This invite link is missing its token.", true);
    return;
  }
  const session = await studioRequest("/auth/session", { method: "GET" }).catch(() => ({ authenticated: false }));
  if (!session.authenticated) {
    setStatus(statusEl, "Sign in or create a Studio account with the email this invite was sent to, then return to this link to accept it.");
    actionEl.innerHTML = `<a class="public-button" href="./?next=${encodeURIComponent(window.location.href)}">Go to sign in</a>`;
    return;
  }
  setStatus(statusEl, "Accepting invite...");
  try {
    await studioRequest("/api/invites/accept", { method: "POST", body: JSON.stringify({ token }) });
    setStatus(statusEl, "You've joined the organization.");
    actionEl.innerHTML = `<a class="public-button" href="./">Go to Studio</a>`;
  } catch (error) {
    setStatus(statusEl, error.message, true);
  }
}
