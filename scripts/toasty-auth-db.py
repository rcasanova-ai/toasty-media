#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Room presence entries older than this with no fresh announce/heartbeat are treated as gone — see
# presence_upsert/presence_list, which both delete stale rows for the room before returning the roster.
# Clients (js/room-presence.js) announce/poll well under half this window so a few missed round trips never
# flip someone to "left" by accident.
PRESENCE_TTL_SECONDS = 20
# 1 Host + this many Guests = max on-camera participants — enforced here (presence_upsert), not just in
# UI. A 4th distinct guest participant_id is refused before it's ever admitted to room_presence.
MAX_GUESTS_PER_ROOM = 3
# How long a kick blocks its exact participant_id from re-announcing. Generous relative to the 5s
# heartbeat interval so a kicked tab's next few heartbeats are reliably caught, short enough that it
# can't permanently wedge a room if a participant_id is ever accidentally reused.
KICK_BLOCK_SECONDS = 300
# Must stay in sync with js/brand-themes.js's BRAND_THEMES keys. Invalid IDs must never be stored:
# frontend normalizeBrandTheme falls back to Toasty, which would silently undress a locked customer.
KNOWN_BRAND_IDS = frozenset({"toasty", "8alta", "santati", "optimai", "tangem", "superteam", "peeps"})


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_path):
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def migrate(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT,
          status TEXT NOT NULL DEFAULT 'active'
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS provider_accounts (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_account_id TEXT,
          account_email TEXT,
          access_token_encrypted TEXT,
          refresh_token_encrypted TEXT,
          scope TEXT,
          token_type TEXT,
          expires_at TEXT,
          status TEXT NOT NULL DEFAULT 'connected',
          connected_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          disconnected_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_owner_provider
        ON provider_accounts(owner_user_id, provider)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS media_assets (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          brand_id TEXT,
          provider TEXT NOT NULL,
          provider_file_id TEXT,
          provider_account_id TEXT,
          name TEXT NOT NULL,
          mime_type TEXT,
          size INTEGER,
          duration REAL,
          width INTEGER,
          height INTEGER,
          thumbnail_reference TEXT,
          source_reference TEXT,
          parent_folder_reference TEXT,
          created_at TEXT,
          modified_at TEXT,
          imported_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'available',
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(provider_account_id) REFERENCES provider_accounts(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_media_assets_owner ON media_assets(owner_user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_media_assets_provider_file ON media_assets(provider, provider_file_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS productions (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          brand_id TEXT,
          title TEXT NOT NULL,
          output_provider TEXT,
          output_provider_file_id TEXT,
          output_reference TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS experts (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT,
          name TEXT NOT NULL,
          avatar_reference TEXT,
          headline TEXT NOT NULL,
          bio TEXT,
          location TEXT,
          languages TEXT NOT NULL DEFAULT '[]',
          experience TEXT NOT NULL DEFAULT '[]',
          organizations TEXT NOT NULL DEFAULT '[]',
          education TEXT NOT NULL DEFAULT '[]',
          publications TEXT NOT NULL DEFAULT '[]',
          research TEXT NOT NULL DEFAULT '[]',
          speaking_experience TEXT NOT NULL DEFAULT '[]',
          media_appearances TEXT NOT NULL DEFAULT '[]',
          links TEXT NOT NULL DEFAULT '[]',
          linkedin_url TEXT,
          website_url TEXT,
          github_url TEXT,
          cv_reference TEXT,
          availability TEXT,
          hourly_price REAL,
          session_price REAL,
          currency TEXT NOT NULL DEFAULT 'USDC',
          preferred_engagement_types TEXT NOT NULL DEFAULT '[]',
          verification_state TEXT NOT NULL DEFAULT 'Unverified',
          reputation_score REAL NOT NULL DEFAULT 0,
          completed_engagements INTEGER NOT NULL DEFAULT 0,
          wallet_address TEXT,
          visibility TEXT NOT NULL DEFAULT 'public',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_experts_visibility ON experts(visibility)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_experts_verification ON experts(verification_state)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS expert_topics (
          id TEXT PRIMARY KEY,
          expert_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          topic_type TEXT NOT NULL DEFAULT 'skill',
          weight REAL NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          FOREIGN KEY(expert_id) REFERENCES experts(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_expert_topics_topic ON expert_topics(topic)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS expert_credentials (
          id TEXT PRIMARY KEY,
          expert_id TEXT NOT NULL,
          title TEXT NOT NULL,
          issuer TEXT,
          credential_type TEXT,
          evidence_reference TEXT,
          verification_state TEXT NOT NULL DEFAULT 'Unverified',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(expert_id) REFERENCES experts(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS expert_documents (
          id TEXT PRIMARY KEY,
          expert_id TEXT NOT NULL,
          owner_user_id TEXT,
          document_type TEXT NOT NULL,
          storage_reference TEXT NOT NULL,
          visibility TEXT NOT NULL DEFAULT 'private',
          created_at TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(expert_id) REFERENCES experts(id) ON DELETE CASCADE,
          FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS profile_evidence (
          id TEXT PRIMARY KEY,
          expert_id TEXT,
          field TEXT NOT NULL,
          category TEXT NOT NULL,
          proposed_value TEXT NOT NULL,
          normalized_value TEXT,
          source_type TEXT NOT NULL,
          source_url TEXT,
          source_title TEXT,
          source_date TEXT,
          discovered_at TEXT NOT NULL,
          confidence TEXT NOT NULL DEFAULT 'Low',
          status TEXT NOT NULL DEFAULT 'PROPOSED',
          distinction TEXT NOT NULL DEFAULT 'Claimed Expertise',
          user_edited INTEGER NOT NULL DEFAULT 0,
          approved_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(expert_id) REFERENCES experts(id) ON DELETE CASCADE
        )
        """
    )
    ensure_columns(conn, "profile_evidence", {
        "expert_id": "TEXT",
        "field": "TEXT NOT NULL DEFAULT 'profile'",
        "category": "TEXT NOT NULL DEFAULT 'Professional footprint'",
        "proposed_value": "TEXT NOT NULL DEFAULT ''",
        "normalized_value": "TEXT",
        "source_type": "TEXT NOT NULL DEFAULT 'Public source'",
        "source_url": "TEXT",
        "source_title": "TEXT",
        "source_date": "TEXT",
        "discovered_at": "TEXT",
        "confidence": "TEXT NOT NULL DEFAULT 'Low'",
        "status": "TEXT NOT NULL DEFAULT 'PROPOSED'",
        "distinction": "TEXT NOT NULL DEFAULT 'Claimed Expertise'",
        "user_edited": "INTEGER NOT NULL DEFAULT 0",
        "approved_at": "TEXT",
        "created_at": "TEXT",
        "updated_at": "TEXT",
        "metadata": "TEXT NOT NULL DEFAULT '{}'",
    })
    conn.execute("CREATE INDEX IF NOT EXISTS idx_profile_evidence_expert ON profile_evidence(expert_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_profile_evidence_status ON profile_evidence(status)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_profile_evidence_normalized ON profile_evidence(normalized_value)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS expert_requests (
          id TEXT PRIMARY KEY,
          requester_user_id TEXT,
          expert_id TEXT NOT NULL,
          production_id TEXT,
          topic TEXT,
          description TEXT NOT NULL,
          expertise_required TEXT NOT NULL DEFAULT '[]',
          location_preference TEXT,
          language TEXT,
          budget REAL,
          engagement_type TEXT NOT NULL,
          desired_date_time TEXT,
          duration_minutes INTEGER,
          additional_constraints TEXT,
          scope TEXT NOT NULL,
          price REAL,
          currency TEXT NOT NULL DEFAULT 'USDC',
          deliverable TEXT,
          state TEXT NOT NULL DEFAULT 'Draft',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          viewed_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(requester_user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY(expert_id) REFERENCES experts(id) ON DELETE CASCADE,
          FOREIGN KEY(production_id) REFERENCES productions(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_expert_requests_requester ON expert_requests(requester_user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_expert_requests_expert ON expert_requests(expert_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS engagements (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          requester_user_id TEXT,
          expert_id TEXT NOT NULL,
          production_id TEXT,
          engagement_type TEXT NOT NULL,
          scope TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'Pending payment',
          price REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'USDC',
          duration_minutes INTEGER,
          scheduled_for TEXT,
          payment_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(request_id) REFERENCES expert_requests(id) ON DELETE CASCADE,
          FOREIGN KEY(requester_user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY(expert_id) REFERENCES experts(id) ON DELETE CASCADE,
          FOREIGN KEY(production_id) REFERENCES productions(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_engagements_requester ON engagements(requester_user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_engagements_expert ON engagements(expert_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          engagement_id TEXT,
          payment_kind TEXT NOT NULL DEFAULT 'BOOKING_SETTLEMENT',
          rail TEXT NOT NULL DEFAULT 'x402-solana-usdc',
          provider TEXT,
          purpose TEXT,
          status TEXT NOT NULL DEFAULT 'Payment required',
          network TEXT NOT NULL DEFAULT 'solana-devnet',
          payer_wallet TEXT,
          payee_wallet TEXT,
          escrow_wallet TEXT,
          amount REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'USDC',
          token_mint TEXT,
          transaction_signature TEXT,
          payment_requirement TEXT,
          payment_signature TEXT,
          policy_decision TEXT,
          approval_source TEXT,
          authorization_reference TEXT,
          release_condition TEXT,
          submitted_at TEXT,
          confirmed_at TEXT,
          settled_at TEXT,
          failed_at TEXT,
          refunded_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(engagement_id) REFERENCES engagements(id) ON DELETE CASCADE
        )
        """
    )
    ensure_columns(conn, "payments", {
        "engagement_id": "TEXT",
        "payment_kind": "TEXT NOT NULL DEFAULT 'BOOKING_SETTLEMENT'",
        "rail": "TEXT NOT NULL DEFAULT 'x402-solana-usdc'",
        "provider": "TEXT",
        "purpose": "TEXT",
        "status": "TEXT NOT NULL DEFAULT 'Payment required'",
        "network": "TEXT NOT NULL DEFAULT 'solana-devnet'",
        "payer_wallet": "TEXT",
        "payee_wallet": "TEXT",
        "escrow_wallet": "TEXT",
        "amount": "REAL NOT NULL DEFAULT 0",
        "currency": "TEXT NOT NULL DEFAULT 'USDC'",
        "token_mint": "TEXT",
        "transaction_signature": "TEXT",
        "payment_requirement": "TEXT",
        "payment_signature": "TEXT",
        "policy_decision": "TEXT",
        "approval_source": "TEXT",
        "authorization_reference": "TEXT",
        "release_condition": "TEXT",
        "submitted_at": "TEXT",
        "confirmed_at": "TEXT",
        "settled_at": "TEXT",
        "failed_at": "TEXT",
        "refunded_at": "TEXT",
        "created_at": "TEXT",
        "updated_at": "TEXT",
        "metadata": "TEXT NOT NULL DEFAULT '{}'",
    })
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_engagement ON payments(engagement_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_kind ON payments(payment_kind)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_rail ON payments(rail)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_signature ON payments(transaction_signature)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS judgment_tasks (
          id TEXT PRIMARY KEY,
          prompt TEXT NOT NULL,
          topic TEXT,
          requirements TEXT NOT NULL DEFAULT '[]',
          responses_required INTEGER NOT NULL DEFAULT 1,
          price_per_accepted_response REAL NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'USDC',
          state TEXT NOT NULL DEFAULT 'OPEN',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS judgment_responses (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          contributor_id TEXT,
          contributor_name TEXT,
          recipient_wallet TEXT,
          answer TEXT NOT NULL,
          accepted INTEGER NOT NULL DEFAULT 0,
          payment_id TEXT,
          payment_status TEXT,
          demonstrated_expertise TEXT,
          created_at TEXT NOT NULL,
          accepted_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(task_id) REFERENCES judgment_tasks(id) ON DELETE CASCADE,
          FOREIGN KEY(payment_id) REFERENCES payments(id) ON DELETE SET NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_judgment_tasks_topic ON judgment_tasks(topic)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_judgment_responses_task ON judgment_responses(task_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_judgment_responses_contributor ON judgment_responses(contributor_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS expert_reviews (
          id TEXT PRIMARY KEY,
          engagement_id TEXT NOT NULL,
          requester_user_id TEXT,
          expert_id TEXT NOT NULL,
          completion_status TEXT NOT NULL,
          requester_rating INTEGER,
          expert_rating INTEGER,
          written_feedback TEXT,
          payment_success INTEGER NOT NULL DEFAULT 0,
          engagement_type TEXT,
          created_at TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(engagement_id) REFERENCES engagements(id) ON DELETE CASCADE,
          FOREIGN KEY(requester_user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY(expert_id) REFERENCES experts(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_requests (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT,
          agent_id TEXT,
          endpoint TEXT NOT NULL,
          request_payload TEXT NOT NULL DEFAULT '{}',
          response_payload TEXT NOT NULL DEFAULT '{}',
          payment_requirement TEXT,
          payment_id TEXT,
          status TEXT NOT NULL DEFAULT 'received',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY(payment_id) REFERENCES payments(id) ON DELETE SET NULL
        )
        """
    )
    # Toasty session presence — the source of truth for "who is actually in this room and what VDO.Ninja
    # source carries their media," replacing the roomId+"h" deterministic-id shortcut and VDO-label-based
    # identity guessing that js/live-session.js and js/guest.js previously relied on. VDO.Ninja remains pure
    # media transport; this table is what "Toasty owns identity" means in practice. One row per
    # (room_id, participant_id); participants announce/heartbeat via presence_upsert (see main() below) and
    # are pruned once last_seen_at falls outside PRESENCE_TTL_SECONDS — see presence_upsert/presence_list.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS room_presence (
          room_id TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          role TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          company TEXT NOT NULL DEFAULT '',
          transport_source_id TEXT,
          joined_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (room_id, participant_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_room_presence_room ON room_presence(room_id)")
    # Brand-locked customer accounts — authorization/entitlement, not a frontend preference. Idempotent
    # ALTER: SQLite has no ADD COLUMN IF NOT EXISTS; ensure_columns below no-ops when already present.
    # Default flexible so every existing user keeps today's brand-selector behavior.
    ensure_columns(
        conn,
        "users",
        {
            "brand_mode": "TEXT NOT NULL DEFAULT 'flexible'",
            "locked_brand_id": "TEXT",
        },
    )
    # Durable LiveSession record — presence is "who is here right now"; a LiveSession is "this room
    # exists / existed and its owner can find, reopen, or end it." CREATE TABLE IF NOT EXISTS is
    # idempotent against an already-populated production DB.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS live_sessions (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL UNIQUE,
          owner_user_id TEXT NOT NULL REFERENCES users(id),
          brand_id TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'OPEN',
          created_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          last_active_at TEXT NOT NULL,
          ended_by TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_live_sessions_owner ON live_sessions(owner_user_id, status)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS session_kicks (
          room_id TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          kicked_at TEXT NOT NULL,
          PRIMARY KEY (room_id, participant_id)
        )
        """
    )
    # Canonical live-session control plane — program scene/assets plus media commands. Presence is who
    # is here; this is what they are looking at / being asked to do. BroadcastChannel is same-browser
    # only and cannot reach a phone Guest or a Program Output that failed to share that channel.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS session_program (
          room_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL DEFAULT '{}',
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS session_commands (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          target_participant_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          acked_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_session_commands_room_target ON session_commands(room_id, target_participant_id, acked_at)")
    ensure_columns(
        conn,
        "room_presence",
        {
            "mic_enabled": "INTEGER",
            "camera_enabled": "INTEGER",
            "output_status": "TEXT",
            "screen_share": "TEXT",
            "audio_activity": "TEXT",
            "transcript_event": "TEXT",
        },
    )
    # End card (Program Output outro CTA): profile default lives on the user, a per-session override lives
    # on live_sessions — same durable-record precedent as brand_id above. Resolution (session override ->
    # profile default -> tasteful fallback) happens client-side in js/end-card.js; the server just stores
    # and returns whatever JSON blob each level was last saved with.
    ensure_columns(conn, "users", {"end_card_json": "TEXT NOT NULL DEFAULT '{}'"})
    ensure_columns(conn, "live_sessions", {"end_card_json": "TEXT NOT NULL DEFAULT '{}'"})
    conn.commit()


def ensure_columns(conn, table, columns):
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def user_end_card(row):
    if not row or not _row_has(row, "end_card_json"):
        return {}
    try:
        parsed = json.loads(row["end_card_json"] or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def public_user(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_login_at": row["last_login_at"],
        "status": row["status"],
        "branding": user_branding(row),
        "endCard": user_end_card(row),
    }


def _row_has(row, key):
    try:
        return key in row.keys()
    except Exception:
        return False


def user_branding(row):
    if not row:
        return {"mode": "flexible", "brandId": None}
    mode = row["brand_mode"] if _row_has(row, "brand_mode") and row["brand_mode"] else "flexible"
    brand_id = row["locked_brand_id"] if _row_has(row, "locked_brand_id") else None
    if mode != "locked":
        return {"mode": "flexible", "brandId": None}
    return {"mode": "locked", "brandId": brand_id}


def branding_forbids_session(user_row, session_row):
    branding = user_branding(user_row)
    if branding["mode"] != "locked":
        return False
    return (session_row["brand_id"] or "") != (branding["brandId"] or "")


def provider_account(row, include_tokens=False):
    if not row:
        return None
    data = {
        "id": row["id"],
        "owner_user_id": row["owner_user_id"],
        "provider": row["provider"],
        "provider_account_id": row["provider_account_id"],
        "account_email": row["account_email"],
        "scope": row["scope"],
        "token_type": row["token_type"],
        "expires_at": row["expires_at"],
        "status": row["status"],
        "connected_at": row["connected_at"],
        "updated_at": row["updated_at"],
        "disconnected_at": row["disconnected_at"],
        "metadata": json.loads(row["metadata"] or "{}"),
    }
    if include_tokens:
        data["access_token_encrypted"] = row["access_token_encrypted"]
        data["refresh_token_encrypted"] = row["refresh_token_encrypted"]
    return data


def public_media_asset(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "owner_user_id": row["owner_user_id"],
        "brand_id": row["brand_id"],
        "provider": row["provider"],
        "provider_file_id": row["provider_file_id"],
        "provider_account_id": row["provider_account_id"],
        "name": row["name"],
        "mime_type": row["mime_type"],
        "size": row["size"],
        "duration": row["duration"],
        "width": row["width"],
        "height": row["height"],
        "thumbnail_reference": row["thumbnail_reference"],
        "source_reference": row["source_reference"],
        "parent_folder_reference": row["parent_folder_reference"],
        "created_at": row["created_at"],
        "modified_at": row["modified_at"],
        "imported_at": row["imported_at"],
        "status": row["status"],
        "metadata": json.loads(row["metadata"] or "{}"),
    }


def _presence_bool(value):
    if value is None:
        return None
    return bool(int(value))


def public_presence(row):
    output_status = None
    raw_status = row["output_status"] if "output_status" in row.keys() else None
    if raw_status:
        try:
            output_status = json.loads(raw_status)
        except (TypeError, ValueError):
            output_status = None
    screen_share = None
    raw_share = row["screen_share"] if "screen_share" in row.keys() else None
    if raw_share:
        try:
            screen_share = json.loads(raw_share)
        except (TypeError, ValueError):
            screen_share = None
    audio_activity = None
    raw_activity = row["audio_activity"] if "audio_activity" in row.keys() else None
    if raw_activity:
        try:
            audio_activity = json.loads(raw_activity)
        except (TypeError, ValueError):
            audio_activity = None
    transcript_event = None
    raw_transcript = row["transcript_event"] if "transcript_event" in row.keys() else None
    if raw_transcript:
        try:
            transcript_event = json.loads(raw_transcript)
        except (TypeError, ValueError):
            transcript_event = None
    return {
        "participantId": row["participant_id"],
        "role": row["role"],
        "displayName": row["display_name"],
        "title": row["title"],
        "company": row["company"],
        "transportSourceId": row["transport_source_id"],
        "joinedAt": row["joined_at"],
        "lastSeenAt": row["last_seen_at"],
        "micEnabled": _presence_bool(row["mic_enabled"]) if "mic_enabled" in row.keys() else None,
        "cameraEnabled": _presence_bool(row["camera_enabled"]) if "camera_enabled" in row.keys() else None,
        "outputStatus": output_status,
        "screenShare": screen_share,
        "audioActivity": audio_activity,
        "transcriptEvent": transcript_event,
    }


def public_command(row):
    payload = {}
    try:
        payload = json.loads(row["payload_json"] or "{}")
    except (TypeError, ValueError):
        payload = {}
    return {
        "id": row["id"],
        "targetParticipantId": row["target_participant_id"],
        "type": row["type"],
        "payload": payload,
        "createdAt": row["created_at"],
        "ackedAt": row["acked_at"],
    }


def session_program_get(conn, room_id):
    row = conn.execute("SELECT state_json, revision, updated_at FROM session_program WHERE room_id = ?", (room_id,)).fetchone()
    if not row:
        return None
    try:
        state = json.loads(row["state_json"] or "{}")
    except (TypeError, ValueError):
        state = {}
    if not isinstance(state, dict):
        state = {}
    state["revision"] = row["revision"]
    state["updatedAt"] = row["updated_at"]
    return state


def session_program_put(conn, room_id, state):
    if not isinstance(state, dict):
        return session_program_get(conn, room_id)
    now = utc_now()
    existing = conn.execute("SELECT revision FROM session_program WHERE room_id = ?", (room_id,)).fetchone()
    revision = (existing["revision"] + 1) if existing else 1
    stored = json.dumps(state)[:48000]
    conn.execute(
        """
        INSERT INTO session_program (room_id, state_json, revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (room_id) DO UPDATE SET
          state_json = excluded.state_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at
        """,
        (room_id, stored, revision, now),
    )
    return session_program_get(conn, room_id)


def pending_commands_for(conn, room_id, participant_id):
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat(timespec="seconds")
    conn.execute("DELETE FROM session_commands WHERE room_id = ? AND created_at < ?", (room_id, cutoff))
    if not participant_id:
        return []
    transport = None
    row = conn.execute(
        "SELECT transport_source_id FROM room_presence WHERE room_id = ? AND participant_id = ?",
        (room_id, participant_id),
    ).fetchone()
    if row:
        transport = row["transport_source_id"]
    rows = conn.execute(
        """
        SELECT * FROM session_commands
        WHERE room_id = ? AND acked_at IS NULL
          AND (target_participant_id = ? OR (? IS NOT NULL AND target_participant_id = ?))
        ORDER BY created_at ASC
        LIMIT 20
        """,
        (room_id, participant_id, transport, transport),
    ).fetchall()
    return [public_command(row) for row in rows]


def enqueue_commands(conn, room_id, commands, requested_by="host"):
    if not isinstance(commands, list):
        return
    now = utc_now()
    allowed = {"mute-mic", "unmute-mic-request", "camera-off", "camera-on-request"}
    for item in commands[:12]:
        if not isinstance(item, dict):
            continue
        command_type = str(item.get("type") or "")
        target = str(item.get("targetParticipantId") or "")
        if command_type not in allowed or not target:
            continue
        command_id = str(item.get("id") or f"cmd-{now}")[:80]
        payload = {"requestedBy": item.get("requestedBy") or requested_by}
        conn.execute(
            """
            INSERT INTO session_commands (id, room_id, target_participant_id, type, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO NOTHING
            """,
            (command_id, room_id, target[:80], command_type, json.dumps(payload), now),
        )


def ack_commands(conn, room_id, command_ids):
    if not isinstance(command_ids, list):
        return
    now = utc_now()
    for command_id in command_ids[:20]:
        conn.execute(
            "UPDATE session_commands SET acked_at = ? WHERE id = ? AND room_id = ? AND acked_at IS NULL",
            (now, str(command_id)[:80], room_id),
        )


def control_bundle(conn, room_id, participant_id):
    everyone = presence_roster(conn, room_id)
    roster = [entry for entry in everyone if entry["role"] in ("host", "guest")]
    outputs = []
    for entry in everyone:
        if entry["role"] != "output":
            continue
        status = entry.get("outputStatus") or {}
        status.setdefault("outputId", entry["participantId"])
        status.setdefault("lastSeenAt", entry.get("lastSeenAt"))
        status["updatedAt"] = status.get("updatedAt") or entry.get("lastSeenAt")
        outputs.append(status)
    return {
        "roster": roster,
        "outputs": outputs,
        "program": session_program_get(conn, room_id),
        "commands": pending_commands_for(conn, room_id, participant_id) if participant_id else [],
    }


def presence_cutoff():
    return (datetime.now(timezone.utc) - timedelta(seconds=PRESENCE_TTL_SECONDS)).isoformat(timespec="seconds")


def presence_roster(conn, room_id):
    # Prune first so a roster read right after someone's tab died (no explicit presence_leave call — the
    # common case) doesn't keep showing them for up to the full TTL to every OTHER client polling this room.
    conn.execute("DELETE FROM room_presence WHERE room_id = ? AND last_seen_at < ?", (room_id, presence_cutoff()))
    conn.commit()
    rows = conn.execute(
        "SELECT * FROM room_presence WHERE room_id = ? AND last_seen_at >= ? ORDER BY joined_at ASC",
        (room_id, presence_cutoff()),
    ).fetchall()
    return [public_presence(row) for row in rows]


def session_end_card(row):
    if not row or not _row_has(row, "end_card_json"):
        return {}
    try:
        parsed = json.loads(row["end_card_json"] or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def public_session(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "roomId": row["room_id"],
        "ownerUserId": row["owner_user_id"],
        "brandId": row["brand_id"],
        "title": row["title"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "startedAt": row["started_at"],
        "endedAt": row["ended_at"],
        "lastActiveAt": row["last_active_at"],
        "endedBy": row["ended_by"],
        "endCard": session_end_card(row),
    }


def session_brand_for_room(conn, room_id):
    row = conn.execute("SELECT brand_id FROM live_sessions WHERE room_id = ?", (room_id,)).fetchone()
    return row["brand_id"] if row else None


def main():
    payload = json.load(sys.stdin)
    db_path = payload["dbPath"]
    action = payload["action"]
    conn = connect(db_path)
    migrate(conn)

    if action == "migrate":
        print(json.dumps({"ok": True}))
        return

    if action == "create_user":
        now = utc_now()
        try:
            conn.execute(
                """
                INSERT INTO users (id, name, email, password_hash, created_at, updated_at, status)
                VALUES (?, ?, ?, ?, ?, ?, 'active')
                """,
                (payload["id"], payload["name"], payload["email"], payload["passwordHash"], now, now),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            print(json.dumps({"error": "duplicate_email"}))
            return
        row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"user": public_user(row)}))
        return

    if action == "get_user_by_email":
        row = conn.execute("SELECT * FROM users WHERE email = ?", (payload["email"],)).fetchone()
        print(json.dumps({"user": public_user(row), "passwordHash": row["password_hash"] if row else None}))
        return

    if action == "get_user_by_id":
        row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"user": public_user(row)}))
        return

    # OPERATOR-ONLY — not reachable through any public HTTP route. Locking a customer's brand is
    # something we set on their account, never something the account itself can toggle.
    if action == "user_set_branding":
        mode = payload.get("mode")
        if mode not in ("flexible", "locked"):
            print(json.dumps({"error": "invalid_mode"}))
            return
        if mode == "locked":
            brand_id = payload.get("brandId")
            if not brand_id or brand_id not in KNOWN_BRAND_IDS:
                print(json.dumps({"error": "invalid_brand"}))
                return
        else:
            brand_id = None
        now = utc_now()
        conn.execute(
            "UPDATE users SET brand_mode = ?, locked_brand_id = ?, updated_at = ? WHERE id = ?",
            (mode, brand_id, now, payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"user": public_user(row)}))
        return

    if action == "mark_login":
        now = utc_now()
        conn.execute(
            "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?",
            (now, now, payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"user": public_user(row)}))
        return

    if action == "upsert_provider_account":
        now = utc_now()
        existing = conn.execute(
            "SELECT * FROM provider_accounts WHERE owner_user_id = ? AND provider = ?",
            (payload["ownerUserId"], payload["provider"]),
        ).fetchone()
        account_id = existing["id"] if existing else payload["id"]
        refresh_token = payload.get("refreshTokenEncrypted") or (existing["refresh_token_encrypted"] if existing else None)
        if existing:
            conn.execute(
                """
                UPDATE provider_accounts
                SET provider_account_id = ?, account_email = ?, access_token_encrypted = ?,
                    refresh_token_encrypted = ?, scope = ?, token_type = ?, expires_at = ?,
                    status = 'connected', updated_at = ?, disconnected_at = NULL, metadata = ?
                WHERE id = ?
                """,
                (
                    payload.get("providerAccountId"),
                    payload.get("accountEmail"),
                    payload.get("accessTokenEncrypted"),
                    refresh_token,
                    payload.get("scope"),
                    payload.get("tokenType"),
                    payload.get("expiresAt"),
                    now,
                    json.dumps(payload.get("metadata") or {}),
                    account_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO provider_accounts (
                  id, owner_user_id, provider, provider_account_id, account_email,
                  access_token_encrypted, refresh_token_encrypted, scope, token_type,
                  expires_at, status, connected_at, updated_at, metadata
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?)
                """,
                (
                    account_id,
                    payload["ownerUserId"],
                    payload["provider"],
                    payload.get("providerAccountId"),
                    payload.get("accountEmail"),
                    payload.get("accessTokenEncrypted"),
                    refresh_token,
                    payload.get("scope"),
                    payload.get("tokenType"),
                    payload.get("expiresAt"),
                    now,
                    now,
                    json.dumps(payload.get("metadata") or {}),
                ),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM provider_accounts WHERE id = ?", (account_id,)).fetchone()
        print(json.dumps({"account": provider_account(row)}))
        return

    if action == "get_provider_account":
        row = conn.execute(
            """
            SELECT * FROM provider_accounts
            WHERE owner_user_id = ? AND provider = ? AND status = 'connected'
            """,
            (payload["ownerUserId"], payload["provider"]),
        ).fetchone()
        print(json.dumps({"account": provider_account(row, include_tokens=payload.get("includeTokens", False))}))
        return

    if action == "disconnect_provider_account":
        now = utc_now()
        conn.execute(
            """
            UPDATE provider_accounts
            SET status = 'disconnected', access_token_encrypted = NULL,
                refresh_token_encrypted = NULL, updated_at = ?, disconnected_at = ?
            WHERE owner_user_id = ? AND provider = ?
            """,
            (now, now, payload["ownerUserId"], payload["provider"]),
        )
        conn.execute(
            """
            UPDATE media_assets
            SET status = 'provider_disconnected'
            WHERE owner_user_id = ? AND provider = ?
            """,
            (payload["ownerUserId"], payload["provider"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "upsert_media_asset":
        now = utc_now()
        existing = None
        if payload.get("providerFileId"):
            existing = conn.execute(
                """
                SELECT * FROM media_assets
                WHERE owner_user_id = ? AND provider = ? AND provider_file_id = ?
                """,
                (payload["ownerUserId"], payload["provider"], payload["providerFileId"]),
            ).fetchone()
        asset_id = existing["id"] if existing else payload["id"]
        values = (
            payload["ownerUserId"],
            payload.get("brandId"),
            payload["provider"],
            payload.get("providerFileId"),
            payload.get("providerAccountId"),
            payload["name"],
            payload.get("mimeType"),
            payload.get("size"),
            payload.get("duration"),
            payload.get("width"),
            payload.get("height"),
            payload.get("thumbnailReference"),
            payload.get("sourceReference"),
            payload.get("parentFolderReference"),
            payload.get("createdAt"),
            payload.get("modifiedAt"),
            now,
            payload.get("status") or "available",
            json.dumps(payload.get("metadata") or {}),
        )
        if existing:
            conn.execute(
                """
                UPDATE media_assets
                SET owner_user_id = ?, brand_id = ?, provider = ?, provider_file_id = ?,
                    provider_account_id = ?, name = ?, mime_type = ?, size = ?,
                    duration = ?, width = ?, height = ?, thumbnail_reference = ?,
                    source_reference = ?, parent_folder_reference = ?, created_at = ?,
                    modified_at = ?, imported_at = ?, status = ?, metadata = ?
                WHERE id = ?
                """,
                values + (asset_id,),
            )
        else:
            conn.execute(
                """
                INSERT INTO media_assets (
                  owner_user_id, brand_id, provider, provider_file_id, provider_account_id,
                  name, mime_type, size, duration, width, height, thumbnail_reference,
                  source_reference, parent_folder_reference, created_at, modified_at,
                  imported_at, status, metadata, id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values + (asset_id,),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM media_assets WHERE id = ?", (asset_id,)).fetchone()
        print(json.dumps({"asset": public_media_asset(row)}))
        return

    if action == "list_media_assets":
        rows = conn.execute(
            """
            SELECT * FROM media_assets
            WHERE owner_user_id = ?
            ORDER BY imported_at DESC
            LIMIT ?
            """,
            (payload["ownerUserId"], int(payload.get("limit") or 100)),
        ).fetchall()
        print(json.dumps({"assets": [public_media_asset(row) for row in rows]}))
        return

    if action == "get_media_asset":
        row = conn.execute(
            "SELECT * FROM media_assets WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        ).fetchone()
        print(json.dumps({"asset": public_media_asset(row)}))
        return

    if action == "mark_production_output":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO productions (
              id, owner_user_id, brand_id, title, output_provider, output_provider_file_id,
              output_reference, created_at, updated_at, metadata
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              output_provider = excluded.output_provider,
              output_provider_file_id = excluded.output_provider_file_id,
              output_reference = excluded.output_reference,
              updated_at = excluded.updated_at,
              metadata = excluded.metadata
            """,
            (
                payload["id"],
                payload["ownerUserId"],
                payload.get("brandId"),
                payload.get("title") or "Toasty production",
                payload.get("outputProvider"),
                payload.get("outputProviderFileId"),
                payload.get("outputReference"),
                now,
                now,
                json.dumps(payload.get("metadata") or {}),
            ),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "record_payment":
        now = utc_now()
        payment_id = payload.get("id")
        conn.execute(
            """
            INSERT INTO payments (
              id, engagement_id, payment_kind, rail, provider, purpose, status, network,
              payer_wallet, payee_wallet, escrow_wallet, amount, currency, token_mint,
              transaction_signature, payment_requirement, payment_signature, policy_decision,
              approval_source, authorization_reference, release_condition, submitted_at,
              confirmed_at, settled_at, failed_at, refunded_at, created_at, updated_at, metadata
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              transaction_signature = excluded.transaction_signature,
              payment_requirement = excluded.payment_requirement,
              payment_signature = excluded.payment_signature,
              policy_decision = excluded.policy_decision,
              approval_source = excluded.approval_source,
              submitted_at = excluded.submitted_at,
              confirmed_at = excluded.confirmed_at,
              settled_at = excluded.settled_at,
              failed_at = excluded.failed_at,
              refunded_at = excluded.refunded_at,
              updated_at = excluded.updated_at,
              metadata = excluded.metadata
            """,
            (
                payment_id,
                payload.get("engagementId"),
                payload.get("paymentKind") or "BOOKING_SETTLEMENT",
                payload.get("rail") or "x402-solana-usdc",
                payload.get("provider"),
                payload.get("purpose"),
                payload.get("status") or "PAYMENT_REQUIRED",
                payload.get("network") or "solana-devnet",
                payload.get("payerWallet"),
                payload.get("payeeWallet"),
                payload.get("escrowWallet"),
                payload.get("amount") or 0,
                payload.get("currency") or "USDC",
                payload.get("tokenMint"),
                payload.get("transactionSignature"),
                json.dumps(payload.get("paymentRequirement") or {}),
                payload.get("paymentSignature"),
                payload.get("policyDecision"),
                payload.get("approvalSource"),
                payload.get("authorizationReference"),
                payload.get("releaseCondition"),
                payload.get("submittedAt"),
                payload.get("confirmedAt"),
                payload.get("settledAt"),
                payload.get("failedAt"),
                payload.get("refundedAt"),
                now,
                now,
                json.dumps(payload.get("metadata") or {}),
            ),
        )
        conn.commit()
        print(json.dumps({"ok": True, "paymentId": payment_id}))
        return

    if action == "record_microtask_settlement":
        now = utc_now()
        task = payload.get("task") or {}
        response = payload.get("response") or {}
        payment = payload.get("payment") or {}
        payment_id = payment.get("id")
        task_id = task.get("id")
        response_id = response.get("id")
        conn.execute(
            """
            INSERT INTO judgment_tasks (
              id, prompt, topic, requirements, responses_required,
              price_per_accepted_response, currency, state, created_at, updated_at, metadata
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              prompt = excluded.prompt,
              topic = excluded.topic,
              requirements = excluded.requirements,
              responses_required = excluded.responses_required,
              price_per_accepted_response = excluded.price_per_accepted_response,
              currency = excluded.currency,
              state = excluded.state,
              updated_at = excluded.updated_at,
              metadata = excluded.metadata
            """,
            (
                task_id,
                task.get("prompt") or "",
                task.get("topic"),
                json.dumps(task.get("requirements") or []),
                int(task.get("responsesRequired") or 1),
                float(task.get("pricePerAcceptedResponse") or 0),
                task.get("currency") or "USDC",
                task.get("state") or "OPEN",
                now,
                now,
                json.dumps(task.get("metadata") or {}),
            ),
        )
        conn.execute(
            """
            INSERT INTO payments (
              id, engagement_id, payment_kind, rail, provider, purpose, status, network,
              payer_wallet, payee_wallet, escrow_wallet, amount, currency, token_mint,
              transaction_signature, payment_requirement, payment_signature, policy_decision,
              approval_source, authorization_reference, release_condition, submitted_at,
              confirmed_at, settled_at, failed_at, refunded_at, created_at, updated_at, metadata
            )
            VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '{}', NULL, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              transaction_signature = excluded.transaction_signature,
              policy_decision = excluded.policy_decision,
              approval_source = excluded.approval_source,
              settled_at = excluded.settled_at,
              updated_at = excluded.updated_at,
              metadata = excluded.metadata
            """,
            (
                payment_id,
                payment.get("paymentKind") or "HUMAN_JUDGMENT_SETTLEMENT",
                payment.get("rail") or "x402-solana-usdc",
                payment.get("provider") or "toasty-experts",
                payment.get("purpose") or "accepted-human-judgment-response",
                payment.get("status") or "PAYMENT_RELEASED",
                payment.get("network") or "solana-devnet",
                payment.get("payerWallet"),
                payment.get("payeeWallet"),
                payment.get("amount") or 0,
                payment.get("currency") or "USDC",
                payment.get("tokenMint"),
                payment.get("transactionSignature"),
                payment.get("policyDecision"),
                payment.get("approvalSource"),
                now,
                now,
                now,
                now,
                now,
                json.dumps(payment.get("metadata") or {}),
            ),
        )
        conn.execute(
            """
            INSERT INTO judgment_responses (
              id, task_id, contributor_id, contributor_name, recipient_wallet, answer,
              accepted, payment_id, payment_status, demonstrated_expertise,
              created_at, accepted_at, metadata
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              answer = excluded.answer,
              accepted = excluded.accepted,
              payment_id = excluded.payment_id,
              payment_status = excluded.payment_status,
              demonstrated_expertise = excluded.demonstrated_expertise,
              accepted_at = excluded.accepted_at,
              metadata = excluded.metadata
            """,
            (
                response_id,
                task_id,
                response.get("contributorId"),
                response.get("contributorName"),
                response.get("recipientWallet"),
                response.get("answer") or "",
                1 if response.get("accepted") else 0,
                payment_id,
                response.get("paymentStatus"),
                response.get("demonstratedExpertise"),
                now,
                now if response.get("accepted") else None,
                json.dumps(response.get("metadata") or {}),
            ),
        )
        conn.commit()
        print(json.dumps({"ok": True, "taskId": task_id, "responseId": response_id, "paymentId": payment_id}))
        return

    if action == "presence_upsert":
        now = utc_now()
        room_id = payload["roomId"]
        participant_id = payload["participantId"]
        role = payload["role"]

        kick_cutoff = (datetime.now(timezone.utc) - timedelta(seconds=KICK_BLOCK_SECONDS)).isoformat(timespec="seconds")
        conn.execute("DELETE FROM session_kicks WHERE room_id = ? AND kicked_at < ?", (room_id, kick_cutoff))
        kicked = conn.execute(
            "SELECT 1 FROM session_kicks WHERE room_id = ? AND participant_id = ?",
            (room_id, participant_id),
        ).fetchone()
        if kicked:
            print(json.dumps({"error": "kicked"}))
            return

        if role == "guest":
            existing = conn.execute(
                "SELECT 1 FROM room_presence WHERE room_id = ? AND participant_id = ?",
                (room_id, participant_id),
            ).fetchone()
            if not existing:
                guest_count = conn.execute(
                    "SELECT COUNT(*) AS n FROM room_presence WHERE room_id = ? AND role = 'guest' AND last_seen_at >= ?",
                    (room_id, presence_cutoff()),
                ).fetchone()["n"]
                if guest_count >= MAX_GUESTS_PER_ROOM:
                    print(json.dumps({"error": "full"}))
                    return

        mic = payload.get("micEnabled")
        camera = payload.get("cameraEnabled")
        mic_int = None if mic is None else (1 if mic else 0)
        camera_int = None if camera is None else (1 if camera else 0)
        output_status = payload.get("outputStatus")
        output_json = json.dumps(output_status)[:8000] if isinstance(output_status, dict) else None
        screen_share = payload.get("screenShare")
        screen_json = json.dumps(screen_share)[:2000] if isinstance(screen_share, dict) else None
        audio_activity = payload.get("audioActivity")
        if isinstance(audio_activity, dict) and ("pcm" in audio_activity or "samples" in audio_activity or "audio" in audio_activity):
            audio_activity = {
                "participantId": audio_activity.get("participantId"),
                "transportSourceId": audio_activity.get("transportSourceId"),
                "audioLevel": audio_activity.get("audioLevel"),
                "speaking": audio_activity.get("speaking"),
                "measuredAt": audio_activity.get("measuredAt"),
            }
        activity_json = json.dumps(audio_activity)[:500] if isinstance(audio_activity, dict) else None
        transcript_event = payload.get("transcriptEvent")
        transcript_json = json.dumps(transcript_event)[:800] if isinstance(transcript_event, dict) else None

        conn.execute(
            """
            INSERT INTO room_presence (
              room_id, participant_id, role, display_name, title, company,
              transport_source_id, joined_at, last_seen_at, mic_enabled, camera_enabled, output_status, screen_share,
              audio_activity, transcript_event
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (room_id, participant_id) DO UPDATE SET
              role = excluded.role,
              display_name = excluded.display_name,
              title = excluded.title,
              company = excluded.company,
              transport_source_id = excluded.transport_source_id,
              last_seen_at = excluded.last_seen_at,
              mic_enabled = COALESCE(excluded.mic_enabled, room_presence.mic_enabled),
              camera_enabled = COALESCE(excluded.camera_enabled, room_presence.camera_enabled),
              output_status = COALESCE(excluded.output_status, room_presence.output_status),
              screen_share = excluded.screen_share,
              audio_activity = excluded.audio_activity,
              transcript_event = excluded.transcript_event
            """,
            (
                room_id,
                participant_id,
                role,
                payload.get("displayName") or "",
                payload.get("title") or "",
                payload.get("company") or "",
                payload.get("transportSourceId"),
                now,
                now,
                mic_int,
                camera_int,
                output_json,
                screen_json,
                activity_json,
                transcript_json,
            ),
        )
        if role == "host":
            if isinstance(payload.get("program"), dict):
                session_program_put(conn, room_id, payload["program"])
            enqueue_commands(conn, room_id, payload.get("commands") or [], "host")
        ack_commands(conn, room_id, payload.get("ackCommandIds") or [])
        conn.commit()
        bundle = control_bundle(conn, room_id, participant_id)
        print(json.dumps(bundle))
        return

    if action == "presence_list":
        bundle = control_bundle(conn, payload["roomId"], payload.get("participantId"))
        bundle["brandId"] = session_brand_for_room(conn, payload["roomId"])
        print(json.dumps(bundle))
        return

    if action == "presence_leave":
        conn.execute(
            "DELETE FROM room_presence WHERE room_id = ? AND participant_id = ?",
            (payload["roomId"], payload["participantId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "session_create":
        now = utc_now()
        brand_id = payload.get("brandId") or ""
        if brand_id and brand_id not in KNOWN_BRAND_IDS:
            print(json.dumps({"error": "invalid_brand"}))
            return
        conn.execute(
            """
            INSERT INTO live_sessions (
              id, room_id, owner_user_id, brand_id, title, status, created_at, last_active_at
            )
            VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)
            """,
            (
                payload["id"],
                payload["roomId"],
                payload["ownerUserId"],
                brand_id,
                payload.get("title") or "",
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM live_sessions WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"session": public_session(row)}))
        return

    if action == "session_list":
        owner_user_id = payload["ownerUserId"]
        statuses = payload.get("statuses") or ["OPEN", "LIVE", "ENDED"]
        placeholders = ",".join("?" for _ in statuses)
        rows = conn.execute(
            f"SELECT * FROM live_sessions WHERE owner_user_id = ? AND status IN ({placeholders}) ORDER BY last_active_at DESC",
            (owner_user_id, *statuses),
        ).fetchall()
        owner = conn.execute("SELECT * FROM users WHERE id = ?", (owner_user_id,)).fetchone()
        sessions = []
        for row in rows:
            if branding_forbids_session(owner, row):
                continue
            entry = public_session(row)
            entry["participantCount"] = len(presence_roster(conn, row["room_id"]))
            sessions.append(entry)
        print(json.dumps({"sessions": sessions}))
        return

    if action == "session_get":
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        ).fetchone()
        if not row:
            print(json.dumps({"session": None}))
            return
        owner = conn.execute("SELECT * FROM users WHERE id = ?", (payload["ownerUserId"],)).fetchone()
        if branding_forbids_session(owner, row):
            print(json.dumps({"error": "brand_forbidden"}))
            return
        session = public_session(row)
        session["participantCount"] = len(presence_roster(conn, row["room_id"]))
        print(json.dumps({"session": session}))
        return

    if action == "session_get_by_room":
        row = conn.execute("SELECT * FROM live_sessions WHERE room_id = ?", (payload["roomId"],)).fetchone()
        print(json.dumps({"status": row["status"] if row else None, "brandId": row["brand_id"] if row else None}))
        return

    if action == "session_set_brand":
        brand_id = payload.get("brandId") or ""
        if brand_id and brand_id not in KNOWN_BRAND_IDS:
            print(json.dumps({"error": "invalid_brand"}))
            return
        owner = conn.execute("SELECT * FROM users WHERE id = ?", (payload["ownerUserId"],)).fetchone()
        if owner and user_branding(owner)["mode"] == "locked" and brand_id != (user_branding(owner)["brandId"] or ""):
            print(json.dumps({"error": "brand_forbidden"}))
            return
        now = utc_now()
        conn.execute(
            "UPDATE live_sessions SET brand_id = ?, last_active_at = ? WHERE id = ? AND owner_user_id = ?",
            (brand_id, now, payload["id"], payload["ownerUserId"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        ).fetchone()
        print(json.dumps({"session": public_session(row)}))
        return

    if action == "session_set_end_card":
        end_card_json = json.dumps(payload.get("endCard") or {})
        now = utc_now()
        conn.execute(
            "UPDATE live_sessions SET end_card_json = ?, last_active_at = ? WHERE id = ? AND owner_user_id = ?",
            (end_card_json, now, payload["id"], payload["ownerUserId"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        ).fetchone()
        if not row:
            print(json.dumps({"session": None}))
            return
        print(json.dumps({"session": public_session(row)}))
        return

    if action == "user_set_end_card":
        end_card_json = json.dumps(payload.get("endCard") or {})
        now = utc_now()
        conn.execute(
            "UPDATE users SET end_card_json = ?, updated_at = ? WHERE id = ?",
            (end_card_json, now, payload["ownerUserId"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["ownerUserId"],)).fetchone()
        print(json.dumps({"user": public_user(row)}))
        return

    if action == "session_end":
        now = utc_now()
        conn.execute(
            """
            UPDATE live_sessions SET status = 'ENDED', ended_at = ?, ended_by = ?, last_active_at = ?
            WHERE id = ? AND owner_user_id = ? AND status != 'ENDED'
            """,
            (now, payload.get("endedBy") or payload["ownerUserId"], now, payload["id"], payload["ownerUserId"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        ).fetchone()
        print(json.dumps({"session": public_session(row)}))
        return

    if action == "session_touch":
        now = utc_now()
        conn.execute(
            """
            UPDATE live_sessions
            SET last_active_at = ?, status = CASE WHEN status = 'OPEN' THEN 'LIVE' ELSE status END, started_at = COALESCE(started_at, ?)
            WHERE room_id = ? AND status != 'ENDED'
            """,
            (now, now, payload["roomId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "session_kick":
        now = utc_now()
        room_id = payload["roomId"]
        participant_id = payload["participantId"]
        conn.execute(
            "DELETE FROM room_presence WHERE room_id = ? AND participant_id = ?",
            (room_id, participant_id),
        )
        conn.execute(
            """
            INSERT INTO session_kicks (room_id, participant_id, kicked_at) VALUES (?, ?, ?)
            ON CONFLICT (room_id, participant_id) DO UPDATE SET kicked_at = excluded.kicked_at
            """,
            (room_id, participant_id, now),
        )
        conn.commit()
        print(json.dumps({"ok": True, "roster": presence_roster(conn, room_id)}))
        return

    raise ValueError(f"Unknown action: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": "db_error", "detail": str(exc)}))
        sys.exit(1)
