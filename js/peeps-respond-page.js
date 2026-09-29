// Controller for peeps/respond.html — the external person's introduction page. No account, no wallet, no
// Dub claim: the unguessable token in the URL is the only credential and it reaches exactly one
// introduction. Asks ONLY what the server says is still missing (`needs`), one small step at a time.
import { peepsRespond, peepsRespondCalendarUrl } from "./peeps-jam-api.js";

const token = new URLSearchParams(window.location.search).get("token") || "";
const root = document.getElementById("root");
let view = null;
let showAvailabilityEditor = false;
let showDecline = false;

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c) => (c && c.amount ? `$${Number(c.amount).toFixed(2)} ${esc(c.currency || "USD")}` : null);
const RECORDING = { planned: "This session is expected to be recorded. You'll be asked for consent before it starts.", not_planned: "This session is not planned to be recorded.", unknown: "Recording hasn't been decided yet." };
const REASONS = [["not_interested", "Not interested"], ["bad_timing", "Bad timing"], ["wrong_fit", "Wrong fit"], ["no_recorded_sessions", "I don't do recorded sessions"], ["compensation", "Compensation"], ["other", "Something else"]];

function summaryCard() {
  const v = view;
  return `<section class="card">
    <span class="eyebrow">Introduction request · facilitated by Toasty Peeps</span>
    <h1>${esc(v.requester.name)} would like to speak with you</h1>
    <p class="note">Toasty Peeps is making this introduction on ${esc(v.requester.name)}'s behalf. You don't need an account, and you're under no obligation.</p>
    <dl>
      <dt>Who</dt><dd>${esc(v.requester.name)}${v.requester.organization ? ` · ${esc(v.requester.organization)}` : ""}</dd>
      <dt>Why</dt><dd>${esc(v.purpose)}</dd>
      <dt>Why you</dt><dd>${esc(v.whyYou)}</dd>
      <dt>Format</dt><dd>${esc(v.formatLabel)}</dd>
      <dt>Time</dt><dd>About ${esc(v.proposedDurationMinutes)} minutes</dd>
      <dt>Recording</dt><dd>${esc(RECORDING[v.recording] || RECORDING.unknown)}</dd>
      ${money(v.compensation) ? `<dt>Compensation</dt><dd>${money(v.compensation)}</dd>` : ""}
    </dl>
  </section>`;
}

function tzOptions() {
  const zones = (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"]);
  return `<datalist id="tzlist">${zones.map((z) => `<option value="${esc(z)}">`).join("")}</datalist>`;
}

function windowRow(w = {}) {
  const [d = "", t1 = ""] = String(w.start || "").split("T");
  const t2 = String(w.end || "").split("T")[1] || "";
  return `<div class="win"><input class="field w-date" type="date" value="${esc(d)}" aria-label="Date"><input class="field w-from" type="time" value="${esc(t1)}" aria-label="From"><input class="field w-to" type="time" value="${esc(t2)}" aria-label="To"><button type="button" class="btn quiet w-del" aria-label="Remove">✕</button></div>`;
}

function availabilityForm(prefill, { submitLabel = "Share my availability", extra = "" } = {}) {
  const tz = (prefill && prefill.timezone) || view.known.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const rows = (prefill && prefill.windows && prefill.windows.length ? prefill.windows : [{}]).map(windowRow).join("");
  return `<section class="card" id="availCard">
    <h2 style="margin-top:0">When could you talk?</h2>
    <p class="note">Add a few windows that work for you. We only ever book inside them.</p>
    <label class="muted" for="tz">Your timezone</label>
    <input class="field" id="tz" list="tzlist" value="${esc(tz)}" autocomplete="off">${tzOptions()}
    <div id="wins">${rows}</div>
    <button type="button" class="btn quiet" id="addWin">+ Add another window</button>
    <label class="muted" for="notice" style="display:block;margin-top:14px">Minimum notice</label>
    <select class="field" id="notice">${[[0, "None"], [4, "4 hours"], [12, "12 hours"], [24, "1 day"], [48, "2 days"]].map(([h, l]) => `<option value="${h}" ${Number(prefill?.minNoticeHours || 0) === h ? "selected" : ""}>${l}</option>`).join("")}</select>
    ${extra}
    <div class="choices"><button class="btn" id="sendAvail">${esc(submitLabel)}</button></div>
    <p class="err" id="availErr"></p>
  </section>`;
}

function readAvailability() {
  const wins = [...document.querySelectorAll(".win")].map((row) => {
    const date = row.querySelector(".w-date").value;
    const from = row.querySelector(".w-from").value;
    const to = row.querySelector(".w-to").value;
    return date && from && to ? { start: `${date}T${from}`, end: `${date}T${to}` } : null;
  }).filter(Boolean);
  return { timezone: document.getElementById("tz").value.trim(), minNoticeHours: Number(document.getElementById("notice").value) || 0, windows: wins };
}

function wireAvailability(onSubmit) {
  const wins = document.getElementById("wins");
  document.getElementById("addWin").addEventListener("click", () => wins.insertAdjacentHTML("beforeend", windowRow()));
  wins.addEventListener("click", (event) => {
    if (event.target.classList.contains("w-del") && wins.children.length > 1) event.target.closest(".win").remove();
  });
  document.getElementById("sendAvail").addEventListener("click", async (event) => {
    event.target.disabled = true;
    document.getElementById("availErr").textContent = "";
    try { await onSubmit(readAvailability()); } catch (error) { document.getElementById("availErr").textContent = error.message; event.target.disabled = false; }
  });
}

async function act(action, body = {}) {
  view = await peepsRespond(token, action, body);
  render();
}

function questionStep(need) {
  if (need === "recording") {
    return `<section class="card"><h2 style="margin-top:0">Are you comfortable being recorded?</h2>
      <p class="note">${esc(RECORDING[view.recording])}</p>
      <div class="choices"><button class="btn" data-answer='{"recordingPreference":"ok"}'>Yes, that's fine</button><button class="btn quiet" data-answer='{"recordingPreference":"no"}'>I'd rather not be recorded</button></div></section>`;
  }
  if (need === "duration") {
    return `<section class="card"><h2 style="margin-top:0">How long works for you?</h2>
      <div class="choices">${[30, 45, 60].map((m) => `<button class="btn ${m === 45 ? "" : "quiet"}" data-answer='{"durationMinutes":${m}}'>${m} minutes</button>`).join("")}</div></section>`;
  }
  if (need === "compensation") {
    return `<section class="card"><h2 style="margin-top:0">Is payment part of this for you?</h2>
      <p class="note">No payment has been offered for this conversation.</p>
      <div class="choices"><button class="btn" data-answer='{"compensation":{"requirement":"none"}}'>No payment needed</button><button class="btn quiet" id="needPay">I'd need to be paid</button></div>
      <div id="payBox" hidden><label class="muted" for="payAmt">Rough amount (USD)</label><input class="field" id="payAmt" type="number" min="0" step="1"><button class="btn" id="payGo">Send</button></div></section>`;
  }
  return "";
}

function wireQuestion() {
  document.querySelectorAll("[data-answer]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await act("answers", JSON.parse(btn.dataset.answer)); } catch (error) { alert(error.message); btn.disabled = false; }
  }));
  const need = document.getElementById("needPay");
  if (need) {
    need.addEventListener("click", () => { document.getElementById("payBox").hidden = false; });
    document.getElementById("payGo").addEventListener("click", () => act("answers", { compensation: { requirement: "paid", amount: Number(document.getElementById("payAmt").value) || 0 } }).catch((e) => alert(e.message)));
  }
}

function bookedSection(prep) {
  const b = view.booking;
  const consent = view.consent || { required: [], captured: false };
  const consentLabels = { terms_of_service: "I agree to the terms of participating", recording: "I consent to this session being recorded" };
  return `<section class="card">
    <span class="eyebrow">${b.status === "booked" ? "You're booked" : b.status === "reschedule_requested" ? "Reschedule requested" : "Cancelled"}</span>
    <h1>${esc(b.display)}</h1>
    <p class="note">${b.durationMinutes} minutes with ${esc(view.requester.name)}. ${b.status === "reschedule_requested" ? "We've asked them to pick a new time." : ""}</p>
    ${b.status === "booked" ? `<div class="choices"><a class="btn quiet" href="${esc(peepsRespondCalendarUrl(token))}">Add to calendar (.ics)</a></div>` : ""}
  </section>
  ${prep && b.status === "booked" ? `<section class="card"><h2 style="margin-top:0">Your prep</h2>
    <dl><dt>Purpose</dt><dd>${esc(prep.purpose)}</dd><dt>Format</dt><dd>${esc(prep.format)}</dd>
    <dt>Recording</dt><dd>${esc(prep.recording.statement)}</dd>${prep.compensation ? `<dt>Compensation</dt><dd>$${Number(prep.compensation.amount).toFixed(2)} ${esc(prep.compensation.currency || "USD")}</dd>` : ""}
    ${prep.otherGuestCount ? `<dt>Other guests</dt><dd>${prep.otherGuestCount} other guest${prep.otherGuestCount === 1 ? "" : "s"}</dd>` : ""}
    ${prep.instructions ? `<dt>From ${esc(prep.requester.name)}</dt><dd>${esc(prep.instructions)}</dd>` : ""}</dl>
    ${prep.topics.length ? `<h3>Topics</h3><ul class="q">${prep.topics.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    <h3>Questions you may be asked</h3><ul class="q">${prep.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
    <h3>What's expected</h3><ul class="q">${prep.whatIsExpected.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></section>
  <section class="card"><h2 style="margin-top:0">Consent &amp; joining</h2>
    ${consent.captured ? `<p class="ok">✓ Consent recorded.</p>` : consent.required.map((k) => `<label class="check"><input type="checkbox" class="consent-box" value="${esc(k)}"> <span>${esc(consentLabels[k] || k.replace(/_/g, " "))}</span></label>`).join("") + `<div class="choices"><button class="btn quiet" id="giveConsent">Save my consent</button></div>`}
    <div class="choices"><button class="btn" id="joinBtn">Join the session</button></div>
    <p class="note">You can join a few minutes early. The link opens the lobby where you can check your camera and microphone.</p><p class="err" id="joinErr"></p></section>
  <section class="card"><h3 style="margin-top:0">Need to change something?</h3>
    <div class="choices"><button class="btn quiet" id="reschedBtn">Request a different time</button><button class="btn quiet" id="cancelBtn">Cancel</button></div>
    <p class="note">Late-cancellation window: ${b.cancellationPolicy.lateCancellationHours} hours. Any consequence follows the agreement with ${esc(view.requester.name)}; Peeps applies no automatic penalty.</p></section>` : ""}`;
}

function render() {
  const v = view;
  let html = "";
  if (v.state === "declined") {
    html = `<section class="card"><h1>Thanks — we've let them know</h1><p class="note">You declined this introduction. Nothing more will be sent, and this isn't held against you in any way.</p></section>`;
  } else if (v.state === "expired") {
    html = `<section class="card"><h1>This invitation has expired</h1><p class="note">Ask ${esc(v.requester.name)} if they'd like to send a fresh one.</p></section>`;
  } else if (v.state === "unavailable") {
    html = `<section class="card"><h1>This introduction isn't open right now</h1></section>`;
  } else if (v.state === "awaiting_decision") {
    html = summaryCard() + `<section class="card">
      <h2 style="margin-top:0">Would you like to talk?</h2>
      <div class="choices"><button class="btn" id="yesBtn">I'm interested</button><button class="btn quiet" id="noBtn">Not for me</button></div>
      <div id="declineBox" ${showDecline ? "" : "hidden"}><p class="note" style="margin-top:14px">Totally fine. A reason is optional.</p>
        <select class="field" id="reason"><option value="">No reason to share</option>${REASONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <textarea class="field" id="note" maxlength="400" placeholder="Anything you'd like them to know (optional)"></textarea>
        <button class="btn quiet" id="confirmNo">Confirm — decline</button></div>
      <p class="note" style="margin-top:14px">Or send a quick question first:</p><textarea class="field" id="msg" maxlength="1000" placeholder="Your question"></textarea><button class="btn quiet" id="sendMsg">Send question</button><p class="err" id="msgErr"></p>
    </section>`;
  } else if (v.state === "collecting_details") {
    const need = v.needs.find((n) => n !== "availability") || "availability";
    html = summaryCard() + `<section class="card"><span class="eyebrow">Great — a couple of quick things</span><p class="note">We already know what we can, so we'll only ask what's still missing.</p></section>`
      + (need === "availability" ? availabilityForm(v.submitted.availability) : questionStep(need));
  } else if (v.state === "waiting_for_booking") {
    html = `<section class="card"><span class="eyebrow">You're all set for now</span><h1>Thanks — ${esc(v.requester.name)} is picking a time</h1><p class="note">We'll email you as soon as it's confirmed. Your availability was saved${v.submitted.availability ? ` (${esc(v.submitted.availability.timezone)})` : ""}.</p>
      <div class="choices"><button class="btn quiet" id="editAvail">Change my availability</button></div></section>${showAvailabilityEditor ? availabilityForm(v.submitted.availability, { submitLabel: "Update availability" }) : ""}`;
  } else if (v.state === "booked" || v.state === "reschedule_requested" || (v.state === "cancelled" && v.booking)) {
    html = `<div id="bookedRoot"></div>` + (v.state === "reschedule_requested" || showAvailabilityEditor ? availabilityForm(v.submitted.availability, { submitLabel: "Send my new availability" }) : "");
  } else if (v.state === "cancelled") {
    html = `<section class="card"><h1>This session was cancelled</h1></section>`;
  }
  root.innerHTML = html;
  wire();
}

async function wire() {
  const v = view;
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("yesBtn", () => act("interested").catch((e) => alert(e.message)));
  on("noBtn", () => { showDecline = true; document.getElementById("declineBox").hidden = false; });
  on("confirmNo", () => act("decline", { reason: document.getElementById("reason").value, note: document.getElementById("note").value }).catch((e) => alert(e.message)));
  on("sendMsg", async () => {
    try { await act("message", { message: document.getElementById("msg").value }); } catch (e) { const el = document.getElementById("msgErr"); if (el) el.textContent = e.message; }
  });
  on("editAvail", () => { showAvailabilityEditor = true; render(); });
  if (document.getElementById("availCard")) {
    wireAvailability(async (availability) => {
      if (v.state === "reschedule_requested" || (v.state === "booked") || (v.state === "cancelled")) await act("reschedule", { ...availability, reason: "" });
      else await act("answers", availability);
      showAvailabilityEditor = false;
    });
  }
  wireQuestion();
  if (document.getElementById("bookedRoot")) {
    let prep = null;
    if (v.booking.status === "booked") { try { prep = await peepsRespond(token, "prep"); } catch { prep = null; } }
    document.getElementById("bookedRoot").innerHTML = bookedSection(prep);
    on("giveConsent", async () => {
      const boxes = [...document.querySelectorAll(".consent-box")];
      const acceptances = boxes.filter((b) => b.checked).map((b) => b.value);
      try {
        const result = await peepsRespond(token, "consent", { acceptances });
        if (!result.consentSatisfied) { document.getElementById("joinErr").textContent = "Please tick every box to record consent."; return; }
        view = await peepsRespond(token); render();
      } catch (e) { document.getElementById("joinErr").textContent = e.message; }
    });
    on("joinBtn", async () => {
      try { const { joinUrl } = await peepsRespond(token, "join", {}); window.location.href = joinUrl; }
      catch (e) { document.getElementById("joinErr").textContent = e.message; }
    });
    on("reschedBtn", () => act("reschedule", { reason: "" }).catch((e) => alert(e.message)));
    on("cancelBtn", () => { if (confirm("Cancel this session?")) act("cancel", { reason: "" }).catch((e) => alert(e.message)); });
    if (v.state === "cancelled") document.getElementById("bookedRoot").insertAdjacentHTML("beforeend", `<p class="note">Changed your mind? Share new availability below and ${esc(v.requester.name)} can rebook.</p>`);
  }
}

async function init() {
  if (!token) { root.innerHTML = `<section class="card"><h1>This link isn't valid</h1><p class="note">Open the link from your introduction email.</p></section>`; return; }
  try {
    view = await peepsRespond(token);
    if (view.state === "cancelled" && view.booking) showAvailabilityEditor = true;
    render();
  } catch (error) {
    root.innerHTML = `<section class="card"><h1>${error.status === 410 ? "This link has expired" : "This link isn't valid"}</h1><p class="note">${esc(error.message)}</p></section>`;
  }
}
init();
