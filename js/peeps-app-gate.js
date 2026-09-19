// Auth gate for /peeps/app/* — reuses the existing Studio session (scripts/render-production-server.mjs
// /auth/session + the toasty_session cookie), same as js/studio-auth.js and js/camera-b-experiment.js.
//
// This is NOT a parallel login system. There is no localStorage token, no demo-role cookie, and no
// client-side "remember me" that can make a stale tab look signed in. The render host is authoritative;
// if that check fails or the service is down, the visitor is sent to the public sales page, not into
// the app. Hiding the "Open Peeps" link is not this file's job — the route itself is what we protect.
import { studioRequest } from "./studio-api.js";

export const PEEPS_PUBLIC_PATH = "/peeps/";
export const PEEPS_APP_PATH_RE = /\/peeps\/app(?:\/|$)/;

export function isPeepsAppPath(pathname) {
  return PEEPS_APP_PATH_RE.test(pathname || "");
}

export function unauthenticatedAppRedirect(pathname) {
  return isPeepsAppPath(pathname) ? PEEPS_PUBLIC_PATH : null;
}

export async function readPeepsSession(request = studioRequest) {
  return request("/auth/session", { method: "GET" });
}

// Fail-closed: unauthenticated, unknown, or unreachable auth → public sales page.
// Session is only what `readSession` returns (production: GET /auth/session). Local storage is
// not an input on purpose — a stale tab cannot mint access with a leftover client token.
export async function gatePeepsApp({
  pathname = "/",
  readSession = readPeepsSession,
  redirect = (url) => { window.location.replace(url); },
  reveal = () => document.documentElement.classList.remove("peeps-app-gated"),
  publicPath = PEEPS_PUBLIC_PATH
} = {}) {
  const destination = unauthenticatedAppRedirect(pathname);
  try {
    const session = await readSession();
    if (!session?.authenticated) {
      if (destination) redirect(publicPath);
      return { authenticated: false, user: null };
    }
    reveal();
    return { authenticated: true, user: session.user || null };
  } catch {
    if (destination) redirect(publicPath);
    return { authenticated: false, user: null, error: true };
  }
}

export async function logoutPeeps({
  request = studioRequest,
  redirect = (url) => { window.location.replace(url); },
  publicPath = PEEPS_PUBLIC_PATH
} = {}) {
  try {
    await request("/auth/logout", { method: "POST", body: "{}" });
  } catch {
    // Cookie/session may already be gone; still leave the app.
  }
  redirect(publicPath);
}

function bindLogout() {
  document.querySelectorAll("[data-peeps-logout]").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      logoutPeeps();
    });
  });
  ensureLogoutButton(document.querySelector(".side-foot"));
  // Mobile CSS hides `.side-foot`; keep a Sign out control in the topbar so logout isn't desktop-only.
  ensureLogoutButton(document.querySelector(".topbar"), "peeps-logout-topbar");
}

function ensureLogoutButton(parent, extraClass = "") {
  if (!parent || parent.querySelector("[data-peeps-logout]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = extraClass ? `peeps-logout ${extraClass}` : "peeps-logout";
  button.dataset.peepsLogout = "1";
  button.textContent = "Sign out";
  parent.appendChild(button);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    logoutPeeps();
  });
}

function personalize(user) {
  if (!user?.name) return;
  document.querySelectorAll("[data-peeps-user-name]").forEach((el) => {
    el.textContent = user.name;
  });
}

const isGatedDocument = typeof document !== "undefined"
  && document.documentElement.classList.contains("peeps-app-gated");

if (isGatedDocument) {
  const failClosed = window.setTimeout(() => {
    window.location.replace(PEEPS_PUBLIC_PATH);
  }, 10000);
  gatePeepsApp({
    pathname: window.location.pathname,
    reveal() {
      window.clearTimeout(failClosed);
      document.documentElement.classList.remove("peeps-app-gated");
      bindLogout();
    },
    redirect(url) {
      window.clearTimeout(failClosed);
      window.location.replace(url);
    }
  }).then((result) => {
    if (result.authenticated) personalize(result.user);
  });
}
