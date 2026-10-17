"""Human Presence Verification storage (SQLite), called from toasty-auth-db.py.

Stores metadata only: requests, challenge records (secret and nonce as hashes), result summaries, signed
receipts and an append-only audit log. Raw frames, audio, face templates or landmarks are never accepted
and never stored. Every state change that must be exclusive (consent, challenge issue, challenge
consumption) is a single conditional UPDATE or runs inside BEGIN IMMEDIATE, so replay and races lose.
"""
import json
from datetime import datetime, timedelta, timezone

MAX_CHALLENGES_PER_REQUEST = 5


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _j(value, default):
    try:
        return json.loads(value) if value else default
    except (TypeError, ValueError):
        return default


def migrate(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS presence_requests (
          id TEXT PRIMARY KEY,
          organization_id TEXT,
          session_id TEXT,
          jam_id TEXT,
          jam_participant_id TEXT,
          dub_id TEXT,
          participant_key TEXT NOT NULL,
          participant_label TEXT NOT NULL DEFAULT '',
          timing TEXT NOT NULL DEFAULT 'during',
          reason TEXT NOT NULL DEFAULT '',
          requested_by_user_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          consent_version TEXT,
          consent_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_presence_requests_session ON presence_requests(session_id, participant_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_presence_requests_jam ON presence_requests(jam_id, jam_participant_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS presence_challenges (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES presence_requests(id) ON DELETE CASCADE,
          secret_hash TEXT NOT NULL,
          nonce_hash TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'issued',
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_presence_challenges_request ON presence_challenges(request_id, status)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS presence_results (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES presence_requests(id) ON DELETE CASCADE,
          challenge_id TEXT NOT NULL UNIQUE,
          outcome TEXT NOT NULL,
          assurance TEXT NOT NULL,
          methods_json TEXT NOT NULL DEFAULT '[]',
          reason_codes_json TEXT NOT NULL DEFAULT '[]',
          verifier_id TEXT NOT NULL,
          verifier_version TEXT NOT NULL,
          verifier_trusted INTEGER NOT NULL DEFAULT 0,
          receipt_id TEXT NOT NULL UNIQUE,
          receipt TEXT,
          valid_until TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS presence_audit (
          id TEXT PRIMARY KEY,
          request_id TEXT,
          session_id TEXT,
          jam_id TEXT,
          participant_key TEXT,
          event TEXT NOT NULL,
          actor_kind TEXT NOT NULL DEFAULT '',
          actor_id TEXT NOT NULL DEFAULT '',
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_presence_audit_session ON presence_audit(session_id, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_presence_audit_jam ON presence_audit(jam_id, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_presence_audit_request ON presence_audit(request_id, created_at)")


def _request(row):
    if not row:
        return None
    return {
        "id": row["id"], "organizationId": row["organization_id"], "sessionId": row["session_id"], "jamId": row["jam_id"],
        "jamParticipantId": row["jam_participant_id"], "dubId": row["dub_id"], "participantKey": row["participant_key"],
        "participantLabel": row["participant_label"], "timing": row["timing"], "reason": row["reason"],
        "requestedByUserId": row["requested_by_user_id"], "status": row["status"], "consentVersion": row["consent_version"],
        "consentAt": row["consent_at"], "attempts": row["attempts"], "createdAt": row["created_at"],
        "expiresAt": row["expires_at"], "updatedAt": row["updated_at"],
    }


def _challenge(row):
    if not row:
        return None
    return {
        "id": row["id"], "requestId": row["request_id"], "secretHash": row["secret_hash"], "nonceHash": row["nonce_hash"],
        "steps": _j(row["steps_json"], []), "status": row["status"], "issuedAt": row["issued_at"],
        "expiresAt": row["expires_at"], "consumedAt": row["consumed_at"],
    }


def _result(row):
    if not row:
        return None
    return {
        "id": row["id"], "requestId": row["request_id"], "challengeId": row["challenge_id"], "outcome": row["outcome"],
        "assurance": row["assurance"], "methods": _j(row["methods_json"], []), "reasonCodes": _j(row["reason_codes_json"], []),
        "verifierId": row["verifier_id"], "verifierVersion": row["verifier_version"], "verifierTrusted": bool(row["verifier_trusted"]),
        "receiptId": row["receipt_id"], "receipt": row["receipt"], "validUntil": row["valid_until"],
        "createdAt": row["created_at"], "revokedAt": row["revoked_at"],
    }


def _audit(conn, p, event, actor_kind="", actor_id="", detail=None, request=None):
    conn.execute(
        "INSERT INTO presence_audit (id, request_id, session_id, jam_id, participant_key, event, actor_kind, actor_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            p["auditId"], request["id"] if request else p.get("requestId"), request["session_id"] if request else p.get("sessionId"),
            request["jam_id"] if request else p.get("jamId"), request["participant_key"] if request else p.get("participantKey"),
            event, actor_kind, actor_id, json.dumps(detail or {}), _now(),
        ),
    )


def _expire_stale(conn, now):
    conn.execute("UPDATE presence_challenges SET status='expired' WHERE status='issued' AND expires_at <= ?", (now,))
    conn.execute(
        "UPDATE presence_requests SET status='expired', updated_at=? WHERE status IN ('pending','consented','in_progress') AND expires_at <= ?",
        (now, now),
    )


def handle(conn, action, p):
    """Returns a dict for an hp_* action, or None when the action is not ours."""
    if not action.startswith("hp_"):
        return None
    # This module owns its transaction boundaries (BEGIN IMMEDIATE below), so switch to autocommit mode.
    conn.isolation_level = None

    if action == "hp_request_create":
        now = _now()
        _expire_stale(conn, now)
        conn.execute("BEGIN IMMEDIATE")
        try:
            open_row = conn.execute(
                """SELECT id FROM presence_requests WHERE participant_key = ? AND COALESCE(session_id,'') = COALESCE(?,'')
                   AND COALESCE(jam_id,'') = COALESCE(?,'') AND status IN ('pending','consented','in_progress')""",
                (p["participantKey"], p.get("sessionId"), p.get("jamId")),
            ).fetchone()
            if open_row:
                conn.execute("ROLLBACK")
                return {"error": "conflict", "requestId": open_row["id"]}
            conn.execute(
                """INSERT INTO presence_requests (id, organization_id, session_id, jam_id, jam_participant_id, dub_id, participant_key,
                   participant_label, timing, reason, requested_by_user_id, status, created_at, expires_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?,?,?)""",
                (p["id"], p.get("organizationId"), p.get("sessionId"), p.get("jamId"), p.get("jamParticipantId"), p.get("dubId"),
                 p["participantKey"], (p.get("participantLabel") or "")[:120], p.get("timing") or "during", (p.get("reason") or "")[:200],
                 p.get("requestedByUserId"), now, p["expiresAt"], now),
            )
            row = conn.execute("SELECT * FROM presence_requests WHERE id = ?", (p["id"],)).fetchone()
            _audit(conn, p, "request.created", "host", p.get("requestedByUserId") or "", {"timing": p.get("timing") or "during"}, row)
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        return {"request": _request(row)}

    if action == "hp_request_get":
        _expire_stale(conn, _now())
        conn.commit()
        return {"request": _request(conn.execute("SELECT * FROM presence_requests WHERE id = ?", (p["id"],)).fetchone())}

    if action == "hp_request_list":
        now = _now()
        _expire_stale(conn, now)
        conn.commit()
        if p.get("sessionId"):
            rows = conn.execute("SELECT * FROM presence_requests WHERE session_id = ? ORDER BY created_at DESC LIMIT 200", (p["sessionId"],)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM presence_requests WHERE jam_id = ? ORDER BY created_at DESC LIMIT 200", (p["jamId"],)).fetchall()
        out = []
        for row in rows:
            res = conn.execute("SELECT * FROM presence_results WHERE request_id = ? ORDER BY created_at DESC LIMIT 1", (row["id"],)).fetchone()
            r = _result(res)
            if r:
                r.pop("receipt", None)
            out.append({"request": _request(row), "result": r})
        return {"items": out}

    if action == "hp_pending_for":
        _expire_stale(conn, _now())
        conn.commit()
        if p.get("jamParticipantId"):
            row = conn.execute(
                "SELECT * FROM presence_requests WHERE jam_participant_id = ? AND status IN ('pending','consented','in_progress') ORDER BY created_at DESC LIMIT 1",
                (p["jamParticipantId"],),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM presence_requests WHERE session_id = ? AND participant_key = ? AND status IN ('pending','consented','in_progress') ORDER BY created_at DESC LIMIT 1",
                (p["sessionId"], p["participantKey"]),
            ).fetchone()
        return {"request": _request(row)}

    if action == "hp_request_cancel":
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            "UPDATE presence_requests SET status='cancelled', updated_at=? WHERE id=? AND status IN ('pending','consented','in_progress')",
            (_now(), p["id"]),
        )
        row = conn.execute("SELECT * FROM presence_requests WHERE id = ?", (p["id"],)).fetchone()
        if cur.rowcount == 1:
            conn.execute("UPDATE presence_challenges SET status='expired' WHERE request_id=? AND status='issued'", (p["id"],))
            _audit(conn, p, "request.cancelled", "host", p.get("actorId") or "", {}, row)
        conn.execute("COMMIT")
        return {"cancelled": cur.rowcount == 1, "request": _request(row)}

    if action == "hp_consent":
        now = _now()
        conn.execute("BEGIN IMMEDIATE")
        accepted = bool(p.get("accepted"))
        if accepted:
            cur = conn.execute(
                "UPDATE presence_requests SET status='consented', consent_version=?, consent_at=?, updated_at=? WHERE id=? AND status='pending' AND expires_at > ?",
                (p["consentVersion"], now, now, p["id"], now),
            )
        else:
            cur = conn.execute(
                "UPDATE presence_requests SET status='declined', updated_at=? WHERE id=? AND status IN ('pending','consented') AND expires_at > ?",
                (now, p["id"], now),
            )
        row = conn.execute("SELECT * FROM presence_requests WHERE id = ?", (p["id"],)).fetchone()
        if cur.rowcount == 1:
            _audit(conn, p, "consent.accepted" if accepted else "consent.declined", "participant", p.get("actorId") or "", {"version": p.get("consentVersion")}, row)
        conn.execute("COMMIT")
        return {"changed": cur.rowcount == 1, "request": _request(row)}

    if action == "hp_challenge_issue":
        now = _now()
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("UPDATE presence_challenges SET status='expired' WHERE status='issued' AND expires_at <= ?", (now,))
            row = conn.execute("SELECT * FROM presence_requests WHERE id = ?", (p["requestId"],)).fetchone()
            if not row:
                conn.execute("ROLLBACK")
                return {"error": "not_found"}
            if row["status"] not in ("consented", "in_progress") or row["expires_at"] <= now:
                conn.execute("ROLLBACK")
                return {"error": "invalid_state"}
            if row["attempts"] >= MAX_CHALLENGES_PER_REQUEST:
                conn.execute("ROLLBACK")
                return {"error": "busy"}
            live = conn.execute("SELECT 1 FROM presence_challenges WHERE request_id=? AND status='issued'", (p["requestId"],)).fetchone()
            if live:
                # One live challenge at a time: a second start never mints a second answerable challenge.
                conn.execute("ROLLBACK")
                return {"error": "busy"}
            conn.execute(
                "INSERT INTO presence_challenges (id, request_id, secret_hash, nonce_hash, steps_json, status, issued_at, expires_at) VALUES (?,?,?,?,?, 'issued', ?,?)",
                (p["id"], p["requestId"], p["secretHash"], p["nonceHash"], json.dumps(p["steps"]), p["issuedAt"], p["expiresAt"]),
            )
            conn.execute("UPDATE presence_requests SET status='in_progress', attempts=attempts+1, updated_at=? WHERE id=?", (now, p["requestId"]))
            _audit(conn, p, "challenge.issued", "participant", p.get("actorId") or "", {"challengeId": p["id"], "types": [s["type"] for s in p["steps"]]}, row)
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        return {"ok": True}

    if action == "hp_challenge_consume":
        # Atomic, single-winner consumption. A second submit, a wrong secret or an expired challenge changes nothing.
        now = _now()
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            "UPDATE presence_challenges SET status='consumed', consumed_at=? WHERE id=? AND status='issued' AND consumed_at IS NULL AND secret_hash=? AND expires_at > ?",
            (now, p["id"], p["secretHash"], now),
        )
        ch = conn.execute("SELECT * FROM presence_challenges WHERE id = ?", (p["id"],)).fetchone()
        req = conn.execute("SELECT * FROM presence_requests WHERE id = ?", (ch["request_id"],)).fetchone() if ch else None
        if cur.rowcount == 1:
            conn.execute("COMMIT")
            return {"challenge": _challenge(ch), "request": _request(req)}
        reason = "not_found"
        if ch:
            if ch["secret_hash"] != p["secretHash"]:
                reason = "bad_secret"
            elif ch["consumed_at"] or ch["status"] == "consumed":
                reason = "replayed"
            elif ch["expires_at"] <= now or ch["status"] == "expired":
                reason = "expired"
                conn.execute("UPDATE presence_challenges SET status='expired' WHERE id=? AND status='issued'", (p["id"],))
            else:
                reason = "invalid_state"
            if req:
                _audit(conn, p, "challenge.rejected", "participant", p.get("actorId") or "", {"challengeId": p["id"], "reason": reason}, req)
        conn.execute("COMMIT")
        return {"error": "bad_challenge", "reason": reason}

    if action == "hp_result_store":
        now = _now()
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                """INSERT INTO presence_results (id, request_id, challenge_id, outcome, assurance, methods_json, reason_codes_json, verifier_id,
                   verifier_version, verifier_trusted, receipt_id, receipt, valid_until, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (p["id"], p["requestId"], p["challengeId"], p["outcome"], p["assurance"], json.dumps(p["methods"]), json.dumps(p["reasonCodes"]),
                 p["verifierId"], p["verifierVersion"], 1 if p["verifierTrusted"] else 0, p["receiptId"], p["receipt"], p["validUntil"], now),
            )
            conn.execute("UPDATE presence_requests SET status='completed', updated_at=? WHERE id=?", (now, p["requestId"]))
            row = conn.execute("SELECT * FROM presence_requests WHERE id = ?", (p["requestId"],)).fetchone()
            _audit(conn, p, "result.recorded", "system", "", {"outcome": p["outcome"], "assurance": p["assurance"], "receiptId": p["receiptId"], "reasonCodes": p["reasonCodes"]}, row)
            res = conn.execute("SELECT * FROM presence_results WHERE id = ?", (p["id"],)).fetchone()
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        return {"result": _result(res), "request": _request(row)}

    if action == "hp_result_latest":
        row = conn.execute(
            "SELECT * FROM presence_results WHERE request_id = ? ORDER BY created_at DESC LIMIT 1", (p["requestId"],)
        ).fetchone()
        return {"result": _result(row)}

    if action == "hp_result_by_receipt":
        row = conn.execute("SELECT * FROM presence_results WHERE receipt_id = ?", (p["receiptId"],)).fetchone()
        req = conn.execute("SELECT * FROM presence_requests WHERE id = ?", (row["request_id"],)).fetchone() if row else None
        return {"result": _result(row), "request": _request(req)}

    if action == "hp_revoke":
        # Participant-initiated deletion: the receipt stops validating and the stored receipt body is erased.
        now = _now()
        conn.execute("BEGIN IMMEDIATE")
        req = conn.execute("SELECT * FROM presence_requests WHERE id = ?", (p["requestId"],)).fetchone()
        cur = conn.execute("UPDATE presence_results SET revoked_at=?, receipt=NULL WHERE request_id=? AND revoked_at IS NULL", (now, p["requestId"]))
        if req and cur.rowcount > 0:
            conn.execute("UPDATE presence_requests SET status='revoked', updated_at=? WHERE id=?", (now, p["requestId"]))
            _audit(conn, p, "result.revoked", p.get("actorKind") or "participant", p.get("actorId") or "", {"results": cur.rowcount}, req)
        conn.execute("COMMIT")
        return {"revoked": cur.rowcount}

    if action == "hp_audit_list":
        if p.get("sessionId"):
            rows = conn.execute("SELECT * FROM presence_audit WHERE session_id = ? ORDER BY created_at DESC LIMIT ?", (p["sessionId"], int(p.get("limit") or 100))).fetchall()
        else:
            rows = conn.execute("SELECT * FROM presence_audit WHERE jam_id = ? ORDER BY created_at DESC LIMIT ?", (p["jamId"], int(p.get("limit") or 100))).fetchall()
        return {"events": [
            {"id": r["id"], "requestId": r["request_id"], "participantKey": r["participant_key"], "event": r["event"],
             "actorKind": r["actor_kind"], "detail": _j(r["detail_json"], {}), "createdAt": r["created_at"]} for r in rows
        ]}

    if action == "hp_audit_add":
        _audit(conn, p, p["event"], p.get("actorKind") or "", p.get("actorId") or "", p.get("detail") or {})
        conn.commit()
        return {"ok": True}

    if action == "hp_purge":
        cutoff = (datetime.now(timezone.utc) - timedelta(days=int(p["resultRetentionDays"]))).isoformat(timespec="milliseconds")
        audit_cutoff = (datetime.now(timezone.utc) - timedelta(days=int(p["auditRetentionDays"]))).isoformat(timespec="milliseconds")
        conn.execute("BEGIN IMMEDIATE")
        r1 = conn.execute("DELETE FROM presence_requests WHERE created_at < ? AND status IN ('completed','declined','cancelled','expired','revoked')", (cutoff,)).rowcount
        r2 = conn.execute("DELETE FROM presence_audit WHERE created_at < ?", (audit_cutoff,)).rowcount
        conn.execute("COMMIT")
        return {"requestsDeleted": r1, "auditDeleted": r2}

    return {"error": "invalid_status", "detail": "unknown presence action"}
