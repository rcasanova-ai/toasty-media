import { studioRequest } from "./studio-api.js";

const form = document.getElementById("auditionForm");
const status = document.getElementById("auditionStatus");
const startedAt = Date.now();

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  const payload = Object.fromEntries(["name", "email", "location", "about", "topic", "links", "website"].map((key) => [key, String(data.get(key) || "")]));
  Object.assign(payload, { adult: data.has("adult"), release: data.has("release"), privacy: data.has("privacy"), elapsedMs: Date.now() - startedAt });
  button.disabled = true; status.textContent = "Submitting securely…";
  try {
    const result = await studioRequest("/api/organizations/talk-auditions", { method: "POST", body: JSON.stringify(payload) });
    status.textContent = result.message;
    form.reset();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
    return;
  }
  button.textContent = "Application submitted";
});
