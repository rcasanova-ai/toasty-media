// Controller for peeps/app/outcome.html — the requester's post-session view of ONE request:
// Booked → Session → Completed → Outcome → Settlement. Everything shown is read from the server's
// deterministic lifecycle; nothing here is inferred client-side. Crypto/rail details are deliberately
// absent: money is shown as Dough with plain-language status.
import { getPeepsLifecycle, reconcilePeepsRequest, evaluatePeepsOutcome, settlePeepsRequest, corroboratePeepsBreadcrumb, submitJamTranscript, completeJam, addJamArtifact } from "./peeps-jam-api.js";

const id = new URLSearchParams(location.search).get("request") || "";
const root = document.getElementById("outcome-root");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATE = { booked: "Booked", session_completed: "Session completed", outcome_pending: "Outcome pending", outcome_verified: "Outcome verified", completed: "Completed", payment_pending: "Payment pending", paid: "Paid" };
const CLASS = { observed: "Observed", participant_claim: "Participant claim", verified: "Verified", ai_suggested: "AI suggestion" };
let data = null;
let message = "";

async function load() {
  try { data = await getPeepsLifecycle(id); render(); }
  catch (error) { root.innerHTML = `<section class="card"><h3>Couldn't load this request</h3><p class="muted">${esc(error.message)}</p><a class="btn" href="./searches.html">Back</a></section>`; }
}

async function run(fn, done = "") {
  message = "Working…"; render();
  try { await fn(); message = done; } catch (error) { message = error.message || "That didn't work."; }
  await load();
}

function strip() {
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">${data.stages.map((s) => `<i class="tag ${s.status === "done" ? "good" : ""}" style="${s.status === "current" ? "outline:2px solid #ed9a6f" : ""}">${s.status === "done" ? "✓ " : ""}${esc(s.label)}</i>`).join("")}</div>`;
}

function render() {
  const c = data.completion;
  const o = data.outcome;
  const st = data.settlement;
  root.innerHTML = `<div class="section-head"><div><span class="eyebrow">Request</span><h2>Session, outcome &amp; settlement</h2></div><a class="btn secondary" href="./request.html?id=${esc(id)}">← Request</a></div>
  <section class="card"><span class="tag ${["completed", "paid", "outcome_verified"].includes(data.state) ? "good" : ""}">${esc(STATE[data.state] || data.state)}</span>${strip()}<p class="muted" id="msg">${esc(message)}</p>
    <div class="actions">${data.jamId ? `<button class="btn secondary" id="completeBtn">Mark session complete</button>` : ""}<button class="btn secondary" id="reconcileBtn">Refresh from evidence</button></div>
    <p class="muted">A completion is only recorded after the Jam is marked complete or its Studio session ends. Peeps never assumes a session happened.</p></section>
  ${c ? `<section class="card"><h3>What actually happened</h3>
    <p class="muted">Started ${esc(c.startedAt || "—")} · Ended ${esc(c.endedAt || "—")} · Recorded via ${esc(String(c.trigger).replace(/_/g, " "))}</p>
    ${data.guests.map((g) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>${esc(g.name)}</strong><br><span class="muted">${esc(g.status)} · consent ${g.consentCaptured ? "captured" : "not captured"}</span></span><i class="tag ${["attended", "completed"].includes(g.status) ? "good" : ""}">${esc(g.status)}</i></div>`).join("")}
    <p class="muted">Artifacts on file: ${c.artifacts.length ? c.artifacts.map((a) => `${esc(a.type)} (${esc(a.status)})`).join(", ") : "none"}. Transcript: ${c.transcriptPresent ? "attached" : "not attached"}. Recording: ${data.recordingPresent ? "reference on file" : "none on file"}.</p></section>` : ""}
  ${data.jamId ? `<section class="card"><h3>Add what exists</h3>
    <label class="muted">Recording reference (a link or storage path to a real recording)</label><input class="field" id="recRef" placeholder="s3://… or https://…"><button class="btn secondary" id="addRec">Attach recording</button>
    <label class="muted" style="display:block;margin-top:14px">Transcript — one line per turn, like “Guest name: what they said”. Studio doesn't store transcripts itself, so this is recorded as an upload by you.</label><textarea class="field tall" id="tText" placeholder="Priya: Welcome…&#10;Anong Srisuk: Thanks for having me…"></textarea><button class="btn" id="addTranscript">Attach transcript &amp; propose Breadcrumbs</button></section>` : ""}
  ${o ? `<section class="card"><h3>Outcome</h3><p><b>${o.state === "outcome_verified" ? "Verified" : "Not yet verified"}</b>${o.basis ? ` — ${esc(o.basis.replace(/_/g, " "))}` : ""}</p>
    ${o.criteria.map((k) => `<div class="row" style="grid-template-columns:1fr auto"><span>${esc(k.label)}<br><span class="muted">${esc(k.evidence)}${k.required ? "" : " (optional)"}</span></span><i class="tag ${k.met ? "good" : ""}">${k.met ? "✓ met" : (k.required ? "missing" : "n/a")}</i></div>`).join("")}
    ${o.state !== "outcome_verified" ? `<div class="actions"><button class="btn secondary" id="acceptPartial">Accept fewer guests than requested</button></div>` : ""}</section>` : ""}
  ${c ? `<section class="card"><h3>Settlement</h3>${st.status === "none_due" ? `<p class="muted">No compensation was part of this request.</p>` : `<p><b>${st.status === "paid" ? "Paid" : "Pending"}</b> — $${Number(st.paid).toFixed(2)} of $${Number(st.totalOwed).toFixed(2)} settled in Dough.</p>
    ${st.remaining ? `<p style="color:#8e3434">Your Dough balance is short. Add at least $${Number(st.remaining.shortfall).toFixed(2)} and settle again — nobody is paid from money that doesn't exist. <a class="link" href="./dough.html">Add Dough →</a></p>` : ""}
    ${st.status !== "paid" ? `<div class="actions"><button class="btn" id="settleBtn">Settle now</button></div>` : ""}`}</section>` : ""}
  ${data.breadcrumbs.length ? `<section class="card"><h3>Breadcrumbs proposed from this session</h3><p class="muted">Each is a proposal the guest reviews; nothing reaches a Dub until they approve it. Corroborating one that a guest confirmed marks it verified.</p>
    ${data.breadcrumbs.map((b) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>${esc(b.guest)}</strong> · ${esc(b.kindLabel)}<br>${esc(b.statement)}<br><span class="muted">${esc(CLASS[b.evidenceClass] || b.evidenceClass)} · ${esc(b.status)} · ${esc(b.provenance.method || "")}${b.provenance.segmentIndex !== undefined ? ` · segment ${Number(b.provenance.segmentIndex) + 1}` : ""}</span></span>${["rejected"].includes(b.status) || b.corroborated ? `<i class="tag">${b.corroborated ? "corroborated" : "rejected"}</i>` : `<button class="btn secondary" data-corroborate="${esc(b.id)}">Corroborate</button>`}</div>`).join("")}</section>` : ""}`;
  wire();
}

function wire() {
  const on = (sel, fn) => document.querySelectorAll(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
  on("#completeBtn", () => { if (confirm("Mark this session complete?")) run(() => completeJam(data.jamId), "Marked complete."); });
  on("#reconcileBtn", () => run(() => reconcilePeepsRequest(id), "Refreshed."));
  on("#addRec", () => run(() => addJamArtifact(data.jamId, { artifactType: "recording", storageReference: document.getElementById("recRef").value.trim(), status: "ready" }).then(() => reconcilePeepsRequest(id)), "Recording attached."));
  on("#addTranscript", () => run(() => submitJamTranscript(data.jamId, { text: document.getElementById("tText").value }), "Transcript attached."));
  on("#acceptPartial", () => run(() => evaluatePeepsOutcome(id, { acceptPartial: true }), "Outcome re-evaluated."));
  on("#settleBtn", () => run(() => settlePeepsRequest(id), "Settlement attempted."));
  on("[data-corroborate]", (el) => run(() => corroboratePeepsBreadcrumb(el.dataset.corroborate), "Corroborated."));
}

if (!id) root.innerHTML = `<section class="card"><h3>No request selected</h3><a class="btn" href="./searches.html">My requests</a></section>`;
else load();
