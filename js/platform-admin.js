import { studioRequest } from "./studio-api.js";

const state={session:null,status:null,organizations:[],organizationId:null,detail:null,panel:"overview"};
const $=(id)=>document.getElementById(id);
const esc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
const pretty=(v)=>JSON.stringify(v??{},null,2);
const post=(path,body={})=>studioRequest(path,{method:"POST",body:JSON.stringify(body)});
const orgPath=(suffix="")=>"/api/organizations/platform-admin/organizations/"+encodeURIComponent(state.organizationId)+suffix;

function setMessage(text,bad=false){const el=$("platformMessage");el.textContent=text||"";el.classList.toggle("is-error",bad);}
function human(v){return String(v||"").replaceAll("_"," ").replace(/\b\w/g,m=>m.toUpperCase());}
function shortDate(v){if(!v)return "—";try{return new Date(v).toLocaleString();}catch{return String(v);}}
function formatBytes(n){n=Number(n)||0;if(n<1024)return n+" B";if(n<1024**2)return (n/1024).toFixed(1)+" KB";if(n<1024**3)return (n/1024**2).toFixed(1)+" MB";return (n/1024**3).toFixed(1)+" GB";}
function parseJson(id){try{return JSON.parse($(id).value||"{}");}catch{throw new Error(id.replace(/^pa/,"")+" must contain valid JSON.");}}
function memberById(id){return (state.detail?.members||[]).find(m=>m.userId===id);}
function fillSelect(id,values,current){$(id).innerHTML=values.map(v=>'<option value="'+esc(v)+'" '+(v===current?'selected':'')+'>'+esc(human(v))+'</option>').join("");}

document.addEventListener("DOMContentLoaded",init);

async function init(){
  try{
    state.session=await studioRequest("/auth/session");
    if(!state.session.authenticated||!state.session.user?.isPlatformAdmin)throw new Error("Platform administrator access is required.");
    const pair=await Promise.all([
      studioRequest("/api/organizations/platform-admin/status"),
      studioRequest("/api/organizations/platform-admin/organizations")
    ]);
    state.status=pair[0];state.organizations=pair[1].organizations||[];
    const requested=new URLSearchParams(location.search).get("org");
    state.organizationId=state.organizations.some(o=>o.id===requested)?requested:(state.organizations[0]?.id||null);
    renderSwitcher();bindStatic();
    if(!state.organizationId)throw new Error("No organizations exist yet.");
    await loadDetail();
    $("platformLoading").hidden=true;$("platformApp").hidden=false;
  }catch(error){$("platformLoading").innerHTML="<h2>Platform Admin unavailable</h2><p class='hint'>"+esc(error.message)+"</p>";}
}

function renderSwitcher(){
  const select=$("platformOrgSwitcher");
  select.innerHTML=state.organizations.map(o=>'<option value="'+esc(o.id)+'" '+(o.id===state.organizationId?'selected':'')+'>'+esc(o.name)+" · "+esc(o.plan)+'</option>').join("");
  select.onchange=async()=>{
    state.organizationId=select.value;
    const url=new URL(location.href);url.searchParams.set("org",state.organizationId);history.replaceState({},"",url);
    await loadDetail();
  };
}

function bindStatic(){
  document.querySelectorAll(".platform-nav-btn").forEach(btn=>btn.addEventListener("click",()=>selectPanel(btn.dataset.panel)));
  $("paSaveAccount").onclick=saveAccountControls;$("paResetUsage").onclick=resetUsage;$("paSaveOrg").onclick=saveOrganization;
  $("paSaveDefaults").onclick=saveDefaults;$("paSaveBilling").onclick=saveBilling;$("paNewBrand").onclick=()=>renderBrandEditor(null,true);
  $("paInviteMember").onclick=inviteMember;$("paSaveAiKey").onclick=saveAiKey;
}

function selectPanel(panel){
  state.panel=panel;
  document.querySelectorAll(".platform-nav-btn").forEach(b=>b.classList.toggle("is-active",b.dataset.panel===panel));
  document.querySelectorAll(".platform-panel").forEach(p=>p.classList.toggle("is-active",p.dataset.panelView===panel));
}

async function loadDetail(){
  setMessage("Loading organization…");
  state.detail=await studioRequest(orgPath("/detail"));
  setMessage("");renderAll();
}

function renderAll(){
  const d=state.detail,o=d.organization,s=d.settings||{};
  $("platformOrgName").textContent=o.name||"Organization";
  $("platformOrgMeta").textContent=(o.slug||o.id)+" · "+human(o.plan)+" · "+human(o.subscriptionStatus)+" · "+d.members.length+" member"+(d.members.length===1?"":"s");
  $("platformOpenCustomerDashboard").href="./dashboard.html?org="+encodeURIComponent(o.id);

  renderPlatformStatus();
  fillSelect("paPlan",["demo","creator","pro","enterprise"],o.plan);
  fillSelect("paSubscription",["none","trialing","active","past_due","canceled"],o.subscriptionStatus);
  $("paOnboarding").value=s.onboardingCompletedAt?"complete":"reset";
  $("paActiveBrand").innerHTML='<option value="">No active profile</option>'+d.brandProfiles.map(b=>'<option value="'+esc(b.id)+'" '+(b.id===o.activeBrandProfileId?'selected':'')+'>'+esc(b.name)+'</option>').join("");

  $("paOrgName").value=o.name||"";$("paOrgSlug").value=o.slug||"";$("paWebsite").value=s.websiteUrl||"";$("paBooking").value=s.bookingUrl||"";
  $("paSupportEmail").value=s.supportEmail||"";$("paTimezone").value=s.timezone||"UTC";
  $("paDefaultSession").value=pretty(s.defaultSessionSettings);$("paDefaultCTA").value=pretty(s.defaultCTA);$("paDefaultEndCard").value=pretty(s.defaultEndCard);
  $("paSocialLinks").value=pretty(s.socialLinks);$("paDomainConfig").value=pretty(s.customDomainConfig);

  renderMembers();renderBrands();renderAi();renderSessions();renderUsage();renderBilling();
}

function renderPlatformStatus(){
  const ps=state.status||{},d=state.detail,o=d.organization;
  $("platformStatus").innerHTML=
    '<div class="settings-card"><h2>Platform role</h2><strong>Platform Admin</strong><p class="hint">Server-authoritative founder/operator access.</p></div>'+
    '<div class="settings-card"><h2>DeepSeek</h2><strong>'+(ps.providers?.deepseek?.configured?"Configured":"Not configured")+'</strong><p class="hint">'+esc(ps.providers?.deepseek?.model||"")+'</p></div>'+
    '<div class="settings-card"><h2>Organization</h2><strong>'+esc(human(o.plan))+'</strong><p class="hint">'+esc(human(o.subscriptionStatus))+'</p></div>'+
    '<div class="settings-card"><h2>AI configuration</h2><strong>'+d.aiProviders.filter(x=>x.status==="active").length+' active BYOK</strong><p class="hint">Secrets are never exposed.</p></div>';
}

function renderMembers(){
  $("paMembers").innerHTML=(state.detail.members||[]).map(m=>
    '<tr><td><strong>'+esc(m.userName||"User")+'</strong><br><small>'+esc(m.userEmail||m.userId)+'</small></td>'+
    '<td><select data-member-role="'+esc(m.userId)+'">'+["viewer","member","admin","owner"].map(r=>'<option value="'+r+'" '+(r===m.role?'selected':'')+'>'+human(r)+'</option>').join("")+'</select></td>'+
    '<td><select data-member-status="'+esc(m.userId)+'"><option value="active" '+(m.userStatus==="active"?'selected':'')+'>Active</option><option value="suspended" '+(m.userStatus==="suspended"?'selected':'')+'>Suspended</option></select></td>'+
    '<td class="platform-row-actions"><button class="btn" data-save-member="'+esc(m.userId)+'" type="button">Save</button><button class="btn" data-remove-member="'+esc(m.userId)+'" type="button">Remove</button></td></tr>'
  ).join("");
  document.querySelectorAll("[data-save-member]").forEach(b=>b.onclick=()=>saveMember(b.dataset.saveMember));
  document.querySelectorAll("[data-remove-member]").forEach(b=>b.onclick=()=>removeMember(b.dataset.removeMember));
}

async function saveMember(userId){
  const role=document.querySelector('[data-member-role="'+CSS.escape(userId)+'"]').value;
  const status=document.querySelector('[data-member-status="'+CSS.escape(userId)+'"]').value;
  try{setMessage("Updating member…");await post(orgPath("/member-role"),{userId,role});await post(orgPath("/member-status"),{userId,status});await loadDetail();setMessage("Member updated.");}catch(e){setMessage(e.message,true);}
}
async function removeMember(userId){
  const m=memberById(userId);if(!confirm("Remove "+(m?.userEmail||"this member")+" from this organization?"))return;
  try{await post(orgPath("/member-remove"),{userId});await loadDetail();setMessage("Member removed.");}catch(e){setMessage(e.message,true);}
}

function renderBrands(){
  const root=$("paBrands");root.innerHTML="";
  (state.detail.brandProfiles||[]).forEach(b=>renderBrandEditor(b,false));
  if(!state.detail.brandProfiles?.length)root.innerHTML='<p class="hint">No BrandProfiles yet.</p>';
}

function renderBrandEditor(brand,isNew){
  const root=$("paBrands");if(isNew&&root.querySelector("[data-new-brand]"))return;
  const id=brand?.id||"",wrap=document.createElement("div");wrap.className="brand-admin-card";if(isNew)wrap.dataset.newBrand="1";
  wrap.innerHTML='<div class="form-grid two"><label>Name<input data-brand-name value="'+esc(brand?.name||"New Brand")+'"></label><label>Base theme<input data-brand-theme value="'+esc(brand?.baseThemeId||"toasty")+'"></label></div>'+
    '<label>Overrides JSON<textarea data-brand-overrides>'+esc(pretty(brand?.overrides||{}))+'</textarea></label>'+
    '<div class="button-row"><button class="btn primary" data-brand-save type="button">'+(isNew?"Create":"Save")+'</button>'+
    (isNew?'<button class="btn" data-brand-cancel type="button">Cancel</button>':'<button class="btn" data-brand-delete type="button">Delete</button>')+'</div>';
  wrap.querySelector("[data-brand-save]").onclick=async()=>{try{const overrides=JSON.parse(wrap.querySelector("[data-brand-overrides]").value||"{}");await post(orgPath("/brand-profile"),{id:id||undefined,name:wrap.querySelector("[data-brand-name]").value,baseThemeId:wrap.querySelector("[data-brand-theme]").value,overrides});await loadDetail();setMessage(isNew?"Brand profile created.":"Brand profile updated.");}catch(e){setMessage(e.message,true);}};
  const cancel=wrap.querySelector("[data-brand-cancel]");if(cancel)cancel.onclick=()=>wrap.remove();
  const del=wrap.querySelector("[data-brand-delete]");if(del)del.onclick=async()=>{if(!confirm("Delete this BrandProfile?"))return;try{await post(orgPath("/brand-profile-delete"),{id});await loadDetail();setMessage("Brand profile deleted.");}catch(e){setMessage(e.message,true);}};
  if(isNew)root.prepend(wrap);else root.append(wrap);
}

function renderAi(){
  const all=["deepseek","openai","anthropic","gemini"],byProvider=new Map((state.detail.aiProviders||[]).map(x=>[x.provider,x]));
  $("paAiProviders").innerHTML=all.map(provider=>{const c=byProvider.get(provider);return '<div class="platform-row"><div><strong>'+human(provider)+'</strong><br><small>'+(c?(human(c.status)+" · key ending "+esc(c.keyLast4||"????")):"No customer key configured")+'</small></div><div class="platform-row-actions">'+(c?'<button class="btn" data-ai-action="'+(c.status==="active"?"revoke":"activate")+'" data-provider="'+provider+'">'+(c.status==="active"?"Revoke":"Activate")+'</button><button class="btn" data-ai-action="delete" data-provider="'+provider+'">Delete</button>':"")+'</div></div>';}).join("");
  document.querySelectorAll("[data-ai-action]").forEach(b=>b.onclick=()=>aiAction(b.dataset.provider,b.dataset.aiAction));
}
async function aiAction(provider,action){if(action==="delete"&&!confirm("Delete the saved "+provider+" credential? This cannot be undone."))return;try{await post(orgPath("/ai-providers/"+encodeURIComponent(provider)+"/"+action));await loadDetail();setMessage(human(provider)+" updated.");}catch(e){setMessage(e.message,true);}}

function renderSessions(){
  $("paSessions").innerHTML=(state.detail.sessions||[]).map(s=>{const owner=memberById(s.ownerUserId),ended=String(s.status).toUpperCase()==="ENDED";return '<tr><td><strong>'+esc(s.title||"Untitled session")+'</strong><br><small>'+esc(s.id)+'</small></td><td>'+esc(human(s.status))+'</td><td>'+esc(shortDate(s.createdAt))+'</td><td>'+esc(owner?.userEmail||s.ownerUserId||"—")+'</td><td>'+(ended?"—":'<button class="btn" data-end-session="'+esc(s.id)+'">End session</button>')+'</td></tr>';}).join("")||'<tr><td colspan="5">No sessions.</td></tr>';
  document.querySelectorAll("[data-end-session]").forEach(b=>b.onclick=()=>endSession(b.dataset.endSession));
}
async function endSession(id){if(!confirm("End this session from Platform Admin?"))return;try{await post(orgPath("/sessions/"+encodeURIComponent(id)+"/end"));await loadDetail();setMessage("Session ended.");}catch(e){setMessage(e.message,true);}}

function metric(label,value,detail=""){return '<div class="settings-card"><h2>'+esc(label)+'</h2><strong>'+esc(value)+'</strong><p class="hint">'+esc(detail)+'</p></div>';}
function renderUsage(){
  const u=state.detail.usage||{},m=u.month||{},t=u.today||{},limits=state.detail.limits||{};
  $("paUsageCards").innerHTML=[
    metric("Sessions today",t.sessionsCreated||0,"Limit "+(limits.maxSessionsPerDay??"—")),
    metric("AI requests this month",m.aiRequests||0,"Organization usage"),
    metric("Recording minutes",Number(m.recordingMinutes||0).toFixed(1),"Limit "+(limits.maxRecordingMinutes??"—")+" per recording"),
    metric("Uploads this month",formatBytes(m.uploadsBytes||0),"Limit "+formatBytes(limits.maxUploadsBytesPerMonth||0))
  ].join("");
  $("paSafety").innerHTML=Object.entries(state.detail.safety||{}).map(([k,v])=>'<div class="platform-row"><strong>'+esc(human(k))+'</strong><span>'+(v?"Enabled":"Disabled")+'</span></div>').join("");
}

function renderBilling(){
  const b=state.detail.billingAccount||{};$("paBillingEmail").value=b.billingEmail||"";$("paCurrency").value=b.currency||"usd";$("paPaymentMethod").value=b.preferredPaymentMethod||"";
  $("paStripeCustomer").textContent=b.stripeCustomerId?"Stripe customer: "+b.stripeCustomerId:"No Stripe customer attached.";
  $("paSubscriptions").innerHTML=(state.detail.subscriptions||[]).map(s=>'<div class="platform-row"><div><strong>'+esc(human(s.plan))+" · "+esc(human(s.status))+'</strong><br><small>'+esc(s.provider)+" · "+esc(shortDate(s.currentPeriodStart))+" → "+esc(shortDate(s.currentPeriodEnd))+'</small></div><span>'+(s.cancelAtPeriodEnd?"Cancels at period end":"Active schedule")+'</span></div>').join("")||'<p class="hint">No subscription records.</p>';
  $("paPaymentIntents").innerHTML=(state.detail.paymentIntents||[]).slice(0,25).map(p=>'<div class="platform-row"><div><strong>'+esc(human(p.status))+" · "+esc(p.plan)+'</strong><br><small>'+esc(p.provider)+" / "+esc(p.asset)+" · "+esc(shortDate(p.createdAt))+'</small></div><span>'+esc(String(p.fiatReferenceAmount??""))+'</span></div>').join("")||'<p class="hint">No payment intents.</p>';
}

async function saveAccountControls(){try{setMessage("Saving account controls…");await post(orgPath("/plan"),{plan:$("paPlan").value,subscriptionStatus:$("paSubscription").value});await post(orgPath("/basics"),{activeBrandProfileId:$("paActiveBrand").value||null});await post(orgPath("/onboarding"),{completed:$("paOnboarding").value==="complete"});await refreshOrganizations();await loadDetail();setMessage("Account controls saved.");}catch(e){setMessage(e.message,true);}}
async function resetUsage(){if(!confirm("Reset every usage counter for this organization?"))return;try{await post(orgPath("/reset-usage"),{});await loadDetail();setMessage("Usage counters reset.");}catch(e){setMessage(e.message,true);}}
async function saveOrganization(){try{setMessage("Saving organization…");await post(orgPath("/basics"),{name:$("paOrgName").value,slug:$("paOrgSlug").value});await post(orgPath("/settings"),{websiteUrl:$("paWebsite").value,bookingUrl:$("paBooking").value,supportEmail:$("paSupportEmail").value,timezone:$("paTimezone").value});await refreshOrganizations();await loadDetail();setMessage("Organization updated.");}catch(e){setMessage(e.message,true);}}
async function saveDefaults(){try{await post(orgPath("/settings"),{defaultSessionSettings:parseJson("paDefaultSession"),defaultCTA:parseJson("paDefaultCTA"),defaultEndCard:parseJson("paDefaultEndCard"),socialLinks:parseJson("paSocialLinks"),customDomainConfig:parseJson("paDomainConfig")});await loadDetail();setMessage("Organization defaults updated.");}catch(e){setMessage(e.message,true);}}
async function saveBilling(){try{await post(orgPath("/billing-account"),{billingEmail:$("paBillingEmail").value,currency:$("paCurrency").value,preferredPaymentMethod:$("paPaymentMethod").value});await loadDetail();setMessage("Billing account updated.");}catch(e){setMessage(e.message,true);}}
async function refreshOrganizations(){const orgs=await studioRequest("/api/organizations/platform-admin/organizations");state.organizations=orgs.organizations||[];renderSwitcher();}


async function inviteMember(){
  const email=$("paInviteEmail").value.trim(),role=$("paInviteRole").value;
  try{
    await post(orgPath("/member-invite"),{email,role});
    $("paInviteEmail").value="";
    setMessage("Invitation sent.");
  }catch(e){setMessage(e.message,true);}
}

async function saveAiKey(){
  const provider=$("paAiProvider").value,apiKey=$("paAiKey").value.trim();
  try{
    await post(orgPath("/ai-provider-save"),{provider,apiKey});
    $("paAiKey").value="";
    await loadDetail();
    setMessage(human(provider)+" key saved.");
  }catch(e){setMessage(e.message,true);}
}
