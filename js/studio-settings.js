import { studioRequest } from "./studio-api.js";

const state = {
  organizations: [],
  currentOrgId: null,
  role: null,
  aiProviders: ["openai", "anthropic", "deepseek", "gemini"],
  aiProviderLabels: { openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek", gemini: "Gemini" }
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  [
    "loadingState", "settingsApp", "orgSwitcher", "signOutBtn",
    "orgForm", "orgName", "orgSlug", "orgPlanBadge", "orgStatusBadge", "orgMessage",
    "inviteForm", "inviteEmail", "inviteRole", "inviteMessage", "membersBody", "membersEmpty",
    "pendingInvitesCard", "pendingInvitesBody",
    "billingPlanBadge", "billingStatusBadge", "billingPortalBtn", "stripeMessage",
    "solanaIntentForm", "solanaPlan", "solanaTerm", "solanaAsset", "solanaCreateBtn",
    "solanaReference", "solanaAmount", "solanaRecipient", "solanaNetwork", "solanaExpiry",
    "solanaSignature", "solanaConfirmBtn", "solanaMessage",
    "aiProvidersList",
    "brandProfileForm", "brandProfileName", "brandProfileTheme", "brandProfileMessage",
    "brandProfilesBody", "brandProfilesEmpty",
    "changePasswordForm", "currentPassword", "newPassword", "passwordMessage"
  ].forEach((id) => { els[id] = document.getElementById(id); });

  const session = await studioRequest("/auth/session", { method: "GET" }).catch(() => ({ authenticated: false }));
  if (!session.authenticated) {
    window.location.href = "./sessions.html";
    return;
  }

  document.querySelectorAll(".settings-nav button").forEach((btn) => {
    btn.addEventListener("click", () => selectPanel(btn.dataset.panel));
  });
  els.signOutBtn.addEventListener("click", signOut);
  els.orgSwitcher.addEventListener("change", () => { setCurrentOrg(els.orgSwitcher.value); });
  els.orgForm.addEventListener("submit", saveOrganization);
  els.inviteForm.addEventListener("submit", inviteMember);
  els.billingPortalBtn.addEventListener("click", openBillingPortal);
  document.querySelectorAll("[data-checkout-plan]").forEach((btn) => {
    btn.addEventListener("click", () => startCheckout(btn.dataset.checkoutPlan));
  });
  els.solanaCreateBtn.addEventListener("click", createSolanaIntent);
  els.solanaConfirmBtn.addEventListener("click", confirmSolanaPayment);
  els.brandProfileForm.addEventListener("submit", createBrandProfile);
  els.changePasswordForm.addEventListener("submit", changePassword);

  try {
    const orgs = await studioRequest("/api/organizations", { method: "GET" });
    state.organizations = orgs.organizations || [];
    if (!state.organizations.length) {
      els.loadingState.textContent = "No organization found on this account yet. Sign in to the Studio once to have one created automatically.";
      return;
    }
    els.orgSwitcher.innerHTML = state.organizations.map((org) => `<option value="${org.id}">${escapeHtml(org.name)}</option>`).join("");
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("org");
    const initial = state.organizations.find((org) => org.id === requested) || state.organizations[0];
    els.orgSwitcher.value = initial.id;
    await setCurrentOrg(initial.id);
    const requestedPanel = window.location.hash.replace(/^#/, "");
    if (requestedPanel && document.querySelector(`.settings-nav button[data-panel="${CSS.escape(requestedPanel)}"]`)) {
      selectPanel(requestedPanel);
    }
    els.loadingState.hidden = true;
    els.settingsApp.hidden = false;
  } catch (error) {
    els.loadingState.textContent = error.message || "Could not load Studio settings.";
  }
}

function selectPanel(name) {
  document.querySelectorAll(".settings-nav button").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.panel === name));
  document.querySelectorAll(".settings-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === name));
}

async function setCurrentOrg(orgId) {
  state.currentOrgId = orgId;
  const url = new URL(window.location.href);
  url.searchParams.set("org", orgId);
  window.history.replaceState({}, "", url);
  // loadOrganization sets state.role, which every other panel's canManage check reads — it must resolve
  // FIRST, not race the others in the same Promise.all, or those panels render with role still null and
  // permanently disable their owner/admin-only controls for this page load.
  await loadOrganization();
  await Promise.all([
    loadMembers(),
    loadAiProviders(),
    loadBrandProfiles()
  ]);
}

function orgPath(suffix = "") {
  return `/api/organizations/${encodeURIComponent(state.currentOrgId)}${suffix}`;
}

async function loadOrganization() {
  try {
    const result = await studioRequest(orgPath(), { method: "GET" });
    state.role = result.role;
    const org = result.organization;
    els.orgName.value = org.name || "";
    els.orgSlug.value = org.slug || "";
    setBadge(els.orgPlanBadge, org.plan, planBadgeClass(org.plan));
    setBadge(els.billingPlanBadge, org.plan, planBadgeClass(org.plan));
    setBadge(els.orgStatusBadge, org.subscriptionStatus || "n/a", statusBadgeClass(org.subscriptionStatus));
    setBadge(els.billingStatusBadge, org.subscriptionStatus || "n/a", statusBadgeClass(org.subscriptionStatus));
    const canManage = state.role === "owner" || state.role === "admin";
    els.orgName.disabled = !canManage;
    els.orgSlug.disabled = !canManage;
    els.orgForm.querySelector("button[type=submit]").hidden = !canManage;
    els.billingPortalBtn.hidden = state.role !== "owner";
    document.querySelectorAll("[data-checkout-plan]").forEach((btn) => { btn.hidden = state.role !== "owner"; });
    els.solanaCreateBtn.hidden = state.role !== "owner";
  } catch (error) {
    setMessage(els.orgMessage, error.message, true);
  }
}

function planBadgeClass(plan) {
  return plan && plan !== "demo" ? "ok" : "off";
}

function statusBadgeClass(status) {
  if (status === "active") return "ok";
  if (status === "past_due") return "warn";
  return "off";
}

async function saveOrganization(event) {
  event.preventDefault();
  setMessage(els.orgMessage, "");
  try {
    const result = await studioRequest(orgPath("/update"), {
      method: "POST",
      body: JSON.stringify({ name: els.orgName.value, slug: els.orgSlug.value })
    });
    const option = els.orgSwitcher.querySelector(`option[value="${CSS.escape(state.currentOrgId)}"]`);
    if (option) option.textContent = result.organization.name;
    setMessage(els.orgMessage, "Saved.", false, true);
  } catch (error) {
    setMessage(els.orgMessage, error.message, true);
  }
}

async function loadMembers() {
  try {
    const result = await studioRequest(orgPath("/members"), { method: "GET" });
    const members = result.members || [];
    els.membersBody.innerHTML = members.map((member) => memberRow(member)).join("");
    els.membersEmpty.hidden = members.length > 0;
    document.querySelectorAll("[data-role-select]").forEach((select) => {
      select.addEventListener("change", () => updateMemberRole(select.dataset.roleSelect, select.value));
    });
    document.querySelectorAll("[data-remove-member]").forEach((btn) => {
      btn.addEventListener("click", () => removeMember(btn.dataset.removeMember));
    });
    const pending = result.pendingInvites || [];
    els.pendingInvitesCard.hidden = pending.length === 0;
    els.pendingInvitesBody.innerHTML = pending.map((invite) => `
      <tr><td>${escapeHtml(invite.email)}</td><td>${escapeHtml(invite.role)}</td><td>${formatDate(invite.expiresAt)}</td></tr>
    `).join("");
    const canManage = state.role === "owner" || state.role === "admin";
    els.inviteForm.querySelector("button[type=submit]").hidden = !canManage;
  } catch (error) {
    setMessage(els.inviteMessage, error.message, true);
  }
}

function memberRow(member) {
  const canManage = (state.role === "owner" || state.role === "admin");
  const roles = ["viewer", "member", "admin", "owner"];
  const roleOptions = roles.map((role) => `<option value="${role}" ${role === member.role ? "selected" : ""}>${role}</option>`).join("");
  const roleCell = canManage
    ? `<select data-role-select="${member.userId}">${roleOptions}</select>`
    : escapeHtml(member.role);
  const removeCell = canManage ? `<button class="btn small danger" data-remove-member="${member.userId}" type="button">Remove</button>` : "";
  return `<tr><td>${escapeHtml(member.userName || "—")}</td><td>${escapeHtml(member.userEmail || "—")}</td><td>${roleCell}</td><td>${removeCell}</td></tr>`;
}

async function inviteMember(event) {
  event.preventDefault();
  setMessage(els.inviteMessage, "");
  try {
    await studioRequest(orgPath("/members/invite"), {
      method: "POST",
      body: JSON.stringify({ email: els.inviteEmail.value, role: els.inviteRole.value })
    });
    els.inviteEmail.value = "";
    setMessage(els.inviteMessage, "Invite sent.", false, true);
    await loadMembers();
  } catch (error) {
    setMessage(els.inviteMessage, error.message, true);
  }
}

async function updateMemberRole(userId, role) {
  try {
    await studioRequest(orgPath("/members/role"), { method: "POST", body: JSON.stringify({ userId, role }) });
    await loadMembers();
  } catch (error) {
    setMessage(els.inviteMessage, error.message, true);
    await loadMembers();
  }
}

async function removeMember(userId) {
  if (!window.confirm("Remove this member from the organization?")) return;
  try {
    await studioRequest(orgPath("/members/remove"), { method: "POST", body: JSON.stringify({ userId }) });
    await loadMembers();
  } catch (error) {
    setMessage(els.inviteMessage, error.message, true);
  }
}

async function openBillingPortal() {
  setMessage(els.stripeMessage, "Opening billing portal...");
  try {
    const result = await studioRequest(orgPath("/billing/portal"), { method: "POST", body: "{}" });
    window.location.href = result.url;
  } catch (error) {
    setMessage(els.stripeMessage, error.message, true);
  }
}

async function startCheckout(plan) {
  setMessage(els.stripeMessage, "Starting checkout...");
  try {
    const result = await studioRequest(orgPath("/billing/checkout"), { method: "POST", body: JSON.stringify({ plan }) });
    window.location.href = result.url;
  } catch (error) {
    setMessage(els.stripeMessage, error.message, true);
  }
}

let activeSolanaIntentId = null;

async function createSolanaIntent() {
  setMessage(els.solanaMessage, "Requesting a payment address...");
  els.solanaReference.hidden = true;
  try {
    const result = await studioRequest(orgPath("/billing/solana/intent"), {
      method: "POST",
      body: JSON.stringify({ plan: els.solanaPlan.value, termDays: Number(els.solanaTerm.value), asset: els.solanaAsset.value })
    });
    const intent = result.paymentIntent;
    activeSolanaIntentId = intent.id;
    els.solanaAmount.textContent = `${intent.cryptoAmount} ${intent.asset}`;
    els.solanaRecipient.textContent = intent.recipientWallet;
    els.solanaNetwork.textContent = intent.network;
    els.solanaExpiry.textContent = formatDate(intent.expiresAt);
    els.solanaSignature.value = "";
    els.solanaReference.hidden = false;
    setMessage(els.solanaMessage, "");
  } catch (error) {
    setMessage(els.solanaMessage, error.message, true);
  }
}

async function confirmSolanaPayment() {
  if (!activeSolanaIntentId) return;
  setMessage(els.solanaMessage, "Verifying on-chain...");
  try {
    const result = await studioRequest(`/api/billing/solana/intents/${encodeURIComponent(activeSolanaIntentId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ transactionSignature: els.solanaSignature.value.trim() })
    });
    if (result.paymentIntent?.status === "paid") {
      setMessage(els.solanaMessage, "Payment confirmed — plan activated.", false, true);
      els.solanaReference.hidden = true;
      await loadOrganization();
    } else {
      setMessage(els.solanaMessage, "Payment recorded but not yet confirmed. Try again shortly.", true);
    }
  } catch (error) {
    setMessage(els.solanaMessage, error.message, true);
  }
}

async function loadAiProviders() {
  try {
    const result = await studioRequest(orgPath("/ai-providers"), { method: "GET" });
    const connected = new Map((result.credentials || []).map((cred) => [cred.provider, cred]));
    const canManage = state.role === "owner" || state.role === "admin";
    els.aiProvidersList.innerHTML = state.aiProviders.map((provider) => {
      const cred = connected.get(provider);
      const status = cred ? `<span class="badge ${cred.status === "active" ? "ok" : "warn"}">${cred.status} · ••••${escapeHtml(cred.keyLast4 || "")}</span>` : `<span class="badge off">Not connected</span>`;
      const disabled = canManage ? "" : "disabled";
      return `
        <div class="provider-row" data-provider="${provider}">
          <span class="provider-name">${state.aiProviderLabels[provider]}</span>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            ${status}
            <input type="password" placeholder="API key" data-key-input="${provider}" ${disabled} style="min-height:34px; border:1px solid var(--public-line); border-radius:6px; background:#130f0d; color:var(--public-ink); padding:0 10px; flex:1; min-width:160px;">
          </div>
          <div class="btn-row">
            <button class="btn small" data-action="save" data-provider="${provider}" ${disabled} type="button">Save</button>
            <button class="btn small" data-action="test" data-provider="${provider}" type="button">Test</button>
            <button class="btn small" data-action="revoke" data-provider="${provider}" ${disabled} type="button" ${cred ? "" : "disabled"}>Revoke</button>
            <button class="btn small danger" data-action="delete" data-provider="${provider}" ${disabled} type="button" ${cred ? "" : "disabled"}>Delete</button>
          </div>
          <p class="settings-message" data-message-for="${provider}"></p>
        </div>
      `;
    }).join("");

    els.aiProvidersList.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => handleAiProviderAction(btn.dataset.action, btn.dataset.provider));
    });
  } catch (error) {
    els.aiProvidersList.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

async function handleAiProviderAction(action, provider) {
  const row = els.aiProvidersList.querySelector(`.provider-row[data-provider="${provider}"]`);
  const messageEl = row.querySelector(`[data-message-for="${provider}"]`);
  const keyInput = row.querySelector(`[data-key-input="${provider}"]`);
  setMessage(messageEl, "");
  try {
    if (action === "save") {
      const apiKey = keyInput.value.trim();
      if (!apiKey) return setMessage(messageEl, "Enter an API key first.", true);
      await studioRequest(orgPath("/ai-providers"), { method: "POST", body: JSON.stringify({ provider, apiKey }) });
      setMessage(messageEl, "Saved.", false, true);
      await loadAiProviders();
    } else if (action === "test") {
      const apiKey = keyInput.value.trim();
      const result = await studioRequest(orgPath(`/ai-providers/${provider}/test`), { method: "POST", body: JSON.stringify(apiKey ? { apiKey } : {}) });
      setMessage(messageEl, result.ok ? "Key works." : (result.error || "Key rejected."), !result.ok, result.ok);
    } else if (action === "revoke") {
      await studioRequest(orgPath(`/ai-providers/${provider}/revoke`), { method: "POST", body: "{}" });
      await loadAiProviders();
    } else if (action === "delete") {
      if (!window.confirm(`Delete the stored ${state.aiProviderLabels[provider]} key?`)) return;
      await studioRequest(orgPath(`/ai-providers/${provider}/delete`), { method: "POST", body: "{}" });
      await loadAiProviders();
    }
  } catch (error) {
    setMessage(messageEl, error.message, true);
  }
}

async function loadBrandProfiles() {
  try {
    const result = await studioRequest(orgPath("/brand-profiles"), { method: "GET" });
    const profiles = result.brandProfiles || [];
    els.brandProfilesBody.innerHTML = profiles.map((profile) => `
      <tr>
        <td>${escapeHtml(profile.name)}</td>
        <td>${escapeHtml(profile.baseThemeId)}</td>
        <td><button class="btn small danger" data-delete-profile="${profile.id}" type="button">Delete</button></td>
      </tr>
    `).join("");
    els.brandProfilesEmpty.hidden = profiles.length > 0;
    els.brandProfilesBody.querySelectorAll("[data-delete-profile]").forEach((btn) => {
      btn.addEventListener("click", () => deleteBrandProfile(btn.dataset.deleteProfile));
    });
    const canManage = state.role === "owner" || state.role === "admin";
    els.brandProfileForm.querySelector("button[type=submit]").hidden = !canManage;
  } catch (error) {
    setMessage(els.brandProfileMessage, error.message, true);
  }
}

async function createBrandProfile(event) {
  event.preventDefault();
  setMessage(els.brandProfileMessage, "");
  try {
    await studioRequest(orgPath("/brand-profiles"), {
      method: "POST",
      body: JSON.stringify({ name: els.brandProfileName.value, baseThemeId: els.brandProfileTheme.value })
    });
    els.brandProfileName.value = "";
    setMessage(els.brandProfileMessage, "Created.", false, true);
    await loadBrandProfiles();
  } catch (error) {
    setMessage(els.brandProfileMessage, error.message, true);
  }
}

async function deleteBrandProfile(id) {
  if (!window.confirm("Delete this brand profile?")) return;
  try {
    await studioRequest(`/api/brand-profiles/${encodeURIComponent(id)}/delete`, { method: "POST", body: "{}" });
    await loadBrandProfiles();
  } catch (error) {
    setMessage(els.brandProfileMessage, error.message, true);
  }
}

async function changePassword(event) {
  event.preventDefault();
  setMessage(els.passwordMessage, "");
  try {
    await studioRequest("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: els.currentPassword.value, newPassword: els.newPassword.value })
    });
    els.currentPassword.value = "";
    els.newPassword.value = "";
    setMessage(els.passwordMessage, "Password updated.", false, true);
  } catch (error) {
    setMessage(els.passwordMessage, error.message, true);
  }
}

async function signOut() {
  try {
    await studioRequest("/auth/logout", { method: "POST", body: "{}" });
  } catch (_) {
    // Navigate away regardless.
  }
  window.location.href = "./sessions.html";
}

function setBadge(el, text, cls) {
  el.textContent = text;
  el.className = `badge ${cls}`;
}

function setMessage(el, message, isError = false, isSuccess = false) {
  el.textContent = message;
  el.dataset.state = isError ? "error" : (isSuccess ? "success" : "neutral");
}

function formatDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
