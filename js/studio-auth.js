const LOCAL_AUTH_ENDPOINT = "http://127.0.0.1:4174";
const PRODUCTION_AUTH_ENDPOINT = "https://render.toasty.media";

const state = {
  mode: "signup",
  appLoaded: false
};

const els = {};

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

  els.showSignup.addEventListener("click", () => setMode("signup"));
  els.showLogin.addEventListener("click", () => setMode("login"));
  els.signupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    register();
  });
  els.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    login();
  });
  els.studioLogout.addEventListener("click", logout);

  checkSession();
});

async function checkSession() {
  setMessage("Checking Studio access...");
  try {
    const session = await request("/auth/session", { method: "GET" });
    if (session.authenticated) {
      openStudio();
      return;
    }
    showPublic("");
  } catch {
    showPublic("Studio account service is unavailable. Please try again shortly.", true);
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
    if (session.authenticated) openStudio();
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
    if (session.authenticated) openStudio();
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

function openStudio() {
  els.studioPublicPage.hidden = true;
  els.studioAppShell.hidden = false;
  document.body.classList.add("is-authenticated");
  if (!state.appLoaded) {
    const query = window.location.search || "?brand=toasty";
    els.studioAppFrame.src = `./director.html${query}`;
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
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "") return LOCAL_AUTH_ENDPOINT;
  return window.TOASTY_AUTH_ENDPOINT || PRODUCTION_AUTH_ENDPOINT;
}
