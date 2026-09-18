#!/usr/bin/env node
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

loadLocalEnv();

const HOST = process.env.TOASTY_RENDER_HOST || "127.0.0.1";
const PORT = Number(process.env.TOASTY_RENDER_PORT || 4174);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const API_TOKEN = process.env.TOASTY_RENDER_TOKEN || "";
const SESSION_SECRET = process.env.TOASTY_SESSION_SECRET || API_TOKEN || "";
const AUTH_DB_PATH = process.env.TOASTY_AUTH_DB || "/var/lib/toasty/toasty.sqlite";
const AUTH_DB_HELPER = process.env.TOASTY_AUTH_DB_HELPER || join(SCRIPT_DIR, "toasty-auth-db.py");
const SESSION_SECONDS = Number(process.env.TOASTY_SESSION_SECONDS || 7 * 24 * 60 * 60);
const COOKIE_NAME = "toasty_session";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://render.toasty.media/integrations/google-drive/oauth/callback";
const TOKEN_ENCRYPTION_KEY = process.env.TOASTY_TOKEN_ENCRYPTION_KEY || SESSION_SECRET;
const GOOGLE_DRIVE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file"
];
const ALLOWED_ORIGINS = new Set([
  "https://toasty.media",
  "https://www.toasty.media",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);
const MAX_UPLOAD_BYTES = Number(process.env.TOASTY_RENDER_MAX_UPLOAD_BYTES || 350 * 1024 * 1024);
const MAX_FILES = Number(process.env.TOASTY_RENDER_MAX_FILES || 20);
const MAX_FILE_BYTES = Number(process.env.TOASTY_RENDER_MAX_FILE_BYTES || 150 * 1024 * 1024);
const MAX_TOTAL_DURATION = Number(process.env.TOASTY_RENDER_MAX_DURATION || 180);
const MAX_SCENES = Number(process.env.TOASTY_RENDER_MAX_SCENES || 40);
const FFMPEG_TIMEOUT_MS = Number(process.env.TOASTY_RENDER_FFMPEG_TIMEOUT_MS || 120000);
const GOOGLE_DOWNLOAD_LIMIT_BYTES = Number(process.env.TOASTY_DRIVE_MAX_DOWNLOAD_BYTES || MAX_FILE_BYTES);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.TOASTY_AI_PRODUCER_MODEL || "claude-sonnet-5";
const ANTHROPIC_TIMEOUT_MS = Number(process.env.TOASTY_AI_PRODUCER_TIMEOUT_MS || 12000);
// DeepSeek is the PREFERRED real-AI provider when configured (see handleAiProducerRespond) — cheap
// enough to actually afford per-show telemetry. Anthropic stays as a second real-AI option if someone
// configures only that. Model/pricing verified against https://api-docs.deepseek.com (2026-09-18):
// deepseek-flash is the current API name (legacy deepseek-v4-flash/deepseek-chat now alias to it).
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.TOASTY_AI_PRODUCER_DEEPSEEK_MODEL || "deepseek-flash";
const DEEPSEEK_TIMEOUT_MS = Number(process.env.TOASTY_AI_PRODUCER_TIMEOUT_MS || 12000);
// Per 1M tokens, from DeepSeek's official pricing page. Peak hours are 01:00-04:00 and 06:00-10:00 UTC,
// Mon-Fri; off-peak is half price and covers most of a US-hours live show.
const DEEPSEEK_PRICING = {
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.60 },
  peak: { cacheHit: 0.006, cacheMiss: 0.30, output: 1.20 }
};
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const scryptAsync = promisify(scrypt);
const execFileAsync = promisify(execFile);
const rateBuckets = new Map();
const TOASTY_EXPERT_DISCOVERY_PRICE = 0.001;
const TOASTY_EXPERT_DISCOVERY_RECIPIENT = process.env.SVM_PAY_TO || process.env.TOASTY_EXPERTS_X402_RECIPIENT || "";
const TOASTY_SOLANA_NETWORK = process.env.TOASTY_SOLANA_NETWORK || "solana-devnet";
const TOASTY_USDC_MINT = process.env.TOASTY_USDC_MINT || "devnet-usdc";
const TOASTY_SOLANA_RPC_URL = process.env.TOASTY_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const TOASTY_SOLANA_PAYER_KEYPAIR = process.env.TOASTY_SOLANA_PAYER_KEYPAIR || process.env.SVM_KEYPAIR_PATH || "";
const TOASTY_MICROTASK_RECIPIENT = process.env.TOASTY_MICROTASK_RECIPIENT || process.env.SVM_PAY_TO || "";
const TOASTY_MICROTASK_RESPONSE_PRICE = Number(process.env.TOASTY_MICROTASK_RESPONSE_PRICE || 0.10);
const TOASTY_EXPERTS = Object.freeze([
  { id: "exp-nadia-maclean", name: "Nadia MacLean", headline: "Canadian soccer business analyst", location: "Toronto, Canada", languages: ["English", "French"], categories: ["Soccer/football", "Media", "Business strategy"], topics: ["canadian premier league", "canada soccer", "soccer business", "sponsorship", "club operations"], sessionPrice: 425, currency: "USDC", verificationState: "Credentials reviewed", reputationScore: 94, completedEngagements: 18 },
  { id: "exp-julien-roche", name: "Julien Roche", headline: "Football journalist covering Canada and CONCACAF", location: "Montreal, Canada", languages: ["English", "French"], categories: ["Soccer/football", "Media"], topics: ["canadian premier league", "concacaf", "canada soccer", "player development", "world cup"], sessionPrice: 325, currency: "USDC", verificationState: "Profile reviewed", reputationScore: 91, completedEngagements: 31 },
  { id: "exp-owen-kerr", name: "Owen Kerr", headline: "Club academy and player pathway consultant", location: "Vancouver, Canada", languages: ["English"], categories: ["Soccer/football", "Business strategy"], topics: ["canadian soccer", "academy development", "scouting", "player pathways", "cpl"], sessionPrice: 500, currency: "USDC", verificationState: "Verified", reputationScore: 96, completedEngagements: 12 },
  { id: "exp-marcus-vale", name: "Marcus Vale", headline: "Solana payments infrastructure operator", location: "Lisbon, Portugal", languages: ["English", "Portuguese"], categories: ["Crypto/Solana", "AI", "Enterprise technology"], topics: ["solana", "usdc", "x402", "agent payments", "stablecoin settlement"], sessionPrice: 650, currency: "USDC", verificationState: "Verified", reputationScore: 97, completedEngagements: 22 },
  { id: "exp-leila-haddad", name: "Dr. Leila Haddad", headline: "Healthcare AI researcher", location: "Boston, United States", languages: ["English", "Arabic"], categories: ["Healthcare/science", "AI"], topics: ["healthcare ai", "clinical evaluation", "medical safety", "digital health"], sessionPrice: 850, currency: "USDC", verificationState: "Verified", reputationScore: 95, completedEngagements: 16 },
  { id: "exp-kenji-sato", name: "Kenji Sato", headline: "Cybersecurity incident response advisor", location: "Seattle, United States", languages: ["English", "Japanese"], categories: ["Cybersecurity", "Enterprise technology"], topics: ["cybersecurity", "incident response", "ransomware", "cloud security"], sessionPrice: 750, currency: "USDC", verificationState: "Verified", reputationScore: 93, completedEngagements: 19 },
  { id: "exp-maya-chen", name: "Maya Chen", headline: "Data center and AI infrastructure strategist", location: "Singapore", languages: ["English", "Mandarin"], categories: ["Data centers/infrastructure", "AI", "Enterprise technology"], topics: ["ai infrastructure", "data centers", "gpu procurement", "energy", "southeast asia"], sessionPrice: 575, currency: "USDC", verificationState: "Profile reviewed", reputationScore: 90, completedEngagements: 14 },
  { id: "exp-sofia-ramos", name: "Sofia Ramos", headline: "Sustainability and climate operations advisor", location: "Mexico City, Mexico", languages: ["English", "Spanish"], categories: ["Sustainability", "Business strategy"], topics: ["sustainability", "carbon accounting", "esg", "supply chain"], sessionPrice: 525, currency: "USDC", verificationState: "Credentials reviewed", reputationScore: 92, completedEngagements: 17 },
  { id: "exp-arun-iyer", name: "Arun Iyer", headline: "Enterprise AI transformation operator", location: "London, United Kingdom", languages: ["English", "Hindi"], categories: ["AI", "Enterprise technology", "Business strategy"], topics: ["enterprise ai", "workflow automation", "agent operations", "procurement"], sessionPrice: 725, currency: "USDC", verificationState: "Profile reviewed", reputationScore: 89, completedEngagements: 21 },
  { id: "exp-camille-price", name: "Camille Price", headline: "Media format strategist and executive producer", location: "New York, United States", languages: ["English"], categories: ["Media", "Business strategy"], topics: ["podcasts", "webinars", "interviews", "executive media", "guest prep"], sessionPrice: 450, currency: "USDC", verificationState: "Profile reviewed", reputationScore: 88, completedEngagements: 27 }
]);

function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = join(dirname(SCRIPT_DIR), name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && !Object.hasOwn(process.env, key)) process.env[key] = value;
    }
  }
}

const server = createServer(async (req, res) => {
  try {
  if (!setCors(req, res)) {
    sendJson(req, res, 403, { error: "Origin is not allowed." });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    sendJson(req, res, 200, { ok: true, authConfigured: authConfigured() });
    return;
  }
  if (req.method === "GET" && req.url === "/auth/session") {
    const session = await readSession(req);
    sendJson(req, res, 200, {
      authenticated: Boolean(session),
      user: session ? publicSessionUser(session) : null
    });
    return;
  }
  if (req.method === "POST" && req.url === "/auth/register") {
    if (!requireCsrf(req, res) || !limit(req, res, "register", 8, 15 * 60 * 1000)) return;
    await handleRegister(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/auth/login") {
    if (!requireCsrf(req, res) || !limit(req, res, "login", 12, 15 * 60 * 1000)) return;
    await handleLogin(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/auth/logout") {
    if (!requireCsrf(req, res)) return;
    clearSession(req, res);
    sendJson(req, res, 200, { authenticated: false });
    return;
  }
  if (req.method === "GET" && req.url === "/integrations/google-drive/status") {
    const session = await requireSession(req, res);
    if (!session) return;
    const account = await googleAccount(session.id);
    sendJson(req, res, 200, {
      configured: googleConfigured(),
      connected: Boolean(account),
      account: account ? publicProviderAccount(account) : null,
      requiredScopes: GOOGLE_DRIVE_SCOPES
    });
    return;
  }
  if (req.method === "POST" && req.url === "/integrations/google-drive/oauth/start") {
    if (!requireCsrf(req, res)) return;
    const session = await requireSession(req, res);
    if (!session) return;
    if (!googleConfigured()) return sendJson(req, res, 503, { error: "Google Drive integration is not configured on the server." });
    const state = signOAuthState({ userId: session.id, nonce: randomUUID(), expires: Math.floor(Date.now() / 1000) + 10 * 60 });
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", GOOGLE_DRIVE_SCOPES.join(" "));
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("state", state);
    sendJson(req, res, 200, { authUrl: authUrl.toString() });
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/integrations/google-drive/oauth/callback")) {
    await handleGoogleCallback(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/integrations/google-drive/disconnect") {
    if (!requireCsrf(req, res)) return;
    const session = await requireSession(req, res);
    if (!session) return;
    await disconnectGoogleDrive(session.id);
    sendJson(req, res, 200, { connected: false });
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/integrations/google-drive/files")) {
    const session = await requireSession(req, res);
    if (!session) return;
    await handleDriveFiles(req, res, session);
    return;
  }
  if (req.method === "GET" && req.url === "/media-assets") {
    const session = await requireSession(req, res);
    if (!session) return;
    const result = await db("list_media_assets", { ownerUserId: session.id, limit: 200 });
    sendJson(req, res, 200, { assets: result.assets || [] });
    return;
  }
  if (req.method === "POST" && req.url === "/media-assets/google-drive/import") {
    if (!requireCsrf(req, res)) return;
    const session = await requireSession(req, res);
    if (!session) return;
    await handleDriveImport(req, res, session);
    return;
  }
  if (req.method === "POST" && req.url === "/api/agent/find-experts") {
    if (!limit(req, res, "experts-find", 60, 15 * 60 * 1000)) return;
    await handleAgentFindExperts(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/experts/enrich-public") {
    if (!limit(req, res, "experts-enrich", 20, 15 * 60 * 1000)) return;
    await handlePublicExpertEnrichment(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/agent/microtasks/settle") {
    if (!limit(req, res, "microtask-settle", 30, 15 * 60 * 1000)) return;
    await handleMicrotaskSettlement(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/ai-producer/respond") {
    if (!limit(req, res, "ai-producer-respond", 30, 5 * 60 * 1000)) return;
    await handleAiProducerRespond(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/transcribe") {
    if (!limit(req, res, "transcribe", 30, 5 * 60 * 1000)) return;
    await handleTranscribe(req, res);
    return;
  }
  // Room presence — see handlePresenceAnnounce's own comment. Deliberately unauthenticated like
  // /api/agent/find-experts above: a Guest has no Toasty account (see studio/guest.html's "No account
  // required"), so this can't require a session the way /media-assets etc. do. Rate-limited per IP instead.
  if (req.method === "POST" && req.url === "/api/presence/announce") {
    if (!limit(req, res, "presence-announce", 60, 60 * 1000)) return;
    await handlePresenceAnnounce(req, res);
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/presence/room")) {
    if (!limit(req, res, "presence-room", 60, 60 * 1000)) return;
    await handlePresenceRoom(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/presence/leave") {
    if (!limit(req, res, "presence-leave", 60, 60 * 1000)) return;
    await handlePresenceLeave(req, res);
    return;
  }
  // LiveSession management — the durable record room_presence was never meant to be (see
  // scripts/toasty-auth-db.py's live_sessions table comment). Authenticated like /media-assets: a
  // Producer's own account, never a Guest's (see requireSession). Ownership always enforced in SQL via
  // owner_user_id, not just checked in this handler — see session_list/session_get/session_end.
  if (req.method === "GET" && (req.url === "/api/sessions" || req.url?.startsWith("/api/sessions?"))) {
    if (!limit(req, res, "sessions-list", 60, 60 * 1000)) return;
    const session = await requireSession(req, res);
    if (!session) return;
    await handleSessionList(req, res, session);
    return;
  }
  if (req.method === "POST" && req.url === "/api/sessions") {
    if (!requireCsrf(req, res) || !limit(req, res, "sessions-create", 20, 15 * 60 * 1000)) return;
    const session = await requireSession(req, res);
    if (!session) return;
    await handleSessionCreate(req, res, session);
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/sessions/")) {
    if (!limit(req, res, "sessions-get", 60, 60 * 1000)) return;
    const session = await requireSession(req, res);
    if (!session) return;
    await handleSessionGet(req, res, session);
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/api/sessions/") && req.url.endsWith("/end")) {
    if (!requireCsrf(req, res) || !limit(req, res, "sessions-end", 20, 15 * 60 * 1000)) return;
    const session = await requireSession(req, res);
    if (!session) return;
    await handleSessionEnd(req, res, session);
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/api/sessions/") && req.url.endsWith("/kick")) {
    if (!requireCsrf(req, res) || !limit(req, res, "sessions-kick", 60, 15 * 60 * 1000)) return;
    const session = await requireSession(req, res);
    if (!session) return;
    await handleSessionKick(req, res, session);
    return;
  }
  if (req.method !== "POST" || req.url !== "/render") {
    sendJson(req, res, 404, { error: "Render helper is running. POST /render to create an MP4." });
    return;
  }
  if (!requireCsrf(req, res)) return;
  if (!(await isAuthorized(req))) {
    sendJson(req, res, 401, { error: "Sign in to render video." });
    return;
  }
  if (Number(req.headers["content-length"] || 0) > MAX_UPLOAD_BYTES) {
    sendJson(req, res, 413, { error: "Render upload is too large." });
    return;
  }

  let workDir;
  try {
    workDir = await mkdtemp(join(tmpdir(), "toasty-render-"));
    const request = new Request(`http://${HOST}:${PORT}/render`, {
      method: "POST",
      headers: req.headers,
      body: Readable.toWeb(req),
      duplex: "half"
    });
    const form = await request.formData();
    const manifestPart = form.get("manifest");
    const manifest = JSON.parse(typeof manifestPart === "string" ? manifestPart : await manifestPart.text());
    validateManifest(manifest);
    const media = await writeMediaFiles({ form, workDir });
    await resolveReferencedMedia({ manifest, media, workDir, userId: (await readSession(req))?.id || null });
    const outputPath = await renderProduction({ manifest, media, workDir });
    const driveOutput = await maybeSaveOutputToDrive({ manifest, outputPath, userId: (await readSession(req))?.id || null });
    const output = await readFile(outputPath);
    setCors(req, res);
    if (driveOutput) res.setHeader("X-Toasty-Drive-File-Id", driveOutput.id);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${safeFileName(manifest.title || "toasty-production")}.mp4"`,
      "Content-Length": output.length
    });
    res.end(output);
  } catch (error) {
    console.error(error);
    sendJson(req, res, error.statusCode || 500, { error: creatorError(error) });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
  } catch (error) {
    console.error(error);
    sendJson(req, res, error.statusCode || 500, { error: creatorError(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Toasty render helper listening on http://${HOST}:${PORT}`);
});

// AI Producer proxy — the ONLY place either API key is used. The browser (js/ai-producer.js's
// BackendAIProducerProvider) sends {instruction, context, persona}; nothing here ever returns a key, a
// raw provider error, or debug detail to the client — only the structured entry plus a `usage` block
// (token counts + an estimated dollar cost) that js/ai-producer.js is expected to surface in Producer
// diagnostics ONLY, never in Host View. Keep this prompt/schema in sync with js/ai-producer.js's
// heuristic provider output shape ({type,title,summary,items,action,sources}) — the Host UI must not
// care which provider produced an entry.
//
// Persona/relationship/tone/autonomy text below is a DELIBERATE DUPLICATE of js/producer-persona.js —
// see that file's own top comment for why: this script is deployed to a separate host as one
// self-contained file (no relative imports elsewhere in this file either), so it can't import across the
// repo boundary. js/producer-persona.js is the canonical wording; keep this in sync with it by hand.
const AI_PRODUCER_BASELINE_PERSONA = `You are Toasty Producer: an experienced live producer sitting just off-camera, typing privately to the host during a real broadcast. Not a chatbot, not an assistant brand — a person who has done this job for years.

Who you are:
- Friendly, relaxed, fast, concise, competent, observant.
- Conversational, not chatbot-like. You talk the way a producer actually types mid-show: short lines, no throat-clearing.
- Useful first, funny second — a joke never replaces an actual answer.
- Comfortable pushing back when the host is wrong or missing something obvious. You are not a yes-man.
- You do not constantly praise the host. Skip the compliments unless something genuinely earns one.
- You understand live production urgency: when something is actually broken or time-critical, you get short, direct, and useful — the personality turns down, not off.
- You know when NOT to interrupt. Silence/brevity is a valid response to a calm show that doesn't need you.
- Profanity, when it shows up in your voice, is contextual — it lands because the moment calls for it, never because you're performing "edgy."

Never invent facts, audience sentiment, or production state that isn't actually in the ShowContext you were given. If you don't know, say so briefly — don't fill the gap with something that sounds plausible.

Never use generic AI-assistant phrasing. Specifically avoid: "Certainly!", "Great question!", "I'd be happy to help.", "As an AI...", or anything else that sounds like a support bot instead of a producer.`;

const AI_PRODUCER_RELATIONSHIP_PROFILES = {
  professional: `Relationship with this host: PROFESSIONAL.
- Polished and restrained. No profanity, even if the host uses it first.
- Minimal teasing — keep banter light-to-none. Warmth comes through competence and attentiveness, not jokes.`,
  friendly: `Relationship with this host: FRIENDLY (default).
- Conversational and warm. Light humor is welcome when the moment allows it.
- Not stiff, not overly familiar — this is a good working relationship, not an old friendship yet.`,
  familiar: `Relationship with this host: FAMILIAR.
- A close producer/host dynamic built over real time working together. Candid, playful, teasing allowed.
- Contextual profanity is allowed and can be met in kind — do not lecture the host about their language and do not treat their swearing as automatically hostile (see the note on profanity below).
- You can tell the host they're being an idiot when it's genuinely warranted — that's part of this relationship, not a violation of it.
- This never becomes hostile, and not every response is a joke. During a relaxed broadcast this reads as friendly, funny, conversational. During an actual production failure or something time-critical, this same closeness reads as short, useful, direct — read the moment, don't default to bit.
- IMPORTANT: profanity from the host is not automatically anger. "You're fucking useless today" said mid-show is very likely affectionate ribbing, not a real complaint — a quick, warm, playful pushback followed by the actual useful answer is the right read, not an apology or a defensive explanation.`,
  custom: `Relationship with this host: CUSTOM.
- No preset profile is configured yet for this custom relationship. Default to the FRIENDLY baseline (conversational, warm, light humor) until specific custom traits are provided.`
};

const AI_PRODUCER_SHOW_TONE_PROFILES = {
  professional: "Show tone: PROFESSIONAL. This is a polished, buttoned-up production regardless of how close you are with the host — keep delivery crisp and composed.",
  conversational: "Show tone: CONVERSATIONAL (default). A normal talking-show register — relaxed but still a real production.",
  relaxed: "Show tone: RELAXED. Low-stakes, casual atmosphere. More room for personality and humor when the relationship allows it.",
  energetic: "Show tone: ENERGETIC. High-tempo, high-energy show. Keep responses punchy and quick — match the pace, don't slow it down."
};

const AI_PRODUCER_ACTION_MODEL_BLOCK = `Every response carries an "action" field describing who it's for:
- "private" (default): a normal producer note to the host. Use this unless the host clearly asked for one of the others.
- "surface_question": promote a specific audience question for the host to address on air.
- "draft_audience_reply": prepare audience-facing reply text, without sending it anywhere.
- "send_to_program": explicitly push a message toward Program Output (audience-visible). Only choose this when the host's instruction clearly asks for it.
Never choose anything other than "private" just because a response mentions the audience — summarizing or curating audience questions FOR THE HOST is still "private". Reserve the other three for when the host is actually asking you to do something audience-facing.`;

function aiProducerAutonomyNote(autonomy) {
  if (autonomy === "autonomous") return `Producer autonomy: AUTONOMOUS. A "send_to_program" action will go out without a manual confirmation click — still only choose it when the host's instruction clearly calls for it.`;
  if (autonomy === "ask_host") return `Producer autonomy: ASK_HOST. A "send_to_program" action will be shown to the host as a confirmation prompt before it goes anywhere — phrase the summary as something awaiting their yes/no.`;
  return `Producer autonomy: DRAFT_ONLY (default). A "send_to_program" action only ever produces a draft the host must manually approve — phrase the summary as a suggestion, not a done deed.`;
}

const AI_PRODUCER_OUTPUT_CONTRACT = `You will receive the host's instruction plus a compact JSON ShowContext (current topic, agenda, recent transcript, recent audience messages, connected guests if any, and your own recent responses).

Respond with ONLY a single JSON object, no markdown fences, no prose outside it, matching exactly:
{"type":"audience_questions|context|transition|timing|research|production_suggestion","title":"short label","summary":"one or two sentences, in YOUR voice per the persona/relationship/tone above","items":[{"from":"optional name","text":"short line"}],"action":"private|surface_question|draft_audience_reply|send_to_program","sources":["optional audience message ids used"]}

Rules:
- For audience questions: filter junk/spam, ignore questions already answered in the transcript, merge near-duplicates, and return at most 3 items. Never expose a numeric score.
- Ground every answer in the ShowContext given — never invent facts, names, or numbers not present in it.
- The host's instruction arrives via speech-to-text and may contain mishearings, especially of names — if a word doesn't match anything in ShowContext but a similar-sounding one does (e.g. a place or company name), reason about it using the real ShowContext rather than treating the odd transcription literally. Never mention that you did this — just answer as if you heard it correctly.
- Keep it glanceable: short summary, at most 3 items.
- If the instruction is unrelated to producing the show, still return valid JSON with type "production_suggestion" and a brief, honest summary.
- "action" defaults to "private" — see the action model above for when to use anything else.`;

function buildAiProducerSystemPrompt(persona = {}) {
  const relationship = Object.hasOwn(AI_PRODUCER_RELATIONSHIP_PROFILES, persona.relationship) ? persona.relationship : "friendly";
  const tone = Object.hasOwn(AI_PRODUCER_SHOW_TONE_PROFILES, persona.tone) ? persona.tone : "conversational";
  let relationshipBlock = AI_PRODUCER_RELATIONSHIP_PROFILES[relationship];
  if (relationship === "custom" && persona.customRelationshipFields && typeof persona.customRelationshipFields === "object") {
    const extra = Object.entries(persona.customRelationshipFields).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join("\n");
    if (extra) relationshipBlock = `${relationshipBlock}\nConfigured custom traits:\n${extra}`;
  }
  return [
    AI_PRODUCER_BASELINE_PERSONA,
    relationshipBlock,
    AI_PRODUCER_SHOW_TONE_PROFILES[tone],
    AI_PRODUCER_ACTION_MODEL_BLOCK,
    aiProducerAutonomyNote(persona.autonomy),
    AI_PRODUCER_OUTPUT_CONTRACT
  ].join("\n\n");
}

const AI_PRODUCER_ENTRY_TYPES = new Set(["audience_questions", "context", "transition", "timing", "research", "production_suggestion"]);
const AI_PRODUCER_ACTION_TYPES = new Set(["private", "surface_question", "draft_audience_reply", "send_to_program"]);

async function handleAiProducerRespond(req, res) {
  if (!DEEPSEEK_API_KEY && !ANTHROPIC_API_KEY) throw httpError(503, "AI Producer isn't configured on the server.");
  const body = await readJson(req);
  const instruction = String(body.instruction || "").trim().slice(0, 2000);
  if (!instruction) throw httpError(400, "Missing instruction.");
  const context = body.context && typeof body.context === "object" ? body.context : {};
  const persona = body.persona && typeof body.persona === "object" ? body.persona : {};
  const userContent = `HOST INSTRUCTION: ${instruction}\n\nSHOW CONTEXT:\n${JSON.stringify(context)}`;
  const systemPrompt = buildAiProducerSystemPrompt(persona);

  // DeepSeek preferred whenever configured — see the DEEPSEEK_API_KEY comment above for why.
  const { text, usage } = DEEPSEEK_API_KEY ? await callDeepSeek(userContent, systemPrompt) : await callAnthropic(userContent, systemPrompt);

  let parsed;
  try {
    const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (error) {
    console.error("AI Producer returned malformed JSON:", text);
    throw httpError(502, "AI Producer returned an unusable response.");
  }
  if (!AI_PRODUCER_ENTRY_TYPES.has(parsed.type)) parsed.type = "production_suggestion";
  if (!AI_PRODUCER_ACTION_TYPES.has(parsed.action)) parsed.action = "private";

  sendJson(req, res, 200, {
    type: parsed.type,
    title: String(parsed.title || "AI Producer").slice(0, 120),
    summary: String(parsed.summary || "").slice(0, 600),
    items: Array.isArray(parsed.items) ? parsed.items.slice(0, 6) : [],
    action: parsed.action,
    sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 20) : [],
    usage
  });
}

// Push-to-talk recorded-audio transcription (see js/talk-to-producer.js's top comment: MediaRecorder
// owns the physical hold's duration client-side; the RECORDED BLOB is authoritative here, not live
// SpeechRecognition, which the client only falls back to if this endpoint fails/is unreachable).
//
// Provider: self-hosted whisper.cpp, tiny.en-q5_1 — chosen after a real measured pilot on this exact
// VPS (1 vCPU/1.9GiB): ~4-5s/clip idle, ~11s under full-core contention, ~132MB peak RSS, and proper-noun
// accuracy no worse than base.en-q5_1 (which cost 2x the latency for no reliable accuracy gain on our
// actual test phrases). Latency is accepted as fine for an asynchronous producer workflow, NOT optimized
// for Siri-style instant response. Raw transcript is kept exactly as whisper.cpp produced it — likely
// misspellings (a real example from the pilot: "Johor" -> "Lahore") are NOT silently corrected here;
// that's ShowContext's job at the reasoning layer (js/producer-persona.js's prompt), which has enough
// surrounding context to reinterpret a plausible mishearing without this endpoint guessing.
//
// One process at a time, on purpose: this is a single shared core also running AI Producer proxying and
// video rendering — two whisper.cpp invocations fighting over it would make both slower, not faster. A
// small bounded queue absorbs two shows hitting PTT at once; beyond that, 429 rather than pile up on a
// box this size.
const WHISPER_CLI_PATH = process.env.WHISPER_CLI_PATH || "";
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || "";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const MAX_TRANSCRIBE_AUDIO_BYTES = 2 * 1024 * 1024; // ~15s of mono voice-bitrate Opus is well under 200KB
const MAX_TRANSCRIBE_CLIP_SECONDS = 30;
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TOASTY_TRANSCRIBE_TIMEOUT_MS || 45000);
const TRANSCRIBE_MAX_CONCURRENT = 1;
const TRANSCRIBE_MAX_QUEUE = 4;
let transcribeActive = 0;
const transcribeQueue = [];

// Bounded FIFO around the one thing this box can only do one of at a time. Rejects with 429 past the
// queue depth instead of letting requests pile up indefinitely on a 1-core VPS.
function withTranscribeSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      transcribeActive += 1;
      fn().then(resolve, reject).finally(() => {
        transcribeActive -= 1;
        transcribeQueue.shift()?.();
      });
    };
    if (transcribeActive < TRANSCRIBE_MAX_CONCURRENT) run();
    else if (transcribeQueue.length < TRANSCRIBE_MAX_QUEUE) transcribeQueue.push(run);
    else reject(httpError(429, "Transcription is busy — try again in a moment."));
  });
}

async function handleTranscribe(req, res) {
  if (!WHISPER_CLI_PATH || !WHISPER_MODEL_PATH) throw httpError(503, "Recorded-audio transcription isn't configured on the server yet.");
  const audio = await readBinaryBody(req, MAX_TRANSCRIBE_AUDIO_BYTES);
  if (!audio.length) throw httpError(400, "No audio received.");

  const workDir = await mkdtemp(join(tmpdir(), "toasty-transcribe-"));
  try {
    const inputPath = join(workDir, "input");
    const wavPath = join(workDir, "audio.wav");
    const textBase = join(workDir, "transcript");
    await writeFile(inputPath, audio);

    const { stdout: durationOut } = await execFileAsync(FFPROBE, ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", inputPath], { timeout: 10000 });
    const durationSeconds = parseFloat(durationOut);
    if (Number.isFinite(durationSeconds) && durationSeconds > MAX_TRANSCRIBE_CLIP_SECONDS) {
      throw httpError(413, `Recording is too long (max ${MAX_TRANSCRIBE_CLIP_SECONDS}s).`);
    }

    // Whisper.cpp wants 16kHz mono 16-bit PCM; MediaRecorder produces WebM/Opus (or MP4/AAC on Safari) —
    // ffmpeg is already a dependency of this exact server (see the /render endpoint), nothing new here.
    await execFileAsync(FFMPEG, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], { timeout: 15000 });

    const transcript = await withTranscribeSlot(async () => {
      await execFileAsync(WHISPER_CLI_PATH, ["-m", WHISPER_MODEL_PATH, "-f", wavPath, "-t", "1", "-otxt", "-of", textBase, "-nt"], { timeout: TRANSCRIBE_TIMEOUT_MS });
      return (await readFile(`${textBase}.txt`, "utf8")).trim();
    });

    if (!transcript) throw httpError(422, "Didn't catch anything in that recording.");
    sendJson(req, res, 200, { transcript });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Extension point, NOT implemented this pass: continuous "show listening" (rolling background transcript
// of program audio, feeding ShowContext so Hottie knows what's been discussed without a PTT hold) would
// reuse this exact pipeline — same ffmpeg conversion, same whisper-cli invocation, same WHISPER_CLI_PATH/
// WHISPER_MODEL_PATH config — but through its OWN queue lane, not withTranscribeSlot above. PTT is a
// human actively waiting on a result; background show-audio chunks can tolerate being 10-30s behind and
// must never make a live PTT request wait behind one. That priority split is real design work for later,
// not something to fake by sharing today's single-slot queue.

async function readBinaryBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "Recording is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function callDeepSeek(userContent, systemPrompt) {
  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
      headers: { "content-type": "application/json", authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        // Non-thinking mode: deepseek-flash defaults to thinking-enabled, which costs more and is
        // slower for zero benefit here — the heuristic pass already did the hard analytical work, this
        // call just has to follow instructions and produce well-formed JSON.
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ]
      })
    });
  } catch (error) {
    console.error("AI Producer (DeepSeek) upstream request failed:", error);
    throw httpError(502, "AI Producer request failed.");
  }
  if (!response.ok) {
    console.error("AI Producer (DeepSeek) upstream error status:", response.status, await response.text().catch(() => ""));
    throw httpError(502, "AI Producer request failed.");
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  const u = data.usage || {};
  const cacheHitTokens = Number(u.prompt_cache_hit_tokens || 0);
  const cacheMissTokens = Number(u.prompt_cache_miss_tokens || 0);
  const completionTokens = Number(u.completion_tokens || 0);
  const rates = deepSeekIsPeakNow() ? DEEPSEEK_PRICING.peak : DEEPSEEK_PRICING.offPeak;
  const estimatedCostUsd = (cacheHitTokens / 1e6) * rates.cacheHit + (cacheMissTokens / 1e6) * rates.cacheMiss + (completionTokens / 1e6) * rates.output;
  return {
    text,
    usage: {
      provider: "deepseek",
      model: DEEPSEEK_MODEL,
      promptTokens: Number(u.prompt_tokens || cacheHitTokens + cacheMissTokens),
      cacheHitTokens,
      cacheMissTokens,
      completionTokens,
      totalTokens: Number(u.total_tokens || 0),
      estimatedCostUsd,
      peak: deepSeekIsPeakNow()
    }
  };
}

// Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday. Everything else (including all weekend hours)
// is off-peak, per DeepSeek's published pricing schedule.
function deepSeekIsPeakNow() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 0 || day === 6) return false;
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

async function callAnthropic(userContent, systemPrompt) {
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 700,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }]
      })
    });
  } catch (error) {
    console.error("AI Producer (Anthropic) upstream request failed:", error);
    throw httpError(502, "AI Producer request failed.");
  }
  if (!response.ok) {
    console.error("AI Producer (Anthropic) upstream error status:", response.status, await response.text().catch(() => ""));
    throw httpError(502, "AI Producer request failed.");
  }
  const data = await response.json();
  const text = data.content?.[0]?.text || "";
  // No verified current Anthropic pricing on hand this session, so this reports real token counts
  // without guessing a dollar figure — token counts are still genuinely useful, an invented cost isn't.
  const u = data.usage || {};
  return {
    text,
    usage: {
      provider: "anthropic",
      model: ANTHROPIC_MODEL,
      promptTokens: Number(u.input_tokens || 0),
      cacheHitTokens: Number(u.cache_read_input_tokens || 0),
      cacheMissTokens: Number(u.input_tokens || 0) - Number(u.cache_read_input_tokens || 0),
      completionTokens: Number(u.output_tokens || 0),
      totalTokens: Number(u.input_tokens || 0) + Number(u.output_tokens || 0),
      estimatedCostUsd: null,
      peak: null
    }
  };
}

async function handleAgentFindExperts(req, res) {
  if (!TOASTY_EXPERT_DISCOVERY_RECIPIENT) {
    sendJson(req, res, 503, { error: "Toasty Commerce x402 recipient is not configured. Set SVM_PAY_TO." });
    return;
  }
  const body = await readJson(req);
  const request = normalizeExpertRequest(body);
  const proof = readDiscoveryPaymentProof(req);
  if (!proof.ok) {
    sendX402DiscoveryRequirement(req, res, proof.reason);
    return;
  }

  await db("record_payment", {
    id: randomUUID(),
    paymentKind: "EXPERT_DISCOVERY",
    rail: "x402-solana-usdc",
    provider: "toasty-experts",
    purpose: "expert discovery and candidate ranking",
    status: "PAYMENT_VERIFIED",
    network: TOASTY_SOLANA_NETWORK,
    payerWallet: proof.payerWallet,
    payeeWallet: TOASTY_EXPERT_DISCOVERY_RECIPIENT,
    amount: TOASTY_EXPERT_DISCOVERY_PRICE,
    currency: "USDC",
    tokenMint: TOASTY_USDC_MINT,
    transactionSignature: proof.transactionSignature,
    paymentRequirement: x402DiscoveryRequirement(),
    paymentSignature: proof.paymentSignature,
    policyDecision: "APPROVED",
    approvalSource: proof.approvalSource,
    metadata: { request, verificationStatus: "VERIFIED" }
  });

  sendJson(req, res, 200, {
    ok: true,
    request,
    payment: {
      paymentKind: "EXPERT_DISCOVERY",
      status: "PAYMENT_VERIFIED",
      amount: TOASTY_EXPERT_DISCOVERY_PRICE,
      currency: "USDC",
      network: TOASTY_SOLANA_NETWORK,
      transactionSignature: proof.transactionSignature
    },
    candidates: rankToastyExperts(request)
  });
}

function sendX402DiscoveryRequirement(req, res, reason = "payment_required") {
  const requirement = x402DiscoveryRequirement(reason);
  setCors(req, res);
  res.writeHead(402, {
    "Content-Type": "application/json",
    "X402-Payment-Required": "true",
    "Payment-Required": Buffer.from(JSON.stringify(requirement)).toString("base64url")
  });
  res.end(JSON.stringify(requirement));
}

function x402DiscoveryRequirement(reason = "payment_required") {
  return {
    status: 402,
    error: "Payment Required",
    reason,
    provider: "toasty-experts",
    action: "find-experts",
    paymentKind: "EXPERT_DISCOVERY",
    purpose: "expert discovery and candidate ranking",
    accepts: [{
      scheme: "exact",
      network: TOASTY_SOLANA_NETWORK,
      asset: "USDC",
      amount: TOASTY_EXPERT_DISCOVERY_PRICE.toFixed(3),
      payTo: TOASTY_EXPERT_DISCOVERY_RECIPIENT
    }],
    submitProofTo: "/api/agent/payments/proof",
    continueWith: "/api/agent/find-experts"
  };
}

function readDiscoveryPaymentProof(req) {
  const paymentSignature = String(req.headers["x-payment-signature"] || "").trim();
  const transactionSignature = String(req.headers["x-solana-transaction-signature"] || paymentSignature).trim();
  const asset = String(req.headers["x-payment-asset"] || "").trim().toUpperCase();
  const amount = Number(req.headers["x-payment-amount"] || 0);
  const payerWallet = String(req.headers["x-payer-wallet"] || "").trim().slice(0, 120);
  const approvalSource = String(req.headers["x-approval-source"] || "POLICY").trim().toUpperCase().slice(0, 40);
  if (!paymentSignature) return { ok: false, reason: "missing_payment_signature" };
  if (asset !== "USDC") return { ok: false, reason: "invalid_asset" };
  if (Math.abs(amount - TOASTY_EXPERT_DISCOVERY_PRICE) > 0.0000001) return { ok: false, reason: "invalid_amount" };
  if (!/^[a-zA-Z0-9._:-]{24,160}$/.test(transactionSignature)) return { ok: false, reason: "invalid_transaction_signature" };
  return { ok: true, paymentSignature, transactionSignature, payerWallet, approvalSource };
}

function normalizeExpertRequest(body = {}) {
  return {
    topic: String(body.topic || "").trim().slice(0, 180),
    description: String(body.description || "").trim().slice(0, 1200),
    expertiseRequired: Array.isArray(body.expertiseRequired)
      ? body.expertiseRequired.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : String(body.expertiseRequired || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20),
    locationPreference: String(body.locationPreference || "").trim().slice(0, 120),
    language: String(body.language || "English").trim().slice(0, 40),
    budget: Number(body.budget || 0),
    engagementType: String(body.engagementType || "Podcast guest").trim().slice(0, 80),
    desiredDateTime: String(body.desiredDateTime || "Flexible").trim().slice(0, 120),
    durationMinutes: Number(body.durationMinutes || 45),
    additionalConstraints: String(body.additionalConstraints || "").trim().slice(0, 600)
  };
}

function rankToastyExperts(request) {
  return TOASTY_EXPERTS.map((expert) => scoreToastyExpert(expert, request))
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);
}

function scoreToastyExpert(expert, request) {
  const requestTerms = tokenizeExpertText([
    request.topic,
    request.description,
    request.locationPreference,
    request.language,
    request.engagementType,
    request.additionalConstraints,
    ...request.expertiseRequired
  ].join(" "));
  const expertTerms = tokenizeExpertText([
    expert.name,
    expert.headline,
    expert.location,
    ...expert.languages,
    ...expert.categories,
    ...expert.topics
  ].join(" "));
  const matchedTerms = [...requestTerms].filter((term) => expertTerms.has(term) || [...expertTerms].some((candidate) => candidate.includes(term) || term.includes(candidate)));
  const budgetFit = !request.budget || request.budget >= expert.sessionPrice;
  const locationFit = request.locationPreference && expert.location.toLowerCase().includes(request.locationPreference.toLowerCase().replace(" preferred", ""));
  const languageFit = expert.languages.includes(request.language);
  const formatFit = String(request.engagementType || "").toLowerCase().includes("podcast") && expert.topics.concat(expert.categories).join(" ").toLowerCase().includes("media");
  const requestText = [...requestTerms].join(" ");
  const expertText = [...expertTerms].join(" ");
  const soccerBoost = requestText.includes("soccer") && expertText.includes("soccer") ? 12 : 0;
  const canadaBoost = (requestText.includes("canada") || requestText.includes("canadian")) && (expertText.includes("canada") || expertText.includes("canadian")) ? 10 : 0;
  const cplBoost = requestText.includes("premier") && requestText.includes("league") && (expertText.includes("cpl") || expertText.includes("premier")) ? 8 : 0;
  const score = Math.max(35, Math.min(98, 46 + matchedTerms.length * 5 + soccerBoost + canadaBoost + cplBoost + (budgetFit ? 7 : -4) + (locationFit ? 8 : 0) + (languageFit ? 5 : 0) + (formatFit ? 5 : 0) + Math.min(8, expert.completedEngagements / 4)));
  return {
    ...expert,
    score: Math.round(score),
    confidence: score >= 88 ? "High" : score >= 72 ? "Medium" : "Exploratory",
    matchReasons: [
      matchedTerms.length ? `Matched terms: ${matchedTerms.slice(0, 5).join(", ")}` : "General category fit",
      budgetFit ? `${expert.sessionPrice} USDC fits budget` : `${expert.sessionPrice} USDC may require negotiation`,
      locationFit ? `Location fit: ${expert.location}` : "",
      `${expert.verificationState}; ${expert.completedEngagements} completed engagements`
    ].filter(Boolean)
  };
}

function tokenizeExpertText(value = "") {
  const stop = new Set(["about", "after", "and", "are", "for", "from", "into", "need", "the", "this", "with"]);
  return new Set(String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((term) => term.length > 2 && !stop.has(term)));
}

async function handlePublicExpertEnrichment(req, res) {
  const profile = await readJson(req);
  const evidence = await enrichPublicProfile(profile);
  sendJson(req, res, 200, {
    ok: true,
    discoveredAt: new Date().toISOString(),
    evidence,
    message: evidence.length ? "Public professional evidence queued for review." : "No reliable public professional evidence found."
  });
}

async function enrichPublicProfile(profile = {}) {
  const name = cleanSearchTerm(profile.name || "");
  const location = cleanSearchTerm(profile.location || "");
  const expertise = Array.isArray(profile.expertise) ? profile.expertise.map(cleanSearchTerm).filter(Boolean) : cleanSearchTerm(profile.expertise || "");
  const identifiers = [profile.linkedinUrl, profile.website, profile.githubUrl].map((value) => String(value || "").trim()).filter(Boolean);
  const expertiseTerms = Array.isArray(expertise) ? expertise : String(expertise).split(",").map(cleanSearchTerm).filter(Boolean);
  const queries = [
    [name, location, expertiseTerms.slice(0, 2).join(" "), "speaker OR podcast OR interview"].filter(Boolean).join(" "),
    [name, expertiseTerms.slice(0, 2).join(" "), "publication OR article OR research"].filter(Boolean).join(" "),
    [name, "company bio OR team page OR advisor"].filter(Boolean).join(" "),
    ...identifiers
  ].filter((query, index, list) => query && list.indexOf(query) === index).slice(0, 5);
  const results = [];
  for (const url of identifiers) {
    try {
      const direct = await fetchPublicProfessionalPage(url);
      if (direct) results.push(direct);
    } catch (error) {
      console.warn("public enrichment direct fetch failed", url, error.message);
    }
  }
  for (const query of queries) {
    try {
      results.push(...await searchPublicWeb(query));
    } catch (error) {
      console.warn("public enrichment search failed", query, error.message);
    }
  }
  return normalizePublicEvidence(results, { name, expertiseTerms });
}

async function fetchPublicProfessionalPage(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 ToastyExperts/0.1 professional-profile-enrichment",
      "Accept": "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) throw new Error(`Fetch failed with HTTP ${response.status}`);
  const html = (await response.text()).slice(0, 300000);
  const sourceTitle = cleanHtmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || safeHost(url));
  const description = cleanHtmlText(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
    ""
  );
  return {
    sourceUrl: url,
    sourceTitle,
    snippet: description || sourceTitle
  };
}

async function searchPublicWeb(query) {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ToastyExpertsBot/0.1 professional-profile-enrichment",
      "Accept": "text/html"
    }
  });
  if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}`);
  const html = await response.text();
  const matches = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.slice(0, 8).map((match) => {
    const sourceUrl = decodeSearchUrl(stripHtml(match[1]));
    return {
      sourceUrl,
      sourceTitle: cleanHtmlText(match[2]),
      snippet: cleanHtmlText(match[3])
    };
  }).filter((item) => item.sourceUrl && isProfessionalSource(item));
}

function normalizePublicEvidence(results, { name, expertiseTerms }) {
  const byClaim = new Map();
  for (const result of results) {
    const category = categorizePublicSource(result);
    const proposedValue = discoveredFact(result, { name, expertiseTerms, category });
    if (!proposedValue) continue;
    const normalized = normalizeClaim(`${category} ${proposedValue}`);
    const existing = byClaim.get(normalized);
    const source = {
      sourceType: sourceTypeForUrl(result.sourceUrl),
      sourceUrl: result.sourceUrl,
      sourceTitle: result.sourceTitle,
      sourceDate: ""
    };
    if (existing) {
      existing.sources = dedupeEvidenceSources([...existing.sources, source]);
      existing.confidence = existing.sources.length > 1 ? "High" : existing.confidence;
      continue;
    }
    byClaim.set(normalized, {
      id: randomUUID(),
      field: fieldForEvidenceCategory(category),
      category,
      proposedValue,
      normalizedValue: normalized,
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl,
      sourceTitle: source.sourceTitle,
      sourceDate: "",
      discoveredAt: new Date().toISOString(),
      confidence: confidenceForEvidence(result),
      status: "PROPOSED",
      sourceConfirmationState: "SOURCE_CONFIRMED",
      distinction: "Source-Confirmed Evidence",
      userEdited: false,
      approvedAt: null,
      sources: [source]
    });
  }
  return [...byClaim.values()].slice(0, 12);
}

async function handleMicrotaskSettlement(req, res) {
  const body = await readJson(req);
  const task = normalizeMicrotask(body.task || {});
  const response = normalizeMicrotaskResponse(body.response || {});
  const amount = Number(body.amount || task.pricePerAcceptedResponse || TOASTY_MICROTASK_RESPONSE_PRICE);
  const recipient = String(body.recipientWallet || response.recipientWallet || TOASTY_MICROTASK_RECIPIENT || "").trim();
  if (!TOASTY_SOLANA_PAYER_KEYPAIR) return sendJson(req, res, 503, { error: "Solana payer keypair is not configured." });
  if (!recipient) return sendJson(req, res, 400, { error: "A recipient wallet is required for microtask settlement." });
  if (!response.accepted) return sendJson(req, res, 400, { error: "Only accepted responses are payable." });
  const settlement = await settleUsdc({ recipient, amount });
  const paymentId = randomUUID();
  await db("record_microtask_settlement", {
    task,
    response: {
      ...response,
      recipientWallet: recipient,
      paymentId,
      paymentStatus: "PAYMENT_RELEASED"
    },
    payment: {
      id: paymentId,
      paymentKind: "HUMAN_JUDGMENT_SETTLEMENT",
      rail: "x402-solana-usdc",
      provider: "toasty-experts",
      purpose: "accepted-human-judgment-response",
      status: "PAYMENT_RELEASED",
      network: TOASTY_SOLANA_NETWORK,
      payerWallet: settlement.payerWallet,
      payeeWallet: recipient,
      amount,
      currency: "USDC",
      tokenMint: TOASTY_USDC_MINT,
      transactionSignature: settlement.transactionSignature,
      policyDecision: "APPROVED",
      approvalSource: "ACCEPTED_RESPONSE",
      metadata: {
        taskId: task.id,
        responseId: response.id,
        verificationStatus: "VERIFIED",
        demonstratedExpertise: response.demonstratedExpertise
      }
    }
  });
  sendJson(req, res, 200, {
    ok: true,
    task,
    response: { ...response, recipientWallet: recipient, paymentId, paymentStatus: "PAYMENT_RELEASED" },
    payment: {
      id: paymentId,
      paymentKind: "HUMAN_JUDGMENT_SETTLEMENT",
      amount,
      currency: "USDC",
      network: TOASTY_SOLANA_NETWORK,
      payer: settlement.payerWallet,
      recipient,
      transactionSignature: settlement.transactionSignature,
      verificationState: "VERIFIED",
      timestamp: new Date().toISOString()
    },
    demonstratedExpertise: response.demonstratedExpertise
  });
}

async function settleUsdc({ recipient, amount }) {
  const keypairPath = resolveHomePath(TOASTY_SOLANA_PAYER_KEYPAIR);
  const payerWallet = (await execFileAsync("solana-keygen", ["pubkey", keypairPath])).stdout.trim();
  const args = [
    "transfer",
    "--fund-recipient",
    "--allow-unfunded-recipient",
    "--url", TOASTY_SOLANA_RPC_URL,
    "--owner", keypairPath,
    TOASTY_USDC_MINT,
    amount.toFixed(3),
    recipient
  ];
  const { stdout, stderr } = await execFileAsync("spl-token", args, { timeout: 60000 });
  const output = `${stdout}\n${stderr}`;
  const transactionSignature = output.match(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{40,100})/)?.[1] || output.match(/\b([1-9A-HJ-NP-Za-km-z]{80,100})\b/)?.[1];
  if (!transactionSignature) throw new Error(`USDC transfer completed without parseable signature: ${output.slice(0, 240)}`);
  return { payerWallet, transactionSignature };
}

function normalizeMicrotask(task) {
  return {
    id: String(task.id || randomUUID()).slice(0, 80),
    prompt: String(task.prompt || "Which podcast title would make you most likely to listen?").trim().slice(0, 1000),
    requirements: Array.isArray(task.requirements) ? task.requirements.map(String).slice(0, 20) : String(task.requirements || "Canadian soccer knowledge").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20),
    responsesRequired: Number(task.responsesRequired || 5),
    pricePerAcceptedResponse: Number(task.pricePerAcceptedResponse || TOASTY_MICROTASK_RESPONSE_PRICE),
    currency: "USDC",
    topic: String(task.topic || "Canadian soccer").trim().slice(0, 120)
  };
}

function normalizeMicrotaskResponse(response) {
  return {
    id: String(response.id || randomUUID()).slice(0, 80),
    contributorId: String(response.contributorId || "exp-nadia-maclean").slice(0, 120),
    contributorName: String(response.contributorName || "Nadia MacLean").slice(0, 160),
    recipientWallet: String(response.recipientWallet || "").trim(),
    answer: String(response.answer || "The title with a clear Canadian Premier League angle is most compelling.").trim().slice(0, 2000),
    accepted: response.accepted !== false,
    demonstratedExpertise: String(response.demonstratedExpertise || "Accepted Canadian soccer judgment").trim().slice(0, 240)
  };
}

function cleanSearchTerm(value = "") {
  return String(value).replace(/[^\p{L}\p{N}\s:./_-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function cleanHtmlText(value = "") {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value = "") {
  return String(value).replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim();
}

function decodeSearchUrl(value = "") {
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.href;
  } catch {
    return value;
  }
}

function isProfessionalSource(item) {
  const text = `${item.sourceUrl} ${item.sourceTitle} ${item.snippet}`.toLowerCase();
  if (/facebook|instagram|tiktok|pinterest|reddit|family|wedding|obituary|arrest|mugshot/.test(text)) return false;
  return /linkedin|github|speaker|conference|event|podcast|interview|publication|research|journal|company|team|advisor|board|association|award|certification|profile|bio|article/.test(text);
}

function categorizePublicSource(item) {
  const text = `${item.sourceUrl} ${item.sourceTitle} ${item.snippet}`.toLowerCase();
  if (/github|repository|project/.test(text)) return "Public project work";
  if (/speaker|conference|event|webinar|panel/.test(text)) return "Speaking";
  if (/podcast|interview|media|youtube/.test(text)) return "Media appearance";
  if (/publication|research|journal|paper|scholar|article|byline/.test(text)) return "Publication / research";
  if (/certification|certificate|award/.test(text)) return "Credential";
  if (/board|advisor|advisory|association/.test(text)) return "Board / advisory role";
  if (/company|team|about|bio|profile/.test(text)) return "Professional bio";
  return "Professional footprint";
}

function discoveredFact(item, { name, expertiseTerms, category }) {
  const title = item.sourceTitle || "";
  const snippet = item.snippet || "";
  const subject = name || "Expert";
  const topic = expertiseTerms?.find((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(`${title} ${snippet}`));
  if (!title && !snippet) return "";
  if (topic) return `${subject} has public ${category.toLowerCase()} evidence related to ${topic}: ${title}`;
  return `${subject} has ${category.toLowerCase()} evidence: ${title || snippet.slice(0, 140)}`;
}

function confidenceForEvidence(item) {
  const host = safeHost(item.sourceUrl);
  if (/edu|gov|org$/.test(host) || /conference|event|speaker|github|journal|company/.test(`${host} ${item.sourceTitle}`.toLowerCase())) return "High";
  return "Medium";
}

function sourceTypeForUrl(url = "") {
  const host = safeHost(url);
  if (host.includes("github")) return "GitHub";
  if (host.includes("linkedin")) return "LinkedIn URL";
  if (/conference|event/.test(host)) return "Event website";
  if (/podcast|youtube|spotify/.test(host)) return "Podcast/interview";
  if (/journal|scholar|research/.test(host)) return "Publication index";
  return "Public web";
}

function safeHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function fieldForEvidenceCategory(category = "") {
  if (/speaking|media|publication|research|credential|board/i.test(category)) return "credentials";
  if (/project|expertise/i.test(category)) return "topics";
  return "profile";
}

function normalizeClaim(value = "") {
  return String(value).toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeEvidenceSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = `${source.sourceUrl}|${source.sourceTitle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveHomePath(path = "") {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function handleRegister(req, res) {
  if (!authConfigured()) return sendJson(req, res, 503, { error: "Studio authentication is not configured." });
  const body = await readJson(req);
  const name = cleanName(body?.name);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || "");
  if (!name || !email || !password) return sendJson(req, res, 400, { error: "Name, email, and password are required." });
  if (!EMAIL_PATTERN.test(email)) return sendJson(req, res, 400, { error: "Enter a valid email address." });
  if (password.length < 10) return sendJson(req, res, 400, { error: "Use a password with at least 10 characters." });
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);
  const result = await db("create_user", { id: userId, name, email, passwordHash });
  if (result.error === "duplicate_email") return sendJson(req, res, 409, { error: "An account with that email already exists." });
  if (!result.user) return sendJson(req, res, 500, { error: "Account could not be created." });
  setSession(req, res, result.user);
  sendJson(req, res, 201, { authenticated: true, user: result.user });
}

async function handleLogin(req, res) {
  if (!authConfigured()) return sendJson(req, res, 503, { error: "Studio authentication is not configured." });
  const body = await readJson(req);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || "");
  if (!email || !password) return sendJson(req, res, 400, { error: "Email and password are required." });
  const result = await db("get_user_by_email", { email });
  const generic = { error: "Incorrect email or password." };
  if (!result.user || result.user.status !== "active" || !(await verifyPassword(password, result.passwordHash))) {
    return sendJson(req, res, 401, generic);
  }
  const login = await db("mark_login", { id: result.user.id });
  const user = login.user || result.user;
  setSession(req, res, user);
  sendJson(req, res, 200, { authenticated: true, user });
}

function authConfigured() {
  return Boolean(SESSION_SECRET);
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(key).toString("hex")}`;
}

async function verifyPassword(password, stored = "") {
  const [method, salt, hash] = String(stored).split("$");
  if (method !== "scrypt" || !salt || !hash) return false;
  const candidate = Buffer.from(await scryptAsync(password, salt, 64));
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function setSession(req, res, user) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    expires
  })).toString("base64url");
  const signature = sign(payload);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${payload}.${signature}; ${cookieAttributes(req)}; Max-Age=${SESSION_SECONDS}`);
}

function clearSession(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; ${cookieAttributes(req)}; Max-Age=0`);
}

function cookieAttributes(req) {
  const secure = isLocalOrigin(req.headers.origin || "") ? "" : " Secure;";
  return `HttpOnly;${secure} SameSite=Lax; Path=/`;
}

async function readSession(req) {
  if (!authConfigured()) return null;
  const cookies = parseCookies(req.headers.cookie || "");
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const suppliedSignature = raw.slice(dot + 1);
  if (!safeStringEqual(suppliedSignature, sign(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(session.expires) <= Math.floor(Date.now() / 1000)) return null;
    const result = await db("get_user_by_id", { id: session.id });
    if (!result.user || result.user.status !== "active") return null;
    return result.user;
  } catch {
    return null;
  }
}

function publicSessionUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email, status: user.status } : null;
}

function googleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && TOKEN_ENCRYPTION_KEY);
}

function publicProviderAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    provider: account.provider,
    providerAccountId: account.provider_account_id,
    accountEmail: account.account_email,
    scope: account.scope,
    status: account.status,
    connectedAt: account.connected_at,
    updatedAt: account.updated_at
  };
}

async function requireSession(req, res) {
  const session = await readSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: "Sign in to Toasty Studio first." });
    return null;
  }
  return session;
}

function signOAuthState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function readOAuthState(value = "") {
  const dot = value.lastIndexOf(".");
  if (dot < 1) throw httpError(400, "Invalid Google OAuth state.");
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!safeStringEqual(signature, sign(body))) throw httpError(400, "Invalid Google OAuth state.");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (Number(payload.expires) <= Math.floor(Date.now() / 1000)) throw httpError(400, "Google OAuth state expired.");
  return payload;
}

async function handleGoogleCallback(req, res) {
  try {
    if (!googleConfigured()) throw httpError(503, "Google Drive integration is not configured on the server.");
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const code = url.searchParams.get("code");
    const state = readOAuthState(url.searchParams.get("state") || "");
    if (!code) throw httpError(400, "Google did not return an authorization code.");
    const token = await googleTokenRequest({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code"
    });
    const profile = await googleApiJson("https://www.googleapis.com/oauth2/v2/userinfo", token.access_token);
    await db("upsert_provider_account", {
      id: randomUUID(),
      ownerUserId: state.userId,
      provider: "google_drive",
      providerAccountId: profile.id,
      accountEmail: profile.email,
      accessTokenEncrypted: encryptSecret(token.access_token),
      refreshTokenEncrypted: token.refresh_token ? encryptSecret(token.refresh_token) : null,
      scope: token.scope,
      tokenType: token.token_type,
      expiresAt: isoFromNow(Number(token.expires_in || 3600)),
      metadata: { name: profile.name, picture: profile.picture }
    });
    res.writeHead(302, { Location: "https://toasty.media/studio/?drive=connected" });
    res.end();
  } catch (error) {
    console.error("Google OAuth callback failed:", creatorError(error));
    res.writeHead(302, { Location: "https://toasty.media/studio/?drive=error" });
    res.end();
  }
}

async function handleDriveFiles(req, res, session) {
  const account = await requireGoogleAccount(session.id);
  const accessToken = await validGoogleAccessToken(session.id, account);
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const query = cleanDriveQuery(url.searchParams.get("q") || "");
  const folderId = cleanDriveId(url.searchParams.get("folderId") || "");
  const pageToken = cleanPageToken(url.searchParams.get("pageToken") || "");
  const api = new URL("https://www.googleapis.com/drive/v3/files");
  const terms = ["trashed = false"];
  if (folderId) terms.push(`'${folderId}' in parents`);
  if (query) terms.push(`name contains '${query.replaceAll("'", "\\'")}'`);
  api.searchParams.set("q", terms.join(" and "));
  api.searchParams.set("pageSize", "50");
  api.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,thumbnailLink,webViewLink,iconLink,parents,createdTime,modifiedTime,videoMediaMetadata,imageMediaMetadata)");
  api.searchParams.set("orderBy", "folder,name");
  if (pageToken) api.searchParams.set("pageToken", pageToken);
  const payload = await googleApiJson(api.toString(), accessToken);
  sendJson(req, res, 200, {
    files: (payload.files || []).map(toDriveFile),
    nextPageToken: payload.nextPageToken || null
  });
}

async function handleDriveImport(req, res, session) {
  const body = await readJson(req);
  const account = await requireGoogleAccount(session.id);
  const accessToken = await validGoogleAccessToken(session.id, account);
  const fileId = cleanDriveId(body?.fileId || "");
  if (!fileId) return sendJson(req, res, 400, { error: "Choose a Google Drive file first." });
  const file = await driveFileMetadata(fileId, accessToken);
  if (!isSupportedDriveMedia(file)) return sendJson(req, res, 400, { error: "Choose a video, image, or audio file." });
  const asset = await db("upsert_media_asset", {
    id: randomUUID(),
    ownerUserId: session.id,
    brandId: cleanOptionalId(body?.brandId),
    provider: "google_drive",
    providerFileId: file.id,
    providerAccountId: account.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size ? Number(file.size) : null,
    duration: file.videoMediaMetadata?.durationMillis ? Number(file.videoMediaMetadata.durationMillis) / 1000 : null,
    width: file.videoMediaMetadata?.width || file.imageMediaMetadata?.width || null,
    height: file.videoMediaMetadata?.height || file.imageMediaMetadata?.height || null,
    thumbnailReference: file.thumbnailLink || null,
    sourceReference: file.webViewLink || null,
    parentFolderReference: file.parents?.[0] || null,
    createdAt: file.createdTime || null,
    modifiedAt: file.modifiedTime || null,
    metadata: {
      iconLink: file.iconLink || null,
      provenance: "google_drive_reference"
    }
  });
  sendJson(req, res, 201, { asset: asset.asset });
}

async function googleAccount(userId) {
  const result = await db("get_provider_account", { ownerUserId: userId, provider: "google_drive" });
  return result.account || null;
}

async function requireGoogleAccount(userId) {
  const result = await db("get_provider_account", { ownerUserId: userId, provider: "google_drive", includeTokens: true });
  if (!result.account) throw httpError(409, "Connect Google Drive first.");
  return result.account;
}

async function disconnectGoogleDrive(userId) {
  const account = await db("get_provider_account", { ownerUserId: userId, provider: "google_drive", includeTokens: true });
  const refreshToken = account.account?.refresh_token_encrypted ? decryptSecret(account.account.refresh_token_encrypted) : null;
  if (refreshToken) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken })
      });
    } catch {
      // Local disconnect still removes Toasty's stored credentials.
    }
  }
  await db("disconnect_provider_account", { ownerUserId: userId, provider: "google_drive" });
}

async function validGoogleAccessToken(userId, account) {
  if (!account.access_token_encrypted) throw httpError(409, "Reconnect Google Drive.");
  if (account.expires_at && new Date(account.expires_at).getTime() > Date.now() + 60_000) {
    return decryptSecret(account.access_token_encrypted);
  }
  if (!account.refresh_token_encrypted) throw httpError(409, "Reconnect Google Drive.");
  const refreshed = await googleTokenRequest({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: decryptSecret(account.refresh_token_encrypted),
    grant_type: "refresh_token"
  });
  await db("upsert_provider_account", {
    id: account.id,
    ownerUserId: userId,
    provider: "google_drive",
    providerAccountId: account.provider_account_id,
    accountEmail: account.account_email,
    accessTokenEncrypted: encryptSecret(refreshed.access_token),
    refreshTokenEncrypted: account.refresh_token_encrypted,
    scope: refreshed.scope || account.scope,
    tokenType: refreshed.token_type || account.token_type,
    expiresAt: isoFromNow(Number(refreshed.expires_in || 3600)),
    metadata: account.metadata || {}
  });
  return refreshed.access_token;
}

async function googleTokenRequest(fields) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(502, payload.error_description || payload.error || "Google OAuth request failed.");
  return payload;
}

async function googleApiJson(url, accessToken) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(response.status, payload.error?.message || "Google Drive request failed.");
  return payload;
}

async function driveFileMetadata(fileId, accessToken) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,size,thumbnailLink,webViewLink,iconLink,parents,createdTime,modifiedTime,videoMediaMetadata,imageMediaMetadata");
  return googleApiJson(url.toString(), accessToken);
}

function toDriveFile(file) {
  const folder = file.mimeType === "application/vnd.google-apps.folder";
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size ? Number(file.size) : null,
    thumbnailLink: file.thumbnailLink || null,
    webViewLink: file.webViewLink || null,
    iconLink: file.iconLink || null,
    parents: file.parents || [],
    createdTime: file.createdTime || null,
    modifiedTime: file.modifiedTime || null,
    width: file.videoMediaMetadata?.width || file.imageMediaMetadata?.width || null,
    height: file.videoMediaMetadata?.height || file.imageMediaMetadata?.height || null,
    duration: file.videoMediaMetadata?.durationMillis ? Number(file.videoMediaMetadata.durationMillis) / 1000 : null,
    isFolder: folder,
    selectable: !folder && isSupportedDriveMedia(file)
  };
}

function isSupportedDriveMedia(file) {
  return /^(video|image|audio)\//.test(file?.mimeType || "");
}

function encryptSecret(value) {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(TOKEN_ENCRYPTION_KEY).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptSecret(value = "") {
  const [version, iv, tag, encrypted] = String(value).split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw httpError(500, "Stored provider token is invalid.");
  const key = createHash("sha256").update(TOKEN_ENCRYPTION_KEY).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function isoFromNow(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function sign(payload) {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function safeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header) {
  return header.split(";").reduce((out, item) => {
    const index = item.indexOf("=");
    if (index > 0) out[item.slice(0, index).trim()] = item.slice(index + 1).trim();
    return out;
  }, {});
}

// Errors the auth-db script returns as legitimate, expected results (not a storage/DB failure) — callers
// branch on result.error themselves for these. Anything else in result.error means the Python side threw
// (see toasty-auth-db.py's own try/except) and really is a storage failure.
const DB_EXPECTED_ERRORS = new Set(["duplicate_email", "kicked", "full"]);

async function db(action, values = {}) {
  const result = await runJson("python3", [AUTH_DB_HELPER], { action, dbPath: AUTH_DB_PATH, ...values });
  if (result.error && !DB_EXPECTED_ERRORS.has(result.error)) throw httpError(500, "Authentication storage is unavailable.");
  return result;
}

// Room presence — Toasty's own record of who is actually in a Studio room, replacing the roomId+"h"
// deterministic-id shortcut a real two-device test proved doesn't scale past the Host (a guest has no way
// to discover ANOTHER guest's id that way) and the VDO-label-based identity guessing that showed a guest's
// real name as "Guest" on Director. VDO.Ninja stays pure media transport; this is what "Toasty owns
// identity" means concretely — see scripts/toasty-auth-db.py's room_presence table and
// js/room-presence.js, the shared client used identically by both js/live-session.js (Host) and
// js/guest.js (Guest) to announce/poll/leave. Deliberately unauthenticated (see the route registration
// above) and rate-limited per IP instead of per-session.
const PRESENCE_ROLES = new Set(["host", "guest"]);

function presenceText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function requirePresenceId(value, label) {
  const id = String(value ?? "");
  if (!SAFE_ID.test(id)) throw httpError(400, `Invalid ${label}.`);
  return id;
}

async function handlePresenceAnnounce(req, res) {
  const body = await readJson(req);
  const roomId = requirePresenceId(body.roomId, "roomId");
  const participantId = requirePresenceId(body.participantId, "participantId");
  const role = String(body.role || "");
  if (!PRESENCE_ROLES.has(role)) throw httpError(400, "Invalid role.");
  let transportSourceId = null;
  if (body.transportSourceId) transportSourceId = requirePresenceId(body.transportSourceId, "transportSourceId");
  // A LiveSession the owner explicitly ENDED must refuse every new admission, host included — "ended"
  // means the room is closed, not just "guests can't join." No-op (status null) for rooms with no
  // live_sessions row at all, so this never breaks a room that predates session tracking.
  const sessionStatus = await db("session_get_by_room", { roomId });
  if (sessionStatus.status === "ENDED") throw httpError(410, "This session has ended.");
  const result = await db("presence_upsert", {
    roomId,
    participantId,
    role,
    displayName: presenceText(body.displayName, 120),
    title: presenceText(body.title, 120),
    company: presenceText(body.company, 120),
    transportSourceId
  });
  // "kicked": this exact participant_id was removed by the Producer and is still within its block window
  // (see scripts/toasty-auth-db.py's presence_upsert) — the client reacts by showing a removed state, not
  // by retrying. "full": a genuinely NEW guest participant_id when the room already has MAX_GUESTS_PER_ROOM
  // — enforced here, not just hidden in UI, so a fourth guest never reaches VDO transport at all.
  if (result.error === "kicked") throw httpError(403, "You have been removed from this session.");
  if (result.error === "full") throw httpError(409, "This session is currently full.");
  await db("session_touch", { roomId });
  sendJson(req, res, 200, { roster: result.roster || [] });
}

async function handlePresenceRoom(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = requirePresenceId(url.searchParams.get("roomId"), "roomId");
  const result = await db("presence_list", { roomId });
  sendJson(req, res, 200, { roster: result.roster || [] });
}

async function handlePresenceLeave(req, res) {
  const body = await readJson(req);
  const roomId = requirePresenceId(body.roomId, "roomId");
  const participantId = requirePresenceId(body.participantId, "participantId");
  await db("presence_leave", { roomId, participantId });
  sendJson(req, res, 200, { ok: true });
}

// ---- LiveSession management (Producer-authenticated) ----
// See scripts/toasty-auth-db.py's live_sessions table comment for the presence-vs-session distinction.

function sessionText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

async function handleSessionCreate(req, res, authSession) {
  const body = await readJson(req);
  const roomId = requirePresenceId(body.roomId, "roomId");
  const id = `ls_${randomUUID().replace(/-/g, "")}`;
  const result = await db("session_create", {
    id,
    roomId,
    ownerUserId: authSession.id,
    brandId: sessionText(body.brandId, 60),
    title: sessionText(body.title, 160)
  });
  sendJson(req, res, 200, { session: result.session });
}

async function handleSessionList(req, res, authSession) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filter = url.searchParams.get("status");
  const statuses = filter === "active" ? ["OPEN", "LIVE"] : filter === "ended" ? ["ENDED"] : undefined;
  const result = await db("session_list", { ownerUserId: authSession.id, statuses });
  sendJson(req, res, 200, { sessions: result.sessions || [] });
}

async function handleSessionGet(req, res, authSession) {
  const id = decodeURIComponent(req.url.slice("/api/sessions/".length));
  if (!SAFE_ID.test(id)) throw httpError(400, "Invalid session id.");
  const result = await db("session_get", { id, ownerUserId: authSession.id });
  if (!result.session) throw httpError(404, "Session not found.");
  sendJson(req, res, 200, { session: result.session });
}

async function handleSessionEnd(req, res, authSession) {
  const path = req.url.slice("/api/sessions/".length, -"/end".length);
  const id = decodeURIComponent(path);
  if (!SAFE_ID.test(id)) throw httpError(400, "Invalid session id.");
  const result = await db("session_end", { id, ownerUserId: authSession.id, endedBy: authSession.id });
  if (!result.session) throw httpError(404, "Session not found.");
  sendJson(req, res, 200, { session: result.session });
}

async function handleSessionKick(req, res, authSession) {
  const path = req.url.slice("/api/sessions/".length, -"/kick".length);
  const id = decodeURIComponent(path);
  if (!SAFE_ID.test(id)) throw httpError(400, "Invalid session id.");
  const body = await readJson(req);
  const participantId = requirePresenceId(body.participantId, "participantId");
  // Ownership check happens HERE, via session_get, before session_kick ever touches room_presence — kick
  // is real removal, not a UI-only hide, so it must be just as owner-scoped as end/get.
  const sessionResult = await db("session_get", { id, ownerUserId: authSession.id });
  if (!sessionResult.session) throw httpError(404, "Session not found.");
  const result = await db("session_kick", { roomId: sessionResult.session.roomId, participantId });
  sendJson(req, res, 200, { roster: result.roster || [] });
}

async function writeMediaFiles({ form, workDir }) {
  const media = new Map();
  const files = form.getAll("media");
  if (files.length > MAX_FILES) throw httpError(413, "Too many media files.");
  for (const file of files) {
    if (!file?.name || typeof file.arrayBuffer !== "function") continue;
    if (file.size > MAX_FILE_BYTES) throw httpError(413, "One media file is too large.");
    const [mediaId, ...nameParts] = file.name.split("__");
    if (!SAFE_ID.test(mediaId || "")) throw httpError(400, "Invalid media id.");
    const fileName = safeFileName(nameParts.join("__") || file.name);
    const filePath = join(workDir, `${mediaId}-${fileName}`);
    await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
    media.set(mediaId, filePath);
  }
  return media;
}

async function resolveReferencedMedia({ manifest, media, workDir, userId }) {
  if (!userId) return;
  const references = new Map();
  for (const asset of manifest.assets || []) {
    if (!asset?.mediaId || media.has(asset.mediaId)) continue;
    if (asset.mediaAssetId) references.set(asset.mediaId, asset.mediaAssetId);
    if (asset.mediaReference?.id) references.set(asset.mediaId, asset.mediaReference.id);
  }
  if (manifest.narrationAudio?.mediaId && !media.has(manifest.narrationAudio.mediaId)) {
    const referenceId = manifest.narrationAudio.mediaAssetId || manifest.narrationAudio.mediaReference?.id;
    if (referenceId) references.set(manifest.narrationAudio.mediaId, referenceId);
  }
  for (const [mediaId, assetId] of references) {
    const result = await db("get_media_asset", { id: assetId, ownerUserId: userId });
    const asset = result.asset;
    if (!asset || asset.status !== "available") throw httpError(409, "A referenced media asset is unavailable.");
    if (asset.provider !== "google_drive") throw httpError(400, "Unsupported media provider.");
    const filePath = await downloadGoogleDriveAsset({ userId, asset, workDir, mediaId });
    media.set(mediaId, filePath);
  }
}

async function downloadGoogleDriveAsset({ userId, asset, workDir, mediaId }) {
  const account = await requireGoogleAccount(userId);
  const accessToken = await validGoogleAccessToken(userId, account);
  if (Number(asset.size || 0) > GOOGLE_DOWNLOAD_LIMIT_BYTES) throw httpError(413, "Referenced Drive media is too large for this render.");
  const metadata = await driveFileMetadata(asset.provider_file_id, accessToken);
  if (!isSupportedDriveMedia(metadata)) throw httpError(400, "Referenced Drive asset is not playable media.");
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.provider_file_id)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw httpError(response.status, "Could not download a referenced Drive asset.");
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    if (size > GOOGLE_DOWNLOAD_LIMIT_BYTES) throw httpError(413, "Referenced Drive media is too large for this render.");
    chunks.push(chunk);
  }
  const filePath = join(workDir, `${mediaId}-${safeFileName(asset.name || "drive-media")}`);
  await writeFile(filePath, Buffer.concat(chunks));
  return filePath;
}

async function maybeSaveOutputToDrive({ manifest, outputPath, userId }) {
  if (!userId || !manifest?.output?.saveToGoogleDrive) return null;
  const account = await googleAccount(userId);
  if (!account) return null;
  const tokenAccount = await requireGoogleAccount(userId);
  const accessToken = await validGoogleAccessToken(userId, tokenAccount);
  const folderId = await ensureDriveFolderPath({
    accessToken,
    parts: ["Toasty", "Productions", safeDriveFolderName(manifest.brandProfile?.name), safeDriveFolderName(manifest.title)]
  });
  const outputName = `${safeFileName(manifest.title || "toasty-production")}.mp4`;
  const file = await uploadDriveFile({ accessToken, folderId, filePath: outputPath, name: outputName, mimeType: "video/mp4" });
  await db("mark_production_output", {
    id: manifest.productionId || randomUUID(),
    ownerUserId: userId,
    brandId: manifest.brandProfile?.id || null,
    title: manifest.title || "Toasty production",
    outputProvider: "google_drive",
    outputProviderFileId: file.id,
    outputReference: file.webViewLink || null,
    metadata: { source: "render_worker" }
  });
  return file;
}

async function ensureDriveFolderPath({ accessToken, parts }) {
  let parent = "root";
  for (const rawPart of parts.filter(Boolean)) {
    const name = safeDriveFolderName(rawPart);
    const existing = await findDriveFolder({ accessToken, parent, name });
    parent = existing?.id || (await createDriveFolder({ accessToken, parent, name })).id;
  }
  return parent;
}

async function findDriveFolder({ accessToken, parent, name }) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `'${parent}' in parents`,
    `name = '${name.replaceAll("'", "\\'")}'`
  ].join(" and "));
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");
  const result = await googleApiJson(url.toString(), accessToken);
  return result.files?.[0] || null;
}

async function createDriveFolder({ accessToken, parent, name }) {
  const response = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parent]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(response.status, payload.error?.message || "Could not create Drive output folder.");
  return payload;
}

async function uploadDriveFile({ accessToken, folderId, filePath, name, mimeType }) {
  const boundary = `toasty-${randomUUID()}`;
  const fileSize = (await stat(filePath)).size;
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const header = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from((async function* () {
    yield header;
    for await (const chunk of createReadStream(filePath)) yield chunk;
    yield footer;
  })());
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(header.length + fileSize + footer.length)
    },
    body,
    duplex: "half"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(response.status, payload.error?.message || "Could not save the finished MP4 to Google Drive.");
  return payload;
}

async function renderProduction({ manifest, media, workDir }) {
  const { width, height } = dimensionsFor(manifest.aspectRatio);
  const sceneFiles = [];
  for (const segment of manifest.timeline) {
    const scene = manifest.productionSpec.scenes.find((candidate) => candidate.id === segment.sceneId);
    const asset = manifest.assets.find((candidate) => candidate.id === segment.primaryVisualAssetId);
    const avatar = manifest.assets.find((candidate) => candidate.id === segment.avatarAssetId);
    const broll = manifest.assets.find((candidate) => candidate.id === segment.brollAssetId);
    const audioSource = manifest.assets.find((candidate) => candidate.id === segment.audioSourceAssetId);
    const output = join(workDir, `scene-${String(segment.order).padStart(2, "0")}.mp4`);
    await renderScene({
      segment,
      scene,
      assetPath: asset?.mediaId ? media.get(asset.mediaId) : null,
      avatarPath: avatar?.mediaId ? media.get(avatar.mediaId) : null,
      brollPath: broll?.mediaId ? media.get(broll.mediaId) : null,
      audioSourcePath: audioSource?.mediaId ? media.get(audioSource.mediaId) : null,
      manifest,
      width,
      height,
      output
    });
    sceneFiles.push(output);
  }

  const listPath = join(workDir, "scenes.txt");
  await writeFile(listPath, sceneFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  const silentVideo = join(workDir, "video-only.mp4");
  await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", silentVideo]);

  const narrationPath = manifest.narrationAudio?.mediaId ? media.get(manifest.narrationAudio.mediaId) : null;
  const outputPath = join(workDir, "toasty-production.mp4");
  if (narrationPath) {
    await run(FFMPEG, [
      "-y",
      "-i", silentVideo,
      "-i", narrationPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      "-movflags", "+faststart",
      outputPath
    ]);
  } else {
    await run(FFMPEG, ["-y", "-i", silentVideo, "-c", "copy", "-movflags", "+faststart", outputPath]);
  }
  return outputPath;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw httpError(400, "Invalid render manifest.");
  if (!Array.isArray(manifest.timeline) || manifest.timeline.length < 1 || manifest.timeline.length > MAX_SCENES) {
    throw httpError(400, "Invalid scene count.");
  }
  if (!Array.isArray(manifest.assets)) throw httpError(400, "Invalid asset list.");
  if (!manifest.productionSpec || !Array.isArray(manifest.productionSpec.scenes)) {
    throw httpError(400, "Invalid production spec.");
  }
  if (!["9:16", "16:9", "1:1"].includes(manifest.aspectRatio)) throw httpError(400, "Invalid aspect ratio.");
  const totalDuration = manifest.timeline.reduce((sum, segment) => {
    if (!SAFE_ID.test(segment.sceneId || "")) throw httpError(400, "Invalid scene id.");
    const duration = Number(segment.duration);
    if (!Number.isFinite(duration) || duration < 1 || duration > MAX_TOTAL_DURATION) throw httpError(400, "Invalid scene duration.");
    [
      segment.primaryVisualAssetId,
      segment.avatarAssetId,
      segment.brollAssetId,
      segment.audioSourceAssetId,
      segment.narrationMediaId
    ].filter(Boolean).forEach((id) => {
      if (!SAFE_ID.test(id)) throw httpError(400, "Invalid asset id.");
    });
    return sum + duration;
  }, 0);
  if (totalDuration > MAX_TOTAL_DURATION) throw httpError(400, "Render is too long.");
  manifest.assets.forEach((asset) => {
    if (asset.id && !SAFE_ID.test(asset.id)) throw httpError(400, "Invalid asset id.");
    if (asset.mediaId && !SAFE_ID.test(asset.mediaId)) throw httpError(400, "Invalid media id.");
  });
}

async function renderScene({ segment, scene, assetPath, avatarPath, brollPath, audioSourcePath, manifest, width, height, output }) {
  const duration = Math.max(1, Number(segment.duration) || 3);
  const caption = segment.caption || scene?.captionText || "";
  const brand = manifest.brandProfile || {};
  const color = normalizeColor(brand.primaryColor || "#ff7a29");
  const overlayPath = join(dirname(output), `overlay-${segment.order}.png`);
  await createOverlayPng({
    width,
    height,
    caption,
    title: titleForSegment({ segment, scene, manifest }),
    lowerThird: segment.lowerThird || "",
    watermark: segment.watermark !== false,
    brandName: brand.name || "Toasty Media",
    website: brand.website || brand.creatorHandle || "",
    color,
    output: overlayPath
  });
  const videoOnly = join(dirname(output), `scene-${String(segment.order).padStart(2, "0")}-video.mp4`);
  const filter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[base];[base][1:v]overlay=0:0`;

  if (segment.composition === "avatar-pip" && avatarPath && brollPath) {
    await renderPipScene({ avatarPath, brollPath, overlayPath, duration, width, height, output: videoOnly });
    await muxSceneAudio({ videoPath: videoOnly, audioPath: audioSourcePath, duration, output });
    return;
  }

  if (!assetPath || segment.composition === "text-card" || segment.composition === "intro-card" || segment.composition === "outro-card") {
    await run(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=${backgroundColor(brand)}:s=${width}x${height}:d=${duration}`,
      "-loop", "1",
      "-i", overlayPath,
      "-filter_complex", "[0:v][1:v]overlay=0:0",
      "-t", String(duration),
      ...videoOutputArgs(videoOnly)
    ]);
    await muxSceneAudio({ videoPath: videoOnly, audioPath: audioSourcePath, duration, output });
    return;
  }

  const loopArgs = isImage(assetPath) ? ["-loop", "1"] : ["-stream_loop", "-1"];
  await run(FFMPEG, [
    "-y",
    ...loopArgs,
    "-i", assetPath,
    "-loop", "1",
    "-i", overlayPath,
    "-t", String(duration),
    "-filter_complex", filter,
    ...videoOutputArgs(videoOnly)
  ]);
  await muxSceneAudio({ videoPath: videoOnly, audioPath: audioSourcePath, duration, output });
}

async function renderPipScene({ avatarPath, brollPath, overlayPath, duration, width, height, output }) {
  const brollLoop = isImage(brollPath) ? ["-loop", "1"] : ["-stream_loop", "-1"];
  const avatarLoop = isImage(avatarPath) ? ["-loop", "1"] : ["-stream_loop", "-1"];
  const pipWidth = Math.round(width * 0.32);
  const pipHeight = Math.round(pipWidth * 16 / 9);
  const filter = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[bg]`,
    `[1:v]scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=increase,crop=${pipWidth}:${pipHeight},setsar=1[pip]`,
    `[bg][pip]overlay=x=W-w-42:y=42:format=auto[pipbg]`,
    `[pipbg][2:v]overlay=0:0`
  ].join(";");
  await run(FFMPEG, [
    "-y",
    ...brollLoop,
    "-i", brollPath,
    ...avatarLoop,
    "-i", avatarPath,
    "-loop", "1",
    "-i", overlayPath,
    "-t", String(duration),
    "-filter_complex", filter,
    ...videoOutputArgs(output)
  ]);
}

async function createOverlayPng(spec) {
  await run("python3", [join(SCRIPT_DIR, "render-overlay.py"), JSON.stringify(spec)]);
}

function videoOutputArgs(output) {
  return [
    "-an",
    "-r", "30",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "veryfast",
    "-movflags", "+faststart",
    output
  ];
}

async function muxSceneAudio({ videoPath, audioPath, duration, output }) {
  if (audioPath) {
    try {
      await run(FFMPEG, [
        "-y",
        "-i", videoPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-t", String(duration),
        "-c:v", "copy",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-shortest",
        "-movflags", "+faststart",
        output
      ]);
      return;
    } catch {
      // Fall back to silent audio for videos with no readable audio stream.
    }
  }
  await run(FFMPEG, [
    "-y",
    "-i", videoPath,
    "-f", "lavfi",
    "-t", String(duration),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    "-movflags", "+faststart",
    output
  ]);
}

function dimensionsFor(aspectRatio) {
  if (aspectRatio === "16:9") return { width: 1280, height: 720 };
  if (aspectRatio === "1:1") return { width: 1080, height: 1080 };
  return { width: 720, height: 1280 };
}

function titleForSegment({ segment, scene, manifest }) {
  if (segment.quickRole === "intro") return scene?.scriptText || manifest.title;
  if (segment.quickRole === "outro") return scene?.scriptText || manifest.productionSpec?.cta || "";
  if (segment.composition === "text-card") return scene?.scriptText || manifest.title;
  return "";
}

function backgroundColor(brand) {
  return normalizeColor(brand.primaryColor || "#171210").replace("#", "0x");
}

function normalizeColor(color) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#ff7a29";
}

function isImage(filePath) {
  return /\.(png|jpe?g|webp|gif)$/i.test(filePath);
}

function safeFileName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "toasty-production";
}

function creatorError(error) {
  if (error.publicMessage) return error.publicMessage;
  if (/ENOENT/.test(error.message)) return "Render helper could not find FFmpeg.";
  if (/timed out/.test(error.message)) return "Render timed out. Try a shorter production or smaller media files.";
  if (/No such file|Invalid data|Error opening/.test(error.message)) return "One of the media files could not be rendered. Try replacing that scene asset.";
  return "Render failed. Check that the local render helper is running and the imported media files are playable.";
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Toasty-Render-Token, X-Toasty-CSRF");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

function sendJson(req, res, status, payload) {
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function isAuthorized(req) {
  if (await readSession(req)) return true;
  if (!API_TOKEN && isLocalOrigin(req.headers.origin)) return true;
  return Boolean(API_TOKEN) && req.headers["x-toasty-render-token"] === API_TOKEN;
}

function isLocalOrigin(origin = "") {
  return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
}

function requireCsrf(req, res) {
  const origin = req.headers.origin || "";
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    sendJson(req, res, 403, { error: "Origin is not allowed." });
    return false;
  }
  if (req.headers["x-toasty-csrf"] !== "1") {
    sendJson(req, res, 403, { error: "Request verification failed." });
    return false;
  }
  return true;
}

function limit(req, res, key, max, windowMs) {
  const now = Date.now();
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const bucketKey = `${key}:${ip}`;
  const bucket = rateBuckets.get(bucketKey) || [];
  const current = bucket.filter((time) => now - time < windowMs);
  current.push(now);
  rateBuckets.set(bucketKey, current);
  if (current.length > max) {
    sendJson(req, res, 429, { error: "Too many attempts. Try again shortly." });
    return false;
  }
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw httpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON request.");
  }
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanDriveQuery(value) {
  return String(value || "").trim().replace(/[\\\r\n]/g, " ").slice(0, 120);
}

function cleanDriveId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{6,200}$/.test(id) ? id : "";
}

function cleanPageToken(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._/-]/g, "").slice(0, 500);
}

function cleanOptionalId(value) {
  const id = String(value || "").trim();
  return SAFE_ID.test(id) ? id : null;
}

function safeDriveFolderName(value) {
  return String(value || "General").trim().replace(/[\\/:*?"<>|\r\n]+/g, "-").replace(/\s+/g, " ").slice(0, 80) || "General";
}

function httpError(statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

function runJson(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `${command} exited with ${code}`));
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, FFMPEG_TIMEOUT_MS);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
  });
}
