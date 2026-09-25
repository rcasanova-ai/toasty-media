import { studioRequest } from "./studio-api.js";

const statusRoot = document.getElementById("platformStatus");
const orgBody = document.getElementById("platformOrganizations");
const message = document.getElementById("platformMessage");

function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));}
function setMessage(text, bad=false){message.textContent=text||"";message.style.color=bad?"#ff9a9a":"";}

async function load(){
  try{
    const session = await studioRequest("/auth/session");
    if(!session.authenticated || !session.user?.isPlatformAdmin) throw new Error("Platform administrator access is required.");
    const [status, orgs] = await Promise.all([
      studioRequest("/api/platform/status"),
      studioRequest("/api/platform/organizations")
    ]);
    renderStatus(status);
    renderOrganizations(orgs.organizations||[]);
  }catch(error){
    statusRoot.innerHTML=`<div class="settings-card"><h2>Access unavailable</h2><p class="hint">${esc(error.message)}</p></div>`;
    orgBody.innerHTML="";
  }
}

function renderStatus(status){
  const deepseek=status.providers?.deepseek||{};
  const anthropic=status.providers?.anthropic||{};
  statusRoot.innerHTML=`
    <div class="settings-card"><h2>Role</h2><strong>Platform Admin</strong><p class="hint">Founder/operator privileges active.</p></div>
    <div class="settings-card"><h2>DeepSeek</h2><strong>${deepseek.configured?"Configured":"Not configured"}</strong><p class="hint">${esc(deepseek.model||"")}</p></div>
    <div class="settings-card"><h2>Founder AI</h2><strong>${status.founderAiFallback?"Enabled":"Unavailable"}</strong><p class="hint">Your server DeepSeek key is available only to platform-admin requests when an org has no BYOK key.</p></div>
    <div class="settings-card"><h2>Safety</h2><strong>${Object.values(status.safetySwitches||{}).filter(Boolean).length} enabled</strong><p class="hint">Cost switches remain server-controlled.</p></div>
  `;
}

function renderOrganizations(orgs){
  orgBody.innerHTML=orgs.map(org=>`
    <tr>
      <td><strong>${esc(org.name)}</strong><br><small>${esc(org.slug||org.id)}</small></td>
      <td>
        <select data-plan="${esc(org.id)}">
          ${["demo","creator","pro","enterprise"].map(p=>`<option value="${p}" ${p===org.plan?"selected":""}>${p}</option>`).join("")}
        </select>
      </td>
      <td>
        <select data-status="${esc(org.id)}">
          ${["none","trialing","active","past_due","canceled"].map(s=>`<option value="${s}" ${s===org.subscriptionStatus?"selected":""}>${s}</option>`).join("")}
        </select>
      </td>
      <td>${Number(org.memberCount||0)}</td>
      <td>
        <button class="btn primary" data-save="${esc(org.id)}" type="button">Apply</button>
        <button class="btn" data-reset="${esc(org.id)}" type="button">Reset usage</button>
      </td>
    </tr>
  `).join("");

  orgBody.querySelectorAll("[data-save]").forEach(btn=>btn.addEventListener("click",()=>savePlan(btn.dataset.save)));
  orgBody.querySelectorAll("[data-reset]").forEach(btn=>btn.addEventListener("click",()=>resetUsage(btn.dataset.reset)));
}

async function savePlan(id){
  const plan=orgBody.querySelector(`[data-plan="${CSS.escape(id)}"]`).value;
  const subscriptionStatus=orgBody.querySelector(`[data-status="${CSS.escape(id)}"]`).value;
  try{
    setMessage("Applying…");
    await studioRequest(`/api/platform/organizations/${encodeURIComponent(id)}/plan`,{method:"POST",body:JSON.stringify({plan,subscriptionStatus})});
    setMessage("Organization plan updated.");
    await load();
  }catch(error){setMessage(error.message,true);}
}

async function resetUsage(id){
  if(!window.confirm("Reset all usage counters for this organization?")) return;
  try{
    setMessage("Resetting…");
    await studioRequest(`/api/platform/organizations/${encodeURIComponent(id)}/reset-usage`,{method:"POST",body:"{}"});
    setMessage("Usage counters reset.");
  }catch(error){setMessage(error.message,true);}
}

load();
