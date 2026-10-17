// Human Presence Verification UI: participant challenge dialog (camera + microphone, on device analysis only)
// and the host / organizer control panel. Everything is inert unless the server reports
// HUMAN_PRESENCE_ENABLED. See docs/human-presence-verification.md.
//
// Privacy: video and audio never leave the device. The dialog derives a few coarse numbers locally
// (motion, level, transcript match score) and sends only those. The server treats them as untrusted hints
// and, until a trusted liveness provider is enabled, every result is inconclusive.
import { studioApiEndpoint } from "./studio-api.js";

const STYLE_ID = "hp-style";
const CSS = `
.hp-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(11,9,8,.82);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Inter,system-ui,sans-serif}
.hp-card{width:min(480px,100%);max-height:92vh;overflow:auto;background:#1a1210;color:#f6e9d7;border:1px solid #3a2a20;border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.hp-card h2{margin:0 0 6px;font:800 20px/1.2 Manrope,Inter,sans-serif;color:#ffab5c}
.hp-card p,.hp-card li{font-size:14px;line-height:1.5;color:#e7d6c0}
.hp-card ul{padding-left:18px;margin:10px 0}
.hp-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
.hp-btn{appearance:none;border:0;border-radius:999px;padding:11px 18px;font:700 14px Inter,sans-serif;cursor:pointer;background:#ff7a29;color:#1a0d05}
.hp-btn.hp-ghost{background:transparent;color:#f6e9d7;border:1px solid #5a4333}
.hp-btn[disabled]{opacity:.5;cursor:default}
.hp-video{width:100%;aspect-ratio:4/3;background:#000;border-radius:12px;object-fit:cover;transform:scaleX(-1)}
.hp-prompt{font:800 20px/1.3 Manrope,Inter,sans-serif;color:#f6e9d7;margin:12px 0 4px;min-height:52px}
.hp-bar{height:6px;background:#3a2a20;border-radius:6px;overflow:hidden;margin-top:8px}
.hp-bar>i{display:block;height:100%;width:0;background:#ff7a29;transition:width .2s linear}
.hp-note{font-size:12px;color:#b89c80}
.hp-chip{display:inline-block;border-radius:999px;padding:3px 10px;font:700 12px Inter,sans-serif;border:1px solid #5a4333;color:#e7d6c0;white-space:nowrap}
.hp-chip.pending,.hp-chip.in_progress{border-color:#ff7a29;color:#ffab5c}
.hp-chip.inconclusive{border-color:#d9a66f;color:#d9a66f}
.hp-chip.failed{border-color:#c4523a;color:#e8836d}
.hp-chip.verified{border-color:#7bd88f;color:#7bd88f}
.hp-fab{position:fixed;right:16px;bottom:16px;z-index:2147482000;border-radius:999px;border:1px solid #5a4333;background:#1a1210;color:#ffab5c;padding:10px 16px;font:700 13px Inter,sans-serif;cursor:pointer}
.hp-panel{position:fixed;right:16px;bottom:64px;z-index:2147482000;width:min(380px,calc(100vw - 32px));max-height:70vh;overflow:auto;background:#1a1210;color:#f6e9d7;border:1px solid #3a2a20;border-radius:16px;padding:16px;font-family:Inter,system-ui,sans-serif}
.hp-panel h3{margin:0 0 4px;font:800 16px Manrope,Inter,sans-serif;color:#ffab5c}
.hp-person{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;border-top:1px solid #3a2a20}
.hp-person b{font-size:14px}
.hp-small{font-size:12px;padding:6px 12px}
.hp-audit{font-size:12px;color:#b89c80;margin:6px 0;line-height:1.4}
.hp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${studioApiEndpoint()}${path}`, {
    method,
    credentials: "include",
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Toasty-CSRF": "1" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try { data = await response.json(); } catch { /* empty */ }
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function humanPresenceConfig() {
  try { return await api("/api/human-presence/config"); } catch { return { enabled: false }; }
}

// ------------------------------------------------------------------------------------------------
// On device capture. Produces coarse, self reported numbers only. No frames, audio or text leave the device.
// ------------------------------------------------------------------------------------------------

const STEP_WINDOW_MS = { head_turn: 3500, hand_gesture: 3500, spoken_phrase: 4500 };

function createMotionSampler(video) {
  const canvas = document.createElement("canvas");
  canvas.width = 32; canvas.height = 24;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let prev = null;
  return () => {
    ctx.drawImage(video, 0, 0, 32, 24);
    const data = ctx.getImageData(0, 0, 32, 24).data;
    const gray = new Float32Array(32 * 24);
    for (let i = 0; i < gray.length; i += 1) gray[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 765;
    let result = { mass: 0, cx: 0.5, cy: 0.5 };
    if (prev) {
      let mass = 0, sx = 0, sy = 0;
      for (let y = 0; y < 24; y += 1) for (let x = 0; x < 32; x += 1) {
        const d = Math.abs(gray[y * 32 + x] - prev[y * 32 + x]);
        if (d > 0.06) { mass += d; sx += d * x; sy += d * y; }
      }
      if (mass > 0.5) result = { mass: mass / (32 * 24), cx: sx / mass / 31, cy: sy / mass / 23 };
    }
    prev = gray;
    return result;
  };
}

function createSpeechMatcher(phrase) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return { stop: () => null };
  let heard = "";
  let rec;
  try {
    rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = document.documentElement.lang || "en-US";
    rec.onresult = (e) => { heard = Array.from(e.results).map((r) => r[0].transcript).join(" ").toLowerCase(); };
    rec.start();
  } catch { return { stop: () => null }; }
  return {
    stop: () => {
      try { rec.stop(); } catch { /* ignore */ }
      const want = phrase.toLowerCase().split(/\s+/);
      const got = new Set(heard.split(/[^a-z0-9]+/));
      // Only the score leaves the device; the transcript is discarded here.
      return want.filter((w) => got.has(w)).length / want.length;
    }
  };
}

async function runStep(step, { video, analyser, sampleMotion, setPrompt, setProgress, startedAt }) {
  const windowMs = STEP_WINDOW_MS[step.type] || 3500;
  setPrompt(step.prompt);
  await new Promise((r) => setTimeout(r, 900));
  const start = Math.round(performance.now() - startedAt);
  const matcher = step.type === "spoken_phrase" ? createSpeechMatcher(step.phrase) : null;
  const buf = new Uint8Array(analyser.fftSize);
  let minX = 1, maxX = 0, minY = 1, maxY = 0, motionSum = 0, frames = 0, peakLevel = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < windowMs) {
    const m = sampleMotion();
    if (m.mass > 0) { minX = Math.min(minX, m.cx); maxX = Math.max(maxX, m.cx); minY = Math.min(minY, m.cy); maxY = Math.max(maxY, m.cy); }
    motionSum += m.mass; frames += 1;
    analyser.getByteTimeDomainData(buf);
    let sum = 0; for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
    peakLevel = Math.max(peakLevel, Math.sqrt(sum / buf.length));
    setProgress(Math.min(1, (performance.now() - t0) / windowMs));
    await new Promise((r) => setTimeout(r, 100));
  }
  const end = Math.round(performance.now() - startedAt);
  const spreadX = Math.max(0, maxX - minX), spreadY = Math.max(0, maxY - minY);
  const meanMotion = frames ? motionSum / frames : 0;
  const signals = {};
  if (step.type === "head_turn") {
    const spread = step.direction === "left" || step.direction === "right" ? spreadX : spreadY;
    signals.motion = Math.min(1, spread * 2);
    signals.completed = spread > 0.06;
  } else if (step.type === "hand_gesture") {
    signals.motion = Math.min(1, meanMotion * 20);
    signals.completed = meanMotion > 0.004;
  } else {
    signals.level = Math.min(1, peakLevel * 4);
    const score = matcher?.stop();
    if (typeof score === "number") signals.transcriptMatch = Math.round(score * 100) / 100;
    signals.completed = peakLevel > 0.02 && (score == null || score >= 0.5);
  }
  setProgress(0);
  return { stepId: step.stepId, type: step.type, startOffsetMs: start, endOffsetMs: end, signals };
}

// ------------------------------------------------------------------------------------------------
// Participant dialog
// ------------------------------------------------------------------------------------------------

export async function mountParticipantPrompt(identity, { pollMs = 5000 } = {}) {
  const config = await humanPresenceConfig();
  if (!config.enabled) return () => null;
  ensureStyle();
  let open = false, stopped = false, timer = null;
  // A request the participant closed without finishing is not re-offered during this page visit.
  const dismissed = new Set();
  const who = () => (typeof identity === "function" ? identity() : identity);

  async function poll() {
    if (stopped || open) return;
    try {
      const data = await api("/api/human-presence/pending", { method: "POST", body: who() });
      if (data.request && dismissed.has(data.request.requestId)) return;
      if (data.request && !data.request.consented && data.request.status === "pending") await showDialog(data);
      else if (data.request && data.request.consented) await showDialog(data);
    } catch { /* not in a room yet, or feature off: stay quiet */ }
  }

  async function showDialog(pending) {
    open = true;
    const overlay = el("div", { class: "hp-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "hp-title" });
    const card = el("div", { class: "hp-card" });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const requestId = pending.request.requestId;
    const close = () => { overlay.remove(); open = false; dismissed.add(requestId); };
    const base = () => ({ ...who(), requestId });
    let stream = null;
    const stopMedia = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };

    function renderConsent() {
      card.replaceChildren(
        el("h2", { id: "hp-title", text: pending.consent.title }),
        el("p", { text: "The host asked for a quick human presence check. It takes about 20 seconds." }),
        el("ul", {}, pending.consent.points.map((p) => el("li", { text: p }))),
        el("div", { class: "hp-row" }, [
          el("button", { class: "hp-btn", type: "button", text: "Agree and continue", onclick: async (e) => {
            e.target.disabled = true;
            try { await api("/api/human-presence/consent", { method: "POST", body: { ...base(), accepted: true } }); renderReady(); }
            catch (err) { renderMessage("This check is no longer open.", err.message); }
          } }),
          el("button", { class: "hp-btn hp-ghost", type: "button", text: "No thanks", onclick: async () => {
            try { await api("/api/human-presence/consent", { method: "POST", body: { ...base(), accepted: false } }); } catch { /* ignore */ }
            close();
          } })
        ])
      );
      card.querySelector("button")?.focus();
    }

    function renderMessage(title, text, extra = []) {
      stopMedia();
      card.replaceChildren(el("h2", { id: "hp-title", text: title }), el("p", { text }), ...extra,
        el("div", { class: "hp-row" }, [el("button", { class: "hp-btn", type: "button", text: "Close", onclick: close })]));
    }

    async function renderReady() {
      const video = el("video", { class: "hp-video", autoplay: "", muted: "", playsinline: "" });
      const status = el("p", { class: "hp-note", text: "Allow camera and microphone when your browser asks. Nothing is recorded or uploaded." });
      const startBtn = el("button", { class: "hp-btn", type: "button", text: "Start check", disabled: "" });
      card.replaceChildren(
        el("h2", { id: "hp-title", text: "Get ready" }), video, status,
        el("div", { class: "hp-row" }, [startBtn, el("button", { class: "hp-btn hp-ghost", type: "button", text: "Cancel", onclick: () => { stopMedia(); close(); } })])
      );
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: true });
        video.srcObject = stream;
        await video.play().catch(() => null);
        status.textContent = "Sit where your face and one hand are visible. Press Start when you are ready.";
        startBtn.removeAttribute("disabled");
        startBtn.focus();
      } catch {
        status.textContent = "Your camera or microphone could not be opened here (it may be in use by the session). You can cancel, and your host can verify you another way. This never removes you from the session.";
        return;
      }
      startBtn.addEventListener("click", () => run(video));
    }

    async function run(video) {
      const prompt = el("div", { class: "hp-prompt", "aria-live": "assertive" });
      const bar = el("div", { class: "hp-bar" }, [el("i")]);
      card.replaceChildren(el("h2", { id: "hp-title", text: "Follow the prompts" }), video, prompt, bar, el("p", { class: "hp-note", text: "Analysis happens on this device. Nothing is recorded." }));
      let challenge;
      try { challenge = await api("/api/human-presence/challenge", { method: "POST", body: base() }); }
      catch (err) { return renderMessage("Could not start", err.status === 429 ? "Too many attempts for this request. Ask your host to send a new one." : err.message); }
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const sampleMotion = createMotionSampler(video);
      const startedAt = performance.now();
      const steps = [];
      try {
        for (const step of challenge.steps) {
          steps.push(await runStep(step, { video, analyser, sampleMotion, startedAt, setPrompt: (t) => { prompt.textContent = t; }, setProgress: (p) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; } }));
        }
      } finally { audioCtx.close().catch(() => null); stopMedia(); }
      prompt.textContent = "Checking...";
      try {
        const evidence = { nonce: challenge.nonce, steps, client: { video: true, audio: true, analyzer: "local-v1" } };
        const result = await api("/api/human-presence/respond", { method: "POST", body: { ...who(), challengeId: challenge.challengeId, responseSecret: challenge.responseSecret, evidence } });
        renderResult(result);
      } catch (err) {
        renderMessage(err.status === 410 ? "That took too long" : "Check not accepted", err.status === 410 ? "The challenge expired. Ask your host to send a new request." : "Your submission was not accepted. You can try again if your host sends a new request.");
      }
    }

    function renderResult(result) {
      // The label comes from the server; the UI never upgrades it.
      card.replaceChildren(
        el("h2", { id: "hp-title", text: result.verified ? "Check complete" : "Check completed" }),
        el("p", {}, [el("span", { class: `hp-chip ${result.status}`, text: result.label })]),
        ...(result.reasons || []).map((r) => el("p", { class: "hp-note", text: r })),
        el("p", { class: "hp-note", text: "This result does not prove who you are and has no effect on your place in the session." }),
        el("div", { class: "hp-row" }, [
          el("button", { class: "hp-btn", type: "button", text: "Done", onclick: close }),
          el("button", { class: "hp-btn hp-ghost", type: "button", text: "Delete my result", onclick: async (e) => {
            e.target.disabled = true;
            try { await api("/api/human-presence/delete", { method: "POST", body: base() }); e.target.textContent = "Deleted"; } catch { e.target.textContent = "Could not delete"; }
          } })
        ])
      );
    }

    if (pending.request.consented) renderReady(); else renderConsent();
  }

  timer = setInterval(poll, pollMs);
  poll();
  return () => { stopped = true; clearInterval(timer); };
}

// ------------------------------------------------------------------------------------------------
// Host / organizer panel
// ------------------------------------------------------------------------------------------------

// scope: { kind: "session", id } (or a function returning it) or { kind: "jam", id }
export async function mountHostPanel(scopeInput, { pollMs = 5000 } = {}) {
  const config = await humanPresenceConfig();
  if (!config.enabled) return () => null;
  const scopeOf = () => (typeof scopeInput === "function" ? scopeInput() : scopeInput);
  if (scopeOf()?.kind === "jam" && !config.peepsIntegration) return () => null;
  ensureStyle();
  const fab = el("button", { class: "hp-fab", type: "button", "aria-expanded": "false", text: "Human presence" });
  const panel = el("div", { class: "hp-panel", hidden: "", role: "region", "aria-label": "Human presence checks" });
  document.body.append(fab, panel);
  let timer = null, showAudit = false;
  const path = () => {
    const s = scopeOf();
    return s?.id ? (s.kind === "jam" ? `/api/jams/${encodeURIComponent(s.id)}/human-presence` : `/api/sessions/${encodeURIComponent(s.id)}/human-presence`) : null;
  };

  async function refresh() {
    const base = path();
    if (!base) { panel.replaceChildren(el("p", { class: "hp-note", text: "Start or open a session to request checks." })); return; }
    let data;
    try { data = await api(base); } catch (err) { panel.replaceChildren(el("p", { class: "hp-note", text: err.message })); return; }
    const isJam = scopeOf().kind === "jam";
    const rows = data.participants.map((p) => {
      const open = p.status === "pending" || p.status === "in_progress";
      const actions = [];
      if (open) actions.push(el("button", { class: "hp-btn hp-ghost hp-small", type: "button", text: "Cancel", onclick: async () => {
        await api(`${base}/cancel`, { method: "POST", body: { requestId: p.requestId } }).catch(() => null);
        refresh();
      } }));
      else actions.push(el("button", { class: "hp-btn hp-small", type: "button", text: p.status === "not_requested" ? "Request check" : "Request again", onclick: async (e) => {
        e.target.disabled = true;
        try { await api(`${base}/requests`, { method: "POST", body: isJam ? { jamParticipantId: p.jamParticipantId, timing: "before" } : { participantId: p.participantId, timing: "during" } }); } catch { /* shown on refresh */ }
        refresh();
      } }));
      return el("div", { class: "hp-person" }, [
        el("div", {}, [el("b", { text: p.displayName }), el("div", {}, [el("span", { class: `hp-chip ${p.status}`, text: p.label })])]),
        el("div", {}, actions)
      ]);
    });
    const notice = el("p", { class: "hp-note", text: data.config.notice });
    const auditList = showAudit ? data.audit.map((e) => el("div", { class: "hp-audit", text: `${new Date(e.createdAt).toLocaleTimeString()}  ${e.event.replace(/\./g, " ")}` })) : [];
    panel.replaceChildren(
      el("h3", { text: "Human presence" }), notice,
      ...(rows.length ? rows : [el("p", { class: "hp-note", text: isJam ? "No participants yet." : "No guests are in the room." })]),
      el("div", { class: "hp-row" }, [el("button", { class: "hp-btn hp-ghost hp-small", type: "button", text: showAudit ? "Hide history" : "Show history", onclick: () => { showAudit = !showAudit; refresh(); } })]),
      ...auditList
    );
  }

  fab.addEventListener("click", () => {
    const opening = panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !opening);
    fab.setAttribute("aria-expanded", String(opening));
    clearInterval(timer);
    if (opening) { refresh(); timer = setInterval(refresh, pollMs); }
  });
  return () => { clearInterval(timer); fab.remove(); panel.remove(); };
}
