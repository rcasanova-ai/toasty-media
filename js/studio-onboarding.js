import { studioRequest } from "./studio-api.js";

const TOTAL_STEPS = 10;
const AI_PROVIDERS = ["openai", "anthropic", "deepseek", "gemini"];
const AI_PROVIDER_LABELS = { openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek", gemini: "Gemini" };

const state = {
  step: 1,
  orgId: null,
  brandName: "",
  baseThemeId: "toasty",
  analysis: null,
  websiteUrl: "",
  socials: {},
  brandProfileId: null,
  primaryColor: "#ff7a29",
  secondaryColor: "#ffc670",
  logoUrl: ""
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  [
    "loadingState", "wizardApp", "stepLabel", "progressTrack", "backBtn", "nextBtn",
    "orgNameInput", "step1Message",
    "brandNameInput", "baseThemeSelect",
    "websiteUrlInput", "analyzeBtn", "analysisResult", "analysisTitle", "analysisDescription", "analysisSwatches", "step3Message",
    "socialTwitter", "socialInstagram", "socialLinkedin", "socialYoutube", "step4Message",
    "step5Lede", "step5Message",
    "previewCard",
    "tweakPrimary", "tweakSecondary", "tweakLogoUrl", "step7Message",
    "stayOnDemoBtn", "upgradeCreatorBtn", "upgradeProBtn", "step8Message",
    "onboardingAiProviders", "step9Message",
    "enterStudioLink", "skipAllBtn"
  ].forEach((id) => { els[id] = document.getElementById(id); });

  const session = await studioRequest("/auth/session", { method: "GET" }).catch(() => ({ authenticated: false }));
  if (!session.authenticated) {
    window.location.href = "./";
    return;
  }

  try {
    const orgs = await studioRequest("/api/organizations", { method: "GET" });
    const org = (orgs.organizations || [])[0];
    if (!org) {
      els.loadingState.textContent = "No organization found on this account yet.";
      return;
    }
    state.orgId = org.id;
    els.orgNameInput.value = org.name || "";
    els.brandNameInput.value = `${org.name || "My"} Brand`;
  } catch (error) {
    els.loadingState.textContent = error.message || "Could not load your account.";
    return;
  }

  buildProgressTrack();
  wireEvents();
  renderStep();

  els.loadingState.hidden = true;
  els.wizardApp.hidden = false;
}

function buildProgressTrack() {
  els.progressTrack.innerHTML = "";
  for (let i = 1; i <= TOTAL_STEPS; i += 1) {
    const span = document.createElement("span");
    span.dataset.step = String(i);
    els.progressTrack.appendChild(span);
  }
}

function wireEvents() {
  els.backBtn.addEventListener("click", () => goToStep(state.step - 1));
  els.nextBtn.addEventListener("click", handleNext);
  els.analyzeBtn.addEventListener("click", analyzeWebsite);
  els.stayOnDemoBtn.addEventListener("click", () => goToStep(9));
  els.upgradeCreatorBtn.addEventListener("click", () => startCheckout("creator"));
  els.upgradeProBtn.addEventListener("click", () => startCheckout("pro"));
  els.skipAllBtn.addEventListener("click", () => goToStep(10));
}

function orgPath(suffix = "") {
  return `/api/organizations/${encodeURIComponent(state.orgId)}${suffix}`;
}

async function handleNext() {
  const ok = await commitStep(state.step);
  if (ok === false) return;
  goToStep(state.step + 1);
}

async function commitStep(step) {
  if (step === 1) {
    const name = els.orgNameInput.value.trim();
    if (!name) { setMessage(els.step1Message, "Organization name is required.", true); return false; }
    try {
      await studioRequest(orgPath("/update"), { method: "POST", body: JSON.stringify({ name }) });
      return true;
    } catch (error) {
      setMessage(els.step1Message, error.message, true);
      return false;
    }
  }
  if (step === 2) {
    state.brandName = els.brandNameInput.value.trim() || "My Brand";
    state.baseThemeId = els.baseThemeSelect.value;
    return true;
  }
  if (step === 3) {
    state.websiteUrl = els.websiteUrlInput.value.trim();
    return true;
  }
  if (step === 4) {
    state.socials = {
      twitter: els.socialTwitter.value.trim(),
      instagram: els.socialInstagram.value.trim(),
      linkedin: els.socialLinkedin.value.trim(),
      youtube: els.socialYoutube.value.trim()
    };
    try {
      await studioRequest(orgPath("/settings"), {
        method: "POST",
        body: JSON.stringify({ socialLinks: state.socials, websiteUrl: state.websiteUrl || undefined })
      });
    } catch (error) {
      setMessage(els.step4Message, error.message, true);
      return false;
    }
    return true;
  }
  if (step === 7) {
    state.primaryColor = els.tweakPrimary.value;
    state.secondaryColor = els.tweakSecondary.value;
    state.logoUrl = els.tweakLogoUrl.value.trim();
    if (state.brandProfileId) {
      try {
        await studioRequest(`/api/brand-profiles/${encodeURIComponent(state.brandProfileId)}/update`, {
          method: "POST",
          body: JSON.stringify({ overrides: buildOverrides() })
        });
      } catch (error) {
        setMessage(els.step7Message, error.message, true);
        return false;
      }
    }
    return true;
  }
  return true;
}

function buildOverrides() {
  return {
    vars: { "--brand-primary": state.primaryColor, "--brand-secondary": state.secondaryColor },
    logoSrc: state.logoUrl || undefined,
    textLogo: state.brandName
  };
}

async function goToStep(step) {
  if (step < 1 || step > TOTAL_STEPS) return;
  state.step = step;
  renderStep();
  if (step === 5) await generateBrandProfile();
  if (step === 6) renderPreview();
  if (step === 7) prefillTweaks();
  if (step === 9) renderAiProviders();
  if (step === 10) await completeOnboarding();
}

function renderStep() {
  document.querySelectorAll(".step-panel").forEach((panel) => {
    panel.classList.toggle("is-active", Number(panel.dataset.step) === state.step);
  });
  els.progressTrack.querySelectorAll("span").forEach((span) => {
    const n = Number(span.dataset.step);
    span.classList.toggle("is-done", n < state.step);
    span.classList.toggle("is-current", n === state.step);
  });
  els.stepLabel.textContent = `Step ${state.step} of ${TOTAL_STEPS}`;
  els.backBtn.hidden = state.step === 1;
  els.nextBtn.hidden = state.step === 10 || state.step === 5;
  els.nextBtn.textContent = state.step === 9 ? "Skip for now" : "Continue";
}

async function analyzeWebsite() {
  const url = els.websiteUrlInput.value.trim();
  if (!url) { setMessage(els.step3Message, "Enter a website URL first.", true); return; }
  setMessage(els.step3Message, "Analyzing...");
  els.analyzeBtn.disabled = true;
  try {
    const result = await studioRequest(orgPath("/onboarding/analyze-website"), { method: "POST", body: JSON.stringify({ url }) });
    state.analysis = result.analysis;
    state.websiteUrl = result.websiteUrl;
    els.analysisTitle.textContent = result.analysis.title || "Analyzed";
    els.analysisDescription.textContent = result.analysis.description || "";
    els.analysisSwatches.innerHTML = (result.analysis.dominantColors || []).map((color) => `<span class="color-swatch" style="background:${color}" title="${color}"></span>`).join("");
    els.analysisResult.hidden = false;
    if (result.analysis.themeColor) state.primaryColor = result.analysis.themeColor;
    else if (result.analysis.dominantColors?.[0]) state.primaryColor = result.analysis.dominantColors[0];
    if (result.analysis.logoUrl) state.logoUrl = result.analysis.logoUrl;
    setMessage(els.step3Message, "Analysis complete.", false, true);
  } catch (error) {
    setMessage(els.step3Message, error.message, true);
  } finally {
    els.analyzeBtn.disabled = false;
  }
}

async function generateBrandProfile() {
  setMessage(els.step5Message, "");
  els.step5Lede.textContent = "Building a brand profile from what we found...";
  try {
    const result = await studioRequest(orgPath("/brand-profiles"), {
      method: "POST",
      body: JSON.stringify({ name: state.brandName, baseThemeId: state.baseThemeId, overrides: buildOverrides() })
    });
    state.brandProfileId = result.brandProfile.id;
    els.step5Lede.textContent = "Brand profile created.";
    window.setTimeout(() => { if (state.step === 5) goToStep(6); }, 600);
  } catch (error) {
    els.step5Lede.textContent = "We hit a snag generating your brand profile.";
    setMessage(els.step5Message, `${error.message} You can continue and adjust it later in Settings.`, true);
    els.nextBtn.hidden = false;
  }
}

function renderPreview() {
  els.previewCard.innerHTML = `
    ${state.logoUrl ? `<img src="${escapeHtml(state.logoUrl)}" alt="Logo">` : ""}
    <strong>${escapeHtml(state.brandName)}</strong>
    <div class="color-swatches">
      <span class="color-swatch" style="background:${state.primaryColor}"></span>
      <span class="color-swatch" style="background:${state.secondaryColor}"></span>
    </div>
  `;
}

function prefillTweaks() {
  els.tweakPrimary.value = state.primaryColor;
  els.tweakSecondary.value = state.secondaryColor;
  els.tweakLogoUrl.value = state.logoUrl;
}

async function startCheckout(plan) {
  setMessage(els.step8Message, "Starting checkout...");
  try {
    const result = await studioRequest(orgPath("/billing/checkout"), { method: "POST", body: JSON.stringify({ plan }) });
    window.location.href = result.url;
  } catch (error) {
    setMessage(els.step8Message, error.message, true);
  }
}

async function renderAiProviders() {
  els.onboardingAiProviders.innerHTML = AI_PROVIDERS.map((provider) => `
    <div class="provider-row" data-provider="${provider}">
      <span class="provider-name">${AI_PROVIDER_LABELS[provider]}</span>
      <input type="password" placeholder="API key" data-key-input="${provider}" style="min-height:34px; border:1px solid var(--public-line); border-radius:6px; background:#130f0d; color:var(--public-ink); padding:0 10px; flex:1; min-width:160px;">
      <div class="btn-row">
        <button class="btn small" data-action="save" data-provider="${provider}" type="button">Save</button>
        <button class="btn small" data-action="test" data-provider="${provider}" type="button">Test</button>
      </div>
      <p class="wizard-message" data-message-for="${provider}"></p>
    </div>
  `).join("");
  els.onboardingAiProviders.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleAiProviderAction(btn.dataset.action, btn.dataset.provider));
  });
}

async function handleAiProviderAction(action, provider) {
  const row = els.onboardingAiProviders.querySelector(`.provider-row[data-provider="${provider}"]`);
  const messageEl = row.querySelector(`[data-message-for="${provider}"]`);
  const keyInput = row.querySelector(`[data-key-input="${provider}"]`);
  setMessage(messageEl, "");
  try {
    if (action === "save") {
      const apiKey = keyInput.value.trim();
      if (!apiKey) return setMessage(messageEl, "Enter an API key first.", true);
      await studioRequest(orgPath("/ai-providers"), { method: "POST", body: JSON.stringify({ provider, apiKey }) });
      setMessage(messageEl, "Saved.", false, true);
    } else if (action === "test") {
      const apiKey = keyInput.value.trim();
      const result = await studioRequest(orgPath(`/ai-providers/${provider}/test`), { method: "POST", body: JSON.stringify(apiKey ? { apiKey } : {}) });
      setMessage(messageEl, result.ok ? "Key works." : (result.error || "Key rejected."), !result.ok, result.ok);
    }
  } catch (error) {
    setMessage(messageEl, error.message, true);
  }
}

async function completeOnboarding() {
  try {
    await studioRequest(orgPath("/settings"), { method: "POST", body: JSON.stringify({ onboardingCompleted: true }) });
  } catch (_) {
    // Non-fatal — the wizard still finished; Settings remains available regardless of this flag.
  }
}

function setMessage(el, message, isError = false, isSuccess = false) {
  el.textContent = message;
  el.dataset.state = isError ? "error" : (isSuccess ? "success" : "neutral");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
