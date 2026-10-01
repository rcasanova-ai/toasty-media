// Public /peeps/ private-beta waitlist. Submits to POST /api/peeps/waitlist on the render host
// (persistent peeps_waitlist table) through the same studioRequest transport as the rest of Toasty.
// Never gates or hides the page, and never touches authentication.
import { studioRequest } from "./studio-api.js";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
const els = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "peepsWaitlist", "peepsWaitlistForm", "peepsWaitlistFormView", "peepsWaitlistDone", "peepsWaitlistDoneTitle",
    "peepsWaitlistMessage", "peepsWaitlistSubmit", "peepsWaitlistClose", "peepsWaitlistDoneClose",
    "peepsAuth", "peepsAuthToWaitlist"
  ].forEach((id) => { els[id] = document.getElementById(id); });
  if (!els.peepsWaitlist) return;

  document.querySelectorAll("[data-waitlist-open]").forEach((el) => el.addEventListener("click", openWaitlist));
  els.peepsWaitlistClose?.addEventListener("click", () => els.peepsWaitlist.close());
  els.peepsWaitlistDoneClose?.addEventListener("click", () => els.peepsWaitlist.close());
  els.peepsAuthToWaitlist?.addEventListener("click", () => {
    els.peepsAuth?.close();
    openWaitlist();
  });
  els.peepsWaitlistForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  if (new URLSearchParams(window.location.search).has("waitlist")) openWaitlist();
});

function openWaitlist() {
  setMessage("");
  els.peepsWaitlistFormView.hidden = false;
  els.peepsWaitlistDone.hidden = true;
  if (!els.peepsWaitlist.open) els.peepsWaitlist.showModal();
  els.peepsWaitlistForm.elements.name?.focus();
}

function attribution() {
  const params = new URLSearchParams(window.location.search);
  const utm = {};
  UTM_KEYS.forEach((key) => {
    const value = params.get(key);
    if (value) utm[key] = value;
  });
  return {
    utm,
    referrer: document.referrer || "",
    source: utm.utm_source || params.get("ref") || "peeps-landing"
  };
}

async function submit() {
  const form = els.peepsWaitlistForm;
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const email = String(data.get("email") || "").trim();
  if (!name) return fail("Please tell us your name.", "name");
  if (!form.elements.email.checkValidity() || !email) return fail("Enter a valid email address.", "email");
  if (!form.elements.consent.checked) return fail("Please agree so we can contact you about access.", "consent");
  setBusy(true);
  setMessage("");
  try {
    const result = await studioRequest("/api/peeps/waitlist", {
      method: "POST",
      body: JSON.stringify({
        name,
        email,
        company: String(data.get("company") || "").trim(),
        useCase: String(data.get("useCase") || "").trim(),
        consent: true,
        website: String(data.get("website") || ""),
        ...attribution()
      })
    });
    els.peepsWaitlistDoneTitle.textContent = result.status === "already_on_list" ? "You’re already on the list." : "You’re on the list.";
    els.peepsWaitlistFormView.hidden = true;
    els.peepsWaitlistDone.hidden = false;
    form.reset();
  } catch (error) {
    setMessage(error.message || "We couldn’t save that just now. Please try again.", true);
  } finally {
    setBusy(false);
  }
}

function fail(message, field) {
  setMessage(message, true);
  els.peepsWaitlistForm.elements[field]?.focus();
}

function setBusy(busy) {
  els.peepsWaitlistForm.querySelectorAll("input, textarea, button").forEach((el) => { el.disabled = busy; });
  els.peepsWaitlistSubmit.textContent = busy ? "Joining…" : "Join the Waitlist";
}

function setMessage(message, isError = false) {
  els.peepsWaitlistMessage.textContent = message;
  els.peepsWaitlistMessage.dataset.state = isError ? "error" : "neutral";
}
