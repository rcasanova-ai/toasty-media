#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


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
    conn.commit()


def ensure_columns(conn, table, columns):
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


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
    }


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

    raise ValueError(f"Unknown action: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": "db_error", "detail": str(exc)}))
        sys.exit(1)
