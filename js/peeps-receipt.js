// The request receipt, rendered from GET /api/peeps/requests/:id/receipt. Read-only: every status, signature and amount comes
// from the server and is labelled by what it really is (simulated demo credit, off-chain Dough ledger, ONCHAIN VERIFIED
// Solana, confidential Zcash). The browser never claims payment, consent, attendance or settlement itself.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_TAG = { onchain_verified: "ONCHAIN VERIFIED", ledger_posted: "OFFCHAIN", simulated: "SIMULATED" };
function stateTag(state) { return `<i class="tag ${state === "done" ? "good" : ""}">${state === "done" ? "✓ DONE" : state === "na" ? "N/A" : "PENDING"}</i>`; }
const EXPLORER_PREFIXES = ["https://explorer.solana.com/tx/", "https://sepolia.basescan.org/tx/", "https://basescan.org/tx/"];
function safeExplorer(url) { return typeof url === "string" && EXPLORER_PREFIXES.some((prefix) => url.startsWith(prefix)) ? url : ""; }
const explorerName = (url) => (url.includes("basescan") ? "Base" : "Solana");
function money(e) { return `${e.currency === "USD" ? "$" : ""}${Number(e.amount).toFixed(2)}${e.currency === "USDC" ? " USDC" : ""}`; }

export function receiptCard(r) {
  if (!r) return "";
  const sol = r.solana;
  const events = sol.events.map((e) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>Introduction fee · ${esc(money(e))}</strong><br><span class="muted">${esc(e.label)}</span>
      ${e.signature ? `<br><span class="muted">Signature <code style="word-break:break-all">${esc(e.signature)}</code> · ${esc(e.network)}${e.slot ? ` · slot ${esc(e.slot)}` : ""}</span>${safeExplorer(e.explorerUrl) ? `<br><a class="link" href="${esc(safeExplorer(e.explorerUrl))}" target="_blank" rel="noopener noreferrer">View on ${explorerName(safeExplorer(e.explorerUrl))} Explorer ↗</a>` : ""}` : ""}</span><i class="tag ${e.status === "onchain_verified" ? "good" : ""}">${esc(STATUS_TAG[e.status] || e.status.replace(/_/g, " ").toUpperCase())}</i></div>`).join("");
  const funding = sol.doughFunding.map((f) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>Dough funded · $${Number(f.amount).toFixed(2)} ${esc(f.asset)}</strong><br><span class="muted">${esc(f.label)}</span><br><span class="muted">Signature <code style="word-break:break-all">${esc(f.signature)}</code></span>${safeExplorer(f.explorerUrl) ? `<br><a class="link" href="${esc(safeExplorer(f.explorerUrl))}" target="_blank" rel="noopener noreferrer">View on ${explorerName(safeExplorer(f.explorerUrl))} Explorer ↗</a>` : ""}</span><i class="tag good">ONCHAIN VERIFIED</i></div>`).join("");
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
    ${r.dough.fundingSources ? `<div class="row" style="grid-template-columns:1fr auto"><span><strong>Dough balance source</strong><br><span class="muted">${esc(r.dough.fundingSources.label)}</span></span><i class="tag">${r.dough.fundingSources.demoFunded ? "SIMULATED" : "LEDGER"}</i></div>` : ""}
    <div class="row" style="grid-template-columns:1fr auto"><span><strong>Guest compensation · $${Number(r.dough.compensationOwed).toFixed(2)}</strong><br><span class="muted">${r.dough.items.length && r.dough.items.every((i) => i.rail === "zcash_confidential") ? "Settled on the confidential ZEC rail (below), not the Dough ledger." : `${esc(r.dough.items[0]?.railLabel || "Off-chain Dough ledger")}: atomic debit + credit, idempotent. ${esc(r.dough.note)}`}</span></span><i class="tag ${r.dough.status === "settled" ? "good" : ""}">${r.dough.items.length && r.dough.items.every((i) => i.rail === "zcash_confidential") ? "PAID VIA ZEC (SEE BELOW)" : `DOUGH: OFFCHAIN LEDGER ${r.dough.status === "settled" ? "SETTLED" : esc(r.dough.status.replace(/_/g, " ").toUpperCase())}`}</i></div>
    ${(r.zcash?.settlements || []).map((z) => `<div class="row" style="grid-template-columns:1fr auto"><span><strong>Confidential ZEC settlement · $${Number(z.doughObligation).toFixed(2)} obligation</strong><br><span class="muted">${z.verified ? "ZCASH: CONFIDENTIAL SETTLEMENT VERIFIED by the recipient's own wallet" : esc(z.label)} · ${esc(z.networkLabel)} · ref <code>${esc(z.ref)}</code><br>${esc(r.zcash.privacy)}</span></span><i class="tag ${z.verified ? "good" : ""}">${z.verified ? "VERIFIED CONFIDENTIAL" : esc(z.state.replace(/_/g, " "))}</i></div>`).join("")}
    <p class="muted">Generated ${esc(r.generatedAt)}</p></section>`;
}


export function zecCard(receipt, zecInstructions = {}) {
  const z = receipt?.zcash;
  if (!z?.enabled) return "";
  const p = receipt.participants.find((x) => ["attended", "completed"].includes(x.status));
  if (!p) return "";
  const mine = z.settlements.filter((x) => x.state !== "FAILED").at(-1);
  const lastFailed = z.settlements.filter((x) => x.state === "FAILED").at(-1);
  const inst = mine && zecInstructions[mine.ref];
  let body;
  if (!mine) body = `<p class="muted">Pay ${esc(p.name)} confidentially in shielded ZEC instead of the Dough ledger. Optional. ${lastFailed ? `The last attempt failed (${esc(lastFailed.failureReason || "failed")}); you can retry.` : ""}</p>
    <label class="muted" for="gp-zat">Amount agreed, in zatoshis (1 ZEC = 100,000,000)</label><input class="field" id="gp-zat" type="number" min="1" value="100000" style="max-width:220px">
    <div class="actions"><button class="btn secondary" id="gp-zec-create" data-pid="${esc(p.participantId)}">Settle confidentially in ZEC</button></div>`;
  else if (mine.state === "PENDING") body = `<p class="muted">Waiting for ${esc(p.name)} to opt in on their private page (they were offered it after booking). Nothing is paid until you approve.</p>`;
  else if (mine.state === "AWAITING_APPROVAL") body = inst
    ? `<p><b>Pay from your own wallet</b> (${esc(mine.networkLabel)}). Toasty never moves your funds.</p><p class="muted">Address <code style="word-break:break-all">${esc(inst.address)}</code><br>Amount <code>${esc(inst.amountZat)}</code> zatoshis<br>Memo <code>${esc(inst.memo)}</code></p>
       <label class="muted" for="gp-ztx">Transaction id from your wallet, once sent</label><input class="field" id="gp-ztx" maxlength="64">
       <div class="actions"><button class="btn secondary" id="gp-zec-submit" data-ref="${esc(mine.ref)}">I sent it</button> <button class="btn secondary" id="gp-zec-fail" data-ref="${esc(mine.ref)}">It failed</button></div>`
    : `<p class="muted">${esc(p.name)} opted in. Approve to reveal the payment instructions (shown only to you).</p><div class="actions"><button class="btn secondary" id="gp-zec-approve" data-ref="${esc(mine.ref)}">Approve shielded payment</button></div>`;
  else if (["SUBMITTED", "AWAITING_RECIPIENT_CONFIRMATION"].includes(mine.state)) body = `<p class="muted">Submitted. Settlement is complete only when ${esc(p.name)}'s own wallet confirms receipt.</p><div class="actions"><button class="btn secondary" id="gp-zec-fail" data-ref="${esc(mine.ref)}">Mark failed</button></div>`;
  else body = `<p>✓ <b>VERIFIED CONFIDENTIAL SETTLEMENT</b> (${esc(mine.networkLabel)})</p>`;
  return `<section class="card"><span class="eyebrow">Optional · confidential settlement</span><h3>Pay in shielded ZEC</h3>${body}</section>`;
}
