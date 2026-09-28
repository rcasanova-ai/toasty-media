import { studioRequest } from "./studio-api.js";
import { applyBrandTheme, getInitialBrandTheme, normalizeBrandTheme } from "./brand-themes.js";
import { ensureOrgTheme } from "./org-brand.js";

const state={session:null,organizations:[],organization:null,role:null,sessions:[],locked:false};
const el=(id)=>document.getElementById(id);

document.addEventListener("DOMContentLoaded",init);

async function init(){
  try{
    state.session=await studioRequest("/auth/session",{method:"GET"});
    if(!state.session.authenticated){ window.top.location.href="./sessions.html"; return; }
    const branding=state.session.user?.branding||{mode:"flexible",brandId:null};
    state.locked=branding.mode==="locked";
    // Same "org id already has an inline BrandProfile" precedent as js/studio-auth.js's own openStudio —
    // no extra fetch when this IS the locked account's own /auth/session response. Everything else
    // (guest/listener/other org members visiting this dashboard) resolves via the ?brand= URL param the
    // parent shell already set, same as director.html.
    if(state.locked && branding.organizationId){
      await ensureOrgTheme(`org:${branding.organizationId}`, branding.brandProfile);
    }
    const themeId=state.locked?normalizeBrandTheme(branding.brandId):getInitialBrandTheme(window.location.search,{useStorage:true});
    // brandLink deliberately omitted: dashboard-brand is an internal nav link back to ./dashboard.html,
    // not "go to the client's marketing site" (applyBrandTheme's brandLink sets href to theme.homeUrl).
    applyBrandTheme(themeId,{root:document.body,logoImg:el("dashboardBrandLogo")});
    const orgPayload=await studioRequest("/api/organizations",{method:"GET"});
    state.organizations=orgPayload.organizations||[];
    if(!state.organizations.length){ throw new Error("No organization is available for this account."); }
    el("orgSwitcher").innerHTML=state.organizations.map(org=>`<option value="${escapeHtml(org.id)}">${escapeHtml(org.name||"Organization")}</option>`).join("");
    const requested=new URLSearchParams(window.location.search).get("org");
    const initial=state.organizations.find(org=>org.id===requested)||state.organizations[0];
    el("orgSwitcher").value=initial.id;
    el("orgSwitcher").addEventListener("change",()=>loadOrganization(el("orgSwitcher").value));
    // A locked account never sees another organization to switch to — /api/organizations already only
    // ever returns their own org (server-enforced), so this just removes the now-pointless single-option
    // control rather than leaving a select that can't actually do anything.
    if(state.locked||state.organizations.length<2){
      el("orgSwitcher").hidden=true;
      const label=document.createElement("span");
      label.className="org-switcher-label";
      label.textContent=initial.name||"Organization";
      el("orgSwitcher").insertAdjacentElement("afterend",label);
    }
    await loadOrganization(initial.id);
    el("dashboardLoading").hidden=true;
    el("dashboardApp").hidden=false;
    window.parent?.postMessage?.({type:"toasty:studio-ready",surface:"dashboard"},window.location.origin);
  }catch(error){
    el("dashboardLoading").textContent=error?.message||"Could not open Toasty.";
  }
}

async function loadOrganization(orgId){
  const orgResult=await studioRequest(`/api/organizations/${encodeURIComponent(orgId)}`,{method:"GET"});
  state.organization=orgResult.organization||{};
  state.role=orgResult.role||"member";
  const sessionResult=await studioRequest("/api/sessions",{method:"GET"}).catch(()=>({sessions:[]}));
  state.sessions=(sessionResult.sessions||[]).filter(s=>!s.organizationId||s.organizationId===orgId);
  render();
}

function render(){
  const org=state.organization||{};
  const role=String(state.role||"member").toLowerCase();
  const canAdmin=role==="owner"||role==="admin";
  const platformAdmin=Boolean(state.session?.user?.isPlatformAdmin||["owner","admin"].includes(String(state.session?.user?.platformRole||"").toLowerCase()));

  const name=org.name||"Your organization";
  el("orgName").textContent=name;
  el("orgEyebrow").textContent=name.toUpperCase();
  el("welcomeTitle").textContent=`Welcome to ${name}`;
  el("roleBadge").textContent=role;
  el("orgRole").textContent=capitalize(role);
  el("orgPlan").textContent=capitalize(org.plan||"demo");
  el("orgStatus").textContent=humanStatus(org.subscriptionStatus||"demo");
  el("planLabel").textContent=capitalize(org.plan||"demo");
  el("orgHealth").textContent=org.subscriptionStatus==="active"?"Plan active":"Usage limits enforced";
  el("platformAdminSection").hidden=!platformAdmin;
  document.querySelectorAll(".admin-only").forEach(node=>{node.hidden=!canAdmin;});
  // A locked (organization-owned) account never sees billing administration — hidden regardless of role,
  // same "hide other organizations, skins, Platform Admin, billing administration, operator controls"
  // policy this dashboard's own org-switcher hiding above already follows.
  if(el("billingLink")) el("billingLink").hidden=state.locked;

  const orgParam=`org=${encodeURIComponent(org.id)}`;
  el("settingsNav").href=`./settings.html?${orgParam}`;
  el("manageSettingsBtn").href=`./settings.html?${orgParam}`;
  el("orgAdminLink").href=`./settings.html?${orgParam}`;
  // Plan Session and the Event Growth hub must create/scope work inside the org the dashboard's own
  // switcher currently has selected — never the owner-role default resolveOrganizationForSession()
  // falls back to. There is deliberately no second org selector inside either destination page.
  el("planSessionBtn").href=`./plan.html?${orgParam}`;
  [["membersLink","members"],["billingLink","billing"],["usageLink","usage"],["aiLink","ai-providers"],["brandLink","brand-profiles"],["securityLink","security"]].forEach(([id,hash])=>{el(id).href=`./settings.html?${orgParam}#${hash}`;});

  const active=state.sessions.filter(isLive);
  const ended=state.sessions.filter(s=>String(s.status||"").toUpperCase()==="ENDED");
  const open=state.sessions.filter(s=>!isLive(s)&&String(s.status||"").toUpperCase()!=="ENDED");
  el("liveCount").textContent=String(active.length);
  el("liveDetail").textContent=active.length?`${active.length} session${active.length===1?"":"s"} active`:"No active sessions";
  el("openCount").textContent=String(open.length);
  el("endedCount").textContent=String(ended.length);

  el("livePanel").hidden=!active.length;
  el("liveSessions").innerHTML=active.slice(0,5).map(session=>sessionRow(session,true)).join("");

  const recent=[...active,...open,...ended].slice(0,6);
  el("recentSessions").innerHTML=recent.map(session=>sessionRow(session,isLive(session))).join("");
  el("sessionsEmpty").hidden=recent.length>0;

  const studioHref=studioUrl();
  ["sessionsNav","studioNav","openStudioBtn","allSessionsLink","quickSessionBtn","panelSessionBtn","focusSessionBtn"].forEach(id=>{el(id).href=studioHref;});
}

function sessionRow(session,live){
  const title=escapeHtml(session.title||"Untitled session");
  const status=escapeHtml(live?"Live now":humanStatus(session.status||"Open"));
  const href=studioUrl(session.id);
  return `<article class="session-row"><div><strong>${title}</strong><small>${status}</small></div><div class="session-actions"><a class="${live?"primary":""}" href="${href}">${live?"Resume":"Open Studio"}</a></div></article>`;
}

function studioUrl(sessionId){
  const q=new URLSearchParams();
  const current=new URLSearchParams(window.location.search);
  const brand=current.get("brand");
  const brandLocked=current.get("brandLocked");
  if(brand)q.set("brand",brand);
  if(brandLocked)q.set("brandLocked",brandLocked);
  if(sessionId)q.set("session",sessionId);
  return `./director.html${q.toString()?"?"+q.toString():""}`;
}

function isLive(session){
  const status=String(session?.status||"").toUpperCase();
  return status==="LIVE"||status==="ACTIVE"||(status==="OPEN"&&Boolean(session?.startedAt));
}
function humanStatus(value){return String(value||"").replaceAll("_"," ").replace(/\b\w/g,m=>m.toUpperCase());}
function capitalize(value){const s=String(value||"");return s?s[0].toUpperCase()+s.slice(1):"";}
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[ch]));}
