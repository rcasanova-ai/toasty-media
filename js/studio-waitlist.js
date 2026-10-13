// Studio waitlist form: posts to the Toasty API (never stores anything in the browser), shows exactly what happened.
import { studioApiEndpoint } from "./studio-api.js";

const form = document.getElementById("studioWaitlistForm");
if (form) {
  const message = document.getElementById("swMessage");
  const submit = document.getElementById("swSubmit");
  const openedAt = Date.now();
  const say = (text, kind = "") => { message.textContent = text; message.dataset.kind = kind; };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = {
      name: String(data.get("name") || "").trim(),
      email: String(data.get("email") || "").trim(),
      company: String(data.get("company") || "").trim(),
      interest: String(data.get("interest") || ""),
      notes: String(data.get("notes") || "").trim(),
      consent: form.elements.consent.checked === true,
      website: String(data.get("website") || ""),
      elapsedMs: Date.now() - openedAt
    };
    if (!body.name) return say("Please tell us your name.", "error");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return say("Enter a valid email address.", "error");
    if (!body.interest) return say("Choose what you want to produce.", "error");
    if (!body.consent) return say("Please tick the box to agree to receive Studio emails.", "error");
    submit.disabled = true;
    say("Joining…");
    try {
      const response = await fetch(`${studioApiEndpoint()}/api/organizations/studio-waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Toasty-CSRF": "1" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error("Too many attempts from this connection. Please try again in a few minutes.");
      if (!response.ok) throw new Error(payload.error || "Something went wrong. Please try again.");
      form.reset();
      say(payload.message || "You're on the Studio waitlist.", "ok");
      submit.textContent = "You're on the list";
    } catch (error) {
      say(error.message || "Could not reach Toasty. Please try again.", "error");
      submit.disabled = false;
    }
  });
}
