// Controller for peeps/app/golden-path.html — the Colosseum "judge path". It is deliberately thin: three
// human actions (Find my Peeps · Authorize introductions · Join Jam) over the SAME production APIs the rest
// of /peeps/app/ uses, plus a read-only receipt rendered from GET /api/peeps/requests/:id/receipt.
// Nothing is seeded or faked here: every status, signature and amount comes from the server, and the
// browser never claims payment, consent, attendance or settlement — it only asks the server to act or to
// verify, and displays what the server stored.
import { studioRequest } from "./studio-api.js";
import {
  getPrimaryOrganizationId, createPeepsRequest, getPeepsRequest, authorizePeepsIntroductions, authorizePeepsIntroductionsOnchain,
  getPeepsPaymentRequirement, getPeepsReceipt, getPeepsIntroduction, getPeepsBooking, setPeepsRequesterAvailability, bookPeepsIntroduction,
  submitJamTranscript, completeJam, reconcilePeepsRequest, settlePeepsRequest
} from "./peeps-jam-api.js";

const root = document.getElementById("gp-root");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const params = new URLSearchParams(location.search);
let requestId = params.get("request") || "";
let candidates = [];
let selected = new Set();
let draft = { who: "Fintech/payment executives in Southeast Asia who understand offline payments", outcome: "I want 1 person for a recorded podcast about offline payments and digital wallets.", email: "", compensation: "25", payWith: "dough", signature: "" };
let receipt = null;
let intros = [];
let bookings = {};
let requirement = null;
let guestLinks = {};
let message = "";
let busy = false;
let pollTimer = null;
const booking = new Set();

const INTRO_STAGES = [
  ["Authorized", () => true],
  ["Guest contacted", (i) => ["outreach_sent", "responded", "accepted", "scheduling", "booked"].includes(i.status) || Boolean(i.outreachSentAt)],
  ["Guest accepted", (i) => ["accepted", "scheduling", "booked"].includes(i.status)],
  ["Booked · Jam + Studio created", (i) => i.status === "booked"]
];

function setMessage(text) { message = text || ""; const el = document.getElementById("gp-msg"); if (el) el.textContent = message; }

function localAvailability() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const pad = (n) => String(n).padStart(2, "0");
  const windows = [];
  for (let d = 1; d <= 7; d++) {
    const day = new Date(Date.now() + d * 86400000);
    const stamp = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    windows.push({ start: `${stamp}T09:00`, end: `${stamp}T18:00` });
  }
  return { timezone, windows };
}

async function loadRequestState() {
  const view = await getPeepsRequest(requestId);
  candidates = view.candidates || [];
  intros = view.introductions || [];
  receipt = await getPeepsReceipt(requestId);
  bookings = {};
  for (const intro of intros) {
    try {
      const detail = await getPeepsIntroduction(intro.id);
      intro.detail = detail;
      if (detail.booking) bookings[intro.id] = await getPeepsBooking(detail.booking.id);
    } catch { /* leave detail empty; the receipt still renders */ }
  }
  if (intros.length && !Object.keys(guestLinks).length) {
    try {
      const outbox = await studioRequest(`/api/peeps/test-outbox?requestId=${encodeURIComponent(requestId)}`);
      for (const m of outbox.messages || []) if (m.audience === "candidate" && m.testPayload?.url) guestLinks[m.introductionId] = m.testPayload.url;
    } catch { /* not in test mode: guests get a real email, nothing to show */ }
  }
}

async function agentOrchestrate() {
  // The agent books the first mutually-available time once the guest has given availability. The requester
  // authorized this in step 2; the booking is the existing idempotent /book route and can be cancelled.
  for (const intro of intros) {
    const d = intro.detail;
    if (!d || d.booking || booking.has(intro.id) || !d.availability?.windows?.length) continue;
    if (!["accepted", "scheduling"].includes(d.introduction.status)) continue;
    booking.add(intro.id);
    try { await bookPeepsIntroduction(intro.id, {}); setMessage("Peeps booked the first time that works for both of you."); }
    catch (error) { setMessage(`Peeps couldn't book yet: ${error.message}`); booking.delete(intro.id); }
  }
}

async function refresh({ orchestrate = true } = {}) {
  if (!requestId) return render();
  try {
    await loadRequestState();
    if (orchestrate) { await agentOrchestrate(); await loadRequestState(); }
    render();
  } catch (error) {
    root.innerHTML = `<section class="card"><h3>Couldn't load this request</h3><p class="muted">${esc(error.message)}</p><a class="btn" href="./golden-path.html">Start over</a></section>`;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden && !busy && requestId) refresh(); }, 6000);
}

async function act(fn, done = "") {
  busy = true; setMessage("Working…");
  try { await fn(); message = done; } catch (error) { message = error.message || "That didn't work."; }
  busy = false;
  await refresh();
}

// ---- Step 1 ----
function stepAsk() {
  return `<section class="card"><span class="eyebrow">1 · Find my Peeps</span><h3>Describe the outcome. The agent does the rest.</h3>
    <label class="muted" for="gp-who">Who do you need?</label><textarea class="field" id="gp-who">${esc(draft.who)}</textarea>
    <label class="muted" for="gp-outcome" style="display:block;margin-top:12px">What do you want to accomplish?</label><textarea class="field" id="gp-outcome">${esc(draft.outcome)}</textarea>
    <div class="actions" style="margin-top:14px"><button class="btn" id="gp-find">Find my Peeps →</button></div></section>`;
}

// ---- Step 2 ----
function stepAuthorize() {
  const external = candidates.filter((c) => c.status === "proposed");
  const needsEmail = external.some((c) => selected.has(c.id) && !c.contactEmail && c.reachability !== "claimed_member");
  const solana = requirement && !requirement.demo ? requirement.accepts?.[0] : null;
  return `<section class="card"><span class="eyebrow">2 · Authorize introductions</span><h3>The agent found ${external.length} candidate${external.length === 1 ? "" : "s"}. Nobody has been contacted.</h3>
    ${external.map((c) => `<label class="row" style="grid-template-columns:auto 1fr auto;gap:12px;cursor:pointer"><input type="checkbox" data-pick="${esc(c.id)}" ${selected.has(c.id) ? "checked" : ""}><span><strong>${esc(c.displayName)}</strong><br><span class="muted">${esc(c.headline || "")} · ${esc(c.matchReason || "")}</span></span><i class="tag">${esc(String(c.matchScore))}% fit · ${esc(String(c.reachability || "").replace(/_/g, " "))}</i></label>`).join("") || `<p class="muted">No candidates yet.</p>`}
    ${needsEmail ? `<label class="muted" for="gp-email" style="display:block;margin-top:12px">The guest's email — Peeps never guesses one. Use a second inbox of your own to play the guest.</label><input class="field" id="gp-email" type="email" value="${esc(draft.email)}" placeholder="guest@example.com">` : ""}
    <label class="muted" for="gp-comp" style="display:block;margin-top:12px">Pay each guest who joins (Dough, settled after the session)</label><input class="field" id="gp-comp" type="number" min="0" step="0.01" value="${esc(draft.compensation)}" style="max-width:200px">
    <div style="margin-top:14px"><b>Pay the $0.25 introduction fee with</b>
      <label style="display:block;margin-top:6px"><input type="radio" name="gp-pay" value="dough" ${draft.payWith === "dough" ? "checked" : ""}> Dough <span class="muted">(off-chain ledger; add Dough on the <a class="link" href="./dough.html">Dough page</a>, which can be funded with USDC on Solana)</span></label>
      <label style="display:block;margin-top:6px;${solana ? "" : "opacity:.55"}"><input type="radio" name="gp-pay" value="solana" ${draft.payWith === "solana" ? "checked" : ""} ${solana ? "" : "disabled"}> USDC on Solana <span class="muted">${solana ? "(verified on-chain by the server)" : "(not configured on this server)"}</span></label>
      ${draft.payWith === "solana" && solana ? `<div class="card" style="margin-top:8px"><p class="muted" style="margin:0 0 6px">Send exactly <b>${esc(solana.amount)} USDC</b> on <b>${esc(solana.network)}</b> to <code>${esc(solana.payTo)}</code> (mint <code>${esc(solana.tokenMint)}</code>). Include this request's reference as a read-only account on the transfer (Solana Pay <code>reference</code>): <code>${esc(solana.reference)}</code>. Then paste the transaction signature — the server confirms it on-chain before anything happens.</p><input class="field" id="gp-sig" value="${esc(draft.signature)}" placeholder="Transaction signature"></div>` : ""}</div>
    <div class="actions" style="margin-top:16px"><button class="btn" id="gp-authorize" ${selected.size ? "" : "disabled"}>Authorize introductions →</button><span class="muted">Peeps then contacts them, and — once the guest replies — books the first time that works for both of you in the next 7 days.</span></div></section>`;
}

// ---- Progress ----
function stepProgress() {
  return intros.map((intro) => {
    const d = intro.detail;
    const status = d?.introduction?.status || intro.status;
    const s = { ...intro, status, outreachSentAt: d?.introduction?.outreachSentAt || intro.outreachSentAt };
    const name = (candidates.find((c) => c.id === intro.candidateId) || {}).displayName || "Guest";
    const b = bookings[intro.id];
    const studio = b?.links?.studio;
    return `<section class="card"><span class="eyebrow">Agent progress</span><h3>${esc(name)}</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">${INTRO_STAGES.map(([label, done]) => `<i class="tag ${done(s) ? "good" : ""}">${done(s) ? "✓ " : ""}${esc(label)}</i>`).join("")}</div>
      ${status === "declined" ? `<p style="color:#8e3434">The guest declined. Nobody was charged beyond the introduction fee.</p>` : ""}
      ${["outreach_sent", "responded"].includes(status) ? `<p class="muted">Waiting for ${esc(name)} to accept via their private link${guestLinks[intro.id] ? `: <a class="link" href="${esc(guestLinks[intro.id])}" target="_blank" rel="noopener">open the guest page</a> <i class="tag">simulated outbox · test mode</i>` : " (emailed to the address you gave)"}.</p>` : ""}
      ${["accepted", "scheduling"].includes(status) ? `<p class="muted">${guestLinks[intro.id] ? `Waiting for the guest's availability: <a class="link" href="${esc(guestLinks[intro.id])}" target="_blank" rel="noopener">open the guest page</a>.` : "Waiting for the guest's availability. Peeps books automatically once it arrives."}</p>` : ""}
      ${b ? `<p class="muted">Booked for <b>${esc(b.booking?.startsAt || "—")}</b>. Jam <code>${esc(b.booking?.jamId || "")}</code> · Studio session <code>${esc(b.booking?.studioSessionId || "")}</code>. The guest gives consent on their page before they can join.</p>
        <div class="actions"><a class="btn" id="gp-join" href="${esc(studio || "#")}" target="_blank" rel="noopener">3 · Join Jam →</a><span class="muted">Opens the real Studio room.</span></div>` : ""}
    </section>`;
  }).join("");
}

// ---- Evidence & settlement (real server actions on the real Jam) ----
function stepEvidence() {
  const jam = receipt?.jam;
  if (!jam || (!Object.keys(bookings).length && jam.status !== "completed")) return "";
  const done = jam.status === "completed";
  const settled = receipt.dough.status === "settled" || receipt.dough.status === "none_due";
  return `<section class="card"><span class="eyebrow">After the session</span><h3>Capture evidence, then settle</h3>
    <p class="muted">Attendance comes from the guest's own join event in Studio; consent from their consent step. Studio doesn't store a transcript itself, so paste what was said (or leave it blank to complete without one).</p>
    <textarea class="field" id="gp-transcript" placeholder="${esc("Host: Welcome…\nGuest: Thanks for having me…")}" ${done ? "disabled" : ""}></textarea>
    <div class="actions" style="margin-top:12px"><button class="btn" id="gp-complete" ${done && receipt.evidence.transcripts.length ? "disabled" : ""}>${done ? "Re-check evidence" : "Complete Jam & generate Breadcrumbs"}</button>
    <button class="btn secondary" id="gp-settle" ${done && !settled ? "" : "disabled"}>Settle Dough</button></div></section>`;
}

// ---- Receipt ----
function stateTag(state) { return `<i class="tag ${state === "done" ? "good" : ""}">${state === "done" ? "✓ done" : state === "na" ? "n/a" : "pending"}</i>`; }
function safeExplorer(url) { return typeof url === "string" && url.startsWith("https://explorer.solana.com/tx/") ? url : ""; }
function money(e) { return `${e.currency === "USD" ? "$" : ""}${Number(e.amount).toFixed(2)}${e.currency === "USDC" ? " USDC" : ""}`; }

function receiptCard() {
  if (!receipt) return "";
  const r = receipt;
  const sol = r.solana;
  const events = sol.events.map((e) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>Introduction fee · ${esc(money(e))}</strong><br><span class="muted">${esc(e.label)}</span>
      ${e.signature ? `<br><span class="muted">Signature <code style="word-break:break-all">${esc(e.signature)}</code> · ${esc(e.network)}${e.slot ? ` · slot ${esc(e.slot)}` : ""}</span>${safeExplorer(e.explorerUrl) ? `<br><a class="link" href="${esc(safeExplorer(e.explorerUrl))}" target="_blank" rel="noopener noreferrer">View on Solana Explorer ↗</a>` : ""}` : ""}</span><i class="tag ${e.status === "onchain_verified" ? "good" : ""}">${esc(e.status.replace(/_/g, " "))}</i></div>`).join("");
  const funding = sol.doughFunding.map((f) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>Dough funded · $${Number(f.amount).toFixed(2)} ${esc(f.asset)}</strong><br><span class="muted">${esc(f.label)}</span><br><span class="muted">Signature <code style="word-break:break-all">${esc(f.signature)}</code></span>${safeExplorer(f.explorerUrl) ? `<br><a class="link" href="${esc(safeExplorer(f.explorerUrl))}" target="_blank" rel="noopener noreferrer">View on Solana Explorer ↗</a>` : ""}</span><i class="tag good">onchain verified</i></div>`).join("");
  return `<section class="card" id="gp-receipt"><span class="eyebrow">Receipt · request ${esc(r.requestId)}</span><h3>What actually happened</h3>
    <p class="muted">Lifecycle state: <b>${esc(String(r.lifecycleState).replace(/_/g, " "))}</b>${r.jam ? ` · Jam <code>${esc(r.jam.id)}</code> (${esc(r.jam.status)}) · Studio session <code>${esc(r.jam.studioSessionId || "none yet")}</code>` : ""}</p>
    ${r.checks.map((c) => `<div class="row" style="grid-template-columns:1fr auto"><span>${esc(c.label)}<br><span class="muted">${esc(c.detail)}</span></span>${stateTag(c.state)}</div>`).join("")}
    <h4 style="margin-top:18px">Candidate &amp; participants</h4>
    ${r.candidates.map((c) => `<p style="margin:4px 0"><strong>${esc(c.name)}</strong> <span class="muted">${esc(c.headline)} · ${esc(c.status.replace(/_/g, " "))}</span></p>`).join("") || `<p class="muted">None yet.</p>`}
    ${r.participants.map((p) => `<p class="muted" style="margin:4px 0">${esc(p.name)} · ${esc(p.status)} · consent ${p.consentCapturedAt ? `captured ${esc(p.consentCapturedAt)}` : "not captured"}${p.attendedAt ? ` · attended ${esc(p.attendedAt)}` : ""}</p>`).join("")}
    <h4 style="margin-top:18px">Evidence &amp; Breadcrumbs</h4>
    <p class="muted">${r.evidence.completion ? `Completion recorded via ${esc(String(r.evidence.completion.trigger).replace(/_/g, " "))}. ` : "No completion yet. "}Transcripts: ${r.evidence.transcripts.length ? r.evidence.transcripts.map((t) => `${esc(t.source.replace(/_/g, " "))} (${esc(t.segments)} segments)`).join(", ") : "none"} · Recording: ${r.evidence.recordingPresent ? "reference on file" : "none on file"}</p>
    ${r.breadcrumbs.items.map((b) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>${esc(b.kind)}</strong><br>${esc(b.statement)}<br><span class="muted">From transcript ${esc(b.provenance.transcriptId || "")} · segment ${esc(Number(b.provenance.segmentIndex) + 1)} · ${esc(b.provenance.method || "")}</span></span><i class="tag">${esc(b.status)} · ${esc(b.evidenceClass.replace(/_/g, " "))}</i></div>`).join("") || `<p class="muted">No Breadcrumbs yet — they're derived only from a stored transcript.</p>`}
    <p class="muted">${esc(r.dub.note)}</p>
    <h4 style="margin-top:18px">Money &amp; Solana</h4>
    <p class="muted">Network: ${esc(sol.network)}${sol.recipientConfigured ? "" : " · on-chain recipient not configured on this server"}</p>
    ${events || `<p class="muted">The introduction fee hasn't been paid yet.</p>`}${funding}
    <div class="row" style="grid-template-columns:1fr auto"><span><strong>Guest compensation · $${Number(r.dough.compensationOwed).toFixed(2)}</strong><br><span class="muted">Off-chain: Dough ledger, atomic debit + credit, idempotent. ${esc(r.dough.note)}</span></span><i class="tag ${r.dough.status === "settled" ? "good" : ""}">${esc(r.dough.status.replace(/_/g, " "))}</i></div>
    <p class="muted">Generated ${esc(r.generatedAt)}</p></section>`;
}

function render() {
  const stage = !requestId ? "ask" : (intros.length ? "run" : "pick");
  root.innerHTML = `${stage === "ask" ? stepAsk() : ""}${stage === "pick" ? stepAuthorize() : ""}${stage === "run" ? stepProgress() + stepEvidence() : ""}${stage !== "ask" ? receiptCard() : ""}<p class="muted" id="gp-msg">${esc(message)}</p>`;
  wire();
}

function readDraft() {
  const val = (id) => document.getElementById(id)?.value;
  if (val("gp-who") !== undefined) draft.who = val("gp-who");
  if (val("gp-outcome") !== undefined) draft.outcome = val("gp-outcome");
  if (val("gp-email") !== undefined) draft.email = val("gp-email").trim();
  if (val("gp-comp") !== undefined) draft.compensation = val("gp-comp");
  if (val("gp-sig") !== undefined) draft.signature = val("gp-sig").trim();
  const pay = document.querySelector('input[name="gp-pay"]:checked');
  if (pay) draft.payWith = pay.value;
}

function wire() {
  const on = (sel, fn) => document.querySelectorAll(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
  on("#gp-find", () => { readDraft(); act(async () => {
    const organizationId = await getPrimaryOrganizationId();
    const result = await createPeepsRequest({ organizationId, whoText: draft.who, outcomeText: draft.outcome });
    requestId = result.request.id;
    history.replaceState(null, "", `?request=${encodeURIComponent(requestId)}`);
    candidates = result.candidates || [];
    selected = new Set(candidates.slice(0, Math.max(1, result.request.workingRepresentation?.desiredCandidateCount || 1)).map((c) => c.id));
    requirement = (await getPeepsPaymentRequirement(requestId)).requirement;
    startPolling();
  }, "The agent searched and ranked candidates. Review them and authorize."); });
  on("[data-pick]", (el) => { readDraft(); el.checked ? selected.add(el.dataset.pick) : selected.delete(el.dataset.pick); render(); });
  document.querySelectorAll('input[name="gp-pay"]').forEach((el) => el.addEventListener("change", () => { readDraft(); render(); }));
  on("#gp-authorize", () => { readDraft(); act(async () => {
    const picks = [...selected].map((candidateId) => ({ candidateId, outreachEmail: draft.email || undefined }));
    const compensationAmount = Number(draft.compensation) || 0;
    let result;
    if (draft.payWith === "solana") {
      if (!draft.signature) throw new Error("Paste the Solana transaction signature first.");
      result = await authorizePeepsIntroductionsOnchain(requestId, picks, { compensationAmount, signature: draft.signature });
    } else {
      result = await authorizePeepsIntroductions(requestId, picks, { compensationAmount });
    }
    if (!result.introductions?.length) throw new Error("No introduction could be started: Peeps needs a real email for each guest it can't already reach. The fee is paid once per request, so retrying with an email won't charge you twice.");
    await setPeepsRequesterAvailability(requestId, localAvailability());
  }, "Introductions authorized. Peeps is contacting your guest."); });
  on("#gp-complete", () => { act(async () => {
    const jamId = receipt.jam.id;
    const text = document.getElementById("gp-transcript")?.value.trim();
    if (text) await submitJamTranscript(jamId, { text });
    await completeJam(jamId);
    await reconcilePeepsRequest(requestId);
  }, "Evidence captured from the real Jam."); });
  on("#gp-settle", () => { act(() => settlePeepsRequest(requestId), "Settlement attempted — see the receipt."); });
}

if (requestId) { startPolling(); getPeepsPaymentRequirement(requestId).then((r) => { requirement = r.requirement; }).catch(() => {}); refresh(); }
else render();
