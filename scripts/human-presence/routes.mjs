// Human Presence Verification HTTP routes. Mounted from render-production-server.mjs with its own helpers
// injected, so this module reuses the server's existing authentication (cookie sessions, Jam invite tokens),
// CSRF/origin checks, rate limiting and SQLite helper rather than inventing parallel infrastructure.
//
// Every route is inert (404) unless HUMAN_PRESENCE_ENABLED=1. The Peeps Jam/Dub/Breadcrumb surface needs
// HUMAN_PRESENCE_PEEPS_ENABLED=1 as well.
import { randomBytes } from "node:crypto";
import {
  CONSENT_VERSION, MAX_CHALLENGES_PER_REQUEST, PROTOCOL_VERSION, REASON_COPY, REQUEST_TTL_MS, STATUS_LABELS,
  assessReceipt, buildReceiptPayload, deriveReceiptKeys, deriveStatus, evaluateEvidence, generateChallenge, getFlags,
  publicChallengeView, resolveVerifier, safeEqual, sha256Hex, signReceipt, subjectRef, validateEvidenceEnvelope
} from "./core.mjs";

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function consentText(flags) {
  return {
    version: CONSENT_VERSION,
    title: "Human presence check",
    points: [
      "Your camera and microphone are used on your device to follow a few quick on screen prompts.",
      "Toasty does not record or store your video, audio, face scan or voice print for this check.",
      "Only a small result summary is kept, for up to " + flags.resultRetentionDays + " days: the outcome, the time and a receipt ID.",
      "Completing the check does not prove who you are or that you are real. Results can be inconclusive and are never used to remove you from a session automatically.",
      "You can decline, and you can delete your result afterwards."
    ]
  };
}

export function createHumanPresence(deps) {
  const {
    db, readSession, sendJson, readJson, httpError, limit, requireCsrf, newId, SAFE_ID,
    loadLiveJamInvite, requireOwnedJam, isPlatformAdmin = () => false, env = process.env, sessionSecret = "", now = () => Date.now()
  } = deps;
  const flags = getFlags(env);
  const keys = deriveReceiptKeys(env, sessionSecret);
  const verifier = () => resolveVerifier(flags.providerId);

  const secretsOk = () => keys.length > 0;

  function requireEnabled() {
    if (!flags.enabled) throw httpError(404, "Not found.");
    if (!secretsOk()) throw httpError(503, "Human presence verification is not configured.");
  }
  function requirePeeps() {
    requireEnabled();
    if (!flags.peepsIntegration) throw httpError(404, "Not found.");
  }

  // Host side callers. In admin only mode (the default) only platform admins may create or read checks, which
  // keeps the first live tests to hand picked sessions. Others get the same 404 as when the feature is off.
  async function hostSession(req, res) {
    const authSession = await readSession(req);
    if (!authSession) { sendJson(req, res, 401, { error: "Sign in to Toasty Studio first." }); return null; }
    if (flags.adminOnly && !isPlatformAdmin(authSession)) { sendJson(req, res, 404, { error: "Not found." }); return null; }
    return authSession;
  }

  function publicConfig() {
    const v = verifier();
    return {
      enabled: flags.enabled && secretsOk(),
      adminOnly: flags.adminOnly,
      peepsIntegration: flags.peepsIntegration && secretsOk(),
      protocol: PROTOCOL_VERSION,
      livenessAnalysis: { active: v.trusted === true, provider: v.trusted === true ? v.id : null },
      resultRetentionDays: flags.resultRetentionDays,
      notice: v.trusted === true
        ? "Checks are analyzed by an approved liveness provider."
        : "Checks run without liveness analysis, so results are always inconclusive."
    };
  }

  // ---- views ----

  function statusFor(item) {
    const result = item.result || null;
    const revoked = Boolean(result?.revokedAt);
    return deriveStatus({ request: item.request, result, now: now(), revoked });
  }

  function requestView(item) {
    const r = item.request;
    const status = statusFor(item);
    return {
      requestId: r.id,
      participantKey: r.participantKey,
      participantLabel: r.participantLabel,
      jamParticipantId: r.jamParticipantId || null,
      timing: r.timing,
      reason: r.reason,
      requestStatus: r.status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      consentAt: r.consentAt,
      attempts: r.attempts,
      status: status.status,
      label: status.label,
      verified: status.verified,
      outcome: status.outcome || null,
      assurance: status.assurance || null,
      receiptId: status.receiptId || null,
      validUntil: status.validUntil || null,
      reasons: (item.result?.reasonCodes || []).map((c) => REASON_COPY[c]).filter(Boolean)
    };
  }

  async function audit(extra) {
    await db("hp_audit_add", { auditId: newId("hpa"), ...extra });
  }

  // ---- participant identity (never trusts a client-supplied identity beyond what the server can check) ----

  async function resolveParticipant(body) {
    if (body.jamId && body.invite) {
      requirePeeps();
      const { participant } = await loadLiveJamInvite(String(body.jamId), body.invite);
      const jam = (await db("jam_get_by_id", { id: participant.jamId })).jam;
      if (!jam) throw httpError(404, "Not found.");
      return {
        kind: "jam", jamId: jam.id, jamParticipantId: participant.id, dubId: participant.dubId || null,
        participantKey: participant.id, sessionId: jam.studioSessionId || null, organizationId: jam.organizationId,
        label: participant.displayName || "Participant"
      };
    }
    const roomId = String(body.roomId || "");
    const participantId = String(body.participantId || "");
    if (!SAFE_ID.test(roomId) || !SAFE_ID.test(participantId)) throw httpError(400, "Invalid participant.");
    const lookup = await db("session_get_by_room", { roomId });
    if (!lookup.sessionId || lookup.status === "ENDED") throw httpError(404, "Not found.");
    const roster = (await db("presence_list", { roomId })).roster || [];
    const entry = roster.find((p) => p.participantId === participantId && p.role === "guest");
    if (!entry) throw httpError(404, "Not found.");
    return {
      kind: "studio", jamId: null, jamParticipantId: null, dubId: null, participantKey: participantId,
      sessionId: lookup.sessionId, organizationId: lookup.organizationId || null, label: entry.displayName || "Guest"
    };
  }

  function sameParticipant(request, who) {
    if (!request) return false;
    if (who.kind === "jam") return request.jamParticipantId === who.jamParticipantId;
    return request.sessionId === who.sessionId && request.participantKey === who.participantKey && !request.jamParticipantId;
  }

  async function loadRequestFor(body, who) {
    const id = String(body.requestId || "");
    if (!SAFE_ID.test(id)) throw httpError(400, "Invalid request.");
    const request = (await db("hp_request_get", { id })).request;
    // Same response for "missing" and "belongs to someone else", so ids cannot be probed.
    if (!request || !sameParticipant(request, who)) throw httpError(404, "Not found.");
    return request;
  }

  // ---- host side ----

  async function createRequest({ who, authSession, timing, reason }) {
    const id = newId("hpq");
    const t = timing === "before" ? "before" : "during";
    const created = await db("hp_request_create", {
      id, auditId: newId("hpa"), organizationId: who.organizationId, sessionId: who.sessionId, jamId: who.jamId,
      jamParticipantId: who.jamParticipantId, dubId: who.dubId, participantKey: who.participantKey,
      participantLabel: who.label, timing: t, reason: String(reason || "").slice(0, 200),
      requestedByUserId: authSession.id, expiresAt: new Date(now() + REQUEST_TTL_MS).toISOString()
    });
    if (created.error === "conflict") throw httpError(409, "A check is already open for this participant.");
    return created.request;
  }

  async function requireOwnedSessionById(authSession, id) {
    if (!SAFE_ID.test(id)) throw httpError(400, "Invalid session id.");
    const result = await db("session_get", { id, ownerUserId: authSession.id });
    if (result.error === "brand_forbidden") throw httpError(403, "This session is outside your account's permitted brand.");
    if (!result.session) throw httpError(404, "Session not found.");
    return result.session;
  }

  async function sessionOverview(session) {
    const listing = (await db("hp_request_list", { sessionId: session.id })).items || [];
    const audit = (await db("hp_audit_list", { sessionId: session.id, limit: 100 })).events || [];
    const roster = ((await db("presence_list", { roomId: session.roomId })).roster || []).filter((p) => p.role === "guest");
    const latestByKey = new Map();
    for (const item of listing) if (!latestByKey.has(item.request.participantKey)) latestByKey.set(item.request.participantKey, item);
    return {
      config: publicConfig(),
      participants: roster.map((p) => {
        const item = latestByKey.get(p.participantId);
        return { participantId: p.participantId, displayName: p.displayName || "Guest", ...(item ? requestView(item) : { status: "not_requested", label: STATUS_LABELS.not_requested, verified: false }) };
      }),
      requests: listing.map(requestView),
      audit
    };
  }

  async function jamOverview(jam) {
    const listing = (await db("hp_request_list", { jamId: jam.id })).items || [];
    const audit = (await db("hp_audit_list", { jamId: jam.id, limit: 100 })).events || [];
    const participants = (await db("jam_participant_list", { jamId: jam.id })).participants || [];
    const latestByKey = new Map();
    for (const item of listing) if (!latestByKey.has(item.request.jamParticipantId)) latestByKey.set(item.request.jamParticipantId, item);
    return {
      config: publicConfig(),
      participants: participants.map((p) => {
        const item = latestByKey.get(p.id);
        return { jamParticipantId: p.id, displayName: p.displayName || "Participant", ...(item ? requestView(item) : { status: "not_requested", label: STATUS_LABELS.not_requested, verified: false }) };
      }),
      requests: listing.map(requestView),
      audit
    };
  }

  // ---- Peeps: Breadcrumb attachment (receipt REFERENCE only, never reused as current proof) ----

  async function attachJamBreadcrumb(request, result) {
    if (!flags.peepsIntegration || !request.jamId || !result) return null;
    const status = deriveStatus({ request, result, now: now() });
    const detail = {
      requestId: request.id, receiptId: result.receiptId, outcome: result.outcome, assurance: result.assurance,
      verified: status.verified, validUntil: result.validUntil, verifierId: result.verifierId, protocol: PROTOCOL_VERSION
    };
    await db("jam_event_create", { id: newId("jev"), jamId: request.jamId, jamParticipantId: request.jamParticipantId, type: "presence.check", detail, actor: "system" });
    if (request.dubId) {
      const peepsReq = (await db("peeps_request_get_by_jam", { jamId: request.jamId })).request;
      await db("peeps_breadcrumb_create", {
        id: newId("bc"), jamId: request.jamId, requestId: peepsReq?.id || "", dubId: request.dubId, jamParticipantId: request.jamParticipantId,
        kind: "presence_check", evidenceClass: status.verified ? "presence_verified" : "presence_unverified", status: "recorded",
        statement: status.verified ? "Human presence check passed with an approved liveness provider" : "Human presence check completed, result inconclusive",
        topics: [], fingerprint: `presence:${result.receiptId}`,
        provenance: { jamId: request.jamId, method: "human_presence_challenge", source: "presence_receipt", receiptId: result.receiptId, validUntil: result.validUntil }
      });
    }
    return detail;
  }

  // ---- route table ----

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const method = req.method;

    if (method === "GET" && path === "/api/human-presence/config") {
      if (!limit(req, res, "hp-config", 120, 60 * 1000)) return true;
      return sendJson(req, res, 200, publicConfig()), true;
    }

    let m;
    // ---------- Studio host ----------
    if ((m = path.match(/^\/api\/sessions\/([^/]+)\/human-presence(\/requests|\/cancel)?$/))) {
      requireEnabled();
      const sub = m[2] || "";
      if (method === "GET" && !sub) {
        if (!limit(req, res, "hp-host-read", 120, 60 * 1000)) return true;
        const authSession = await hostSession(req, res);
        if (!authSession) return true;
        const session = await requireOwnedSessionById(authSession, decodeURIComponent(m[1]));
        return sendJson(req, res, 200, await sessionOverview(session)), true;
      }
      if (method === "POST" && (sub === "/requests" || sub === "/cancel")) {
        if (!requireCsrf(req, res) || !limit(req, res, "hp-host-write", 60, 15 * 60 * 1000)) return true;
        const authSession = await hostSession(req, res);
        if (!authSession) return true;
        const session = await requireOwnedSessionById(authSession, decodeURIComponent(m[1]));
        const body = await readJson(req);
        if (sub === "/cancel") {
          const id = String(body.requestId || "");
          if (!SAFE_ID.test(id)) throw httpError(400, "Invalid request.");
          const existing = (await db("hp_request_get", { id })).request;
          if (!existing || existing.sessionId !== session.id) throw httpError(404, "Not found.");
          const out = await db("hp_request_cancel", { id, auditId: newId("hpa"), actorId: authSession.id });
          return sendJson(req, res, 200, { cancelled: out.cancelled }), true;
        }
        const participantId = String(body.participantId || "");
        if (!SAFE_ID.test(participantId)) throw httpError(400, "Invalid participant.");
        const roster = (await db("presence_list", { roomId: session.roomId })).roster || [];
        const entry = roster.find((p) => p.participantId === participantId && p.role === "guest");
        if (!entry) throw httpError(404, "That guest is not in the room.");
        const who = { kind: "studio", jamId: null, jamParticipantId: null, dubId: null, participantKey: participantId, sessionId: session.id, organizationId: session.organizationId || null, label: entry.displayName || "Guest" };
        const request = await createRequest({ who, authSession, timing: body.timing, reason: body.reason });
        return sendJson(req, res, 201, { request: requestView({ request, result: null }) }), true;
      }
    }

    // ---------- Peeps organizer ----------
    if ((m = path.match(/^\/api\/jams\/([^/]+)\/human-presence(\/requests|\/cancel)?$/))) {
      requirePeeps();
      if (method === "GET" && !m[2]) {
        if (!limit(req, res, "hp-jam-read", 120, 60 * 1000)) return true;
        const authSession = await hostSession(req, res);
        if (!authSession) return true;
        const jam = await requireOwnedJam(req, res, authSession, decodeURIComponent(m[1]), "member");
        if (!jam) return true;
        return sendJson(req, res, 200, await jamOverview(jam)), true;
      }
      if (method === "POST" && m[2]) {
        if (!requireCsrf(req, res) || !limit(req, res, "hp-jam-write", 60, 15 * 60 * 1000)) return true;
        const authSession = await hostSession(req, res);
        if (!authSession) return true;
        const jam = await requireOwnedJam(req, res, authSession, decodeURIComponent(m[1]), "member");
        if (!jam) return true;
        const body = await readJson(req);
        if (m[2] === "/cancel") {
          const id = String(body.requestId || "");
          if (!SAFE_ID.test(id)) throw httpError(400, "Invalid request.");
          const existing = (await db("hp_request_get", { id })).request;
          if (!existing || existing.jamId !== jam.id) throw httpError(404, "Not found.");
          const out = await db("hp_request_cancel", { id, auditId: newId("hpa"), actorId: authSession.id });
          return sendJson(req, res, 200, { cancelled: out.cancelled }), true;
        }
        const pid = String(body.jamParticipantId || "");
        if (!SAFE_ID.test(pid)) throw httpError(400, "Invalid participant.");
        const p = (await db("jam_participant_get", { id: pid })).participant;
        if (!p || p.jamId !== jam.id) throw httpError(404, "Participant not found.");
        const who = { kind: "jam", jamId: jam.id, jamParticipantId: p.id, dubId: p.dubId || null, participantKey: p.id, sessionId: jam.studioSessionId || null, organizationId: jam.organizationId, label: p.displayName || "Participant" };
        const request = await createRequest({ who, authSession, timing: body.timing, reason: body.reason });
        return sendJson(req, res, 201, { request: requestView({ request, result: null }) }), true;
      }
    }

    // ---------- Participant ----------
    if (method === "POST" && /^\/api\/human-presence\/(pending|consent|challenge|respond|delete)$/.test(path)) {
      requireEnabled();
      const action = path.split("/").pop();
      if (!requireCsrf(req, res)) return true;
      const rate = { pending: [120, 60_000], consent: [30, 15 * 60_000], challenge: [12, 15 * 60_000], respond: [24, 15 * 60_000], delete: [12, 15 * 60_000] }[action];
      if (!limit(req, res, `hp-${action}`, rate[0], rate[1])) return true;
      const body = await readJson(req, 16 * 1024);

      if (action === "pending") {
        const who = await resolveParticipant(body);
        const request = (await db("hp_pending_for", { sessionId: who.sessionId, participantKey: who.participantKey, jamParticipantId: who.jamParticipantId })).request;
        if (!request) return sendJson(req, res, 200, { request: null, config: publicConfig() }), true;
        return sendJson(req, res, 200, {
          request: { requestId: request.id, timing: request.timing, status: request.status, expiresAt: request.expiresAt, consented: Boolean(request.consentAt), attemptsLeft: Math.max(0, MAX_CHALLENGES_PER_REQUEST - request.attempts) },
          consent: consentText(flags), config: publicConfig()
        }), true;
      }

      const who = await resolveParticipant(body);

      if (action === "consent") {
        const request = await loadRequestFor(body, who);
        const out = await db("hp_consent", { id: request.id, auditId: newId("hpa"), accepted: body.accepted === true, consentVersion: CONSENT_VERSION, actorId: who.participantKey });
        if (!out.changed) throw httpError(409, "This check is no longer open.");
        return sendJson(req, res, 200, { status: out.request.status }), true;
      }

      if (action === "challenge") {
        const request = await loadRequestFor(body, who);
        if (!request.consentAt) throw httpError(409, "Consent is required before a challenge is issued.");
        const challenge = generateChallenge({ now: now() });
        const out = await db("hp_challenge_issue", {
          id: challenge.record.id, auditId: newId("hpa"), requestId: request.id, secretHash: challenge.record.secretHash,
          nonceHash: challenge.record.nonceHash, steps: challenge.record.steps, issuedAt: challenge.record.issuedAt,
          expiresAt: challenge.record.expiresAt, actorId: who.participantKey
        });
        if (out.error === "busy") throw httpError(429, "A challenge is already active or the attempt limit was reached.");
        if (out.error) throw httpError(409, "This check is no longer open.");
        return sendJson(req, res, 201, publicChallengeView(challenge.record, challenge.clientView)), true;
      }

      if (action === "respond") {
        const challengeId = String(body.challengeId || "");
        const secret = String(body.responseSecret || "");
        if (!SAFE_ID.test(challengeId) || secret.length < 20 || secret.length > 80) throw httpError(400, "Invalid challenge.");
        const consumed = await db("hp_challenge_consume", { id: challengeId, secretHash: sha256Hex(secret), auditId: newId("hpa"), actorId: who.participantKey });
        if (consumed.error) {
          const code = consumed.reason === "expired" ? 410 : 400;
          throw httpError(code, consumed.reason === "expired" ? "This challenge expired. Start a new one." : "This challenge cannot be used.");
        }
        const { challenge, request } = consumed;
        // Session and participant binding: the challenge must belong to THIS participant's open request.
        if (!sameParticipant(request, who)) {
          await audit({ requestId: request.id, sessionId: request.sessionId, jamId: request.jamId, participantKey: request.participantKey, event: "challenge.binding_mismatch", actorKind: "participant", actorId: who.participantKey, detail: { challengeId } });
          throw httpError(404, "Not found.");
        }
        const check = validateEvidenceEnvelope(body.evidence, challenge);
        if (!check.ok || !safeEqual(sha256Hex(body.evidence.nonce), challenge.nonceHash)) {
          await audit({ requestId: request.id, sessionId: request.sessionId, jamId: request.jamId, participantKey: request.participantKey, event: "challenge.evidence_rejected", actorKind: "participant", actorId: who.participantKey, detail: { challengeId, reason: check.ok ? "nonce_mismatch" : check.reasonCodes[0] } });
          throw httpError(400, "The submission was not accepted. Start a new challenge.");
        }
        const elapsedMs = now() - Date.parse(challenge.issuedAt);
        const verdict = await evaluateEvidence({ challenge, evidenceCheck: check, elapsedMs, verifier: verifier() });
        const receiptId = newId("hpr");
        const issuedAt = new Date(now()).toISOString();
        const scopeId = request.jamId || request.sessionId;
        const payload = buildReceiptPayload({ receiptId, requestId: request.id, challenge, result: verdict, scopeId, subject: subjectRef(keys, scopeId, request.participantKey), issuedAt });
        const receipt = signReceipt(payload, keys);
        const stored = await db("hp_result_store", {
          id: newId("hps"), auditId: newId("hpa"), requestId: request.id, challengeId: challenge.id, outcome: verdict.outcome, assurance: verdict.assurance,
          methods: verdict.methods, reasonCodes: verdict.reasonCodes, verifierId: verdict.verifierId, verifierVersion: verdict.verifierVersion,
          verifierTrusted: verdict.verifierTrusted, receiptId, receipt, validUntil: payload.validUntil
        });
        const finalRequest = stored.request ? { ...request, status: stored.request.status } : request;
        await attachJamBreadcrumb({ ...request, dubId: request.dubId || who.dubId }, stored.result).catch(() => null);
        const view = requestView({ request: finalRequest, result: stored.result });
        // The participant sees the same honest label the host sees. There is no client-reported pass anywhere.
        return sendJson(req, res, 200, { status: view.status, label: view.label, verified: view.verified, reasons: view.reasons, receiptId, receipt }), true;
      }

      if (action === "delete") {
        const request = await loadRequestFor(body, who);
        const out = await db("hp_revoke", { requestId: request.id, auditId: newId("hpa"), actorKind: "participant", actorId: who.participantKey });
        return sendJson(req, res, 200, { revoked: out.revoked > 0 }), true;
      }
    }

    // ---------- Receipt verification (for Peeps and other signed in callers) ----------
    if (method === "POST" && path === "/api/human-presence/receipts/verify") {
      requireEnabled();
      if (!requireCsrf(req, res) || !limit(req, res, "hp-receipt-verify", 120, 60 * 1000)) return true;
      const authSession = await hostSession(req, res);
      if (!authSession) return true;
      const body = await readJson(req, 8 * 1024);
      const parsed = assessReceipt(body.receipt, keys, { now: now() });
      if (!parsed.valid) return sendJson(req, res, 200, { valid: false, reason: parsed.reason }), true;
      const stored = await db("hp_result_by_receipt", { receiptId: parsed.payload.rid });
      if (!stored.result || stored.result.revokedAt) return sendJson(req, res, 200, { valid: false, reason: stored.result ? "revoked" : "unknown_receipt" }), true;
      const org = stored.request?.organizationId;
      if (org) {
        const membership = await db("get_membership", { organizationId: org, userId: authSession.id }).catch(() => ({}));
        if (!membership.membership && stored.request.requestedByUserId !== authSession.id) return sendJson(req, res, 404, { error: "Not found." }), true;
      } else if (stored.request?.requestedByUserId !== authSession.id) {
        return sendJson(req, res, 404, { error: "Not found." }), true;
      }
      const status = deriveStatus({ request: stored.request, result: stored.result, now: now() });
      return sendJson(req, res, 200, {
        valid: true, fresh: parsed.fresh, status: status.status, label: status.label, verified: status.verified && parsed.fresh,
        outcome: parsed.payload.outcome, assurance: parsed.payload.assurance, validUntil: parsed.payload.validUntil, receiptId: parsed.payload.rid
      }), true;
    }

    return false;
  }

  async function purgeOnce() {
    if (!flags.enabled) return null;
    return db("hp_purge", { resultRetentionDays: flags.resultRetentionDays, auditRetentionDays: flags.auditRetentionDays });
  }

  let timer = null;
  function startRetentionSweep() {
    if (!flags.enabled || timer) return;
    purgeOnce().catch(() => {});
    timer = setInterval(() => purgeOnce().catch(() => {}), PURGE_INTERVAL_MS);
    timer.unref?.();
  }

  return { handle, flags, publicConfig, purgeOnce, startRetentionSweep, randomBytes };
}
