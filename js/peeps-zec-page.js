// Recipient page for confidential (shielded ZEC) settlement. The private response token in the URL is the only
// credential. Toasty never holds keys or sees the chain: you opt in with a shielded address, the requester pays from
// their own wallet, and YOUR wallet's receipt is what confirms it.
import { studioApiEndpoint } from "./studio-api.js";

const token = new URLSearchParams(location.search).get("token") || "";
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function call(action, body) {
  const response = await fetch(`${studioApiEndpoint()}/api/peeps/respond/${encodeURIComponent(token)}/${action}`, {
    method: body === undefined ? "GET" : "POST", credentials: "omit", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {}; try { data = await response.json(); } catch { /* empty */ }
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function say(text, state) { const el = $("zcMsg"); if (el) { el.textContent = text || ""; el.dataset.s = state || ""; el.hidden = !text; } }

async function render() {
  let info;
  try { info = await call("zec"); } catch (error) { $("zcLoading").innerHTML = `<h1>Not available</h1><p class="muted">${esc(error.message)}</p>`; return; }
  const s = info.settlement;
  let html = `<h1>Confidential payment</h1><p class="muted">Network: <b>${esc(info.networkLabel)}</b>. Optional, private and never automatic.</p>`;
  if (!info.optedIn) {
    html += `<p>Share a <b>shielded</b> ${esc(info.network)} address (not a transparent one). It is shown only to the requester, and only after they approve a payment. Toasty never holds your keys.</p>
      <label>Shielded address<textarea id="zcAddr" rows="3" autocomplete="off"></textarea></label>
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:600"><input id="zcConsent" type="checkbox" style="width:22px;min-height:22px"> <span>I want to be paid confidentially in ZEC for this conversation.</span></label>
      <button class="button" id="zcOptIn" style="margin-top:14px;width:100%">Opt in</button>`;
  } else if (!s) {
    html += `<p class="ok">✓ You've opted in. Waiting for the requester to start a confidential settlement.</p>`;
  } else {
    html += `<p><b>${esc(s.label)}</b> <span class="muted">· reference <code>${esc(s.ref)}</code></span></p>`;
    if (["SUBMITTED", "AWAITING_RECIPIENT_CONFIRMATION"].includes(s.state)) {
      html += `<p>The requester says they've sent your payment. Check <b>your own wallet</b>. When the shielded payment has arrived, confirm it here with what your wallet shows:</p>
        <p class="muted">Expected memo <code>${esc(s.expect.memo)}</code> · expected amount <code>${esc(s.expect.amountZat)}</code> zatoshis · confirmation code <code>${esc(s.confirmationCode)}</code></p>
        <label>Transaction id from your wallet<input id="zcTx" autocomplete="off" maxlength="64"></label>
        <label>Amount received (zatoshis)<input id="zcAmt" inputmode="numeric" value="${esc(s.expect.amountZat)}"></label>
        <label>Memo shown in your wallet<input id="zcMemo" value="${esc(s.expect.memo)}"></label>
        <button class="button" id="zcConfirm" style="margin-top:14px;width:100%">Confirm my wallet received it</button>`;
    } else if (s.state === "VERIFIED") {
      html += `<p class="ok">✓ Confirmed. Your compensation is settled confidentially. Only an opaque reference is kept.</p>`;
    }
  }
  html += `<p class="msg" id="zcMsg" role="status" hidden></p>`;
  $("zcBody").innerHTML = html; $("zcLoading").hidden = true; $("zcBody").hidden = false;
  $("zcOptIn")?.addEventListener("click", async () => {
    try { await call("zec-address", { address: $("zcAddr").value.trim(), consent: $("zcConsent").checked }); await render(); }
    catch (error) { say(error.message, "error"); }
  });
  $("zcConfirm")?.addEventListener("click", async () => {
    try { await call("zec-confirm", { ref: s.ref, code: s.confirmationCode, memo: $("zcMemo").value.trim(), amountZat: Number($("zcAmt").value), txid: $("zcTx").value.trim() }); await render(); }
    catch (error) { say(error.message, "error"); }
  });
}

if (!token) { $("zcLoading").innerHTML = `<h1>This link isn't valid</h1>`; } else render();
