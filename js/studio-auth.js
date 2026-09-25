import { studioApiEndpoint } from "./studio-api.js";
import { applyBrandTheme, getInitialBrandTheme, normalizeBrandTheme } from "./brand-themes.js";

const state = {
  mode: "login",
  appLoaded: false,
  // useStorage:false on purpose: this is the LOGGED-OUT public gate. localStorage's saved brand is
  // authenticated-session state (set when a signed-in host picks a brand inside director.js) — reading
  // it here would leak a previous session's client immersion onto a bare, logged-out /studio visit.
  // An explicit ?brand= link (a genuine client invite) still works; getInitialBrandTheme checks the URL
  // before ever considering storage. Bare /studio with no param and no prior explicit choice = Toasty.
  brandTheme: getInitialBrandTheme(window.location.search, { useStorage: false })
};

const els = {};

function dismissEntryCurtain() { const el = document.getElementById("studioEntryCurtain"); if (!el || el.classList.contains("is-leaving")) return; el.classList.add("is-leaving"); window.setTimeout(() => el.remove(), 320); }


document.addEventListener("DOMContentLoaded", () => {
  [
    "studioPublicPage",
    "studioAppShell",
    "studioAppFrame",
    "studioLogout",
    "showSignup",
    "showLogin",
    "signupForm",
    "loginForm",
    "signupName",
    "signupEmail",
    "signupPassword",
    "loginEmail",
    "loginPassword",
    "authMessage"
  ].forEach((id) => { els[id] = document.getElementById(id); });

  applyBrandTheme(state.brandTheme, {
    root: document.body,
    logoImg: document.querySelector(".public-brand img, .studio-access-brand img"),
    poweredBy: document.querySelector("#publicPoweredBy"),
    brandLink: document.querySelector(".public-brand, .studio-access-brand")
  });
  els.showSignup?.addEventListener("click", () => setMode("signup"));
  els.showLogin?.addEventListener("click", () => setMode("login"));
  els.signupForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    register();
  });
  els.loginForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    login();
  });
  els.studioLogout?.addEventListener("click", logout);

  // See js/session-manager.js's setUrlSession comment: director.html (inside #studioAppFrame) can only
  // update ITS OWN address via history.replaceState — this is what lets that choice survive a real
  // top-level browser refresh instead of dropping back to the session gate every time. Origin-checked since
  // this page listens for postMessage at all; ignores anything not from this same origin.
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "toasty:studio-ready") { dismissEntryCurtain(); return; }
    if (event.data?.type !== "toasty:session-selected" || !event.data.sessionId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("session", event.data.sessionId);
    window.history.replaceState({}, "", url);
  });

  checkSession();
});

async function checkSession() {
  setMessage("Checking Studio access...");
  try {
    const session = await request("/auth/session", { method: "GET" });
    if (session.authenticated) {
      openStudio(session.user?.branding);
      return;
    }
    showPublic("");
    dismissEntryCurtain();
  } catch {
    showPublic("Studio account service is unavailable. Please try again shortly.", true);
    dismissEntryCurtain();
  }
}

async function register() {
  setBusy(els.signupForm, true);
  setMessage("");
  try {
    const session = await request("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: els.signupName.value,
        email: els.signupEmail.value,
        password: els.signupPassword.value
      })
    });
    if (session.authenticated) openStudio(session.user?.branding, { destination: "./onboarding.html" });
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    els.signupPassword.value = "";
    setBusy(els.signupForm, false);
  }
}

async function login() {
  setBusy(els.loginForm, true);
  setMessage("");
  try {
    const session = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: els.loginEmail.value,
        password: els.loginPassword.value
      })
    });
    if (session.authenticated) openStudio(session.user?.branding);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    els.loginPassword.value = "";
    setBusy(els.loginForm, false);
  }
}

async function logout() {
  els.studioLogout.disabled = true;
  try {
    await request("/auth/logout", { method: "POST", body: "{}" });
  } catch {
    // The local shell still returns to the public page if the backend is briefly unavailable.
  } finally {
    els.studioLogout.disabled = false;
    els.studioAppFrame.src = "about:blank";
    state.appLoaded = false;
    showPublic("");
  }
}

// branding: {mode, brandId} from /auth/session's user record (see toasty-auth-db.py's user_set_branding).
// A "locked" account (a brand-locked customer like Moe @ Superteam Thailand) never gets its brand from the
// URL/localStorage at all here — this is the one place that decides what director.html even loads with,
// so a locked account can't end up with a mismatched brand for even the first paint. This is a UX nicety,
// NOT the security boundary: handleSessionCreate/handleSessionBrand (render-production-server.mjs) enforce
// the lock server-side regardless of what this ever sends, so a tampered/bypassed URL still can't create or
// change a session to another brand — only the frontend's OWN selector visibility depends on this.
function openStudio(branding = { mode: "flexible", brandId: null }, { destination = null } = {}) {
  els.studioPublicPage.hidden = true;
  els.studioAppShell.hidden = false;
  document.body.classList.add("is-authenticated");
  if (!state.appLoaded) {
    // Once we're actually inside an authenticated session, storage IS a legitimate source for brand
    // (this is "remember my last choice across a refresh while logged in", not the logged-out leak) —
    // state.brandTheme itself stays storage-free so the public gate never flashes stale client branding.
    const authenticatedBrand = branding.mode === "locked"
      ? normalizeBrandTheme(branding.brandId)
      : getInitialBrandTheme(window.location.search, { useStorage: true });
    const query = new URLSearchParams(window.location.search);
    query.set("brand", authenticatedBrand);
    if (branding.mode === "locked") {
      query.set("brandLocked", "1");
    } else {
      query.delete("brandLocked");
    }
    els.studioAppFrame.addEventListener("load", () => {
      // The shell is ready when the authenticated Studio document itself is rendered.
      // Child initialization may continue afterward, but it must never hold the shell hostage.
      dismissEntryCurtain();
    }, { once: true });
    // Authenticated users land on the organization dashboard. A direct session deep-link still opens
    // Studio immediately so shared/bookmarked session URLs keep their existing behavior.
    const resolvedDestination = destination || (query.get("session") ? "./director.html" : "./dashboard.html");
    els.studioAppFrame.src = `${resolvedDestination}?${query}`;
    state.appLoaded = true;
  }
}

function showPublic(message, isError = false) {
  els.studioAppShell.hidden = true;
  els.studioPublicPage.hidden = false;
  document.body.classList.remove("is-authenticated");
  setMessage(message, isError);
}

function setMode(mode) {
  state.mode = mode;
  const signup = mode === "signup";
  els.signupForm.hidden = !signup;
  els.loginForm.hidden = signup;
  els.showSignup.classList.toggle("is-active", signup);
  els.showLogin.classList.toggle("is-active", !signup);
  els.showSignup.setAttribute("aria-selected", String(signup));
  els.showLogin.setAttribute("aria-selected", String(!signup));
  setMessage("");
}

function setBusy(form, busy) {
  form.querySelectorAll("input, button").forEach((el) => { el.disabled = busy; });
}

function setMessage(message, isError = false) {
  els.authMessage.textContent = message;
  els.authMessage.dataset.state = isError ? "error" : "neutral";
}

async function request(path, options = {}) {
  const response = await fetch(`${authEndpoint()}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.method && options.method !== "GET" ? { "Content-Type": "application/json", "X-Toasty-CSRF": "1" } : {}),
      ...(options.headers || {})
    }
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Empty response bodies are treated below by status.
  }
  if (!response.ok) throw new Error(payload.error || "Studio request failed.");
  return payload;
}

function authEndpoint() {
  return studioApiEndpoint();
}
