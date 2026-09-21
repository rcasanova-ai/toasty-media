// Reusable production setup for a LiveSession row — brand/theme, show type, layouts, policy,
// ticker speed, and Run of Show template. Never history: no timeline, transcripts, recordings,
// participants, live scene, ticker copy, or ROS timestamps/status.

export const SESSION_SETUP_VERSION = 1;

export const SessionSetupType = Object.freeze({ LIVE: "live", JAM: "jam" });
export const SessionSetupPrivacy = Object.freeze({ PRIVATE: "private", CONFIDENTIAL: "confidential", BLIND: "blind" });
export const SessionSetupCapture = Object.freeze({
  NONE: "none",
  TRANSCRIPT: "transcript",
  RECORDING: "recording",
  RECORDING_AND_TRANSCRIPT: "recording_and_transcript"
});
export const SessionSetupAccess = Object.freeze({ PUBLIC: "public", INVITED_ONLY: "invited_only" });

const COMPOSITION_MODES = new Set(["balanced", "active-speaker", "spotlight"]);
const LAYOUTS = new Set([
  "grid",
  "balanced",
  "active-speaker",
  "spotlight",
  "single",
  "duo",
  "trio",
  "quad",
  "screen-only",
  "screen-speaker",
  "screen-strip",
  "asset-full",
  "asset-speaker",
  "asset-speaker-pip"
]);
const SHARE_LAYOUTS = new Set(["screen-only", "screen-speaker", "screen-strip"]);
const ASSET_LAYOUTS = new Set(["asset-full", "asset-speaker", "asset-speaker-pip"]);
const SESSION_TYPES = new Set(Object.values(SessionSetupType));
const PRIVACY = new Set(Object.values(SessionSetupPrivacy));
const CAPTURE = new Set(Object.values(SessionSetupCapture));
const ACCESS = new Set(Object.values(SessionSetupAccess));

function clipText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function clipSpeed(value) {
  const numeric = Number(value);
  const next = Number.isFinite(numeric) ? numeric : 16;
  return Math.max(8, Math.min(40, next));
}

export function runOfShowTemplate(items = []) {
  return (Array.isArray(items) ? items : [])
    .slice(0, 80)
    .map((item, index) => {
      const title = clipText(item?.title, 160);
      if (!title) return null;
      const questions = Array.isArray(item?.preparedQuestions)
        ? item.preparedQuestions.map((q) => clipText(q, 400)).filter(Boolean).slice(0, 20)
        : [];
      const minutes = Number(item?.estimatedMinutes || item?.duration || 5);
      return {
        id: clipText(item?.id, 80) || `topic-${index + 1}`,
        title,
        notes: clipText(item?.notes || item?.script, 4000),
        preparedQuestions: questions,
        estimatedMinutes: Number.isFinite(minutes) ? Math.max(1, Math.min(180, Math.round(minutes))) : 5
      };
    })
    .filter(Boolean);
}

export function emptyReusableSetup() {
  return {
    version: SESSION_SETUP_VERSION,
    brandId: "",
    sessionType: SessionSetupType.LIVE,
    policy: {
      sessionType: SessionSetupType.LIVE,
      privacy: null,
      capturePolicy: SessionSetupCapture.RECORDING_AND_TRANSCRIPT,
      aiProcessingAllowed: true,
      jamRecordAllowed: true,
      access: SessionSetupAccess.PUBLIC
    },
    layouts: {
      compositionMode: "balanced",
      layout: "grid",
      shareLayout: null,
      assetLayout: null
    },
    ticker: { speed: 16 },
    runOfShow: []
  };
}

export function sanitizeReusableSetup(input) {
  const raw = input && typeof input === "object" ? input : {};
  const fallback = emptyReusableSetup();
  const sessionType = SESSION_TYPES.has(raw.sessionType) ? raw.sessionType : (SESSION_TYPES.has(raw.policy?.sessionType) ? raw.policy.sessionType : fallback.sessionType);
  const policyRaw = raw.policy && typeof raw.policy === "object" ? raw.policy : {};
  const privacy = PRIVACY.has(policyRaw.privacy) ? policyRaw.privacy : (sessionType === SessionSetupType.JAM ? SessionSetupPrivacy.CONFIDENTIAL : null);
  const capturePolicy = CAPTURE.has(policyRaw.capturePolicy)
    ? policyRaw.capturePolicy
    : (sessionType === SessionSetupType.JAM ? SessionSetupCapture.NONE : fallback.policy.capturePolicy);
  const access = ACCESS.has(policyRaw.access)
    ? policyRaw.access
    : (sessionType === SessionSetupType.JAM ? SessionSetupAccess.INVITED_ONLY : fallback.policy.access);
  const layoutsRaw = raw.layouts && typeof raw.layouts === "object" ? raw.layouts : {};
  const compositionMode = COMPOSITION_MODES.has(layoutsRaw.compositionMode) ? layoutsRaw.compositionMode : fallback.layouts.compositionMode;
  const layout = LAYOUTS.has(layoutsRaw.layout) ? layoutsRaw.layout : fallback.layouts.layout;
  const shareLayout = SHARE_LAYOUTS.has(layoutsRaw.shareLayout) ? layoutsRaw.shareLayout : null;
  const assetLayout = ASSET_LAYOUTS.has(layoutsRaw.assetLayout) ? layoutsRaw.assetLayout : null;
  const tickerRaw = raw.ticker && typeof raw.ticker === "object" ? raw.ticker : {};
  return {
    version: SESSION_SETUP_VERSION,
    brandId: clipText(raw.brandId || raw.brandTheme, 60),
    sessionType,
    policy: {
      sessionType,
      privacy: sessionType === SessionSetupType.JAM ? privacy : null,
      capturePolicy,
      aiProcessingAllowed: sessionType === SessionSetupType.JAM ? Boolean(policyRaw.aiProcessingAllowed) && capturePolicy !== SessionSetupCapture.NONE && capturePolicy !== SessionSetupCapture.RECORDING : true,
      jamRecordAllowed: sessionType === SessionSetupType.JAM ? Boolean(policyRaw.jamRecordAllowed) && (capturePolicy === SessionSetupCapture.RECORDING || capturePolicy === SessionSetupCapture.RECORDING_AND_TRANSCRIPT) : true,
      access
    },
    layouts: {
      compositionMode,
      layout,
      shareLayout,
      assetLayout
    },
    ticker: { speed: clipSpeed(tickerRaw.speed) },
    runOfShow: runOfShowTemplate(raw.runOfShow)
  };
}

export function extractReusableSetup(source = {}) {
  const session = source.session || source;
  const policyState = source.policy?.state || source.policy || session.policy?.state || session.policy || session.setup?.policy || {};
  const program = source.program || session.program || session.setup?.layouts && {
    compositionMode: session.setup.layouts.compositionMode,
    layout: session.setup.layouts.layout,
    shareLayout: session.setup.layouts.shareLayout,
    assetLayout: session.setup.layouts.assetLayout,
    tickerSpeed: session.setup?.ticker?.speed
  } || {};
  const runOfShow = source.runOfShowItems
    || source.runOfShow
    || session.runOfShow?.items
    || session.setup?.runOfShow
    || [];
  return sanitizeReusableSetup({
    brandId: source.brandId || source.brandTheme || session.brandId || session.brandTheme || session.setup?.brandId || "",
    sessionType: policyState.sessionType || session.sessionType || session.setup?.sessionType,
    policy: policyState,
    layouts: {
      compositionMode: program.compositionMode,
      layout: program.layout,
      shareLayout: program.shareLayout,
      assetLayout: typeof program.assetLayout === "string" ? program.assetLayout : null
    },
    ticker: { speed: program.tickerSpeed ?? source.tickerSpeed ?? session.setup?.ticker?.speed },
    runOfShow
  });
}

export function setupOmitsHistory(setup) {
  const raw = setup && typeof setup === "object" ? setup : {};
  if ("timeline" in raw || "transcript" in raw || "recordings" in raw || "participants" in raw) return false;
  if ("scene" in raw || "tickerText" in raw || "productionActions" in raw) return false;
  const items = Array.isArray(raw.runOfShow) ? raw.runOfShow : [];
  return items.every((item) => !("status" in item) && !("startedAt" in item) && !("completedAt" in item));
}
