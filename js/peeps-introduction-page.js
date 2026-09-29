// Controller for peeps/app/introduction.html — the requester's view of ONE authorized introduction, from
// "can we reach them?" through outreach, the guest's response, scheduling, and finally the "Your session is
// ready" state with prep, the editable Session Plan, and Open Studio. Every button maps to one server
// action; the server is the source of truth (state survives refresh and retries).
import {
  getPeepsIntroduction, getPeepsIntroductionSlots, retryPeepsOutreach, findPeepsReplacement, approvePeepsReplacement,
  bookPeepsIntroduction, setPeepsRequesterAvailability, getPeepsBooking, getPeepsBookingPrep, editPeepsBookingPlan,
  cancelPeepsBooking, rebuildPeepsBooking, retryPeepsMessage
} from "./peeps-jam-api.js";

const id = new URLSearchParams(location.search).get("id") || "";
const root = document.getElementById("intro-root");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = {
  authorized: ["Authorized", "Introduction authorized."], resolving_contact: ["Finding a way to reach them", "Peeps is checking for a legitimate contact path."],
  ready_for_outreach: ["Ready to contact", "A contact path exists but outreach hasn't gone out."], outreach_sent: ["Contacted — waiting", "Outreach was sent; waiting for their answer."],
  responded: ["They replied", "They sent a message but haven't decided yet."], accepted: ["Interested", "They're interested; collecting their details."],
  scheduling: ["Ready to schedule", "Everything is known — pick a time."], booked: ["Booked", "Time confirmed."], declined: ["Declined", "They declined this introduction."],
  unreachable: ["Couldn't be reached", "Peeps couldn't reach them by any automated path."], expired: ["No reply", "They never responded."], cancelled: ["Cancelled", "This session was cancelled."]
};
let data = null;
let bookingView = null;
let slots = null;
let replacement = null;
let prepTab = "organizer";
let prepData = null;
let message = "";

async function load() {
  try {
    data = await getPeepsIntroduction(id);
    bookingView = null; slots = null; prepData = null;
    if (data.booking) bookingView = await getPeepsBooking(data.booking.id);
    else if (["scheduling", "accepted"].includes(data.introduction.status)) slots = await getPeepsIntroductionSlots(id);
    render();
  } catch (error) {
    root.innerHTML = `<section class="card"><h3>Couldn't load this introduction</h3><p class="muted">${esc(error.message)}</p><a class="btn" href="./searches.html">Back to requests</a></section>`;
  }
}

async function run(fn, doneMessage = "") {
  message = "Working…"; renderMessage();
  try { await fn(); message = doneMessage; } catch (error) { message = error.message || "That didn't work."; }
  await load();
}

function renderMessage() { const el = document.getElementById("msg"); if (el) el.textContent = message; }

function timeline() {
  const s = data.introduction.status;
  const steps = [["Authorized", true], ["Contacted", ["outreach_sent", "responded", "accepted", "scheduling", "booked"].includes(s) || Boolean(data.introduction.outreachSentAt)], ["Interested", ["accepted", "scheduling", "booked"].includes(s)], ["Booked", s === "booked"], ["Ready", bookingView?.state === "READY_FOR_SESSION"]];
  return `<div class="tag-row" style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">${steps.map(([l, ok]) => `<i class="tag ${ok ? "good" : ""}">${ok ? "✓ " : ""}${l}</i>`).join("")}</div>`;
}

function contactCard() {
  const c = data.contact;
  const adapterLine = data.adapters.filter((a) => a.id !== "selected").map((a) => `<li><b>${esc(a.id)}</b> — ${esc(a.kind === "real" ? "real" : a.kind === "test_demo" ? "TEST/DEMO" : "adapter only (not automated)")}${a.available ? " · available" : ""}<br><span class="muted">${esc(a.note)}</span></li>`).join("");
  return `<section class="card"><h3>How Peeps can reach them</h3>
    ${c.channels.length ? c.channels.map((ch) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>${esc(ch.channel.replace(/_/g, " "))}</strong> · ${esc(ch.destination || ch.publicReference || "")}<br><span class="muted">Source: ${esc(ch.source.replace(/_/g, " "))} · ${esc(ch.verification.replace(/_/g, " "))} · confidence ${esc(ch.confidence || "n/a")} · checked ${esc((ch.lastCheckedAt || "").slice(0, 10))}</span></span><i class="tag ${ch.status === "active" ? "good" : ""}">${ch.automatable ? esc(ch.status) : "manual only"}</i></div>`).join("") : `<p class="muted">No legitimate contact path was found. Peeps never guesses email addresses.</p>`}
    ${c.blocked === "provider_unavailable" ? `<p class="muted"><b>Outreach is not going out:</b> no outreach provider is configured on this deployment.</p>` : ""}
    ${c.manualOptions.length ? `<p class="muted">Manual-only paths (Peeps will not pretend to message these): ${c.manualOptions.map((m) => m.reference ? `<a class="link" href="${esc(m.reference)}" target="_blank" rel="noopener noreferrer">${esc(m.channel.replace(/_/g, " "))}</a>` : esc(m.channel)).join(", ")}</p>` : ""}
    <details class="advanced"><summary>What can be automated</summary><ul class="muted">${adapterLine}</ul></details>
  </section>`;
}

function messagesCard() {
  if (!data.messages.length) return "";
  return `<section class="card"><h3>Messages</h3>${data.messages.map((m) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>${esc(m.purpose.replace(/_/g, " "))}</strong> → ${esc(m.audience)} · attempt ${m.attempt}<br><span class="muted">${esc(m.delivery)}${m.error ? ` — ${esc(m.error)}` : ""}</span></span><span>${["failed", "skipped_unavailable"].includes(m.status) ? `<button class="btn secondary" data-retry-msg="${esc(m.id)}">Retry</button>` : `<i class="tag ${m.providerKind === "test_demo" ? "" : "good"}">${esc(m.providerKind === "test_demo" ? "test/demo" : m.status)}</i>`}</span></div>`).join("")}</section>`;
}

function responseCard() {
  const r = data.response;
  const av = data.availability;
  if (!r.decision && !av && !r.messages.length) return "";
  return `<section class="card"><h3>Their response</h3>
    ${r.decision ? `<p><b>${r.decision === "interested" ? "Interested" : "Declined"}</b>${r.reason ? ` — ${esc(String(r.reason).replace(/_/g, " "))}` : ""}</p>` : ""}
    ${r.messages.map((m) => `<p class="muted">“${esc(m.text)}”</p>`).join("")}
    <p class="muted">Recording: ${esc(r.preferences.recordingPreference || "not answered")} · Length: ${esc(r.preferences.durationMinutes || "not answered")} min · Timezone: ${esc(r.preferences.timezone || "not shared")}${r.preferences.formatConstraints ? ` · Constraints: ${esc(r.preferences.formatConstraints)}` : ""}</p>
    ${av ? `<p class="muted">Availability (${esc(av.timezone)}): ${av.windows.map((w) => `${esc(w.start.replace("T", " "))} → ${esc(w.end.split("T")[1])}`).join("; ")}</p>` : ""}
    ${data.blockers.length ? `<p style="color:#8e3434"><b>Needs your decision:</b> ${data.blockers.map((b) => b === "recording_conflict" ? "They don't want to be recorded." : "They asked for more compensation than offered.").join(" ")}</p>` : ""}
  </section>`;
}

function windowRow() { return `<div class="row" style="grid-template-columns:1fr 1fr 1fr auto"><input class="field a-date" type="date" style="margin:0"><input class="field a-from" type="time" style="margin:0"><input class="field a-to" type="time" style="margin:0"><button class="btn secondary a-del" type="button">✕</button></div>`; }

function schedulingCard() {
  const ra = data.requesterAvailability;
  const tz = ra?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const slotHtml = slots
    ? (slots.reason ? `<p class="muted"><b>${{ requester_availability_required: "Add your availability so Peeps only proposes times you offered.", no_overlapping_availability: "There's no overlap yet — widen your availability or ask them for more times.", candidate_availability_required: "Waiting for their availability.", candidate_unavailable_at_session_time: "They can't make the time this Session is already booked at." }[slots.reason] || slots.reason}</b></p>`
      : `<p class="muted">${slots.durationMinutes}-minute options that work for both of you${slots.groupCompatible === false ? " (not all other guests overlap)" : ""}:</p>${slots.slots.map((s) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>${esc(s.requesterLocal)}</strong><br><span class="muted">Their time: ${esc(s.candidateLocal)}</span></span><button class="btn" data-book="${esc(s.startsAt)}">Book this time</button></div>`).join("")}`)
    : "";
  return `<section class="card"><h3>Schedule</h3>${slotHtml}
    ${slots && slots.blockers?.includes("recording_conflict") ? `<label class="muted"><input type="checkbox" id="notRecorded"> Book as NOT recorded (they declined recording)</label><br>` : ""}
    ${slots && slots.blockers?.includes("compensation_mismatch") ? `<label class="muted"><input type="checkbox" id="ackBlockers"> I've handled their compensation request</label><br>` : ""}
    <details class="advanced" ${ra ? "" : "open"}><summary>Your availability${ra ? ` (${esc(ra.timezone)})` : " — required before booking"}</summary>
      <label class="muted">Timezone</label><input class="field" id="myTz" value="${esc(tz)}">
      <div id="myWins">${(ra?.windows?.length ? ra.windows : [null]).map(windowRow).join("")}</div>
      <button class="btn secondary" id="addMyWin" type="button">+ window</button> <button class="btn" id="saveMyAvail">Save my availability</button>
    </details></section>`;
}

function readyCard() {
  const b = bookingView;
  const ready = b.state === "READY_FOR_SESSION";
  const setupProblems = Object.entries(b.booking.setup || {}).filter(([, v]) => v && v.ok === false);
  return `<section class="card" style="border-left:4px solid ${ready ? "#26765a" : "#ed9a6f"}">
    <span class="eyebrow">${ready ? "Ready for session" : b.booking.status === "booked" ? "Preparing" : esc(b.state)}</span>
    <h2 style="margin:6px 0">${ready ? "Your session is ready." : b.booking.status === "booked" ? "Almost there…" : "This booking is " + esc(b.booking.status.replace(/_/g, " ")) + "."}</h2>
    <p><b>Guest:</b> ${esc(b.guest.name)}<br><b>When:</b> ${esc(b.when.display)}<br><b>Purpose:</b> ${esc(b.purpose)}</p>
    ${b.booking.status === "booked" ? `<div class="actions"><button class="btn" id="reviewPrep">Review Prep</button><a class="btn secondary" href="${esc(b.links.planner || "#")}">Edit Session Plan</a><a class="btn secondary" href="${esc(b.links.studio ? b.links.studio : "#")}">Open Studio</a><a class="btn secondary" href="${esc(b.links.jam)}">Open Jam</a></div>` : ""}
    <details class="advanced" ${ready ? "" : "open"}><summary>Readiness</summary>${b.readiness.items.map((i) => `<div class="row" style="grid-template-columns:1fr auto"><span>${esc(i.label)}</span><i class="tag ${i.ok ? "good" : ""}">${i.ok ? "✓" : "pending"}</i></div>`).join("")}
      ${setupProblems.length ? `<p style="color:#8e3434">${setupProblems.map(([k, v]) => `${esc(k)}: ${esc(v.error)}`).join("; ")}</p><button class="btn" id="rebuildBtn">Retry setup</button>` : ""}
      <p class="muted">Consent: ${b.readiness.consentCaptured ? "captured" : "the guest hasn't given consent yet"}. Calendar: ${esc(b.calendar.note)}</p></details></section>`;
}

function planEditor() {
  const p = bookingView.plan;
  if (!p || bookingView.booking.status !== "booked") return "";
  return `<section class="card" id="planCard"><h3>Session plan</h3>
    <label class="muted">Objective</label><textarea class="field" id="planObjective">${esc(p.objective)}</textarea>
    <label class="muted">Questions (one per line — guests see these)</label><textarea class="field tall" id="planQuestions" style="min-height:220px">${esc((p.questions || []).map((q) => q.text).join("\n"))}</textarea>
    <label class="muted">Topics (one per line)</label><textarea class="field" id="planTopics">${esc((p.topics || []).map((t) => t.text).join("\n"))}</textarea>
    <label class="muted">Instructions for the guest (participant-facing)</label><textarea class="field" id="planInstructions">${esc(p.participantInstructions || "")}</textarea>
    <label class="muted">Recording</label><select class="field" id="planRecording"><option value="recorded" ${p.recording?.state === "recorded" ? "selected" : ""}>Recorded</option><option value="not_recorded" ${p.recording?.state === "not_recorded" ? "selected" : ""}>Not recorded</option></select>
    <label class="muted">Private notes (never shown to guests)</label><textarea class="field" id="planPrivate">${esc(p.privateNotes || "")}</textarea>
    <div class="actions"><button class="btn" id="savePlan">Save changes</button></div>
    <p class="muted">Changing questions, topics, instructions, recording or time notifies the guest. Private notes never do. Version ${p.version}. ${bookingView.versions.length ? `History: ${bookingView.versions.slice(0, 5).map((v) => `v${v.version}${v.participantFacing ? "*" : ""}`).join(", ")} (* = guest-facing)` : ""}</p></section>`;
}

function prepCard() {
  if (!prepData) return "";
  const org = prepData.role === "organizer";
  return `<section class="card" id="prepCard"><h3>Prep</h3><div class="actions"><button class="btn ${org ? "" : "secondary"}" data-prep="organizer">Your prep</button><button class="btn ${org ? "secondary" : ""}" data-prep="attendee">What the guest sees</button></div>
    ${org ? `<p><b>${esc(prepData.who.name)}</b> — ${esc(prepData.who.headline)}<br><span class="muted">Source: ${esc(prepData.who.source)}</span></p><p><b>Why selected:</b> ${esc(prepData.whySelected)}</p>
      <h4>Evidence</h4><ul class="muted">${prepData.evidence.map((e) => `<li>${esc(e.claim)} <i>(${esc(e.sourceTitle)}, ${esc(e.confidence)})</i></li>`).join("")}</ul>
      <h4>Desired outcome</h4><p>${esc(prepData.desiredOutcome)}</p><h4>Questions</h4><ol>${prepData.questions.map((q) => `<li>${esc(q.text)}</li>`).join("")}</ol>
      <h4>Talking points</h4><ul>${prepData.talkingPoints.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <h4>Their requirements</h4><p class="muted">Recording: ${esc(prepData.participantRequirements.recordingPreference || "n/a")} · Timezone: ${esc(prepData.participantRequirements.guestTimezone || "n/a")}${prepData.participantRequirements.formatConstraints ? ` · ${esc(prepData.participantRequirements.formatConstraints)}` : ""}</p>`
    : `<p><b>${esc(prepData.requester.name)}</b> · ${esc(prepData.schedule.display)} · ${prepData.schedule.durationMinutes} min</p><p>${esc(prepData.purpose)}</p><p class="muted">${esc(prepData.recording.statement)}</p><h4>Questions</h4><ol>${prepData.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ol>${prepData.instructions ? `<h4>Instructions</h4><p>${esc(prepData.instructions)}</p>` : ""}`}
  </section>`;
}

function replacementCard() {
  if (!replacement) return "";
  return `<section class="card"><h3>Last-minute opening</h3>
    <p class="muted">${esc(replacement.opening.context.purpose)} · ${replacement.opening.context.startsAt ? "Time held: " + esc(replacement.opening.context.startsAt) : "Time to be agreed"} · ${replacement.opening.context.durationMinutes} min · ${esc(replacement.opening.context.formatLabel)} · recording ${esc(replacement.opening.context.recording)}${replacement.opening.context.compensation ? " · $" + replacement.opening.context.compensation.amount : ""}</p>
    ${replacement.discovered ? `<p class="muted">No one previously qualified was left, so Peeps went back to discovery.</p>` : ""}
    ${replacement.candidates.map((c) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>${esc(c.displayName)}</strong> — ${esc(c.headline)}<br><span class="muted">${esc(c.matchReason)}</span>${c.needsContactFromRequester ? `<br><input class="field" data-rep-email="${esc(c.id)}" placeholder="Their email, if you hold it (Peeps never guesses)" style="max-width:320px">` : ""}</span><button class="btn" data-approve="${esc(c.id)}">Approve &amp; contact</button></div>`).join("") || `<p class="muted">No replacement candidates yet.</p>`}
    <p class="muted">Your original introduction fee is preserved — no new charge.</p></section>`;
}

function render() {
  const intro = data.introduction;
  const [label, blurb] = STATUS[intro.status] || [intro.status, ""];
  const actions = data.nextActions;
  root.innerHTML = `<div class="section-head"><div><span class="eyebrow">Introduction</span><h2>${esc(data.candidate.displayName)}</h2><p class="muted">${esc(data.candidate.headline)}</p></div><a class="btn secondary" href="./request.html?id=${esc(intro.requestId)}">← Request</a></div>
    <section class="card"><span class="tag ${["booked", "scheduling", "accepted"].includes(intro.status) ? "good" : ""}">${esc(label)}</span> <span class="muted">${esc(blurb)}${intro.status === "declined" ? " You haven't been charged again, and this isn't a mark against them." : ""}${intro.replacesIntroductionId ? " (Replacement — original fee preserved.)" : ""}</span>${timeline()}
      <div class="actions">
        ${actions.includes("retry_outreach") ? `<button class="btn secondary" id="retryOutreach">${intro.outreachSentAt ? "Send a reminder" : "Retry outreach"} (${data.outreachAttempts}/${data.maxOutreachAttempts})</button>` : ""}
        ${actions.includes("find_replacement") ? `<button class="btn" id="findRep">Find a replacement</button>` : ""}
      </div><p class="muted" id="msg">${esc(message)}</p></section>
    ${bookingView && bookingView.booking.status !== "cancelled" ? readyCard() : ""}
    ${bookingView && bookingView.booking.status === "cancelled" ? `<section class="card"><b>Booking cancelled</b>${bookingView.booking.lateCancellation ? " — inside the late-cancellation window (no automatic penalty applied)." : "."}</section>` : ""}
    ${replacementCard()}${planEditor()}${prepCard()}
    ${responseCard()}${["scheduling", "accepted"].includes(intro.status) || (data.booking && ["reschedule_requested"].includes(data.booking.status)) ? schedulingCard() : ""}
    ${bookingView && bookingView.booking.status === "booked" ? `<section class="card"><h3>Change of plans</h3><div class="actions"><button class="btn secondary" id="cancelBooking">Cancel this session</button></div><p class="muted">Cancellation window: ${bookingView.booking.cancellationPolicy.lateCancellationHours}h. Peeps records whether it was late; no penalty is applied automatically. To move the time, ask the guest for new availability — the schedule panel then offers new times.</p></section>` : ""}
    ${contactCard()}${messagesCard()}`;
  wire();
}

function wire() {
  const on = (sel, fn) => document.querySelectorAll(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
  on("#retryOutreach", () => run(() => retryPeepsOutreach(id), "Outreach attempted."));
  on("#findRep", () => run(async () => { replacement = await findPeepsReplacement(id); }, "Replacement candidates loaded."));
  on("[data-retry-msg]", (el) => run(() => retryPeepsMessage(el.dataset.retryMsg), "Retried."));
  on("[data-book]", (el) => run(() => bookPeepsIntroduction(id, { slotStart: el.dataset.book, recordingState: document.getElementById("notRecorded")?.checked ? "not_recorded" : undefined, acknowledgeBlockers: Boolean(document.getElementById("ackBlockers")?.checked) }), "Booked."));
  on("#rebuildBtn", () => run(() => rebuildPeepsBooking(bookingView.booking.id), "Setup retried."));
  on("#cancelBooking", () => { if (confirm("Cancel this session?")) run(() => cancelPeepsBooking(bookingView.booking.id), "Cancelled."); });
  on("#reviewPrep", async () => { prepData = await getPeepsBookingPrep(bookingView.booking.id, prepTab); render(); document.getElementById("prepCard")?.scrollIntoView({ behavior: "smooth" }); });
  on("[data-prep]", async (el) => { prepTab = el.dataset.prep; prepData = await getPeepsBookingPrep(bookingView.booking.id, prepTab); render(); });
  on("[data-approve]", (el) => run(async () => {
    const email = document.querySelector(`[data-rep-email="${el.dataset.approve}"]`)?.value.trim();
    await approvePeepsReplacement(replacement.opening.id, { candidateId: el.dataset.approve, outreachEmail: email || undefined });
    replacement = null;
  }, "Replacement approved and contacted."));
  on("#savePlan", () => run(async () => {
    const lines = (elId) => document.getElementById(elId).value.split("\n").map((s) => s.trim()).filter(Boolean);
    const existing = bookingView.plan.questions;
    const newLines = lines("planQuestions");
    const used = new Set();
    const questions = newLines.map((text, i) => {
      // Keep a question's identity (and its guest-specific tag) when its text is unchanged, or when it's
      // an in-place edit of the question that used to sit at this position.
      let match = existing.find((q) => q.text === text && !used.has(q.id));
      if (!match && existing[i] && !newLines.includes(existing[i].text) && !used.has(existing[i].id)) match = existing[i];
      if (match) used.add(match.id);
      return { id: match?.id, text };
    });
    await editPeepsBookingPlan(bookingView.booking.id, {
      objective: document.getElementById("planObjective").value, questions, topics: lines("planTopics"),
      participantInstructions: document.getElementById("planInstructions").value, recordingState: document.getElementById("planRecording").value,
      privateNotes: document.getElementById("planPrivate").value, baseVersion: bookingView.plan.version
    });
  }, "Saved. Guest-facing changes were sent to the guest."));
  const wins = document.getElementById("myWins");
  if (wins) {
    document.getElementById("addMyWin").addEventListener("click", () => wins.insertAdjacentHTML("beforeend", windowRow()));
    wins.addEventListener("click", (e) => { if (e.target.classList.contains("a-del") && wins.children.length > 1) e.target.closest(".row").remove(); });
    document.getElementById("saveMyAvail").addEventListener("click", () => run(async () => {
      const windows = [...wins.querySelectorAll(".row")].map((r) => { const d = r.querySelector(".a-date").value, f = r.querySelector(".a-from").value, t = r.querySelector(".a-to").value; return d && f && t ? { start: `${d}T${f}`, end: `${d}T${t}` } : null; }).filter(Boolean);
      await setPeepsRequesterAvailability(data.introduction.requestId, { timezone: document.getElementById("myTz").value.trim(), windows });
    }, "Your availability was saved."));
  }
}

if (!id) root.innerHTML = `<section class="card"><h3>No introduction selected</h3><a class="btn" href="./searches.html">My requests</a></section>`;
else load();
