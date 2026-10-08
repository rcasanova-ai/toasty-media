// Public Peeps waitlist form (peeps/waitlist/). Posts to POST /api/peeps/waitlist; the server does all
// validation, de-duplication, rate limiting and bot filtering. Nothing is stored in the browser.
import { studioRequest } from "./studio-api.js";

const $ = (id) => document.getElementById(id);
const startedAt = Date.now();
const form = $("wlForm");

function say(text, state) {
  const el = $("wlMessage");
  el.hidden = !text;
  el.textContent = text || "";
  el.dataset.state = state || "";
}

$("wlInterest").addEventListener("change", () => { $("wlCommunityNote").hidden = $("wlInterest").value !== "community_services"; });

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  say("");
  const name = $("wlName").value.trim();
  const email = $("wlEmail").value.trim();
  if (!name) return say("Please tell us your name.", "error");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say("Enter a valid email address.", "error");
  if (!$("wlInterest").value) return say("Choose what you're most interested in.", "error");
  if (!$("wlConsent").checked) return say("Please agree to receive Peeps launch and invitation emails to join.", "error");
  const button = $("wlSubmit");
  button.disabled = true;
  button.textContent = "Joining…";
  try {
    await studioRequest("/api/peeps/waitlist", {
      method: "POST",
      body: JSON.stringify({
        name, email, country: $("wlCountry").value, city: $("wlCity").value, interest: $("wlInterest").value,
        description: $("wlDescription").value, consent: true, website: $("wlWebsite").value, elapsedMs: Date.now() - startedAt
      })
    });
    form.hidden = true;
    $("wlDoneEmail").textContent = email;
    $("wlDone").hidden = false;
    document.querySelector(".wl > h1").hidden = true;
    document.querySelector(".wl > .lead").hidden = true;
    window.scrollTo(0, 0);
  } catch (error) {
    say(error.message || "Something went wrong. Please try again.", "error");
    button.disabled = false;
    button.textContent = "Join the waitlist";
  }
});
