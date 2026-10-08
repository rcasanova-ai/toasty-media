#!/usr/bin/env python3
import json
import math
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
KNOWN_BRAND_IDS = frozenset({"toasty", "8alta", "santati", "optimai", "tangem", "superteam", "peeps", "zenify", "stablecorp"})

# An organization-owned dynamic brand (a real customer's own BrandProfile — logo/colors layered on a base
# theme, see brand_profiles table) is addressed as "org:<organizationId>" wherever a brand id is otherwise
# a fixed KNOWN_BRAND_IDS string — same field, same enforcement (branding_forbids_session, session brand
# lock), no parallel locking mechanism. js/brand-themes.js's isKnownBrandId mirrors this exact rule.
ORG_BRAND_ID_PREFIX = "org:"


def is_valid_brand_id(brand_id):
    if brand_id in KNOWN_BRAND_IDS:
        return True
    return bool(brand_id) and brand_id.startswith(ORG_BRAND_ID_PREFIX) and len(brand_id) > len(ORG_BRAND_ID_PREFIX)


def organization_id_from_locked_brand(brand_id):
    if brand_id and brand_id.startswith(ORG_BRAND_ID_PREFIX):
        return brand_id[len(ORG_BRAND_ID_PREFIX):]
    return None


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
    # Reusable production setup (brand/type/layouts/policy/ROS template). Distinct from session_program,
    # which is the live scene and must never be copied as history on duplicate.
    ensure_columns(conn, "live_sessions", {"setup_json": "TEXT NOT NULL DEFAULT '{}'"})

    # ---- Accounts / Organizations / Billing / Entitlements ----
    # A user can belong to N organizations (memberships); an organization owns branding, billing, AI
    # credentials, and usage — never a single user. Existing single-user concepts (live_sessions.
    # owner_user_id, users.locked_brand_id/brand_mode) are left untouched for backward compatibility;
    # live_sessions gains an ADDITIONAL nullable organization_id below rather than replacing owner_user_id,
    # so every route written against the old column keeps working unchanged during the tenancy rollout.
    ensure_columns(conn, "users", {"email_verified_at": "TEXT"})
    # Stamped on every password reset/change. readSession (render-production-server.mjs) rejects any
    # cookie issued before this timestamp — since every request already re-fetches the live user row (see
    # readSession's existing db("get_user_by_id") call), this is enough to invalidate every outstanding
    # session on a password change/reset with no separate session-store needed.
    ensure_columns(conn, "users", {"password_changed_at": "TEXT"})
    # The actual invalidation mechanism (readSession compares this, not password_changed_at's timestamp —
    # a same-second timestamp tie between a password change and a legitimate new login is a real,
    # reproducible race with second-precision comparisons; an incrementing version has no such tie).
    ensure_columns(conn, "users", {"password_version": "INTEGER NOT NULL DEFAULT 1"})
    # Platform operator role is distinct from organization membership. It follows the user across orgs and
    # is never granted by organization owners/admins. On an existing self-hosted install with no platform
    # admin yet, bootstrap the founder deterministically from the earliest organization owner (or earliest
    # active user before organizations existed). Once one exists this block is a no-op forever.
    ensure_columns(conn, "users", {"platform_role": "TEXT NOT NULL DEFAULT 'user'"})

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          owner_user_id TEXT NOT NULL REFERENCES users(id),
          active_brand_profile_id TEXT,
          plan TEXT NOT NULL DEFAULT 'demo',
          subscription_status TEXT NOT NULL DEFAULT 'none',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_user_id)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS memberships (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          user_id TEXT NOT NULL REFERENCES users(id),
          role TEXT NOT NULL DEFAULT 'member',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_org_user ON memberships(organization_id, user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)")

    # Creator Agent API: hashed bearer tokens and per-user project inbox. Tokens are scoped to creator
    # operations only and cannot access organization/platform administration.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS creator_api_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL DEFAULT 'Ollama',
          created_at TEXT NOT NULL,
          revoked_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_creator_api_tokens_user ON creator_api_tokens(user_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS creator_projects (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          project_type TEXT NOT NULL DEFAULT 'gaming',
          payload_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_creator_projects_user ON creator_projects(user_id, updated_at)")


    # The earliest organization owner is the installation founder. Keep that account authoritative
    # even if a stale/test account already carries platform_admin. The old bootstrap only ran when ZERO
    # platform admins existed, which could permanently lock the real founder out after test/customer data
    # acquired the role. This is idempotent and only ever promotes the deterministic founder account.
    founder = conn.execute(
        "SELECT owner_user_id AS id FROM organizations ORDER BY created_at ASC LIMIT 1"
    ).fetchone()
    if not founder:
        founder = conn.execute(
            "SELECT id FROM users WHERE status = 'active' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
    if founder:
        conn.execute(
            "UPDATE users SET platform_role = 'platform_admin', updated_at = ? WHERE id = ? AND platform_role != 'platform_admin'",
            (utc_now(), founder["id"]),
        )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS organization_settings (
          organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
          website_url TEXT NOT NULL DEFAULT '',
          booking_url TEXT NOT NULL DEFAULT '',
          support_email TEXT NOT NULL DEFAULT '',
          timezone TEXT NOT NULL DEFAULT 'UTC',
          default_session_settings_json TEXT NOT NULL DEFAULT '{}',
          default_cta_json TEXT NOT NULL DEFAULT '{}',
          default_end_card_json TEXT NOT NULL DEFAULT '{}',
          social_links_json TEXT NOT NULL DEFAULT '{}',
          custom_domain_config_json TEXT NOT NULL DEFAULT '{}',
          onboarding_completed_at TEXT,
          updated_at TEXT NOT NULL
        )
        """
    )

    # Organization-owned brand content. base_theme_id is one of js/brand-themes.js's hardcoded ids
    # (client-side fallback for every field an org hasn't overridden yet); overrides_json layers org-
    # specific vars/copy/artwork on top. This is intentionally additive to, not a replacement of, the
    # existing hardcoded BRAND_THEMES table — see docs findings on brand-themes.js/brand-profile.js.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS brand_profiles (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          name TEXT NOT NULL DEFAULT 'Default',
          base_theme_id TEXT NOT NULL DEFAULT 'toasty',
          overrides_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_brand_profiles_org ON brand_profiles(organization_id)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS billing_accounts (
          organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
          stripe_customer_id TEXT,
          preferred_payment_method TEXT NOT NULL DEFAULT '',
          billing_email TEXT NOT NULL DEFAULT '',
          currency TEXT NOT NULL DEFAULT 'usd',
          billing_metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          provider TEXT NOT NULL,
          plan TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'inactive',
          current_period_start TEXT,
          current_period_end TEXT,
          cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
          external_subscription_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(organization_id, status)")

    # encrypted_credential is ciphertext only (see render-production-server.mjs's encryptSecret, the same
    # AES-256-GCM helper already used for Google OAuth tokens) — the plaintext key is NEVER stored and
    # never returned to the browser after the initial save. key_last4 is display-only.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_provider_credentials (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          provider TEXT NOT NULL,
          encrypted_credential TEXT NOT NULL,
          key_last4 TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_credentials_org_provider ON ai_provider_credentials(organization_id, provider)")

    # External broadcast destinations (X, YouTube, TikTok, Instagram, custom RTMP). The RTMP(S) URL and
    # stream key are stored together as ONE ciphertext (encrypted_secret, AES-256-GCM via the Node
    # process's encryptSecret) — this script never decrypts it and no public row ever carries it. The
    # browser only ever sees destination/label/url_host/key_last4/status; the stream key is never sent
    # back after the save. Scoped to organization_id; one saved connection per destination per org.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS broadcast_destinations (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          destination TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          url_host TEXT NOT NULL DEFAULT '',
          key_last4 TEXT NOT NULL DEFAULT '',
          encrypted_secret TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'connected',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_destinations_org_dest ON broadcast_destinations(organization_id, destination)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS usage_counters (
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          period_start TEXT NOT NULL,
          sessions_created INTEGER NOT NULL DEFAULT 0,
          render_jobs INTEGER NOT NULL DEFAULT 0,
          render_minutes REAL NOT NULL DEFAULT 0,
          recording_minutes REAL NOT NULL DEFAULT 0,
          storage_bytes INTEGER NOT NULL DEFAULT 0,
          ai_requests INTEGER NOT NULL DEFAULT 0,
          participant_minutes REAL NOT NULL DEFAULT 0,
          uploads_bytes INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (organization_id, period_start)
        )
        """
    )

    # Solana (and future Stripe-adjacent) payment intents for organization billing — deliberately separate
    # from the existing `payments` table above, which is the expert-marketplace booking/settlement ledger
    # (different lifecycle: one-off x402 booking payment vs. a prepaid subscription term). `reference` is
    # the unique on-chain memo/reference key used to find and verify the matching transaction server-side;
    # `transaction_signature` is UNIQUE so a signature can never be credited to two intents.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS billing_payment_intents (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          provider TEXT NOT NULL DEFAULT 'solana',
          asset TEXT NOT NULL,
          network TEXT NOT NULL,
          fiat_reference_amount REAL NOT NULL,
          crypto_amount REAL NOT NULL,
          recipient_wallet TEXT NOT NULL,
          reference TEXT NOT NULL UNIQUE,
          transaction_signature TEXT UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          plan TEXT NOT NULL,
          term_days INTEGER NOT NULL,
          expires_at TEXT NOT NULL,
          paid_at TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payment_intents_org ON billing_payment_intents(organization_id, status)")

    # One-time tokens: only a hash is ever stored (scrypt via the same helper as passwords), matching the
    # brief's explicit "store token hash, not raw token" requirement for both email verification and
    # password reset. consumed_at makes a token single-use; expires_at is enforced by the caller.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS email_verification_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          token_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          token_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id)")

    # Additive tenancy link on the existing broadcast-room table — nullable so every pre-existing row
    # (and every route that doesn't yet pass an organizationId) keeps working unchanged.
    ensure_columns(conn, "live_sessions", {"organization_id": "TEXT REFERENCES organizations(id)"})
    conn.execute("CREATE INDEX IF NOT EXISTS idx_live_sessions_org ON live_sessions(organization_id)")

    # Pending invites for an email that may not have a Toasty account yet — resolved into a real
    # membership (see accept_invite) once that email signs up or logs in. Only a token hash is stored,
    # same rationale as the password/email-verification tokens above.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS organization_invites (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          email TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          token_hash TEXT NOT NULL,
          invited_by_user_id TEXT NOT NULL REFERENCES users(id),
          status TEXT NOT NULL DEFAULT 'pending',
          expires_at TEXT NOT NULL,
          accepted_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_org_invites_org ON organization_invites(organization_id, status)")

    # ---- Event Growth (Session Planner, Speakers, Consent, Sponsors, Landing Pages, Audience,
    # Campaign Links, Post-event artifacts) ----
    # Every table below carries organization_id as its tenant boundary (never owner_user_id — see the
    # accounts/organizations block above). It is always DERIVED server-side from the parent session's own
    # organization_id at creation time (render-production-server.mjs never trusts a client-supplied org id
    # for these), same principle as live_sessions.organization_id itself, and stays nullable for the same
    # backward-compatibility reason: a session created before the tenancy rollout (or any legacy/demo
    # session with no organization_id) must not make every Event Growth feature on it unusable.

    # Session Planner — plan_json follows the exact precedent of setup_json/end_card_json above:
    # resolution/validation happens client-side, the server just stores and returns whatever JSON blob was
    # last saved (sessionType, deliveryMode, description, scheduledAt, timezone, expectedDurationMinutes,
    # hostName, producerName, visibility, registrationRequired, audience{}, runOfShow[], assets[],
    # readinessChecklist{}, wizardStep). Kept on live_sessions (not a separate table) because it is
    # genuinely 1:1 with a session.
    ensure_columns(conn, "live_sessions", {"plan_json": "TEXT NOT NULL DEFAULT '{}'"})

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS speakers (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          organization_id TEXT REFERENCES organizations(id),
          peeps_person_id TEXT,
          email TEXT NOT NULL DEFAULT '',
          session_role TEXT NOT NULL DEFAULT '',
          invite_status TEXT NOT NULL DEFAULT 'not_sent',
          display_name TEXT NOT NULL DEFAULT '',
          headshot_reference TEXT,
          title TEXT NOT NULL DEFAULT '',
          company TEXT NOT NULL DEFAULT '',
          bio_short TEXT NOT NULL DEFAULT '',
          bio_long TEXT NOT NULL DEFAULT '',
          links_json TEXT NOT NULL DEFAULT '{}',
          pronunciation_notes TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL DEFAULT '',
          speaker_timezone TEXT NOT NULL DEFAULT '',
          onscreen_title TEXT NOT NULL DEFAULT '',
          hidden_fields_json TEXT NOT NULL DEFAULT '[]',
          pronouns TEXT NOT NULL DEFAULT '',
          selection_reason TEXT NOT NULL DEFAULT '',
          profile_submitted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_speakers_session ON speakers(session_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_speakers_org ON speakers(organization_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS speaker_invites (
          id TEXT PRIMARY KEY,
          speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          used_at TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_speaker_invites_speaker ON speaker_invites(speaker_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tech_checks (
          id TEXT PRIMARY KEY,
          speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          completed_at TEXT NOT NULL,
          camera_ok INTEGER NOT NULL DEFAULT 0,
          mic_ok INTEGER NOT NULL DEFAULT 0,
          speaker_ok INTEGER NOT NULL DEFAULT 0,
          browser_supported INTEGER NOT NULL DEFAULT 0,
          connection_outcome TEXT NOT NULL DEFAULT '',
          warnings_json TEXT NOT NULL DEFAULT '[]',
          device_labels_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tech_checks_speaker ON tech_checks(speaker_id)")

    # Consent/release — append-only. Never UPDATE required_acceptances/optional_permissions/
    # agreement_version once written; the only mutation allowed later is setting revoked_at/revoked_reason,
    # so historical records always show exactly what was accepted at accepted_at.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS consent_records (
          id TEXT PRIMARY KEY,
          organization_id TEXT REFERENCES organizations(id),
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          participant_type TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          agreement_version TEXT NOT NULL,
          required_acceptances_json TEXT NOT NULL DEFAULT '[]',
          optional_permissions_json TEXT NOT NULL DEFAULT '[]',
          accepted_at TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT '',
          ip_metadata TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT '',
          document_hash TEXT NOT NULL DEFAULT '',
          revoked_at TEXT,
          revoked_reason TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_consent_records_session ON consent_records(session_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_consent_records_participant ON consent_records(participant_type, participant_id)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sponsors (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          organization_id TEXT REFERENCES organizations(id),
          company_name TEXT NOT NULL DEFAULT '',
          contact_name TEXT NOT NULL DEFAULT '',
          contact_email TEXT NOT NULL DEFAULT '',
          website TEXT NOT NULL DEFAULT '',
          logo_reference TEXT,
          campaign_url TEXT NOT NULL DEFAULT '',
          promo_code TEXT NOT NULL DEFAULT '',
          qr_destination TEXT NOT NULL DEFAULT '',
          talking_points TEXT NOT NULL DEFAULT '',
          required_disclosure TEXT NOT NULL DEFAULT '',
          do_not_say TEXT NOT NULL DEFAULT '',
          product_images_json TEXT NOT NULL DEFAULT '[]',
          sponsor_graphic_reference TEXT,
          video_asset_reference TEXT,
          social_links_json TEXT NOT NULL DEFAULT '{}',
          approval_status TEXT NOT NULL DEFAULT 'pending',
          invite_status TEXT NOT NULL DEFAULT 'not_invited',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sponsors_session ON sponsors(session_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sponsors_org ON sponsors(organization_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sponsor_invites (
          id TEXT PRIMARY KEY,
          sponsor_id TEXT NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          used_at TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sponsor_invites_sponsor ON sponsor_invites(sponsor_id)")
    # Sponsor moments — attaches a sponsor to a Run of Show position. Durable answer to "which sponsor,
    # when, what treatment, has the Host put it on screen" for analytics + Host sponsor controls.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sponsor_moments (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          sponsor_id TEXT NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          label TEXT NOT NULL DEFAULT '',
          start_offset_seconds INTEGER,
          treatment TEXT NOT NULL DEFAULT 'host_read',
          status TEXT NOT NULL DEFAULT 'planned',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sponsor_moments_session ON sponsor_moments(session_id)")

    # Event landing pages — structured blocks, not free-form HTML. brand_profile_id links to the
    # organization's own brand_profiles row (see accounts block above) rather than a bare brand_id string,
    # so a published event page inherits the organization's actual configured brand, not just a hardcoded
    # theme id.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS landing_pages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE REFERENCES live_sessions(id) ON DELETE CASCADE,
          organization_id TEXT REFERENCES organizations(id),
          brand_profile_id TEXT REFERENCES brand_profiles(id),
          slug TEXT NOT NULL UNIQUE,
          template_id TEXT NOT NULL DEFAULT 'default',
          blocks_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'draft',
          published_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )

    # Audience identity — independent from Studio participant/room_presence identity AND from
    # user/membership identity. One row per known anonymous/registered/Peeps-linked visitor, scoped per
    # organization_id (the real tenant boundary now — see accounts block above).
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audience_identities (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          anonymous_id TEXT NOT NULL,
          peeps_person_id TEXT,
          known_email TEXT,
          display_name TEXT NOT NULL DEFAULT '',
          merged_into_id TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_audience_identities_org_anon ON audience_identities(organization_id, anonymous_id)")

    # Audience event stream — append-only event records, not counters. See docs/HUMAN_INSIGHT_NETWORK.md
    # for the identity/consent boundary this must respect (client engagement data vs. platform demand data).
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audience_events (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          identity_id TEXT,
          anonymous_id TEXT,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT '',
          campaign TEXT NOT NULL DEFAULT '',
          referrer TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audience_events_session ON audience_events(session_id, event_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audience_events_identity ON audience_events(identity_id)")

    # Campaign / referral links — toasty.media/r/<slug> style trackable redirects. destination_url is
    # validated server-side (http/https only, see sanitizeRedirectUrl in the Node layer) before it is ever
    # stored or redirected to.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS campaign_links (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          slug TEXT NOT NULL UNIQUE,
          destination_url TEXT NOT NULL DEFAULT '',
          campaign TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          speaker_id TEXT,
          sponsor_id TEXT,
          clip_id TEXT,
          referral_partner TEXT NOT NULL DEFAULT '',
          click_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_campaign_links_session ON campaign_links(session_id)")
    ensure_columns(conn, "campaign_links", {"is_active": "INTEGER NOT NULL DEFAULT 1"})

    # BYOK AI usage detail log — ADDITIVE to usage_counters.ai_requests (see accounts block above), never a
    # replacement or a parallel billing system. render-production-server.mjs calls increment_usage with
    # {aiRequests: 1} exactly as handleAiProducerRespond already does for every Event Growth Moxie hook,
    # and separately writes one of these rows for the richer per-call detail (feature/tokens/latency) the
    # coarse counter doesn't carry. Every AI call this feeds is itself gated by the organization's own BYOK
    # credential (findActiveAiCredential) — this table has no bearing on that gate.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_usage_events (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          session_id TEXT,
          occurred_at TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          feature TEXT NOT NULL DEFAULT '',
          input_tokens INTEGER,
          output_tokens INTEGER,
          total_tokens INTEGER,
          estimated_cost REAL,
          latency_ms INTEGER,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_usage_events_org ON ai_usage_events(organization_id, occurred_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_usage_events_session ON ai_usage_events(session_id)")

    # Platform-admin-only Studio economics telemetry. This records server-side broadcast usage only;
    # local browser recording has no Toasty server media cost. Cost fields are marginal estimates using
    # the operator-configured rates in render-production-server.mjs, so raw bytes/minutes remain the
    # authoritative measurements even when rates are zero or change later.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS studio_broadcast_usage (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          session_id TEXT,
          user_id TEXT,
          started_at TEXT,
          ended_at TEXT NOT NULL,
          duration_seconds INTEGER NOT NULL DEFAULT 0,
          destination_count INTEGER NOT NULL DEFAULT 0,
          destinations_json TEXT NOT NULL DEFAULT '[]',
          bytes_in INTEGER NOT NULL DEFAULT 0,
          bytes_out INTEGER NOT NULL DEFAULT 0,
          encoder_seconds INTEGER NOT NULL DEFAULT 0,
          estimated_network_cost REAL NOT NULL DEFAULT 0,
          estimated_compute_cost REAL NOT NULL DEFAULT 0,
          estimated_total_cost REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_studio_broadcast_usage_org ON studio_broadcast_usage(organization_id, ended_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_studio_broadcast_usage_session ON studio_broadcast_usage(session_id)")

    # Post-event content hooks — retains attribution back to organization/session/speaker/sponsor/campaign
    # for every derived artifact (clip, quote card, article draft, social copy, ...). Storage of the actual
    # media/text stays wherever media_assets already puts it; this table is the durable attribution +
    # status record.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS post_event_artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          organization_id TEXT REFERENCES organizations(id),
          artifact_type TEXT NOT NULL,
          source_moment_ref TEXT NOT NULL DEFAULT '',
          speaker_id TEXT,
          sponsor_id TEXT,
          campaign TEXT NOT NULL DEFAULT '',
          storage_reference TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_post_event_artifacts_session ON post_event_artifacts(session_id)")

    # ---- Peeps Jam <-> Studio session lifecycle (docs/ROADMAP.md Gate 2) ----
    # Jams are Peeps-owned durable engagement records; Studio remains the live production system. A Jam
    # links to at most one Studio session (studio_session_id UNIQUE) via the idempotent jam_run_session
    # action below, which claims this column with `UPDATE ... WHERE studio_session_id IS NULL` inside one
    # transaction — db() spawns a fresh subprocess/connection per call, so idempotency cannot rely on
    # in-process locking and has to be a single atomic claim instead.

    # Minimal, durable participant identity ("Dub"). Deliberately thin: this does not rebuild the full Dub
    # product (matchable profile, evidence export — see peeps/app/dub.html, still client-only) — it only
    # gives a participant a stable id a Jam can reference, per the brief's Core IDs requirement.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dubs (
          id TEXT PRIMARY KEY,
          user_id TEXT REFERENCES users(id),
          email TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_dubs_email ON dubs(email)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jams (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          created_by_user_id TEXT NOT NULL REFERENCES users(id),
          title TEXT NOT NULL DEFAULT '',
          objective TEXT NOT NULL DEFAULT '',
          participant_criteria_json TEXT NOT NULL DEFAULT '{}',
          target_participant_count INTEGER NOT NULL DEFAULT 0,
          compensation_json TEXT NOT NULL DEFAULT '{}',
          consent_requirements_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'draft',
          studio_session_id TEXT UNIQUE REFERENCES live_sessions(id),
          room_secret TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jams_org ON jams(organization_id, status)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jam_participants (
          id TEXT PRIMARY KEY,
          jam_id TEXT NOT NULL REFERENCES jams(id) ON DELETE CASCADE,
          dub_id TEXT NOT NULL REFERENCES dubs(id),
          status TEXT NOT NULL DEFAULT 'candidate',
          consent_captured_at TEXT,
          consent_version TEXT,
          compensation_status TEXT NOT NULL DEFAULT 'not_eligible',
          compensation_amount REAL,
          attended_at TEXT,
          completed_at TEXT,
          removed_at TEXT,
          removed_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_jam_participants_jam_dub ON jam_participants(jam_id, dub_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jam_participants_jam ON jam_participants(jam_id)")

    # Unlike speaker_invites, this is NOT a one-shot redemption token — js/peeps-room.js's already-shipped
    # flow reuses the SAME invite token repeatedly (accept, consent, then every later /access and /events
    # call for the live room, including rejoins after a refresh). So there is deliberately no used_at/
    # single-use semantics here: only expires_at/revoked_at gate whether it still works.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jam_participant_invites (
          id TEXT PRIMARY KEY,
          jam_participant_id TEXT NOT NULL REFERENCES jam_participants(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jam_participant_invites_participant ON jam_participant_invites(jam_participant_id)")

    # Append-only evidence/Breadcrumb ledger — backs POST /api/jams/:id/events, a contract
    # js/peeps-room.js already calls (capture.consent, participant.joined, jam.started, participant.left,
    # jam.ended, dispute.window.opened) plus organizer-side events. This IS the Breadcrumb primitive
    # peeps/app/jam-record.html's copy describes ("participant authorization, capture consent, verified
    # overlap, completion, dispute deadline, settlement status") — deliberately not profile_evidence
    # (expert-marketplace fact-checking) or post_event_artifacts (event-marketing derived content), which
    # are different concepts this table does not duplicate.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jam_events (
          id TEXT PRIMARY KEY,
          jam_id TEXT NOT NULL REFERENCES jams(id) ON DELETE CASCADE,
          jam_participant_id TEXT REFERENCES jam_participants(id),
          type TEXT NOT NULL,
          detail_json TEXT NOT NULL DEFAULT '{}',
          actor TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jam_events_jam ON jam_events(jam_id, created_at)")

    # Durable references only — never blobs, same precedent as post_event_artifacts. Studio does not yet
    # persist recording/transcript/Moxie output server-side (still IndexedDB/in-memory only — see
    # js/session-artifacts.js), so most rows here will carry status='pending'/'unavailable' until that
    # separate body of work lands; this table is the plumbing that will carry real artifacts once it does.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jam_artifacts (
          id TEXT PRIMARY KEY,
          jam_id TEXT NOT NULL REFERENCES jams(id) ON DELETE CASCADE,
          studio_session_id TEXT REFERENCES live_sessions(id),
          artifact_type TEXT NOT NULL,
          storage_reference TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jam_artifacts_jam ON jam_artifacts(jam_id)")

    # Studio-side half of the durable link (jams.studio_session_id is the Peeps-side half) — additive/
    # nullable, same precedent as live_sessions.organization_id above.
    ensure_columns(conn, "live_sessions", {"jam_id": "TEXT REFERENCES jams(id)"})
    conn.execute("CREATE INDEX IF NOT EXISTS idx_live_sessions_jam ON live_sessions(jam_id)")

    # ---- Dough: application ledger, not a crypto token ----
    # Humans see ordinary USD-denominated balances. Crypto/x402/Solana are settlement rails underneath.
    # Accounts can belong to a real user or an unclaimed Dub so earnings are never lost before claim.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS dough_accounts (
          subject_type TEXT NOT NULL CHECK(subject_type IN ('user','dub')),
          subject_id TEXT NOT NULL,
          spend_balance REAL NOT NULL DEFAULT 0,
          earned_balance REAL NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(subject_type, subject_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS dough_entries (
          id TEXT PRIMARY KEY,
          subject_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          bucket TEXT NOT NULL CHECK(bucket IN ('spend','earned')),
          direction TEXT NOT NULL CHECK(direction IN ('credit','debit')),
          amount REAL NOT NULL CHECK(amount > 0),
          kind TEXT NOT NULL,
          reference_id TEXT,
          status TEXT NOT NULL DEFAULT 'posted',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_dough_entries_subject ON dough_entries(subject_type, subject_id, created_at)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_dough_entries_idempotency ON dough_entries(kind, reference_id, subject_type, subject_id) WHERE reference_id IS NOT NULL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS dough_funding_intents (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          amount REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'USD',
          method TEXT NOT NULL,
          provider TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          provider_reference TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS dough_withdrawals (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          amount REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'USD',
          method TEXT NOT NULL,
          destination TEXT,
          status TEXT NOT NULL DEFAULT 'requested',
          provider_reference TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
    """)

    # Real funding confirmation (Stripe webhook for fiat, verified Solana transaction for crypto) needs
    # somewhere to record what actually happened — a funding intent by itself is never money, only a
    # provider's own confirmation is. transaction_signature/provider_reference are UNIQUE (when set) so
    # the exact same Stripe session or on-chain transaction can never fund two different intents, on top
    # of dough_funding_confirm's own atomic status-claim (see its action below).
    ensure_columns(conn, "dough_funding_intents", {
        "transaction_signature": "TEXT",
        "paid_at": "TEXT",
        "recipient_wallet": "TEXT",
        "crypto_amount": "REAL",
        "asset": "TEXT",
    })
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_dough_funding_intents_txsig ON dough_funding_intents(transaction_signature) WHERE transaction_signature IS NOT NULL")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_dough_funding_intents_provref ON dough_funding_intents(provider_reference) WHERE provider_reference IS NOT NULL")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_dough_funding_intents_user ON dough_funding_intents(user_id, created_at)")

    conn.execute("CREATE INDEX IF NOT EXISTS idx_dough_withdrawals_user ON dough_withdrawals(user_id, created_at)")

    # ---- Peeps agent-to-human transaction lifecycle ----
    # Request -> agent research -> candidates -> human-authorized introductions -> outreach (reuses the
    # existing jam_participant_invite email flow) -> acceptance -> booking -> Session Planner -> Jam ->
    # Studio -> settlement -> Breadcrumbs -> Dub claim. Additive only: everything downstream of
    # "authorize introductions" reuses jams/jam_participants/jam_participant_invites/jam_events/dubs/
    # payments as-is (see handlePeepsRequestAuthorize in render-production-server.mjs) rather than
    # duplicating them — a Jam IS the booking record once scheduled_at is set, jam_events IS the
    # Breadcrumb ledger, payments IS the settlement ledger.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_requests (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          created_by_user_id TEXT NOT NULL REFERENCES users(id),
          who_text TEXT NOT NULL,
          outcome_text TEXT NOT NULL,
          working_representation_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'researching',
          jam_id TEXT REFERENCES jams(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_requests_org ON peeps_requests(organization_id, created_at)")

    # One resolver pass's output for a request. source/reachability are the two axes section 5 of the
    # brief insists stay separate: a strong match with no legitimate outreach path is not an actionable
    # result, so reachability is tracked independently of match_score/rank.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_candidates (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES peeps_requests(id) ON DELETE CASCADE,
          dub_id TEXT REFERENCES dubs(id),
          source TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          headline TEXT NOT NULL DEFAULT '',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          match_reason TEXT NOT NULL DEFAULT '',
          match_score REAL NOT NULL DEFAULT 0,
          reachability TEXT NOT NULL DEFAULT 'unreachable',
          contact_email TEXT,
          rank INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'proposed',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_candidates_request ON peeps_candidates(request_id, rank)")

    # The durable record of the human decision point (section 10) through outreach/acceptance. Status is
    # partly derived at read time from the linked jam_participant's own status (see public_peeps_introduction
    # in render-production-server.mjs) rather than duplicated here, so the two can never drift out of sync.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_introductions (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES peeps_requests(id) ON DELETE CASCADE,
          candidate_id TEXT NOT NULL REFERENCES peeps_candidates(id),
          dub_id TEXT NOT NULL REFERENCES dubs(id),
          jam_id TEXT REFERENCES jams(id),
          jam_participant_id TEXT REFERENCES jam_participants(id),
          status TEXT NOT NULL DEFAULT 'authorized',
          authorized_at TEXT,
          authorized_by_user_id TEXT REFERENCES users(id),
          outreach_sent_at TEXT,
          decline_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_introductions_request ON peeps_introductions(request_id)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_peeps_introductions_candidate ON peeps_introductions(candidate_id)")

    # Section 27 — invite an externally-discovered/unclaimed Dub to claim their identity after a real
    # interaction. Same hash-only-token precedent as speaker_invites/jam_participant_invites.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dub_claim_invites (
          id TEXT PRIMARY KEY,
          dub_id TEXT NOT NULL REFERENCES dubs(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          claimed_at TEXT,
          claimed_by_user_id TEXT REFERENCES users(id),
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_dub_claim_invites_dub ON dub_claim_invites(dub_id)")

    # Booking = a Jam with a resolved time. cancellation_policy_json is read, never hardcoded penalty
    # logic (section 18) — {lateCancellationHours, noShowHandling, replacement} with sane defaults applied
    # by the server when absent, never baked into a migration.
    ensure_columns(conn, "jams", {
        "scheduled_at": "TEXT",
        "timezone": "TEXT NOT NULL DEFAULT ''",
        "cancellation_policy_json": "TEXT NOT NULL DEFAULT '{}'"
    })

    # ---- Peeps introduction execution (contact -> outreach -> response -> booking -> ready) ----
    # Extends the EXISTING peeps_introductions/peeps_candidates/jams rows rather than adding a parallel
    # model. status vocabulary: authorized, resolving_contact, ready_for_outreach, outreach_sent,
    # responded, accepted, declined, unreachable, expired, scheduling, booked, cancelled. The legacy
    # value 'contacted' is the same thing as outreach_sent and is migrated below.
    ensure_columns(conn, "peeps_introductions", {
        "response_json": "TEXT NOT NULL DEFAULT '{}'",
        "availability_json": "TEXT NOT NULL DEFAULT '{}'",
        "preferences_json": "TEXT NOT NULL DEFAULT '{}'",
        "contact_state_json": "TEXT NOT NULL DEFAULT '{}'",
        "first_viewed_at": "TEXT",
        "responded_at": "TEXT",
        "outreach_expires_at": "TEXT",
        "payment_ref": "TEXT",
        "replaces_introduction_id": "TEXT",
        "opening_id": "TEXT",
    })
    conn.execute("UPDATE peeps_introductions SET status = 'outreach_sent' WHERE status = 'contacted'")
    ensure_columns(conn, "peeps_requests", {"requester_availability_json": "TEXT NOT NULL DEFAULT '{}'"})
    ensure_columns(conn, "peeps_candidates", {"contact_paths_json": "TEXT NOT NULL DEFAULT '[]'"})

    # One row per way we might legitimately reach a person, with provenance. destination_enc is AES-GCM
    # ciphertext (encryptSecret in the Node server); destination_masked is the only form ever returned to
    # an organizer. destination_hash lets us dedupe without decrypting.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_contact_channels (
          id TEXT PRIMARY KEY,
          introduction_id TEXT NOT NULL REFERENCES peeps_introductions(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          adapter TEXT NOT NULL DEFAULT '',
          destination_enc TEXT NOT NULL DEFAULT '',
          destination_masked TEXT NOT NULL DEFAULT '',
          destination_hash TEXT NOT NULL DEFAULT '',
          public_reference TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          verification TEXT NOT NULL DEFAULT 'unverified',
          confidence TEXT NOT NULL DEFAULT '',
          priority INTEGER NOT NULL DEFAULT 99,
          automatable INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'candidate',
          last_checked_at TEXT,
          authorization_context_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_peeps_channels_dest ON peeps_contact_channels(introduction_id, channel, destination_hash)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_outbound_messages (
          id TEXT PRIMARY KEY,
          introduction_id TEXT NOT NULL REFERENCES peeps_introductions(id) ON DELETE CASCADE,
          booking_id TEXT,
          channel_id TEXT,
          purpose TEXT NOT NULL,
          audience TEXT NOT NULL DEFAULT 'candidate',
          adapter TEXT NOT NULL DEFAULT '',
          provider_kind TEXT NOT NULL DEFAULT 'real',
          status TEXT NOT NULL DEFAULT 'queued',
          thread_ref TEXT NOT NULL DEFAULT '',
          provider_message_id TEXT NOT NULL DEFAULT '',
          attempt INTEGER NOT NULL DEFAULT 1,
          error TEXT NOT NULL DEFAULT '',
          template_json TEXT NOT NULL DEFAULT '{}',
          test_payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_messages_intro ON peeps_outbound_messages(introduction_id, created_at)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_response_tokens (
          id TEXT PRIMARY KEY,
          introduction_id TEXT NOT NULL REFERENCES peeps_introductions(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          first_used_at TEXT,
          last_used_at TEXT,
          use_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_tokens_intro ON peeps_response_tokens(introduction_id)")

    # A booking is one introduction's confirmed time. UNIQUE(introduction_id) is the idempotency guarantee:
    # a retry, refresh or double-click can never create a second booking; a reschedule updates this row.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_bookings (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES peeps_requests(id) ON DELETE CASCADE,
          introduction_id TEXT NOT NULL UNIQUE REFERENCES peeps_introductions(id),
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          requester_user_id TEXT NOT NULL,
          candidate_dub_id TEXT NOT NULL,
          jam_id TEXT,
          jam_participant_id TEXT,
          studio_session_id TEXT,
          starts_at TEXT NOT NULL,
          ends_at TEXT NOT NULL,
          requester_timezone TEXT NOT NULL DEFAULT '',
          candidate_timezone TEXT NOT NULL DEFAULT '',
          duration_minutes INTEGER NOT NULL DEFAULT 45,
          format TEXT NOT NULL DEFAULT 'conversation',
          compensation_json TEXT NOT NULL DEFAULT '{}',
          recording_state TEXT NOT NULL DEFAULT 'unknown',
          cancellation_policy_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'booked',
          calendar_json TEXT NOT NULL DEFAULT '{}',
          plan_version INTEGER NOT NULL DEFAULT 0,
          notified_hash TEXT NOT NULL DEFAULT '',
          setup_json TEXT NOT NULL DEFAULT '{}',
          ready_at TEXT,
          cancelled_at TEXT,
          cancelled_by TEXT,
          cancel_reason TEXT NOT NULL DEFAULT '',
          late_cancellation INTEGER NOT NULL DEFAULT 0,
          sequence INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_bookings_request ON peeps_bookings(request_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_bookings_jam ON peeps_bookings(jam_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_bookings_session ON peeps_bookings(studio_session_id)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_plan_versions (
          id TEXT PRIMARY KEY,
          booking_id TEXT NOT NULL REFERENCES peeps_bookings(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL DEFAULT '{}',
          change_json TEXT NOT NULL DEFAULT '{}',
          participant_facing INTEGER NOT NULL DEFAULT 0,
          edited_by TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_peeps_plan_versions ON peeps_plan_versions(booking_id, version)")

    # "Last-minute opening" — outreach context for replacing a guest (session purpose, time, duration,
    # format, recording, compensation, required fit). The organizer approves a candidate before anyone is
    # substituted.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_openings (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES peeps_requests(id) ON DELETE CASCADE,
          jam_id TEXT,
          booking_id TEXT,
          replaces_introduction_id TEXT NOT NULL,
          context_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'open',
          chosen_candidate_id TEXT,
          replacement_introduction_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_peeps_openings_replaces ON peeps_openings(replaces_introduction_id)")

    # What a person has told Peeps about themselves (timezone, minimum notice, format constraints) so a
    # later introduction never asks again. Deliberately excludes date-specific availability windows —
    # those go stale and are never carried across introductions or organizations.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dub_preferences (
          dub_id TEXT PRIMARY KEY REFERENCES dubs(id) ON DELETE CASCADE,
          preferences_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        )
        """
    )

    # ---- Peeps completion -> Breadcrumbs -> Dub -> outcome -> settlement -> matching ----
    # One completion row per Jam: the durable link request -> introduction -> booking -> Jam -> Studio
    # session -> participants -> Dubs, holding only facts that really happened.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_completions (
          id TEXT PRIMARY KEY,
          jam_id TEXT NOT NULL UNIQUE REFERENCES jams(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          studio_session_id TEXT,
          trigger TEXT NOT NULL DEFAULT '',
          started_at TEXT,
          ended_at TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          outcome_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    # Private session text. Only ever returned to members of the owning organization; never to matching.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_transcripts (
          id TEXT PRIMARY KEY,
          jam_id TEXT NOT NULL REFERENCES jams(id) ON DELETE CASCADE,
          studio_session_id TEXT,
          source TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          segments_json TEXT NOT NULL DEFAULT '[]',
          submitted_by TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_peeps_transcripts_hash ON peeps_transcripts(jam_id, content_hash)")
    # evidence_class: observed | participant_claim | verified | ai_suggested — never collapsed.
    # status: proposed | accepted | corrected | rejected | verified
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_breadcrumbs (
          id TEXT PRIMARY KEY,
          jam_id TEXT NOT NULL REFERENCES jams(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          dub_id TEXT NOT NULL REFERENCES dubs(id),
          jam_participant_id TEXT,
          kind TEXT NOT NULL,
          statement TEXT NOT NULL,
          corrected_statement TEXT,
          evidence_class TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'proposed',
          topics_json TEXT NOT NULL DEFAULT '[]',
          provenance_json TEXT NOT NULL DEFAULT '{}',
          fingerprint TEXT NOT NULL,
          reviewed_by_user_id TEXT,
          reviewed_at TEXT,
          corroborated_by_user_id TEXT,
          corroborated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_peeps_breadcrumbs_fp ON peeps_breadcrumbs(jam_id, dub_id, fingerprint)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_breadcrumbs_dub ON peeps_breadcrumbs(dub_id, status)")
    # What a Dub actually shows: only entries the person accepted/corrected (or system-verified facts).
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dub_profile_entries (
          id TEXT PRIMARY KEY,
          dub_id TEXT NOT NULL REFERENCES dubs(id) ON DELETE CASCADE,
          breadcrumb_id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          statement TEXT NOT NULL,
          evidence_class TEXT NOT NULL,
          topics_json TEXT NOT NULL DEFAULT '[]',
          visibility TEXT NOT NULL DEFAULT 'public',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_dub_profile_entries_dub ON dub_profile_entries(dub_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_settlements (
          id TEXT PRIMARY KEY,
          jam_id TEXT NOT NULL,
          jam_participant_id TEXT NOT NULL UNIQUE,
          request_id TEXT NOT NULL,
          payer_user_id TEXT NOT NULL,
          payee_subject_type TEXT NOT NULL,
          payee_subject_id TEXT NOT NULL,
          amount REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT NOT NULL DEFAULT '',
          available_at_attempt REAL,
          paid_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_settlements_jam ON peeps_settlements(jam_id)")

    # ---- Peeps public waitlist ----
    # A waitlist row is NOT an account: it has no password and grants nothing. Access states are
    # WAITLISTED -> INVITED -> ACTIVE, with SUSPENDED as an admin stop. `email` is stored normalized
    # (lower-case) and is UNIQUE, so a duplicate registration can never create a second row. Consent is
    # recorded with a timestamp and the exact consent-text version. Invitation tokens are single-use,
    # expiring, and only their SHA-256 hash is stored.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_waitlist (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          country TEXT NOT NULL DEFAULT '',
          city TEXT NOT NULL DEFAULT '',
          interest TEXT NOT NULL CHECK(interest IN ('community_services','professional_networking','mentorship','consulting','other')),
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'WAITLISTED' CHECK(status IN ('WAITLISTED','INVITED','ACTIVE','SUSPENDED')),
          consent_at TEXT NOT NULL,
          consent_version TEXT NOT NULL,
          consent_withdrawn_at TEXT,
          user_id TEXT,
          invited_at TEXT,
          invited_by_user_id TEXT,
          activated_at TEXT,
          suspended_at TEXT,
          confirmation_email_status TEXT NOT NULL DEFAULT 'pending',
          confirmation_email_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_waitlist_status ON peeps_waitlist(status, created_at)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_waitlist_invites (
          id TEXT PRIMARY KEY,
          waitlist_id TEXT NOT NULL REFERENCES peeps_waitlist(id),
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          revoked_at TEXT,
          created_by_user_id TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_waitlist_invites_wl ON peeps_waitlist_invites(waitlist_id)")

    # Peeps economic events — one row per economic event in a request's lifecycle (today: the
    # introduction authorization payment). `status` says exactly what is true: onchain_verified (a Solana
    # transaction the SERVER confirmed against the RPC), ledger_posted (internal Dough ledger, no chain)
    # or simulated (demo provider, nothing real moved). `idempotency_key` makes the event single-shot per
    # request; the partial UNIQUE index on transaction_signature means one on-chain payment can never back
    # two events. record_peeps_economic_event additionally refuses a signature already used by Dough funding
    # or org billing, so a transaction can only ever be spent once across all of them.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS peeps_economic_events (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          jam_id TEXT,
          kind TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          rail TEXT NOT NULL,
          status TEXT NOT NULL,
          amount REAL NOT NULL,
          currency TEXT NOT NULL,
          network TEXT,
          token_mint TEXT,
          payer_wallet TEXT,
          payee_wallet TEXT,
          transaction_signature TEXT,
          slot INTEGER,
          block_time TEXT,
          verified_at TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_peeps_economic_events_sig ON peeps_economic_events(transaction_signature) WHERE transaction_signature IS NOT NULL")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_peeps_economic_events_request ON peeps_economic_events(request_id, created_at)")

    bootstrap_stablecorp_brand_lock(conn)

    conn.commit()


# One-time production fix (2026-09-29): studio@mystablecorp.xyz's account and organization already
# existed but Studio never applied their organization's BrandProfile anywhere and never locked the
# account to it, so every surface fell back to the generic toasty skin. Idempotent and self-limiting —
# same precedent as the platform-admin founder bootstrap above (migrate() runs on every server start,
# including every future deploy, forever; both branches below only ever act the FIRST time they find
# their target field unset, and never touch it again once set, so an operator's later manual change is
# never overwritten). Safe to leave in permanently.
STABLECORP_ORGANIZATION_ID = "0e2edb02-0c8d-489f-9ab1-abdfc9e90072"
STABLECORP_USER_EMAIL = "studio@mystablecorp.xyz"
# Real StableCorp identity, read live from https://mystablecorp.xyz on 2026-09-29: primary logo mark
# (stablecorp-primary.svg, #2E2AFF fill), the site's own "Get Started" button color (#2b3bee, effectively
# the same indigo), body text near-black (#131211) on a light warm background (#f3f3f1). Studio itself
# stays on the existing dark-canvas convention every other client theme in js/brand-themes.js uses
# (8alta/tangem/optimai/santati) rather than a light UI, with StableCorp's own indigo as the sole accent
# on black — closest existing precedent is Tangem's single-accent-on-black treatment.
STABLECORP_BRAND_OVERRIDES = {
    "label": "StableCorp",
    "logoSrc": "https://mystablecorp.xyz/stablecorp-primary.svg",
    "faviconSrc": "https://mystablecorp.xyz/stablecorp-primary.svg",
    "homeUrl": "https://mystablecorp.xyz",
    "textLogo": "StableCorp Studio",
    "atmosphereBrand": "STABLECORP",
    "atmosphereProduct": "STUDIO",
    "showPoweredBy": True,
    "vars": {
        "--brand-primary": "#2E2AFF",
        "--brand-secondary": "#ffffff",
        "--brand-accent": "#5a57ff",
        "--brand-background": "#0a0a12",
        "--brand-surface": "#12121c",
        "--brand-surface-alt": "#191926",
        "--brand-text": "#f3f3f1",
        "--brand-text-muted": "#8f8fa3",
        "--brand-border": "rgba(243, 243, 241, 0.10)",
        "--brand-button": "#2E2AFF",
        "--brand-button-text": "#ffffff",
        "--brand-focus": "#5a57ff",
        "--brand-gradient": "linear-gradient(135deg, #5a57ff, #2E2AFF)",
        "--brand-heading-font": "Inter, system-ui, sans-serif",
        "--brand-body-font": "Inter, system-ui, -apple-system, sans-serif",
        "--studio-canvas": "#0a0a12",
        "--studio-canvas-2": "#0d0d16",
        "--studio-surface": "#12121c",
        "--studio-surface-2": "#191926",
        "--studio-surface-raised": "#20202f",
        "--studio-line": "rgba(243, 243, 241, 0.10)",
        "--studio-line-strong": "rgba(46, 42, 255, 0.32)",
        "--studio-line-warm": "rgba(90, 87, 255, 0.42)",
        "--studio-cream": "#f3f3f1",
        "--studio-cream-dim": "#c8c8d6",
        "--studio-muted": "#8f8fa3",
        "--studio-orange": "#2E2AFF",
        "--studio-orange-bright": "#5a57ff",
        "--studio-amber": "#7f7dff",
        "--studio-burnt": "#211fb3",
        "--studio-brown": "#191926",
        "--studio-green": "#34c77b",
        "--studio-client-glow": "rgba(46, 42, 255, 0.22)",
        "--studio-button-text": "#ffffff",
        "--studio-button-shadow": "rgba(46, 42, 255, 0.28)",
        "--studio-button-shadow-hover": "rgba(46, 42, 255, 0.40)",
        "--studio-atmosphere-stroke": "rgba(46, 42, 255, 0.08)",
        "--studio-atmosphere-stroke-2": "rgba(243, 243, 241, 0.045)",
        "--studio-mark-opacity": "0.05",
    },
}


def bootstrap_stablecorp_brand_lock(conn):
    user_row = conn.execute(
        "SELECT id, locked_brand_id FROM users WHERE email = ?", (STABLECORP_USER_EMAIL,)
    ).fetchone()
    if user_row and not user_row["locked_brand_id"]:
        conn.execute(
            "UPDATE users SET brand_mode = 'locked', locked_brand_id = ?, updated_at = ? WHERE id = ?",
            (f"{ORG_BRAND_ID_PREFIX}{STABLECORP_ORGANIZATION_ID}", utc_now(), user_row["id"]),
        )

    org_row = conn.execute(
        "SELECT id, active_brand_profile_id FROM organizations WHERE id = ?", (STABLECORP_ORGANIZATION_ID,)
    ).fetchone()
    if not org_row:
        return
    profile_row = None
    if org_row["active_brand_profile_id"]:
        profile_row = conn.execute(
            "SELECT * FROM brand_profiles WHERE id = ?", (org_row["active_brand_profile_id"],)
        ).fetchone()
    now = utc_now()
    if not profile_row:
        # No active profile pointer at all -- create the real one rather than leaving Studio to fall back
        # to the generic toasty theme forever.
        new_id = f"bp_{os.urandom(16).hex()}"
        conn.execute(
            """
            INSERT INTO brand_profiles (id, organization_id, name, base_theme_id, overrides_json, created_at, updated_at)
            VALUES (?, ?, 'StableCorp', 'toasty', ?, ?, ?)
            """,
            (new_id, STABLECORP_ORGANIZATION_ID, json.dumps(STABLECORP_BRAND_OVERRIDES), now, now),
        )
        conn.execute(
            "UPDATE organizations SET active_brand_profile_id = ?, updated_at = ? WHERE id = ?",
            (new_id, now, STABLECORP_ORGANIZATION_ID),
        )
    else:
        # StableCorp is a first-class Studio theme now. Older production rows were created against
        # the generic Toasty base before that theme existed, which meant the customer's locked account
        # could never receive StableCorp's canvas/artwork treatments. Upgrade that legacy base id once,
        # while preserving any operator-edited overrides.
        if profile_row["base_theme_id"] != "stablecorp":
            conn.execute(
                "UPDATE brand_profiles SET base_theme_id = 'stablecorp', updated_at = ? WHERE id = ?",
                (now, profile_row["id"]),
            )
        if not _json_or(profile_row["overrides_json"], {}):
            conn.execute(
                "UPDATE brand_profiles SET overrides_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(STABLECORP_BRAND_OVERRIDES), now, profile_row["id"]),
            )


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


def public_user(row, conn=None):
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
        "branding": user_branding(row, conn),
        "endCard": user_end_card(row),
        "emailVerifiedAt": row["email_verified_at"] if _row_has(row, "email_verified_at") else None,
        "passwordChangedAt": row["password_changed_at"] if _row_has(row, "password_changed_at") else None,
        "passwordVersion": row["password_version"] if _row_has(row, "password_version") else 1,
        "platformRole": row["platform_role"] if _row_has(row, "platform_role") else "user",
        "isPlatformAdmin": bool(_row_has(row, "platform_role") and row["platform_role"] == "platform_admin"),
    }


def _row_has(row, key):
    try:
        return key in row.keys()
    except Exception:
        return False


def _json_field(row, key, default):
    if not row or not _row_has(row, key) or row[key] is None:
        return default
    try:
        return json.loads(row[key])
    except (TypeError, ValueError):
        return default


def org_public(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "slug": row["slug"],
        "ownerUserId": row["owner_user_id"],
        "activeBrandProfileId": row["active_brand_profile_id"],
        "plan": row["plan"],
        "subscriptionStatus": row["subscription_status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def membership_public(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "userId": row["user_id"],
        "role": row["role"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def org_settings_public(row):
    if not row:
        return None
    return {
        "organizationId": row["organization_id"],
        "websiteUrl": row["website_url"],
        "bookingUrl": row["booking_url"],
        "supportEmail": row["support_email"],
        "timezone": row["timezone"],
        "defaultSessionSettings": _json_field(row, "default_session_settings_json", {}),
        "defaultCTA": _json_field(row, "default_cta_json", {}),
        "defaultEndCard": _json_field(row, "default_end_card_json", {}),
        "socialLinks": _json_field(row, "social_links_json", {}),
        "customDomainConfig": _json_field(row, "custom_domain_config_json", {}),
        "onboardingCompletedAt": row["onboarding_completed_at"],
        "updatedAt": row["updated_at"],
    }


def brand_profile_public(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "name": row["name"],
        "baseThemeId": row["base_theme_id"],
        "overrides": _json_field(row, "overrides_json", {}),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def billing_account_public(row):
    if not row:
        return None
    return {
        "organizationId": row["organization_id"],
        "stripeCustomerId": row["stripe_customer_id"],
        "preferredPaymentMethod": row["preferred_payment_method"],
        "billingEmail": row["billing_email"],
        "currency": row["currency"],
        "billingMetadata": _json_field(row, "billing_metadata_json", {}),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def subscription_public(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "provider": row["provider"],
        "plan": row["plan"],
        "status": row["status"],
        "currentPeriodStart": row["current_period_start"],
        "currentPeriodEnd": row["current_period_end"],
        "cancelAtPeriodEnd": bool(row["cancel_at_period_end"]),
        "externalSubscriptionId": row["external_subscription_id"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


# include_secret=True returns encrypted_credential (still ciphertext — see migrate()'s comment); this is
# ONLY used by get_ai_provider_credential, which is only ever called server-side at the moment an AI
# request is about to be proxied. Every other caller (list/upsert response) passes include_secret=False.
def ai_credential_public(row, include_secret=False):
    if not row:
        return None
    out = {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "provider": row["provider"],
        "keyLast4": row["key_last4"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if include_secret:
        out["encryptedCredential"] = row["encrypted_credential"]
    return out


def broadcast_destination_public(row, include_secret=False):
    if not row:
        return None
    out = {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "destination": row["destination"],
        "label": row["label"],
        "urlHost": row["url_host"],
        "keyLast4": row["key_last4"],
        "status": row["status"],
        "updatedAt": row["updated_at"],
    }
    if include_secret:
        out["encryptedSecret"] = row["encrypted_secret"]
    return out


def usage_public(row, organization_id, period_start):
    if not row:
        return {
            "organizationId": organization_id,
            "periodStart": period_start,
            "sessionsCreated": 0, "renderJobs": 0, "renderMinutes": 0, "recordingMinutes": 0,
            "storageBytes": 0, "aiRequests": 0, "participantMinutes": 0, "uploadsBytes": 0,
        }
    return {
        "organizationId": row["organization_id"],
        "periodStart": row["period_start"],
        "sessionsCreated": row["sessions_created"],
        "renderJobs": row["render_jobs"],
        "renderMinutes": row["render_minutes"],
        "recordingMinutes": row["recording_minutes"],
        "storageBytes": row["storage_bytes"],
        "aiRequests": row["ai_requests"],
        "participantMinutes": row["participant_minutes"],
        "uploadsBytes": row["uploads_bytes"],
    }


def payment_intent_public(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "provider": row["provider"],
        "asset": row["asset"],
        "network": row["network"],
        "fiatReferenceAmount": row["fiat_reference_amount"],
        "cryptoAmount": row["crypto_amount"],
        "recipientWallet": row["recipient_wallet"],
        "reference": row["reference"],
        "transactionSignature": row["transaction_signature"],
        "status": row["status"],
        "plan": row["plan"],
        "termDays": row["term_days"],
        "expiresAt": row["expires_at"],
        "paidAt": row["paid_at"],
        "metadata": _json_field(row, "metadata_json", {}),
        "createdAt": row["created_at"],
    }


def invite_public(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "email": row["email"],
        "role": row["role"],
        "invitedByUserId": row["invited_by_user_id"],
        "status": row["status"],
        "expiresAt": row["expires_at"],
        "createdAt": row["created_at"],
    }


def user_branding(row, conn=None):
    if not row:
        return {"mode": "flexible", "brandId": None}
    mode = row["brand_mode"] if _row_has(row, "brand_mode") and row["brand_mode"] else "flexible"
    brand_id = row["locked_brand_id"] if _row_has(row, "locked_brand_id") else None
    if mode != "locked":
        return {"mode": "flexible", "brandId": None}
    branding = {"mode": "locked", "brandId": brand_id}
    # Organization-locked accounts (brand_id = "org:<id>") additionally carry the org's own resolved
    # BrandProfile inline, so the client has everything applyBrandTheme needs at first paint with no
    # extra round trip. conn is optional (only get_user_by_id/get_user_by_email pass it, at login/session
    # check time) -- every OTHER public_user() caller keeps working unchanged without it.
    organization_id = organization_id_from_locked_brand(brand_id)
    if organization_id and conn is not None:
        branding["organizationId"] = organization_id
        branding["brandProfile"] = resolve_active_brand_profile(conn, organization_id)
    return branding


def resolve_active_brand_profile(conn, organization_id):
    org_row = conn.execute(
        "SELECT active_brand_profile_id FROM organizations WHERE id = ?", (organization_id,)
    ).fetchone()
    if not org_row or not org_row["active_brand_profile_id"]:
        return None
    profile_row = conn.execute(
        "SELECT * FROM brand_profiles WHERE id = ?", (org_row["active_brand_profile_id"],)
    ).fetchone()
    return brand_profile_public(profile_row)


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


SESSION_PROGRAM_MAX_JSON_CHARS = 300000  # see comment in session_program_put — must stay well above
# the End Card qrImage field's own 200000-char cap (sanitizeEndCard in render-production-server.mjs)
# plus headroom for everything else in canonical program state (participants, ticker text, etc).


def session_program_put(conn, room_id, state):
    if not isinstance(state, dict):
        return session_program_get(conn, room_id)
    now = utc_now()
    existing = conn.execute("SELECT revision, state_json FROM session_program WHERE room_id = ?", (room_id,)).fetchone()
    # ROOT CAUSE of "scene buttons permanently stuck" (production regression after the reconciliation fix
    # in PR #37): this was a plain read-modify-write with no ordering protection. The host's OWN recurring
    # 2s heartbeat and any click-triggered publish both write a FULL state snapshot, independently, to the
    # SAME row — whichever HTTP request's write happened to commit last simply overwrote the other's data
    # entirely, regardless of which one was actually more recent from the user's perspective. Reproduced
    # directly: two concurrent announces (one holding a stale "holding" scene, one a fresh "live" scene)
    # raced against this exact table, and the stale one won outright in 8 of 20 trials — a coin flip, not
    # an edge case. Once PR #37's client-side reconciliation (LiveSession._applyControlBundle) started
    # trusting whatever the server's response said, that stale win propagated straight back into the
    # producer's own local state, undoing their own click.
    #
    # Fix: compare-and-swap on state["updatedAt"] (already set fresh to Date.now() on every single call to
    # canonicalControlState() — js/session-control.js's buildCanonicalState defaults it, no client change
    # needed). A write is only applied if its own updatedAt is newer than what's already stored — "last
    # GENERATED wins", not "last to arrive at the server wins". A stale in-flight heartbeat carrying an
    # older snapshot can no longer clobber a newer click's write no matter which HTTP request the server
    # happens to process last.
    if existing and existing["state_json"]:
        try:
            existing_state = json.loads(existing["state_json"])
        except (TypeError, ValueError):
            existing_state = {}
        existing_updated_at = existing_state.get("updatedAt") if isinstance(existing_state, dict) else None
        incoming_updated_at = state.get("updatedAt")
        existing_controller_started_at = existing_state.get("controllerStartedAt") if isinstance(existing_state, dict) else None
        incoming_controller_started_at = state.get("controllerStartedAt")
        # Studio tabs can remain open for hours. Without a controller epoch, an older hidden tab keeps
        # heartbeating its stale scene and can overwrite a newer active tab every few seconds, making LIVE
        # visibly bounce back to STARTING SOON. A newer controller epoch permanently wins for the room.
        if (
            isinstance(existing_controller_started_at, (int, float))
            and isinstance(incoming_controller_started_at, (int, float))
            and incoming_controller_started_at < existing_controller_started_at
        ):
            return session_program_get(conn, room_id)
        if (
            isinstance(existing_updated_at, (int, float))
            and isinstance(incoming_updated_at, (int, float))
            and incoming_updated_at < existing_updated_at
        ):
            return session_program_get(conn, room_id)
    revision = (existing["revision"] + 1) if existing else 1
    stored = json.dumps(state)
    # ROOT CAUSE of "scene transitions don't reliably propagate" (production regression after the End
    # Card/QR upload feature shipped): this used to be json.dumps(state)[:48000] — a blind string slice.
    # Once a producer attaches a real QR image (a base64 data: URL, easily 40-90KB on its own) to the
    # End Card, the canonical program payload republished on every scene/ticker change routinely exceeds
    # 48000 chars. Slicing mid-string produces syntactically invalid JSON; the write itself still returned
    # 200 (nothing here ever saw an error), but session_program_get's json.loads then throws, gets caught,
    # and silently returns {} — every subsequent read (including Program Output's own poll) got back an
    # empty program with no scene at all, on every single transition, until the payload shrank back under
    # the cap. Reproduced and confirmed against the real backend + a real SQLite DB before this fix.
    # Fix: raise the cap (see SESSION_PROGRAM_MAX_JSON_CHARS above) so a real End Card+QR fits comfortably,
    # and if a payload is STILL oversized, drop only the one field big enough to matter (qrImage — a
    # once-per-session asset, not something that needs to survive a mid-show scene toggle) instead of
    # truncating the string, so the result is always valid, parseable JSON with scene/ticker/participants
    # intact even in that extreme case.
    if len(stored) > SESSION_PROGRAM_MAX_JSON_CHARS:
        trimmed = dict(state)
        if isinstance(trimmed.get("endCard"), dict) and trimmed["endCard"].get("qrImage"):
            trimmed["endCard"] = {**trimmed["endCard"], "qrImage": ""}
        stored = json.dumps(trimmed)
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


def session_setup(row):
    if not row or not _row_has(row, "setup_json"):
        return {}
    try:
        parsed = json.loads(row["setup_json"] or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def session_plan(row):
    if not row or not _row_has(row, "plan_json"):
        return {}
    try:
        parsed = json.loads(row["plan_json"] or "{}")
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
        "organizationId": row["organization_id"] if _row_has(row, "organization_id") else None,
        "jamId": row["jam_id"] if _row_has(row, "jam_id") else None,
        "brandId": row["brand_id"],
        "title": row["title"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "startedAt": row["started_at"],
        "endedAt": row["ended_at"],
        "lastActiveAt": row["last_active_at"],
        "endedBy": row["ended_by"],
        "endCard": session_end_card(row),
        "setup": session_setup(row),
        "plan": session_plan(row),
    }


def _json_or(value, fallback):
    try:
        parsed = json.loads(value or "null")
        return parsed if parsed is not None else fallback
    except (TypeError, ValueError):
        return fallback


def public_speaker(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "sessionId": row["session_id"],
        "organizationId": row["organization_id"],
        "peepsPersonId": row["peeps_person_id"],
        "email": row["email"],
        "sessionRole": row["session_role"],
        "inviteStatus": row["invite_status"],
        "displayName": row["display_name"],
        "headshotReference": row["headshot_reference"],
        "title": row["title"],
        "company": row["company"],
        "bioShort": row["bio_short"],
        "bioLong": row["bio_long"],
        "links": _json_or(row["links_json"], {}),
        "pronunciationNotes": row["pronunciation_notes"],
        "location": row["location"],
        "speakerTimezone": row["speaker_timezone"],
        "onscreenTitle": row["onscreen_title"],
        "hiddenFields": _json_or(row["hidden_fields_json"], []),
        "pronouns": row["pronouns"],
        "selectionReason": row["selection_reason"],
        "profileSubmittedAt": row["profile_submitted_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_tech_check(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "speakerId": row["speaker_id"],
        "sessionId": row["session_id"],
        "completedAt": row["completed_at"],
        "cameraOk": bool(row["camera_ok"]),
        "micOk": bool(row["mic_ok"]),
        "speakerOk": bool(row["speaker_ok"]),
        "browserSupported": bool(row["browser_supported"]),
        "connectionOutcome": row["connection_outcome"],
        "warnings": _json_or(row["warnings_json"], []),
        "deviceLabels": _json_or(row["device_labels_json"], []),
        "createdAt": row["created_at"],
    }


def public_consent_record(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "sessionId": row["session_id"],
        "participantType": row["participant_type"],
        "participantId": row["participant_id"],
        "agreementVersion": row["agreement_version"],
        "requiredAcceptances": _json_or(row["required_acceptances_json"], []),
        "optionalPermissions": _json_or(row["optional_permissions_json"], []),
        "acceptedAt": row["accepted_at"],
        "source": row["source"],
        "ipMetadata": row["ip_metadata"],
        "userAgent": row["user_agent"],
        "documentHash": row["document_hash"],
        "revokedAt": row["revoked_at"],
        "revokedReason": row["revoked_reason"],
        "createdAt": row["created_at"],
    }


def public_sponsor(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "sessionId": row["session_id"],
        "organizationId": row["organization_id"],
        "companyName": row["company_name"],
        "contactName": row["contact_name"],
        "contactEmail": row["contact_email"],
        "website": row["website"],
        "logoReference": row["logo_reference"],
        "campaignUrl": row["campaign_url"],
        "promoCode": row["promo_code"],
        "qrDestination": row["qr_destination"],
        "talkingPoints": row["talking_points"],
        "requiredDisclosure": row["required_disclosure"],
        "doNotSay": row["do_not_say"],
        "productImages": _json_or(row["product_images_json"], []),
        "sponsorGraphicReference": row["sponsor_graphic_reference"],
        "videoAssetReference": row["video_asset_reference"],
        "socialLinks": _json_or(row["social_links_json"], {}),
        "approvalStatus": row["approval_status"],
        "inviteStatus": row["invite_status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_sponsor_moment(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "sessionId": row["session_id"],
        "sponsorId": row["sponsor_id"],
        "position": row["position"],
        "label": row["label"],
        "startOffsetSeconds": row["start_offset_seconds"],
        "treatment": row["treatment"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_landing_page(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "sessionId": row["session_id"],
        "organizationId": row["organization_id"],
        "brandProfileId": row["brand_profile_id"],
        "slug": row["slug"],
        "templateId": row["template_id"],
        "blocks": _json_or(row["blocks_json"], []),
        "status": row["status"],
        "publishedAt": row["published_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_audience_identity(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "anonymousId": row["anonymous_id"],
        "peepsPersonId": row["peeps_person_id"],
        "knownEmail": row["known_email"],
        "displayName": row["display_name"],
        "mergedIntoId": row["merged_into_id"],
        "firstSeenAt": row["first_seen_at"],
        "lastSeenAt": row["last_seen_at"],
        "createdAt": row["created_at"],
    }


def public_audience_event(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "sessionId": row["session_id"],
        "identityId": row["identity_id"],
        "anonymousId": row["anonymous_id"],
        "eventType": row["event_type"],
        "occurredAt": row["occurred_at"],
        "source": row["source"],
        "campaign": row["campaign"],
        "referrer": row["referrer"],
        "metadata": _json_or(row["metadata_json"], {}),
        "createdAt": row["created_at"],
    }


def public_campaign_link(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "sessionId": row["session_id"],
        "slug": row["slug"],
        "destinationUrl": row["destination_url"],
        "campaign": row["campaign"],
        "source": row["source"],
        "speakerId": row["speaker_id"],
        "sponsorId": row["sponsor_id"],
        "clipId": row["clip_id"],
        "referralPartner": row["referral_partner"],
        "clickCount": row["click_count"],
        "isActive": bool(row["is_active"]),
        "createdAt": row["created_at"],
    }


def public_ai_usage_event(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "sessionId": row["session_id"],
        "occurredAt": row["occurred_at"],
        "provider": row["provider"],
        "model": row["model"],
        "feature": row["feature"],
        "inputTokens": row["input_tokens"],
        "outputTokens": row["output_tokens"],
        "totalTokens": row["total_tokens"],
        "estimatedCost": row["estimated_cost"],
        "latencyMs": row["latency_ms"],
        "metadata": _json_or(row["metadata_json"], {}),
        "createdAt": row["created_at"],
    }


def public_post_event_artifact(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "sessionId": row["session_id"],
        "organizationId": row["organization_id"],
        "artifactType": row["artifact_type"],
        "sourceMomentRef": row["source_moment_ref"],
        "speakerId": row["speaker_id"],
        "sponsorId": row["sponsor_id"],
        "campaign": row["campaign"],
        "storageReference": row["storage_reference"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_dub(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "email": row["email"],
        "displayName": row["display_name"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_dough_funding_intent(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "amount": row["amount"],
        "currency": row["currency"],
        "method": row["method"],
        "provider": row["provider"],
        "status": row["status"],
        "providerReference": row["provider_reference"],
        "transactionSignature": row["transaction_signature"] if _row_has(row, "transaction_signature") else None,
        "recipientWallet": row["recipient_wallet"] if _row_has(row, "recipient_wallet") else None,
        "asset": row["asset"] if _row_has(row, "asset") else None,
        "cryptoAmount": row["crypto_amount"] if _row_has(row, "crypto_amount") else None,
        "paidAt": row["paid_at"] if _row_has(row, "paid_at") else None,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_dough_withdrawal(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "amount": row["amount"],
        "currency": row["currency"],
        "method": row["method"],
        "destination": row["destination"],
        "status": row["status"],
        "providerReference": row["provider_reference"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_jam(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "createdByUserId": row["created_by_user_id"],
        "title": row["title"],
        "objective": row["objective"],
        "participantCriteria": _json_or(row["participant_criteria_json"], {}),
        "targetParticipantCount": row["target_participant_count"],
        "compensation": _json_or(row["compensation_json"], {}),
        "consentRequirements": _json_or(row["consent_requirements_json"], []),
        "status": row["status"],
        "studioSessionId": row["studio_session_id"],
        "roomSecret": row["room_secret"],
        "scheduledAt": row["scheduled_at"] if _row_has(row, "scheduled_at") else None,
        "timezone": row["timezone"] if _row_has(row, "timezone") else "",
        "cancellationPolicy": _json_or(row["cancellation_policy_json"], {}) if _row_has(row, "cancellation_policy_json") else {},
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_jam_participant(row):
    if not row:
        return None
    entry = {
        "id": row["id"],
        "jamId": row["jam_id"],
        "dubId": row["dub_id"],
        "status": row["status"],
        "consentCapturedAt": row["consent_captured_at"],
        "consentVersion": row["consent_version"],
        "compensationStatus": row["compensation_status"],
        "compensationAmount": row["compensation_amount"],
        "attendedAt": row["attended_at"],
        "completedAt": row["completed_at"],
        "removedAt": row["removed_at"],
        "removedReason": row["removed_reason"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if _row_has(row, "email"):
        entry["email"] = row["email"]
    if _row_has(row, "display_name"):
        entry["displayName"] = row["display_name"]
    return entry


def public_jam_event(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "jamId": row["jam_id"],
        "jamParticipantId": row["jam_participant_id"],
        "type": row["type"],
        "detail": _json_or(row["detail_json"], {}),
        "actor": row["actor"],
        "createdAt": row["created_at"],
    }


def public_jam_artifact(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "jamId": row["jam_id"],
        "studioSessionId": row["studio_session_id"],
        "artifactType": row["artifact_type"],
        "storageReference": row["storage_reference"],
        "status": row["status"],
        "metadata": _json_or(row["metadata_json"], {}),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_peeps_request(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "createdByUserId": row["created_by_user_id"],
        "whoText": row["who_text"],
        "outcomeText": row["outcome_text"],
        "workingRepresentation": _json_or(row["working_representation_json"], {}),
        "requesterAvailability": _json_or(row["requester_availability_json"], {}) if _row_has(row, "requester_availability_json") else {},
        "status": row["status"],
        "jamId": row["jam_id"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_peeps_candidate(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "requestId": row["request_id"],
        "dubId": row["dub_id"],
        "source": row["source"],
        "displayName": row["display_name"],
        "headline": row["headline"],
        "evidence": _json_or(row["evidence_json"], []),
        "matchReason": row["match_reason"],
        "matchScore": row["match_score"],
        "reachability": row["reachability"],
        "contactEmail": row["contact_email"],
        "contactPaths": _json_or(row["contact_paths_json"], []) if _row_has(row, "contact_paths_json") else [],
        "rank": row["rank"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_peeps_introduction(row):
    if not row:
        return None
    entry = {
        "id": row["id"],
        "requestId": row["request_id"],
        "candidateId": row["candidate_id"],
        "dubId": row["dub_id"],
        "jamId": row["jam_id"],
        "jamParticipantId": row["jam_participant_id"],
        "status": row["status"],
        "authorizedAt": row["authorized_at"],
        "authorizedByUserId": row["authorized_by_user_id"],
        "outreachSentAt": row["outreach_sent_at"],
        "declineReason": row["decline_reason"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    for key, column, default in (
        ("response", "response_json", {}), ("availability", "availability_json", {}),
        ("preferences", "preferences_json", {}), ("contactState", "contact_state_json", {}),
    ):
        if _row_has(row, column):
            entry[key] = _json_or(row[column], default)
    for key, column in (
        ("firstViewedAt", "first_viewed_at"), ("respondedAt", "responded_at"),
        ("outreachExpiresAt", "outreach_expires_at"), ("paymentRef", "payment_ref"),
        ("replacesIntroductionId", "replaces_introduction_id"), ("openingId", "opening_id"),
    ):
        if _row_has(row, column):
            entry[key] = row[column]
    # Derived, live status from the linked jam_participant — never duplicated/written separately here, so
    # the two can never drift (see the table's own comment in migrate()).
    if _row_has(row, "participant_status"):
        entry["participantStatus"] = row["participant_status"]
    return entry


def public_peeps_channel(row):
    if not row:
        return None
    return {
        "id": row["id"], "introductionId": row["introduction_id"], "channel": row["channel"],
        "adapter": row["adapter"], "destinationEnc": row["destination_enc"],
        "destinationMasked": row["destination_masked"], "publicReference": row["public_reference"],
        "source": row["source"], "verification": row["verification"], "confidence": row["confidence"],
        "priority": row["priority"], "automatable": bool(row["automatable"]), "status": row["status"],
        "lastCheckedAt": row["last_checked_at"],
        "authorizationContext": _json_or(row["authorization_context_json"], {}),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def public_peeps_message(row, include_test_payload=False):
    if not row:
        return None
    entry = {
        "id": row["id"], "introductionId": row["introduction_id"], "bookingId": row["booking_id"],
        "channelId": row["channel_id"], "purpose": row["purpose"], "audience": row["audience"],
        "adapter": row["adapter"], "providerKind": row["provider_kind"], "status": row["status"],
        "threadRef": row["thread_ref"], "providerMessageId": row["provider_message_id"],
        "attempt": row["attempt"], "error": row["error"], "template": _json_or(row["template_json"], {}),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }
    if include_test_payload:
        entry["testPayload"] = _json_or(row["test_payload_json"], {})
    return entry


def public_peeps_booking(row):
    if not row:
        return None
    return {
        "id": row["id"], "requestId": row["request_id"], "introductionId": row["introduction_id"],
        "organizationId": row["organization_id"], "requesterUserId": row["requester_user_id"],
        "candidateDubId": row["candidate_dub_id"], "jamId": row["jam_id"],
        "jamParticipantId": row["jam_participant_id"], "studioSessionId": row["studio_session_id"],
        "startsAt": row["starts_at"], "endsAt": row["ends_at"],
        "requesterTimezone": row["requester_timezone"], "candidateTimezone": row["candidate_timezone"],
        "durationMinutes": row["duration_minutes"], "format": row["format"],
        "compensation": _json_or(row["compensation_json"], {}), "recordingState": row["recording_state"],
        "cancellationPolicy": _json_or(row["cancellation_policy_json"], {}), "status": row["status"],
        "calendar": _json_or(row["calendar_json"], {}), "planVersion": row["plan_version"],
        "notifiedHash": row["notified_hash"], "setup": _json_or(row["setup_json"], {}),
        "readyAt": row["ready_at"], "cancelledAt": row["cancelled_at"], "cancelledBy": row["cancelled_by"],
        "cancelReason": row["cancel_reason"], "lateCancellation": bool(row["late_cancellation"]),
        "sequence": row["sequence"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def public_peeps_opening(row):
    if not row:
        return None
    return {
        "id": row["id"], "requestId": row["request_id"], "jamId": row["jam_id"], "bookingId": row["booking_id"],
        "replacesIntroductionId": row["replaces_introduction_id"], "context": _json_or(row["context_json"], {}),
        "status": row["status"], "chosenCandidateId": row["chosen_candidate_id"],
        "replacementIntroductionId": row["replacement_introduction_id"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def _apply_update(conn, table, row_id, fields, column_map, json_columns=(), extra_where="", extra_params=()):
    """Shared column-mapped UPDATE for the Peeps execution tables. Returns the rowcount so callers can
    implement compare-and-set (expected-status) idempotency."""
    sets, values = [], []
    for key, column in column_map.items():
        if key in fields:
            sets.append(f"{column} = ?")
            value = fields[key]
            values.append(json.dumps(value if value is not None else ({} if column in json_columns else None)) if column in json_columns else value)
    sets.append("updated_at = ?")
    values.append(utc_now())
    values.append(row_id)
    cursor = conn.execute(f"UPDATE {table} SET {', '.join(sets)} WHERE id = ? {extra_where}", values + list(extra_params))
    conn.commit()
    return cursor.rowcount


PEEPS_INTRO_COLUMNS = {
    "status": "status", "outreachSentAt": "outreach_sent_at", "declineReason": "decline_reason",
    "firstViewedAt": "first_viewed_at", "respondedAt": "responded_at", "outreachExpiresAt": "outreach_expires_at",
    "paymentRef": "payment_ref", "replacesIntroductionId": "replaces_introduction_id", "openingId": "opening_id",
    "response": "response_json", "availability": "availability_json", "preferences": "preferences_json",
    "contactState": "contact_state_json", "jamParticipantId": "jam_participant_id",
}
PEEPS_INTRO_JSON = ("response_json", "availability_json", "preferences_json", "contact_state_json")


def public_peeps_breadcrumb(row, include_quote=True):
    if not row:
        return None
    provenance = _json_or(row["provenance_json"], {})
    if not include_quote:
        provenance = {k: v for k, v in provenance.items() if k != "quote"}
    return {
        "id": row["id"], "jamId": row["jam_id"], "requestId": row["request_id"], "dubId": row["dub_id"],
        "jamParticipantId": row["jam_participant_id"], "kind": row["kind"], "statement": row["statement"],
        "correctedStatement": row["corrected_statement"], "evidenceClass": row["evidence_class"], "status": row["status"],
        "topics": _json_or(row["topics_json"], []), "provenance": provenance, "reviewedAt": row["reviewed_at"],
        "corroboratedAt": row["corroborated_at"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def public_peeps_completion(row):
    if not row:
        return None
    return {
        "id": row["id"], "jamId": row["jam_id"], "requestId": row["request_id"], "organizationId": row["organization_id"],
        "studioSessionId": row["studio_session_id"], "trigger": row["trigger"], "startedAt": row["started_at"],
        "endedAt": row["ended_at"], "metadata": _json_or(row["metadata_json"], {}), "outcome": _json_or(row["outcome_json"], {}),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def public_peeps_settlement(row):
    if not row:
        return None
    return {
        "id": row["id"], "jamId": row["jam_id"], "jamParticipantId": row["jam_participant_id"], "requestId": row["request_id"],
        "payerUserId": row["payer_user_id"], "payeeSubjectType": row["payee_subject_type"], "payeeSubjectId": row["payee_subject_id"],
        "amount": row["amount"], "status": row["status"], "reason": row["reason"], "availableAtAttempt": row["available_at_attempt"],
        "paidAt": row["paid_at"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def public_peeps_economic_event(row):
    if not row:
        return None
    return {
        "id": row["id"], "requestId": row["request_id"], "jamId": row["jam_id"], "kind": row["kind"], "rail": row["rail"],
        "status": row["status"], "amount": row["amount"], "currency": row["currency"], "network": row["network"],
        "tokenMint": row["token_mint"], "payerWallet": row["payer_wallet"], "payeeWallet": row["payee_wallet"],
        "transactionSignature": row["transaction_signature"], "slot": row["slot"], "blockTime": row["block_time"],
        "verifiedAt": row["verified_at"], "metadata": _json_or(row["metadata_json"], {}), "createdAt": row["created_at"],
    }


def public_peeps_waitlist(row, conn=None):
    if not row:
        return None
    entry = {
        "id": row["id"], "email": row["email"], "name": row["name"], "country": row["country"], "city": row["city"],
        "interest": row["interest"], "description": row["description"], "status": row["status"],
        "consentAt": row["consent_at"], "consentVersion": row["consent_version"], "consentWithdrawnAt": row["consent_withdrawn_at"],
        "userId": row["user_id"], "invitedAt": row["invited_at"], "activatedAt": row["activated_at"], "suspendedAt": row["suspended_at"],
        "confirmationEmailStatus": row["confirmation_email_status"], "confirmationEmailAt": row["confirmation_email_at"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }
    if conn is not None:
        inv = conn.execute("SELECT * FROM peeps_waitlist_invites WHERE waitlist_id = ? ORDER BY created_at DESC LIMIT 1", (row["id"],)).fetchone()
        if inv:
            now = datetime.now(timezone.utc)
            try:
                expired = datetime.fromisoformat(inv["expires_at"].replace("Z", "+00:00")) <= now
            except ValueError:
                expired = True
            entry["invite"] = {"createdAt": inv["created_at"], "expiresAt": inv["expires_at"], "usedAt": inv["used_at"], "revokedAt": inv["revoked_at"],
                               "state": "used" if inv["used_at"] else "revoked" if inv["revoked_at"] else "expired" if expired else "pending"}
        else:
            entry["invite"] = None
    return entry


def public_dub_entry(row):
    return {
        "id": row["id"], "dubId": row["dub_id"], "breadcrumbId": row["breadcrumb_id"], "kind": row["kind"],
        "statement": row["statement"], "evidenceClass": row["evidence_class"], "topics": _json_or(row["topics_json"], []),
        "visibility": row["visibility"], "createdAt": row["created_at"],
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

    if action == "creator_token_create":
        now = utc_now()
        conn.execute(
            "INSERT INTO creator_api_tokens (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], payload["userId"], payload["tokenHash"], payload.get("label") or "Ollama", now),
        )
        conn.commit()
        print(json.dumps({"ok": True, "id": payload["id"]}))
        return

    if action == "creator_token_auth":
        row = conn.execute(
            """SELECT t.id AS token_id, u.* FROM creator_api_tokens t
               JOIN users u ON u.id = t.user_id
               WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.status = 'active' LIMIT 1""",
            (payload["tokenHash"],),
        ).fetchone()
        print(json.dumps({"user": public_user(row, conn) if row else None, "tokenId": row["token_id"] if row else None}))
        return

    if action == "creator_project_upsert":
        now = utc_now()
        project_id = payload["id"]
        existing = conn.execute("SELECT id FROM creator_projects WHERE id = ? AND user_id = ?", (project_id, payload["userId"])).fetchone()
        if existing:
            conn.execute(
                "UPDATE creator_projects SET title=?, project_type=?, payload_json=?, status=?, updated_at=? WHERE id=? AND user_id=?",
                (payload["title"], payload["projectType"], json.dumps(payload["payload"]), payload.get("status") or "draft", now, project_id, payload["userId"]),
            )
        else:
            conn.execute(
                """INSERT INTO creator_projects (id,user_id,title,project_type,payload_json,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (project_id, payload["userId"], payload["title"], payload["projectType"], json.dumps(payload["payload"]), payload.get("status") or "draft", now, now),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM creator_projects WHERE id=? AND user_id=?", (project_id, payload["userId"])).fetchone()
        print(json.dumps({"project": {"id": row["id"], "title": row["title"], "type": row["project_type"], "status": row["status"], "payload": json.loads(row["payload_json"]), "updatedAt": row["updated_at"]}}))
        return

    if action == "creator_projects_list":
        rows = conn.execute("SELECT * FROM creator_projects WHERE user_id=? ORDER BY updated_at DESC LIMIT 100", (payload["userId"],)).fetchall()
        print(json.dumps({"projects": [{"id": r["id"], "title": r["title"], "type": r["project_type"], "status": r["status"], "payload": json.loads(r["payload_json"]), "updatedAt": r["updated_at"]} for r in rows]}))
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
        print(json.dumps({"user": public_user(row, conn), "passwordHash": row["password_hash"] if row else None}))
        return

    if action == "get_user_by_id":
        row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"user": public_user(row, conn)}))
        return

    # Platform-admin actions are intentionally only callable by the Node server after its own
    # requirePlatformAdmin() check. The SQLite helper itself is not network-addressable.
    if action == "platform_ensure_skin_organizations":
        now = utc_now()
        owner_user_id = payload["ownerUserId"]
        skins = payload.get("skins") or []
        created = []
        for skin in skins:
            theme_id = skin.get("themeId")
            if not is_valid_brand_id(theme_id) or str(theme_id).startswith(ORG_BRAND_ID_PREFIX):
                continue
            existing = conn.execute(
                """SELECT o.* FROM organizations o JOIN brand_profiles b ON b.organization_id = o.id
                   WHERE b.base_theme_id = ? ORDER BY o.created_at ASC LIMIT 1""", (theme_id,)
            ).fetchone()
            if existing:
                continue
            try:
                conn.execute(
                    """INSERT INTO organizations (id, name, slug, owner_user_id, active_brand_profile_id, plan, subscription_status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, NULL, 'demo', 'none', ?, ?)""",
                    (skin["organizationId"], skin["name"], skin["slug"], owner_user_id, now, now),
                )
                conn.execute(
                    "INSERT INTO memberships (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)",
                    (skin["membershipId"], skin["organizationId"], owner_user_id, now, now),
                )
                conn.execute("INSERT INTO organization_settings (organization_id, onboarding_completed_at, updated_at) VALUES (?, ?, ?)", (skin["organizationId"], now, now))
                conn.execute(
                    """INSERT INTO brand_profiles (id, organization_id, name, base_theme_id, overrides_json, created_at, updated_at)
                       VALUES (?, ?, ?, ?, '{}', ?, ?)""",
                    (skin["brandProfileId"], skin["organizationId"], skin["brandName"], theme_id, now, now),
                )
                conn.execute("UPDATE organizations SET active_brand_profile_id = ?, updated_at = ? WHERE id = ?", (skin["brandProfileId"], now, skin["organizationId"]))
                created.append(skin["organizationId"])
            except sqlite3.IntegrityError:
                conn.rollback()
                continue
        conn.commit()
        print(json.dumps({"ok": True, "created": created}))
        return

    if action == "platform_set_user_password":
        now = utc_now()
        conn.execute(
            """UPDATE users SET password_hash = ?, password_version = COALESCE(password_version, 1) + 1,
               updated_at = ? WHERE id = ?""",
            (payload["passwordHash"], now, payload["userId"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["userId"],)).fetchone()
        print(json.dumps({"user": public_user(row, conn)}))
        return

    if action == "platform_list_organizations":
        rows = conn.execute(
            """
            SELECT o.*,
                   (SELECT COUNT(*) FROM memberships m WHERE m.organization_id = o.id) AS member_count
            FROM organizations o
            ORDER BY o.created_at ASC
            """
        ).fetchall()
        organizations = []
        for row in rows:
            item = org_public(row)
            item["memberCount"] = row["member_count"]
            item["ownerUserId"] = row["owner_user_id"]
            organizations.append(item)
        print(json.dumps({"organizations": organizations}))
        return

    if action == "platform_set_organization_plan":
        plan = payload.get("plan")
        status = payload.get("subscriptionStatus")
        if plan not in ("demo", "creator", "pro", "enterprise"):
            print(json.dumps({"error": "invalid_plan"}))
            return
        if status not in ("none", "trialing", "active", "past_due", "canceled"):
            print(json.dumps({"error": "invalid_status"}))
            return
        now = utc_now()
        conn.execute(
            "UPDATE organizations SET plan = ?, subscription_status = ?, updated_at = ? WHERE id = ?",
            (plan, status, now, payload["organizationId"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM organizations WHERE id = ?", (payload["organizationId"],)).fetchone()
        print(json.dumps({"organization": org_public(row)}))
        return

    if action == "platform_reset_usage":
        conn.execute("DELETE FROM usage_counters WHERE organization_id = ?", (payload["organizationId"],))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "platform_list_sessions_by_org":
        rows = conn.execute(
            "SELECT * FROM live_sessions WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?",
            (payload["organizationId"], int(payload.get("limit") or 200)),
        ).fetchall()
        print(json.dumps({"sessions": [public_session(row) for row in rows]}))
        return

    if action == "platform_set_user_status":
        status = payload.get("status")
        if status not in ("active", "suspended"):
            print(json.dumps({"error": "invalid_status"}))
            return
        now = utc_now()
        conn.execute(
            "UPDATE users SET status = ?, updated_at = ? WHERE id = ?",
            (status, now, payload["userId"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["userId"],)).fetchone()
        print(json.dumps({"user": public_user(row)}))
        return

    if action == "platform_set_onboarding_state":
        now = utc_now()
        existing = conn.execute(
            "SELECT * FROM organization_settings WHERE organization_id = ?",
            (payload["organizationId"],),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO organization_settings (organization_id, updated_at) VALUES (?, ?)",
                (payload["organizationId"], now),
            )
        completed = bool(payload.get("completed"))
        conn.execute(
            "UPDATE organization_settings SET onboarding_completed_at = ?, updated_at = ? WHERE organization_id = ?",
            (now if completed else None, now, payload["organizationId"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM organization_settings WHERE organization_id = ?",
            (payload["organizationId"],),
        ).fetchone()
        print(json.dumps({"settings": org_settings_public(row)}))
        return

    if action == "platform_end_session":
        now = utc_now()
        conn.execute(
            """
            UPDATE live_sessions
            SET status = 'ENDED', ended_at = ?, ended_by = ?, last_active_at = ?
            WHERE id = ? AND organization_id = ? AND status != 'ENDED'
            """,
            (now, payload.get("endedBy"), now, payload["sessionId"], payload["organizationId"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND organization_id = ?",
            (payload["sessionId"], payload["organizationId"]),
        ).fetchone()
        print(json.dumps({"session": public_session(row)}))
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
            if not is_valid_brand_id(brand_id):
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
        print(json.dumps({"user": public_user(row, conn)}))
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
                # maxGuests lets the caller (Node, which owns PLAN_LIMITS — see render-production-server.mjs)
                # pass a plan-derived cap for this specific room; falls back to the original fixed constant
                # when omitted, so any caller that predates this stays exactly as it was.
                max_guests = payload.get("maxGuests")
                max_guests = int(max_guests) if isinstance(max_guests, (int, float)) else MAX_GUESTS_PER_ROOM
                if guest_count >= max_guests:
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
        if brand_id and not is_valid_brand_id(brand_id):
            print(json.dumps({"error": "invalid_brand"}))
            return
        setup_json = json.dumps(payload.get("setup") or {})
        end_card_json = json.dumps(payload.get("endCard") or {})
        conn.execute(
            """
            INSERT INTO live_sessions (
              id, room_id, owner_user_id, organization_id, brand_id, title, status, created_at, last_active_at,
              end_card_json, setup_json
            )
            VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["roomId"],
                payload["ownerUserId"],
                payload.get("organizationId"),
                brand_id,
                payload.get("title") or "",
                now,
                now,
                end_card_json,
                setup_json,
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
        print(json.dumps({
            "status": row["status"] if row else None,
            "brandId": row["brand_id"] if row else None,
            "organizationId": (row["organization_id"] if _row_has(row, "organization_id") else None) if row else None,
        }))
        return

    if action == "session_set_brand":
        brand_id = payload.get("brandId") or ""
        if brand_id and not is_valid_brand_id(brand_id):
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

    if action == "session_set_title":
        now = utc_now()
        conn.execute(
            "UPDATE live_sessions SET title = ?, last_active_at = ? WHERE id = ? AND owner_user_id = ?",
            (payload.get("title") or "", now, payload["id"], payload["ownerUserId"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        ).fetchone()
        print(json.dumps({"session": public_session(row)}))
        return

    if action == "session_set_setup":
        setup_json = json.dumps(payload.get("setup") or {})
        now = utc_now()
        conn.execute(
            "UPDATE live_sessions SET setup_json = ?, last_active_at = ? WHERE id = ? AND owner_user_id = ?",
            (setup_json, now, payload["id"], payload["ownerUserId"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        ).fetchone()
        print(json.dumps({"session": public_session(row)}))
        return

    if action == "session_duplicate":
        source = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["sourceId"], payload["ownerUserId"]),
        ).fetchone()
        if not source:
            print(json.dumps({"session": None}))
            return
        now = utc_now()
        brand_id = payload.get("brandId")
        if brand_id is None:
            brand_id = source["brand_id"] or ""
        if brand_id and not is_valid_brand_id(brand_id):
            print(json.dumps({"error": "invalid_brand"}))
            return
        title = payload.get("title")
        if not title:
            source_title = (source["title"] or "").strip() or "Untitled session"
            title = f"Copy of {source_title}"
        setup = payload.get("setup")
        setup_json = json.dumps(setup if isinstance(setup, dict) else session_setup(source))
        end_card = payload.get("endCard")
        end_card_json = json.dumps(end_card if isinstance(end_card, dict) else session_end_card(source))
        conn.execute(
            """
            INSERT INTO live_sessions (
              id, room_id, owner_user_id, brand_id, title, status, created_at, last_active_at,
              end_card_json, setup_json
            )
            VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["roomId"],
                payload["ownerUserId"],
                brand_id,
                title,
                now,
                now,
                end_card_json,
                setup_json,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM live_sessions WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"session": public_session(row), "sourceId": source["id"]}))
        return

    if action == "session_delete":
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        ).fetchone()
        if not row:
            print(json.dumps({"session": None}))
            return
        room_id = row["room_id"]
        conn.execute("DELETE FROM room_presence WHERE room_id = ?", (room_id,))
        conn.execute("DELETE FROM session_commands WHERE room_id = ?", (room_id,))
        conn.execute("DELETE FROM session_kicks WHERE room_id = ?", (room_id,))
        conn.execute("DELETE FROM session_program WHERE room_id = ?", (room_id,))
        conn.execute(
            "DELETE FROM live_sessions WHERE id = ? AND owner_user_id = ?",
            (payload["id"], payload["ownerUserId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True, "id": payload["id"], "roomId": room_id}))
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

    # ---- Organizations ----

    if action == "create_organization":
        now = utc_now()
        org_id = payload["id"]
        try:
            conn.execute(
                """
                INSERT INTO organizations (id, name, slug, owner_user_id, plan, subscription_status, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'demo', 'none', ?, ?)
                """,
                (org_id, payload["name"], payload["slug"], payload["ownerUserId"], now, now),
            )
            conn.execute(
                "INSERT INTO memberships (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)",
                (payload["membershipId"], org_id, payload["ownerUserId"], now, now),
            )
            conn.execute(
                "INSERT INTO organization_settings (organization_id, updated_at) VALUES (?, ?)",
                (org_id, now),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            print(json.dumps({"error": "duplicate_slug"}))
            return
        print(json.dumps({"organization": org_public(conn.execute("SELECT * FROM organizations WHERE id = ?", (org_id,)).fetchone())}))
        return

    if action == "get_organization":
        row = conn.execute("SELECT * FROM organizations WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"organization": org_public(row)}))
        return

    if action == "get_organization_by_slug":
        row = conn.execute("SELECT * FROM organizations WHERE slug = ?", (payload["slug"],)).fetchone()
        print(json.dumps({"organization": org_public(row)}))
        return

    # Public/guest-safe by design (see session_get_public's own precedent above): a Studio guest or
    # Program Output window has no Toasty account and cannot look up an organization normally, but still
    # needs to render that organization's active BrandProfile. Returns only what applyBrandTheme needs --
    # never plan/billing/owner/slug, which stay behind the authenticated get_organization action.
    if action == "get_organization_brand_profile":
        row = conn.execute("SELECT id, name FROM organizations WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"organizationName": None, "brandProfile": None}))
            return
        print(json.dumps({"organizationName": row["name"], "brandProfile": resolve_active_brand_profile(conn, row["id"])}))
        return

    if action == "list_user_organizations":
        rows = conn.execute(
            """
            SELECT o.*, m.role AS member_role FROM organizations o
            JOIN memberships m ON m.organization_id = o.id
            WHERE m.user_id = ?
            ORDER BY o.created_at ASC
            """,
            (payload["userId"],),
        ).fetchall()
        out = []
        for row in rows:
            item = org_public(row)
            item["role"] = row["member_role"]
            out.append(item)
        print(json.dumps({"organizations": out}))
        return

    if action == "update_organization":
        now = utc_now()
        fields = []
        values = []
        for key, column in (("name", "name"), ("slug", "slug"), ("activeBrandProfileId", "active_brand_profile_id"), ("plan", "plan"), ("subscriptionStatus", "subscription_status")):
            if key in payload:
                fields.append(f"{column} = ?")
                values.append(payload[key])
        if not fields:
            print(json.dumps({"organization": org_public(conn.execute("SELECT * FROM organizations WHERE id = ?", (payload["id"],)).fetchone())}))
            return
        fields.append("updated_at = ?")
        values.append(now)
        values.append(payload["id"])
        try:
            conn.execute(f"UPDATE organizations SET {', '.join(fields)} WHERE id = ?", values)
            conn.commit()
        except sqlite3.IntegrityError:
            print(json.dumps({"error": "duplicate_slug"}))
            return
        print(json.dumps({"organization": org_public(conn.execute("SELECT * FROM organizations WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    # ---- Memberships ----

    if action == "create_membership":
        now = utc_now()
        try:
            conn.execute(
                "INSERT INTO memberships (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (payload["id"], payload["organizationId"], payload["userId"], payload.get("role", "member"), now, now),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            print(json.dumps({"error": "already_member"}))
            return
        print(json.dumps({"membership": membership_public(conn.execute("SELECT * FROM memberships WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "list_memberships":
        rows = conn.execute(
            """
            SELECT m.*, u.name AS user_name, u.email AS user_email, u.status AS user_status,
                   u.platform_role AS user_platform_role
            FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = ?
            ORDER BY m.created_at ASC
            """,
            (payload["organizationId"],),
        ).fetchall()
        out = []
        for row in rows:
            item = membership_public(row)
            item["userName"] = row["user_name"]
            item["userEmail"] = row["user_email"]
            item["userStatus"] = row["user_status"]
            item["userPlatformRole"] = row["user_platform_role"] if "user_platform_role" in row.keys() else "user"
            out.append(item)
        print(json.dumps({"memberships": out}))
        return

    if action == "get_membership":
        row = conn.execute(
            "SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?",
            (payload["organizationId"], payload["userId"]),
        ).fetchone()
        print(json.dumps({"membership": membership_public(row)}))
        return

    if action == "update_membership_role":
        now = utc_now()
        conn.execute(
            "UPDATE memberships SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?",
            (payload["role"], now, payload["organizationId"], payload["userId"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?",
            (payload["organizationId"], payload["userId"]),
        ).fetchone()
        print(json.dumps({"membership": membership_public(row)}))
        return

    if action == "remove_membership":
        conn.execute(
            "DELETE FROM memberships WHERE organization_id = ? AND user_id = ?",
            (payload["organizationId"], payload["userId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    # ---- Organization settings ----

    if action == "get_organization_settings":
        row = conn.execute("SELECT * FROM organization_settings WHERE organization_id = ?", (payload["organizationId"],)).fetchone()
        print(json.dumps({"settings": org_settings_public(row)}))
        return

    if action == "update_organization_settings":
        now = utc_now()
        existing = conn.execute("SELECT * FROM organization_settings WHERE organization_id = ?", (payload["organizationId"],)).fetchone()
        if not existing:
            conn.execute("INSERT INTO organization_settings (organization_id, updated_at) VALUES (?, ?)", (payload["organizationId"], now))
        column_map = {
            "websiteUrl": "website_url",
            "bookingUrl": "booking_url",
            "supportEmail": "support_email",
            "timezone": "timezone",
        }
        json_column_map = {
            "defaultSessionSettings": "default_session_settings_json",
            "defaultCTA": "default_cta_json",
            "defaultEndCard": "default_end_card_json",
            "socialLinks": "social_links_json",
            "customDomainConfig": "custom_domain_config_json",
        }
        fields = []
        values = []
        for key, column in column_map.items():
            if key in payload:
                fields.append(f"{column} = ?")
                values.append(payload[key])
        for key, column in json_column_map.items():
            if key in payload:
                fields.append(f"{column} = ?")
                values.append(json.dumps(payload[key]))
        if payload.get("onboardingCompleted"):
            fields.append("onboarding_completed_at = ?")
            values.append(now)
        if fields:
            fields.append("updated_at = ?")
            values.append(now)
            values.append(payload["organizationId"])
            conn.execute(f"UPDATE organization_settings SET {', '.join(fields)} WHERE organization_id = ?", values)
        conn.commit()
        row = conn.execute("SELECT * FROM organization_settings WHERE organization_id = ?", (payload["organizationId"],)).fetchone()
        print(json.dumps({"settings": org_settings_public(row)}))
        return

    # ---- Brand profiles ----

    if action == "create_brand_profile":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO brand_profiles (id, organization_id, name, base_theme_id, overrides_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (payload["id"], payload["organizationId"], payload.get("name", "Default"), payload.get("baseThemeId", "toasty"), json.dumps(payload.get("overrides", {})), now, now),
        )
        conn.commit()
        print(json.dumps({"brandProfile": brand_profile_public(conn.execute("SELECT * FROM brand_profiles WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "get_brand_profile":
        row = conn.execute("SELECT * FROM brand_profiles WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"brandProfile": brand_profile_public(row)}))
        return

    if action == "list_brand_profiles":
        rows = conn.execute("SELECT * FROM brand_profiles WHERE organization_id = ? ORDER BY created_at ASC", (payload["organizationId"],)).fetchall()
        print(json.dumps({"brandProfiles": [brand_profile_public(row) for row in rows]}))
        return

    if action == "update_brand_profile":
        now = utc_now()
        fields = []
        values = []
        if "name" in payload:
            fields.append("name = ?")
            values.append(payload["name"])
        if "baseThemeId" in payload:
            fields.append("base_theme_id = ?")
            values.append(payload["baseThemeId"])
        if "overrides" in payload:
            fields.append("overrides_json = ?")
            values.append(json.dumps(payload["overrides"]))
        if fields:
            fields.append("updated_at = ?")
            values.append(now)
            values.append(payload["id"])
            conn.execute(f"UPDATE brand_profiles SET {', '.join(fields)} WHERE id = ?", values)
            conn.commit()
        print(json.dumps({"brandProfile": brand_profile_public(conn.execute("SELECT * FROM brand_profiles WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "delete_brand_profile":
        conn.execute("DELETE FROM brand_profiles WHERE id = ?", (payload["id"],))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    # ---- Billing account ----

    if action == "get_billing_account":
        row = conn.execute("SELECT * FROM billing_accounts WHERE organization_id = ?", (payload["organizationId"],)).fetchone()
        print(json.dumps({"billingAccount": billing_account_public(row)}))
        return

    if action == "upsert_billing_account":
        now = utc_now()
        existing = conn.execute("SELECT * FROM billing_accounts WHERE organization_id = ?", (payload["organizationId"],)).fetchone()
        if existing:
            fields = []
            values = []
            for key, column in (("stripeCustomerId", "stripe_customer_id"), ("preferredPaymentMethod", "preferred_payment_method"), ("billingEmail", "billing_email"), ("currency", "currency")):
                if key in payload:
                    fields.append(f"{column} = ?")
                    values.append(payload[key])
            if "billingMetadata" in payload:
                fields.append("billing_metadata_json = ?")
                values.append(json.dumps(payload["billingMetadata"]))
            fields.append("updated_at = ?")
            values.append(now)
            values.append(payload["organizationId"])
            conn.execute(f"UPDATE billing_accounts SET {', '.join(fields)} WHERE organization_id = ?", values)
        else:
            conn.execute(
                """
                INSERT INTO billing_accounts (organization_id, stripe_customer_id, preferred_payment_method, billing_email, currency, billing_metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["organizationId"],
                    payload.get("stripeCustomerId"),
                    payload.get("preferredPaymentMethod", ""),
                    payload.get("billingEmail", ""),
                    payload.get("currency", "usd"),
                    json.dumps(payload.get("billingMetadata", {})),
                    now,
                    now,
                ),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM billing_accounts WHERE organization_id = ?", (payload["organizationId"],)).fetchone()
        print(json.dumps({"billingAccount": billing_account_public(row)}))
        return

    # ---- Subscriptions ----

    if action == "create_subscription":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO subscriptions (id, organization_id, provider, plan, status, current_period_start, current_period_end, cancel_at_period_end, external_subscription_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"], payload["organizationId"], payload["provider"], payload["plan"], payload.get("status", "inactive"),
                payload.get("currentPeriodStart"), payload.get("currentPeriodEnd"), 1 if payload.get("cancelAtPeriodEnd") else 0,
                payload.get("externalSubscriptionId"), now, now,
            ),
        )
        conn.commit()
        print(json.dumps({"subscription": subscription_public(conn.execute("SELECT * FROM subscriptions WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "update_subscription":
        now = utc_now()
        column_map = {
            "plan": "plan", "status": "status", "currentPeriodStart": "current_period_start",
            "currentPeriodEnd": "current_period_end", "externalSubscriptionId": "external_subscription_id",
        }
        fields = []
        values = []
        for key, column in column_map.items():
            if key in payload:
                fields.append(f"{column} = ?")
                values.append(payload[key])
        if "cancelAtPeriodEnd" in payload:
            fields.append("cancel_at_period_end = ?")
            values.append(1 if payload["cancelAtPeriodEnd"] else 0)
        fields.append("updated_at = ?")
        values.append(now)
        values.append(payload["id"])
        conn.execute(f"UPDATE subscriptions SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
        print(json.dumps({"subscription": subscription_public(conn.execute("SELECT * FROM subscriptions WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "get_active_subscription":
        row = conn.execute(
            """
            SELECT * FROM subscriptions WHERE organization_id = ? AND status IN ('active', 'trialing')
            ORDER BY created_at DESC LIMIT 1
            """,
            (payload["organizationId"],),
        ).fetchone()
        print(json.dumps({"subscription": subscription_public(row)}))
        return

    if action == "list_subscriptions":
        rows = conn.execute("SELECT * FROM subscriptions WHERE organization_id = ? ORDER BY created_at DESC", (payload["organizationId"],)).fetchall()
        print(json.dumps({"subscriptions": [subscription_public(row) for row in rows]}))
        return

    # A webhook (Stripe or, later, a Solana confirmation job) only ever knows the PROVIDER's own
    # subscription/payment id, never this table's internal row id — this is how it finds the row to update.
    if action == "get_subscription_by_external_id":
        row = conn.execute(
            "SELECT * FROM subscriptions WHERE provider = ? AND external_subscription_id = ? ORDER BY created_at DESC LIMIT 1",
            (payload["provider"], payload["externalSubscriptionId"]),
        ).fetchone()
        print(json.dumps({"subscription": subscription_public(row)}))
        return

    # ---- AI provider credentials ----
    # encrypted_credential is opaque ciphertext to this script — it never decrypts it, only stores/returns
    # it for the Node process (which holds TOASTY_TOKEN_ENCRYPTION_KEY) to decrypt at the moment of use.

    if action == "upsert_ai_provider_credential":
        now = utc_now()
        existing = conn.execute(
            "SELECT * FROM ai_provider_credentials WHERE organization_id = ? AND provider = ?",
            (payload["organizationId"], payload["provider"]),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE ai_provider_credentials SET encrypted_credential = ?, key_last4 = ?, status = 'active', updated_at = ? WHERE organization_id = ? AND provider = ?",
                (payload["encryptedCredential"], payload.get("keyLast4", ""), now, payload["organizationId"], payload["provider"]),
            )
        else:
            conn.execute(
                """
                INSERT INTO ai_provider_credentials (id, organization_id, provider, encrypted_credential, key_last4, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
                """,
                (payload["id"], payload["organizationId"], payload["provider"], payload["encryptedCredential"], payload.get("keyLast4", ""), now, now),
            )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM ai_provider_credentials WHERE organization_id = ? AND provider = ?",
            (payload["organizationId"], payload["provider"]),
        ).fetchone()
        print(json.dumps({"credential": ai_credential_public(row, include_secret=False)}))
        return

    if action == "get_ai_provider_credential":
        row = conn.execute(
            "SELECT * FROM ai_provider_credentials WHERE organization_id = ? AND provider = ? AND status = 'active'",
            (payload["organizationId"], payload["provider"]),
        ).fetchone()
        print(json.dumps({"credential": ai_credential_public(row, include_secret=True)}))
        return

    if action == "list_ai_provider_credentials":
        rows = conn.execute("SELECT * FROM ai_provider_credentials WHERE organization_id = ? ORDER BY created_at ASC", (payload["organizationId"],)).fetchall()
        print(json.dumps({"credentials": [ai_credential_public(row, include_secret=False) for row in rows]}))
        return

    if action == "delete_ai_provider_credential":
        conn.execute("DELETE FROM ai_provider_credentials WHERE organization_id = ? AND provider = ?", (payload["organizationId"], payload["provider"]))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "set_ai_provider_credential_status":
        now = utc_now()
        conn.execute(
            "UPDATE ai_provider_credentials SET status = ?, updated_at = ? WHERE organization_id = ? AND provider = ?",
            (payload["status"], now, payload["organizationId"], payload["provider"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "upsert_broadcast_destination":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO broadcast_destinations (id, organization_id, destination, label, url_host, key_last4, encrypted_secret, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
            ON CONFLICT (organization_id, destination) DO UPDATE SET
              label = excluded.label, url_host = excluded.url_host, key_last4 = excluded.key_last4,
              encrypted_secret = excluded.encrypted_secret, status = 'connected', updated_at = excluded.updated_at
            """,
            (payload["id"], payload["organizationId"], payload["destination"], payload.get("label", ""), payload.get("urlHost", ""), payload.get("keyLast4", ""), payload["encryptedSecret"], now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM broadcast_destinations WHERE organization_id = ? AND destination = ?", (payload["organizationId"], payload["destination"])).fetchone()
        print(json.dumps({"destination": broadcast_destination_public(row)}))
        return

    if action == "list_broadcast_destinations":
        rows = conn.execute("SELECT * FROM broadcast_destinations WHERE organization_id = ? ORDER BY created_at ASC", (payload["organizationId"],)).fetchall()
        print(json.dumps({"destinations": [broadcast_destination_public(row) for row in rows]}))
        return

    if action == "get_broadcast_destination_secret":
        row = conn.execute("SELECT * FROM broadcast_destinations WHERE organization_id = ? AND destination = ? AND status = 'connected'", (payload["organizationId"], payload["destination"])).fetchone()
        print(json.dumps({"destination": broadcast_destination_public(row, include_secret=True)}))
        return

    if action == "delete_broadcast_destination":
        conn.execute("DELETE FROM broadcast_destinations WHERE organization_id = ? AND destination = ?", (payload["organizationId"], payload["destination"]))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    # ---- Usage ----

    if action == "get_usage_counters":
        row = conn.execute(
            "SELECT * FROM usage_counters WHERE organization_id = ? AND period_start = ?",
            (payload["organizationId"], payload["periodStart"]),
        ).fetchone()
        print(json.dumps({"usage": usage_public(row, payload["organizationId"], payload["periodStart"])}))
        return

    if action == "increment_usage":
        now = utc_now()
        deltas = payload.get("deltas", {})
        column_map = {
            "sessionsCreated": "sessions_created", "renderJobs": "render_jobs", "renderMinutes": "render_minutes",
            "recordingMinutes": "recording_minutes", "storageBytes": "storage_bytes", "aiRequests": "ai_requests",
            "participantMinutes": "participant_minutes", "uploadsBytes": "uploads_bytes",
        }
        conn.execute(
            "INSERT INTO usage_counters (organization_id, period_start, updated_at) VALUES (?, ?, ?) ON CONFLICT (organization_id, period_start) DO NOTHING",
            (payload["organizationId"], payload["periodStart"], now),
        )
        for key, column in column_map.items():
            if key in deltas and deltas[key]:
                conn.execute(
                    f"UPDATE usage_counters SET {column} = {column} + ?, updated_at = ? WHERE organization_id = ? AND period_start = ?",
                    (deltas[key], now, payload["organizationId"], payload["periodStart"]),
                )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM usage_counters WHERE organization_id = ? AND period_start = ?",
            (payload["organizationId"], payload["periodStart"]),
        ).fetchone()
        print(json.dumps({"usage": usage_public(row, payload["organizationId"], payload["periodStart"])}))
        return

    # ---- Billing payment intents (Solana) ----

    if action == "create_payment_intent":
        now = utc_now()
        try:
            conn.execute(
                """
                INSERT INTO billing_payment_intents (
                  id, organization_id, provider, asset, network, fiat_reference_amount, crypto_amount,
                  recipient_wallet, reference, status, plan, term_days, expires_at, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
                """,
                (
                    payload["id"], payload["organizationId"], payload.get("provider", "solana"), payload["asset"],
                    payload["network"], payload["fiatReferenceAmount"], payload["cryptoAmount"], payload["recipientWallet"],
                    payload["reference"], payload["plan"], payload["termDays"], payload["expiresAt"],
                    json.dumps(payload.get("metadata", {})), now,
                ),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            print(json.dumps({"error": "duplicate_reference"}))
            return
        print(json.dumps({"paymentIntent": payment_intent_public(conn.execute("SELECT * FROM billing_payment_intents WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "get_payment_intent":
        row = conn.execute("SELECT * FROM billing_payment_intents WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"paymentIntent": payment_intent_public(row)}))
        return

    if action == "get_payment_intent_by_reference":
        row = conn.execute("SELECT * FROM billing_payment_intents WHERE reference = ?", (payload["reference"],)).fetchone()
        print(json.dumps({"paymentIntent": payment_intent_public(row)}))
        return

    if action == "update_payment_intent_status":
        now = utc_now()
        fields = ["status = ?"]
        values = [payload["status"]]
        if payload.get("transactionSignature"):
            fields.append("transaction_signature = ?")
            values.append(payload["transactionSignature"])
        if payload["status"] == "paid":
            fields.append("paid_at = ?")
            values.append(now)
        values.append(payload["id"])
        if payload.get("transactionSignature") and conn.execute("SELECT 1 FROM peeps_economic_events WHERE transaction_signature = ?", (payload["transactionSignature"],)).fetchone():
            print(json.dumps({"error": "duplicate_signature"}))
            return
        try:
            conn.execute(f"UPDATE billing_payment_intents SET {', '.join(fields)} WHERE id = ?", values)
            conn.commit()
        except sqlite3.IntegrityError:
            print(json.dumps({"error": "duplicate_signature"}))
            return
        print(json.dumps({"paymentIntent": payment_intent_public(conn.execute("SELECT * FROM billing_payment_intents WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "list_payment_intents":
        rows = conn.execute("SELECT * FROM billing_payment_intents WHERE organization_id = ? ORDER BY created_at DESC", (payload["organizationId"],)).fetchall()
        print(json.dumps({"paymentIntents": [payment_intent_public(row) for row in rows]}))
        return

    # ---- Email verification / password reset tokens ----
    # Both token families only ever store a hash (see migrate()'s comment) — the raw token exists only in
    # the emailed link and, briefly, in the Node process's memory before hashing.

    if action == "create_email_verification_token":
        now = utc_now()
        conn.execute("DELETE FROM email_verification_tokens WHERE user_id = ? AND consumed_at IS NULL", (payload["userId"],))
        conn.execute(
            "INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], payload["userId"], payload["tokenHash"], payload["expiresAt"], now),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "consume_email_verification_token":
        now = utc_now()
        row = conn.execute(
            "SELECT * FROM email_verification_tokens WHERE token_hash = ? AND consumed_at IS NULL",
            (payload["tokenHash"],),
        ).fetchone()
        if not row:
            print(json.dumps({"error": "invalid_token"}))
            return
        if row["expires_at"] < now:
            print(json.dumps({"error": "expired_token"}))
            return
        conn.execute("UPDATE email_verification_tokens SET consumed_at = ? WHERE id = ?", (now, row["id"]))
        conn.execute("UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?", (now, now, row["user_id"]))
        conn.commit()
        user_row = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
        print(json.dumps({"user": public_user(user_row)}))
        return

    if action == "create_password_reset_token":
        now = utc_now()
        conn.execute("DELETE FROM password_reset_tokens WHERE user_id = ? AND consumed_at IS NULL", (payload["userId"],))
        conn.execute(
            "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], payload["userId"], payload["tokenHash"], payload["expiresAt"], now),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "consume_password_reset_token":
        now = utc_now()
        row = conn.execute(
            "SELECT * FROM password_reset_tokens WHERE token_hash = ? AND consumed_at IS NULL",
            (payload["tokenHash"],),
        ).fetchone()
        if not row:
            print(json.dumps({"error": "invalid_token"}))
            return
        if row["expires_at"] < now:
            print(json.dumps({"error": "expired_token"}))
            return
        conn.execute("UPDATE password_reset_tokens SET consumed_at = ? WHERE id = ?", (now, row["id"]))
        # Invalidate every other outstanding reset token for this user — a used/expired reset link should
        # never leave a second valid one lying around.
        conn.execute(
            "UPDATE password_reset_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL",
            (now, row["user_id"]),
        )
        conn.execute(
            "UPDATE users SET password_hash = ?, password_changed_at = ?, password_version = password_version + 1, updated_at = ? WHERE id = ?",
            (payload["newPasswordHash"], now, now, row["user_id"]),
        )
        conn.commit()
        user_row = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
        print(json.dumps({"user": public_user(user_row)}))
        return

    # Authenticated "change password" (current password already verified in Node before this call).
    if action == "change_password":
        now = utc_now()
        conn.execute(
            "UPDATE users SET password_hash = ?, password_changed_at = ?, password_version = password_version + 1, updated_at = ? WHERE id = ?",
            (payload["newPasswordHash"], now, now, payload["id"]),
        )
        conn.commit()
        user_row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"user": public_user(user_row)}))
        return

    # ---- Organization invites ----

    if action == "create_invite":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO organization_invites (id, organization_id, email, role, token_hash, invited_by_user_id, status, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            """,
            (payload["id"], payload["organizationId"], payload["email"], payload.get("role", "member"), payload["tokenHash"], payload["invitedByUserId"], payload["expiresAt"], now),
        )
        conn.commit()
        print(json.dumps({"invite": invite_public(conn.execute("SELECT * FROM organization_invites WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "list_invites":
        rows = conn.execute(
            "SELECT * FROM organization_invites WHERE organization_id = ? AND status = 'pending' ORDER BY created_at DESC",
            (payload["organizationId"],),
        ).fetchall()
        print(json.dumps({"invites": [invite_public(row) for row in rows]}))
        return

    if action == "get_invite_by_token":
        row = conn.execute(
            "SELECT * FROM organization_invites WHERE token_hash = ? AND status = 'pending'",
            (payload["tokenHash"],),
        ).fetchone()
        print(json.dumps({"invite": invite_public(row)}))
        return

    if action == "accept_invite":
        now = utc_now()
        row = conn.execute(
            "SELECT * FROM organization_invites WHERE token_hash = ? AND status = 'pending'",
            (payload["tokenHash"],),
        ).fetchone()
        if not row:
            print(json.dumps({"error": "invalid_token"}))
            return
        if row["expires_at"] < now:
            print(json.dumps({"error": "expired_token"}))
            return
        try:
            conn.execute(
                "INSERT INTO memberships (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (payload["membershipId"], row["organization_id"], payload["userId"], row["role"], now, now),
            )
        except sqlite3.IntegrityError:
            print(json.dumps({"error": "already_member"}))
            return
        conn.execute("UPDATE organization_invites SET status = 'accepted', accepted_at = ? WHERE id = ?", (now, row["id"]))
        conn.commit()
        print(json.dumps({"organizationId": row["organization_id"], "role": row["role"]}))
        return

    if action == "revoke_invite":
        now = utc_now()
        conn.execute(
            "UPDATE organization_invites SET status = 'revoked', revoked_at = ? WHERE id = ? AND organization_id = ?",
            (now, payload["id"], payload["organizationId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    # ==================================================================================================
    # EVENT GROWTH — Session Planner, Speakers, Consent, Sponsors, Landing Pages, Audience, Campaign
    # Links, AI usage detail, Post-event artifacts. Session mutation itself (session_set_plan) stays
    # owner_user_id-scoped, exactly like session_set_setup/session_set_end_card above — Studio session
    # access is not yet organization-wide on this codebase (see the enforceSessionQuota comment in
    # render-production-server.mjs). Every NEW child entity below uses organization_id as its tenant
    # boundary instead, always passed in by the Node layer after deriving it from the parent session's own
    # organization_id — never trusted as a raw client value.
    # ==================================================================================================

    if action == "session_get_public":
        # Guest invite pages (speaker/sponsor) need the event's title/brand to say "for EVENT NAME" —
        # never the owner_user_id/organization_id or anything else that would identify the organizer's
        # account to someone holding only an invite token.
        row = conn.execute("SELECT title, brand_id FROM live_sessions WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"session": None}))
            return
        print(json.dumps({"session": {"title": row["title"], "brandId": row["brand_id"]}}))
        return

    if action == "session_get_room_and_status":
        # Internal-only lookup for the Jam access/events routes below — a participant proves authorization
        # via their invite token (checked by the Node handler before this is ever called), not via
        # owner_user_id, so this deliberately has no owner check, same precedent as
        # session_get_organization above. Returns just enough to mount the guest video frame and label the
        # capture policy — never owner_user_id/organization_id.
        row = conn.execute(
            "SELECT room_id, status, brand_id, title, setup_json FROM live_sessions WHERE id = ?",
            (payload["id"],),
        ).fetchone()
        if not row:
            print(json.dumps({"roomId": None, "status": None, "brandId": None, "title": None, "capturePolicy": None}))
            return
        setup = _json_or(row["setup_json"], {})
        policy = setup.get("policy") if isinstance(setup, dict) else None
        capture_policy = policy.get("capturePolicy") if isinstance(policy, dict) else None
        print(json.dumps({
            "roomId": row["room_id"],
            "status": row["status"],
            "brandId": row["brand_id"],
            "title": row["title"],
            "capturePolicy": capture_policy,
        }))
        return

    if action == "session_get_internal":
        # Server-only lookup by id with no owner check — callers (Peeps execution) have already proven
        # organization membership. Never exposed through a route.
        row = conn.execute("SELECT * FROM live_sessions WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"session": public_session(row)}))
        return

    if action == "session_get_organization":
        # Internal-only lookup: derives a session's organization_id server-side so audience-event/identity
        # recording never has to trust a client-supplied organizationId, without exposing organizationId
        # itself through any client-facing action (session_get_public deliberately omits it).
        row = conn.execute("SELECT organization_id FROM live_sessions WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"organizationId": row["organization_id"] if row else None}))
        return

    if action == "session_set_plan":
        now = utc_now()
        conn.execute(
            "UPDATE live_sessions SET plan_json = ?, last_active_at = ? WHERE id = ? AND owner_user_id = ?",
            (json.dumps(payload.get("plan") or {}), now, payload["id"], payload["ownerUserId"]),
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

    # ---- Speakers ----

    if action == "speaker_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO speakers (
              id, session_id, organization_id, email, session_role, invite_status, display_name,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'not_sent', ?, ?, ?)
            """,
            (
                payload["id"],
                payload["sessionId"],
                payload.get("organizationId"),
                payload.get("email") or "",
                payload.get("sessionRole") or "",
                payload.get("displayName") or "",
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM speakers WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"speaker": public_speaker(row)}))
        return

    if action == "speaker_list":
        rows = conn.execute(
            "SELECT * FROM speakers WHERE session_id = ? ORDER BY created_at ASC",
            (payload["sessionId"],),
        ).fetchall()
        print(json.dumps({"speakers": [public_speaker(row) for row in rows]}))
        return

    if action == "speaker_get":
        row = conn.execute("SELECT * FROM speakers WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"speaker": public_speaker(row)}))
        return

    if action == "speaker_update":
        row = conn.execute("SELECT * FROM speakers WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"speaker": None}))
            return
        fields = payload.get("fields") or {}
        column_map = {
            "sessionRole": "session_role",
            "displayName": "display_name",
            "headshotReference": "headshot_reference",
            "title": "title",
            "company": "company",
            "bioShort": "bio_short",
            "bioLong": "bio_long",
            "pronunciationNotes": "pronunciation_notes",
            "location": "location",
            "speakerTimezone": "speaker_timezone",
            "onscreenTitle": "onscreen_title",
            "pronouns": "pronouns",
            "peepsPersonId": "peeps_person_id",
            "selectionReason": "selection_reason",
            "inviteStatus": "invite_status",
        }
        sets = []
        values = []
        for key, column in column_map.items():
            if key in fields:
                sets.append(f"{column} = ?")
                values.append(fields[key])
        if "links" in fields:
            sets.append("links_json = ?")
            values.append(json.dumps(fields["links"] or {}))
        if "hiddenFields" in fields:
            sets.append("hidden_fields_json = ?")
            values.append(json.dumps(fields["hiddenFields"] or []))
        if payload.get("markProfileSubmitted"):
            sets.append("profile_submitted_at = ?")
            values.append(utc_now())
        now = utc_now()
        sets.append("updated_at = ?")
        values.append(now)
        values.append(payload["id"])
        if sets:
            conn.execute(f"UPDATE speakers SET {', '.join(sets)} WHERE id = ?", values)
            conn.commit()
        row = conn.execute("SELECT * FROM speakers WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"speaker": public_speaker(row)}))
        return

    if action == "speaker_invite_issue":
        now = utc_now()
        conn.execute(
            "INSERT INTO speaker_invites (id, speaker_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], payload["speakerId"], payload["tokenHash"], payload["expiresAt"], now),
        )
        conn.execute(
            "UPDATE speakers SET invite_status = 'sent', updated_at = ? WHERE id = ?",
            (now, payload["speakerId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True, "id": payload["id"]}))
        return

    if action == "speaker_invite_get":
        row = conn.execute(
            "SELECT * FROM speaker_invites WHERE token_hash = ?",
            (payload["tokenHash"],),
        ).fetchone()
        if not row:
            print(json.dumps({"invite": None}))
            return
        speaker = conn.execute("SELECT * FROM speakers WHERE id = ?", (row["speaker_id"],)).fetchone()
        invite = {
            "id": row["id"],
            "speakerId": row["speaker_id"],
            "expiresAt": row["expires_at"],
            "revokedAt": row["revoked_at"],
            "usedAt": row["used_at"],
        }
        print(json.dumps({"invite": invite, "speaker": public_speaker(speaker)}))
        return

    if action == "speaker_invite_revoke":
        now = utc_now()
        conn.execute(
            "UPDATE speaker_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (now, payload["id"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "speaker_invite_redeem":
        now = utc_now()
        conn.execute(
            "UPDATE speaker_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
            (now, payload["tokenHash"]),
        )
        conn.execute(
            "UPDATE speakers SET invite_status = 'accepted', updated_at = ? WHERE id = ?",
            (now, payload["speakerId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "tech_check_record":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO tech_checks (
              id, speaker_id, session_id, completed_at, camera_ok, mic_ok, speaker_ok,
              browser_supported, connection_outcome, warnings_json, device_labels_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["speakerId"],
                payload["sessionId"],
                now,
                1 if payload.get("cameraOk") else 0,
                1 if payload.get("micOk") else 0,
                1 if payload.get("speakerOk") else 0,
                1 if payload.get("browserSupported") else 0,
                payload.get("connectionOutcome") or "",
                json.dumps(payload.get("warnings") or []),
                json.dumps(payload.get("deviceLabels") or []),
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM tech_checks WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"techCheck": public_tech_check(row)}))
        return

    if action == "tech_check_latest":
        row = conn.execute(
            "SELECT * FROM tech_checks WHERE speaker_id = ? ORDER BY completed_at DESC LIMIT 1",
            (payload["speakerId"],),
        ).fetchone()
        print(json.dumps({"techCheck": public_tech_check(row)}))
        return

    # ---- Consent ----

    if action == "consent_record_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO consent_records (
              id, organization_id, session_id, participant_type, participant_id, agreement_version,
              required_acceptances_json, optional_permissions_json, accepted_at, source, ip_metadata,
              user_agent, document_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload.get("organizationId"),
                payload["sessionId"],
                payload["participantType"],
                payload["participantId"],
                payload["agreementVersion"],
                json.dumps(payload.get("requiredAcceptances") or []),
                json.dumps(payload.get("optionalPermissions") or []),
                now,
                payload.get("source") or "",
                payload.get("ipMetadata") or "",
                payload.get("userAgent") or "",
                payload.get("documentHash") or "",
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM consent_records WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"consentRecord": public_consent_record(row)}))
        return

    if action == "consent_record_list":
        if payload.get("participantId"):
            rows = conn.execute(
                "SELECT * FROM consent_records WHERE session_id = ? AND participant_id = ? ORDER BY created_at DESC",
                (payload["sessionId"], payload["participantId"]),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM consent_records WHERE session_id = ? ORDER BY created_at DESC",
                (payload["sessionId"],),
            ).fetchall()
        print(json.dumps({"consentRecords": [public_consent_record(row) for row in rows]}))
        return

    if action == "consent_record_revoke":
        now = utc_now()
        conn.execute(
            "UPDATE consent_records SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL",
            (now, payload.get("reason") or "", payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM consent_records WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"consentRecord": public_consent_record(row)}))
        return

    # ---- Sponsors ----

    if action == "sponsor_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO sponsors (
              id, session_id, organization_id, company_name, contact_name, contact_email, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["sessionId"],
                payload.get("organizationId"),
                payload.get("companyName") or "",
                payload.get("contactName") or "",
                payload.get("contactEmail") or "",
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM sponsors WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"sponsor": public_sponsor(row)}))
        return

    if action == "sponsor_list":
        rows = conn.execute(
            "SELECT * FROM sponsors WHERE session_id = ? ORDER BY created_at ASC",
            (payload["sessionId"],),
        ).fetchall()
        print(json.dumps({"sponsors": [public_sponsor(row) for row in rows]}))
        return

    if action == "sponsor_get":
        row = conn.execute("SELECT * FROM sponsors WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"sponsor": public_sponsor(row)}))
        return

    if action == "sponsor_update":
        fields = payload.get("fields") or {}
        column_map = {
            "companyName": "company_name",
            "contactName": "contact_name",
            "contactEmail": "contact_email",
            "website": "website",
            "logoReference": "logo_reference",
            "campaignUrl": "campaign_url",
            "promoCode": "promo_code",
            "qrDestination": "qr_destination",
            "talkingPoints": "talking_points",
            "requiredDisclosure": "required_disclosure",
            "doNotSay": "do_not_say",
            "sponsorGraphicReference": "sponsor_graphic_reference",
            "videoAssetReference": "video_asset_reference",
        }
        sets = []
        values = []
        for key, column in column_map.items():
            if key in fields:
                sets.append(f"{column} = ?")
                values.append(fields[key])
        if "productImages" in fields:
            sets.append("product_images_json = ?")
            values.append(json.dumps(fields["productImages"] or []))
        if "socialLinks" in fields:
            sets.append("social_links_json = ?")
            values.append(json.dumps(fields["socialLinks"] or {}))
        now = utc_now()
        sets.append("updated_at = ?")
        values.append(now)
        values.append(payload["id"])
        if sets:
            conn.execute(f"UPDATE sponsors SET {', '.join(sets)} WHERE id = ?", values)
            conn.commit()
        row = conn.execute("SELECT * FROM sponsors WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"sponsor": public_sponsor(row)}))
        return

    if action == "sponsor_set_approval":
        now = utc_now()
        conn.execute(
            "UPDATE sponsors SET approval_status = ?, updated_at = ? WHERE id = ?",
            (payload["approvalStatus"], now, payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM sponsors WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"sponsor": public_sponsor(row)}))
        return

    if action == "sponsor_invite_issue":
        now = utc_now()
        conn.execute(
            "INSERT INTO sponsor_invites (id, sponsor_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], payload["sponsorId"], payload["tokenHash"], payload["expiresAt"], now),
        )
        conn.execute(
            "UPDATE sponsors SET invite_status = 'sent', updated_at = ? WHERE id = ?",
            (now, payload["sponsorId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True, "id": payload["id"]}))
        return

    if action == "sponsor_invite_get":
        row = conn.execute(
            "SELECT * FROM sponsor_invites WHERE token_hash = ?",
            (payload["tokenHash"],),
        ).fetchone()
        if not row:
            print(json.dumps({"invite": None}))
            return
        sponsor = conn.execute("SELECT * FROM sponsors WHERE id = ?", (row["sponsor_id"],)).fetchone()
        invite = {
            "id": row["id"],
            "sponsorId": row["sponsor_id"],
            "expiresAt": row["expires_at"],
            "revokedAt": row["revoked_at"],
            "usedAt": row["used_at"],
        }
        print(json.dumps({"invite": invite, "sponsor": public_sponsor(sponsor)}))
        return

    if action == "sponsor_invite_redeem":
        now = utc_now()
        conn.execute(
            "UPDATE sponsor_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
            (now, payload["tokenHash"]),
        )
        conn.execute(
            "UPDATE sponsors SET invite_status = 'accepted', updated_at = ? WHERE id = ?",
            (now, payload["sponsorId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "sponsor_moment_get":
        row = conn.execute("SELECT * FROM sponsor_moments WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"sponsorMoment": public_sponsor_moment(row)}))
        return

    if action == "sponsor_moment_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO sponsor_moments (
              id, session_id, sponsor_id, position, label, start_offset_seconds, treatment, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
            """,
            (
                payload["id"],
                payload["sessionId"],
                payload["sponsorId"],
                payload.get("position") or 0,
                payload.get("label") or "",
                payload.get("startOffsetSeconds"),
                payload.get("treatment") or "host_read",
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM sponsor_moments WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"sponsorMoment": public_sponsor_moment(row)}))
        return

    if action == "sponsor_moment_list":
        rows = conn.execute(
            "SELECT * FROM sponsor_moments WHERE session_id = ? ORDER BY position ASC",
            (payload["sessionId"],),
        ).fetchall()
        print(json.dumps({"sponsorMoments": [public_sponsor_moment(row) for row in rows]}))
        return

    if action == "sponsor_moment_update":
        now = utc_now()
        conn.execute(
            "UPDATE sponsor_moments SET status = COALESCE(?, status), updated_at = ? WHERE id = ?",
            (payload.get("status"), now, payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM sponsor_moments WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"sponsorMoment": public_sponsor_moment(row)}))
        return

    # ---- Landing pages ----

    if action == "landing_page_upsert":
        now = utc_now()
        existing = conn.execute(
            "SELECT * FROM landing_pages WHERE session_id = ?", (payload["sessionId"],)
        ).fetchone()
        blocks_json = json.dumps(payload.get("blocks") or [])
        if existing:
            try:
                conn.execute(
                    "UPDATE landing_pages SET slug = ?, template_id = ?, blocks_json = ?, brand_profile_id = ?, updated_at = ? WHERE session_id = ?",
                    (payload["slug"], payload.get("templateId") or "default", blocks_json, payload.get("brandProfileId"), now, payload["sessionId"]),
                )
            except sqlite3.IntegrityError:
                print(json.dumps({"error": "slug_taken"}))
                return
        else:
            try:
                conn.execute(
                    """
                    INSERT INTO landing_pages (
                      id, session_id, organization_id, brand_profile_id, slug, template_id, blocks_json,
                      created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payload["id"],
                        payload["sessionId"],
                        payload.get("organizationId"),
                        payload.get("brandProfileId"),
                        payload["slug"],
                        payload.get("templateId") or "default",
                        blocks_json,
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError:
                print(json.dumps({"error": "slug_taken"}))
                return
        conn.commit()
        row = conn.execute("SELECT * FROM landing_pages WHERE session_id = ?", (payload["sessionId"],)).fetchone()
        print(json.dumps({"landingPage": public_landing_page(row)}))
        return

    if action == "landing_page_publish":
        now = utc_now()
        conn.execute(
            "UPDATE landing_pages SET status = 'published', published_at = ?, updated_at = ? WHERE session_id = ?",
            (now, now, payload["sessionId"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM landing_pages WHERE session_id = ?", (payload["sessionId"],)).fetchone()
        print(json.dumps({"landingPage": public_landing_page(row)}))
        return

    if action == "landing_page_unpublish":
        now = utc_now()
        conn.execute(
            "UPDATE landing_pages SET status = 'draft', updated_at = ? WHERE session_id = ?",
            (now, payload["sessionId"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM landing_pages WHERE session_id = ?", (payload["sessionId"],)).fetchone()
        print(json.dumps({"landingPage": public_landing_page(row)}))
        return

    if action == "landing_page_get_by_session":
        row = conn.execute("SELECT * FROM landing_pages WHERE session_id = ?", (payload["sessionId"],)).fetchone()
        print(json.dumps({"landingPage": public_landing_page(row)}))
        return

    if action == "landing_page_get_by_slug":
        row = conn.execute("SELECT * FROM landing_pages WHERE slug = ?", (payload["slug"],)).fetchone()
        print(json.dumps({"landingPage": public_landing_page(row)}))
        return

    # ---- Audience identity + event stream ----

    if action == "audience_identity_upsert":
        now = utc_now()
        existing = conn.execute(
            "SELECT * FROM audience_identities WHERE organization_id = ? AND anonymous_id = ?",
            (payload["organizationId"], payload["anonymousId"]),
        ).fetchone()
        if existing:
            display_name = payload.get("displayName")
            known_email = payload.get("knownEmail")
            peeps_person_id = payload.get("peepsPersonId")
            conn.execute(
                """
                UPDATE audience_identities
                SET last_seen_at = ?, display_name = COALESCE(?, display_name),
                    known_email = COALESCE(?, known_email), peeps_person_id = COALESCE(?, peeps_person_id)
                WHERE id = ?
                """,
                (now, display_name, known_email, peeps_person_id, existing["id"]),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM audience_identities WHERE id = ?", (existing["id"],)).fetchone()
            print(json.dumps({"identity": public_audience_identity(row)}))
            return
        conn.execute(
            """
            INSERT INTO audience_identities (
              id, organization_id, anonymous_id, peeps_person_id, known_email, display_name,
              first_seen_at, last_seen_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["organizationId"],
                payload["anonymousId"],
                payload.get("peepsPersonId"),
                payload.get("knownEmail"),
                payload.get("displayName") or "",
                now,
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM audience_identities WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"identity": public_audience_identity(row)}))
        return

    if action == "audience_identity_merge":
        now = utc_now()
        conn.execute(
            "UPDATE audience_identities SET merged_into_id = ?, last_seen_at = ? WHERE id = ? AND organization_id = ?",
            (payload["mergedIntoId"], now, payload["id"], payload["organizationId"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM audience_identities WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"identity": public_audience_identity(row)}))
        return

    if action == "audience_event_record":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO audience_events (
              id, organization_id, session_id, identity_id, anonymous_id, event_type, occurred_at,
              source, campaign, referrer, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["organizationId"],
                payload["sessionId"],
                payload.get("identityId"),
                payload.get("anonymousId"),
                payload["eventType"],
                now,
                payload.get("source") or "",
                payload.get("campaign") or "",
                payload.get("referrer") or "",
                json.dumps(payload.get("metadata") or {}),
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM audience_events WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"event": public_audience_event(row)}))
        return

    if action == "audience_event_list":
        limit = min(int(payload.get("limit") or 500), 2000)
        rows = conn.execute(
            "SELECT * FROM audience_events WHERE session_id = ? ORDER BY occurred_at DESC LIMIT ?",
            (payload["sessionId"], limit),
        ).fetchall()
        print(json.dumps({"events": [public_audience_event(row) for row in rows]}))
        return

    if action == "audience_event_summary":
        rows = conn.execute(
            "SELECT event_type, COUNT(*) as n FROM audience_events WHERE session_id = ? GROUP BY event_type",
            (payload["sessionId"],),
        ).fetchall()
        counts = {row["event_type"]: row["n"] for row in rows}
        unique_identities = conn.execute(
            """
            SELECT COUNT(DISTINCT COALESCE(identity_id, anonymous_id)) as n
            FROM audience_events WHERE session_id = ?
            """,
            (payload["sessionId"],),
        ).fetchone()["n"]
        print(json.dumps({"countsByType": counts, "uniqueVisitors": unique_identities}))
        return

    # ---- Campaign links ----

    if action == "campaign_link_create":
        now = utc_now()
        try:
            conn.execute(
                """
                INSERT INTO campaign_links (
                  id, organization_id, session_id, slug, destination_url, campaign, source, speaker_id,
                  sponsor_id, clip_id, referral_partner, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["id"],
                    payload["organizationId"],
                    payload["sessionId"],
                    payload["slug"],
                    payload.get("destinationUrl") or "",
                    payload.get("campaign") or "",
                    payload.get("source") or "",
                    payload.get("speakerId"),
                    payload.get("sponsorId"),
                    payload.get("clipId"),
                    payload.get("referralPartner") or "",
                    now,
                ),
            )
        except sqlite3.IntegrityError:
            print(json.dumps({"error": "slug_taken"}))
            return
        conn.commit()
        row = conn.execute("SELECT * FROM campaign_links WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"campaignLink": public_campaign_link(row)}))
        return

    if action == "campaign_link_list":
        rows = conn.execute(
            "SELECT * FROM campaign_links WHERE session_id = ? ORDER BY created_at ASC",
            (payload["sessionId"],),
        ).fetchall()
        print(json.dumps({"campaignLinks": [public_campaign_link(row) for row in rows]}))
        return

    if action == "campaign_link_get":
        row = conn.execute("SELECT * FROM campaign_links WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"campaignLink": public_campaign_link(row)}))
        return

    if action == "campaign_link_set_active":
        conn.execute(
            "UPDATE campaign_links SET is_active = ? WHERE id = ?",
            (1 if payload.get("isActive") else 0, payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM campaign_links WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"campaignLink": public_campaign_link(row)}))
        return

    if action == "campaign_link_resolve":
        # A disabled link resolves exactly like a non-existent one — the redirect route never reveals
        # whether a slug was disabled vs. never created.
        row = conn.execute(
            "SELECT * FROM campaign_links WHERE slug = ? AND is_active = 1", (payload["slug"],)
        ).fetchone()
        if not row:
            print(json.dumps({"campaignLink": None}))
            return
        conn.execute("UPDATE campaign_links SET click_count = click_count + 1 WHERE id = ?", (row["id"],))
        conn.commit()
        row = conn.execute("SELECT * FROM campaign_links WHERE id = ?", (row["id"],)).fetchone()
        print(json.dumps({"campaignLink": public_campaign_link(row)}))
        return

    # ---- AI usage detail (additive to usage_counters — see schema comment) ----

    if action == "ai_usage_record":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO ai_usage_events (
              id, organization_id, session_id, occurred_at, provider, model, feature, input_tokens,
              output_tokens, total_tokens, estimated_cost, latency_ms, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["organizationId"],
                payload.get("sessionId"),
                now,
                payload.get("provider") or "",
                payload.get("model") or "",
                payload.get("feature") or "",
                payload.get("inputTokens"),
                payload.get("outputTokens"),
                payload.get("totalTokens"),
                payload.get("estimatedCost"),
                payload.get("latencyMs"),
                json.dumps(payload.get("metadata") or {}),
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM ai_usage_events WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"usageEvent": public_ai_usage_event(row)}))
        return

    if action == "ai_usage_summary":
        if payload.get("sessionId"):
            rows = conn.execute(
                "SELECT * FROM ai_usage_events WHERE organization_id = ? AND session_id = ? ORDER BY occurred_at DESC",
                (payload["organizationId"], payload["sessionId"]),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM ai_usage_events WHERE organization_id = ? ORDER BY occurred_at DESC LIMIT 2000",
                (payload["organizationId"],),
            ).fetchall()
        events = [public_ai_usage_event(row) for row in rows]
        by_feature = {}
        total_tokens = 0
        total_cost = 0.0
        for event in events:
            feature = event["feature"] or "unspecified"
            bucket = by_feature.setdefault(feature, {"totalTokens": 0, "estimatedCost": 0.0, "count": 0})
            bucket["totalTokens"] += event["totalTokens"] or 0
            bucket["estimatedCost"] += event["estimatedCost"] or 0
            bucket["count"] += 1
            total_tokens += event["totalTokens"] or 0
            total_cost += event["estimatedCost"] or 0
        print(json.dumps({"events": events, "byFeature": by_feature, "totalTokens": total_tokens, "totalEstimatedCost": total_cost}))
        return

    if action == "platform_ai_usage_report":
        organization_id = payload["organizationId"]

        totals = conn.execute(
            """
            SELECT COUNT(*) AS calls,
                   COALESCE(SUM(input_tokens),0) AS input_tokens,
                   COALESCE(SUM(output_tokens),0) AS output_tokens,
                   COALESCE(SUM(total_tokens),0) AS total_tokens,
                   COALESCE(SUM(estimated_cost),0) AS estimated_cost,
                   COALESCE(AVG(latency_ms),0) AS avg_latency_ms
            FROM ai_usage_events
            WHERE organization_id = ?
            """,
            (organization_id,),
        ).fetchone()

        session_rows = conn.execute(
            """
            SELECT s.id AS session_id,
                   s.title AS session_title,
                   s.status AS session_status,
                   s.created_at AS session_created_at,
                   s.ended_at AS session_ended_at,
                   COUNT(a.id) AS calls,
                   COALESCE(SUM(a.input_tokens),0) AS input_tokens,
                   COALESCE(SUM(a.output_tokens),0) AS output_tokens,
                   COALESCE(SUM(a.total_tokens),0) AS total_tokens,
                   COALESCE(SUM(a.estimated_cost),0) AS estimated_cost,
                   COALESCE(AVG(a.latency_ms),0) AS avg_latency_ms
            FROM live_sessions s
            LEFT JOIN ai_usage_events a
              ON a.session_id = s.id AND a.organization_id = s.organization_id
            WHERE s.organization_id = ?
            GROUP BY s.id
            ORDER BY total_tokens DESC, s.created_at DESC
            LIMIT 250
            """,
            (organization_id,),
        ).fetchall()

        provider_rows = conn.execute(
            """
            SELECT provider, model,
                   COUNT(*) AS calls,
                   COALESCE(SUM(input_tokens),0) AS input_tokens,
                   COALESCE(SUM(output_tokens),0) AS output_tokens,
                   COALESCE(SUM(total_tokens),0) AS total_tokens,
                   COALESCE(SUM(estimated_cost),0) AS estimated_cost,
                   COALESCE(AVG(latency_ms),0) AS avg_latency_ms
            FROM ai_usage_events
            WHERE organization_id = ?
            GROUP BY provider, model
            ORDER BY total_tokens DESC
            """,
            (organization_id,),
        ).fetchall()

        feature_rows = conn.execute(
            """
            SELECT feature,
                   COUNT(*) AS calls,
                   COALESCE(SUM(total_tokens),0) AS total_tokens,
                   COALESCE(SUM(estimated_cost),0) AS estimated_cost
            FROM ai_usage_events
            WHERE organization_id = ?
            GROUP BY feature
            ORDER BY total_tokens DESC
            """,
            (organization_id,),
        ).fetchall()

        recent_rows = conn.execute(
            """
            SELECT * FROM ai_usage_events
            WHERE organization_id = ?
            ORDER BY occurred_at DESC
            LIMIT 100
            """,
            (organization_id,),
        ).fetchall()

        sessions = []
        sessions_with_ai = 0
        for row in session_rows:
            calls = int(row["calls"] or 0)
            if calls:
                sessions_with_ai += 1
            sessions.append({
                "sessionId": row["session_id"],
                "sessionTitle": row["session_title"],
                "sessionStatus": row["session_status"],
                "sessionCreatedAt": row["session_created_at"],
                "sessionEndedAt": row["session_ended_at"],
                "calls": calls,
                "inputTokens": int(row["input_tokens"] or 0),
                "outputTokens": int(row["output_tokens"] or 0),
                "totalTokens": int(row["total_tokens"] or 0),
                "estimatedCost": float(row["estimated_cost"] or 0),
                "avgLatencyMs": float(row["avg_latency_ms"] or 0),
            })

        total_session_count = conn.execute(
            "SELECT COUNT(*) AS n FROM live_sessions WHERE organization_id = ?",
            (organization_id,),
        ).fetchone()["n"]

        report = {
            "totals": {
                "calls": int(totals["calls"] or 0),
                "inputTokens": int(totals["input_tokens"] or 0),
                "outputTokens": int(totals["output_tokens"] or 0),
                "totalTokens": int(totals["total_tokens"] or 0),
                "estimatedCost": float(totals["estimated_cost"] or 0),
                "avgLatencyMs": float(totals["avg_latency_ms"] or 0),
                "sessionCount": int(total_session_count or 0),
                "sessionsWithAi": sessions_with_ai,
            },
            "bySession": sessions,
            "byProviderModel": [{
                "provider": row["provider"] or "",
                "model": row["model"] or "",
                "calls": int(row["calls"] or 0),
                "inputTokens": int(row["input_tokens"] or 0),
                "outputTokens": int(row["output_tokens"] or 0),
                "totalTokens": int(row["total_tokens"] or 0),
                "estimatedCost": float(row["estimated_cost"] or 0),
                "avgLatencyMs": float(row["avg_latency_ms"] or 0),
            } for row in provider_rows],
            "byFeature": [{
                "feature": row["feature"] or "unspecified",
                "calls": int(row["calls"] or 0),
                "totalTokens": int(row["total_tokens"] or 0),
                "estimatedCost": float(row["estimated_cost"] or 0),
            } for row in feature_rows],
            "recentEvents": [public_ai_usage_event(row) for row in recent_rows],
        }
        print(json.dumps(report))
        return

    # ---- Studio broadcast economics (platform operator telemetry) ----

    if action == "studio_broadcast_usage_record":
        now = utc_now()
        conn.execute(
            """
            INSERT OR IGNORE INTO studio_broadcast_usage (
              id, organization_id, session_id, user_id, started_at, ended_at, duration_seconds,
              destination_count, destinations_json, bytes_in, bytes_out, encoder_seconds,
              estimated_network_cost, estimated_compute_cost, estimated_total_cost, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"], payload["organizationId"], payload.get("sessionId"), payload.get("userId"),
                payload.get("startedAt"), payload.get("endedAt") or now, int(payload.get("durationSeconds") or 0),
                int(payload.get("destinationCount") or 0), json.dumps(payload.get("destinations") or []),
                int(payload.get("bytesIn") or 0), int(payload.get("bytesOut") or 0), int(payload.get("encoderSeconds") or 0),
                float(payload.get("estimatedNetworkCost") or 0), float(payload.get("estimatedComputeCost") or 0),
                float(payload.get("estimatedTotalCost") or 0), now,
            ),
        )
        conn.commit()
        print(json.dumps({"ok": True, "id": payload["id"]}))
        return

    if action == "platform_studio_economics_report":
        organization_id = payload["organizationId"]
        rows = conn.execute(
            """
            SELECT b.*, s.title AS session_title, s.status AS session_status
            FROM studio_broadcast_usage b
            LEFT JOIN live_sessions s ON s.id = b.session_id
            WHERE b.organization_id = ?
            ORDER BY b.ended_at DESC
            LIMIT 500
            """,
            (organization_id,),
        ).fetchall()
        totals = conn.execute(
            """
            SELECT COUNT(*) AS broadcasts,
                   COALESCE(SUM(duration_seconds),0) AS duration_seconds,
                   COALESCE(SUM(destination_count),0) AS destination_instances,
                   COALESCE(SUM(bytes_in),0) AS bytes_in,
                   COALESCE(SUM(bytes_out),0) AS bytes_out,
                   COALESCE(SUM(encoder_seconds),0) AS encoder_seconds,
                   COALESCE(SUM(estimated_network_cost),0) AS network_cost,
                   COALESCE(SUM(estimated_compute_cost),0) AS compute_cost,
                   COALESCE(SUM(estimated_total_cost),0) AS total_cost
            FROM studio_broadcast_usage WHERE organization_id = ?
            """,
            (organization_id,),
        ).fetchone()
        session_rows = conn.execute(
            """
            SELECT s.id AS session_id, s.title AS session_title, s.status AS session_status,
                   COALESCE(SUM(b.duration_seconds),0) AS duration_seconds,
                   COALESCE(SUM(b.destination_count),0) AS destination_instances,
                   COALESCE(SUM(b.bytes_in),0) AS bytes_in,
                   COALESCE(SUM(b.bytes_out),0) AS bytes_out,
                   COALESCE(SUM(b.encoder_seconds),0) AS encoder_seconds,
                   COALESCE(SUM(b.estimated_total_cost),0) AS broadcast_cost,
                   COUNT(b.id) AS broadcasts
            FROM live_sessions s
            LEFT JOIN studio_broadcast_usage b ON b.session_id = s.id AND b.organization_id = s.organization_id
            WHERE s.organization_id = ?
            GROUP BY s.id
            ORDER BY MAX(COALESCE(b.ended_at, s.created_at)) DESC
            LIMIT 250
            """,
            (organization_id,),
        ).fetchall()
        report = {
            "totals": {
                "broadcasts": int(totals["broadcasts"] or 0),
                "durationSeconds": int(totals["duration_seconds"] or 0),
                "destinationInstances": int(totals["destination_instances"] or 0),
                "bytesIn": int(totals["bytes_in"] or 0),
                "bytesOut": int(totals["bytes_out"] or 0),
                "encoderSeconds": int(totals["encoder_seconds"] or 0),
                "estimatedNetworkCost": float(totals["network_cost"] or 0),
                "estimatedComputeCost": float(totals["compute_cost"] or 0),
                "estimatedTotalCost": float(totals["total_cost"] or 0),
            },
            "bySession": [{
                "sessionId": row["session_id"], "sessionTitle": row["session_title"] or "Untitled session",
                "sessionStatus": row["session_status"] or "", "broadcasts": int(row["broadcasts"] or 0),
                "durationSeconds": int(row["duration_seconds"] or 0),
                "destinationInstances": int(row["destination_instances"] or 0),
                "bytesIn": int(row["bytes_in"] or 0), "bytesOut": int(row["bytes_out"] or 0),
                "encoderSeconds": int(row["encoder_seconds"] or 0), "estimatedBroadcastCost": float(row["broadcast_cost"] or 0),
            } for row in session_rows],
            "recentBroadcasts": [{
                "id": row["id"], "sessionId": row["session_id"], "sessionTitle": row["session_title"] or "Untitled session",
                "sessionStatus": row["session_status"] or "", "startedAt": row["started_at"], "endedAt": row["ended_at"],
                "durationSeconds": int(row["duration_seconds"] or 0), "destinationCount": int(row["destination_count"] or 0),
                "destinations": json.loads(row["destinations_json"] or "[]"), "bytesIn": int(row["bytes_in"] or 0),
                "bytesOut": int(row["bytes_out"] or 0), "encoderSeconds": int(row["encoder_seconds"] or 0),
                "estimatedNetworkCost": float(row["estimated_network_cost"] or 0),
                "estimatedComputeCost": float(row["estimated_compute_cost"] or 0),
                "estimatedTotalCost": float(row["estimated_total_cost"] or 0),
            } for row in rows],
        }
        print(json.dumps(report))
        return

    # ---- Post-event content hooks ----

    if action == "post_event_artifact_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO post_event_artifacts (
              id, session_id, organization_id, artifact_type, source_moment_ref, speaker_id, sponsor_id,
              campaign, storage_reference, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
            """,
            (
                payload["id"],
                payload["sessionId"],
                payload.get("organizationId"),
                payload["artifactType"],
                payload.get("sourceMomentRef") or "",
                payload.get("speakerId"),
                payload.get("sponsorId"),
                payload.get("campaign") or "",
                payload.get("storageReference") or "",
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM post_event_artifacts WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"artifact": public_post_event_artifact(row)}))
        return

    if action == "post_event_artifact_update":
        row = conn.execute("SELECT * FROM post_event_artifacts WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"artifact": None}))
            return
        status = payload.get("status") or row["status"]
        storage_reference = payload.get("storageReference")
        if storage_reference is None:
            storage_reference = row["storage_reference"]
        conn.execute(
            "UPDATE post_event_artifacts SET status = ?, storage_reference = ?, updated_at = ? WHERE id = ?",
            (status, storage_reference, utc_now(), payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM post_event_artifacts WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"artifact": public_post_event_artifact(row)}))
        return

    if action == "post_event_artifact_get":
        row = conn.execute("SELECT * FROM post_event_artifacts WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"artifact": public_post_event_artifact(row)}))
        return

    if action == "post_event_artifact_list":
        rows = conn.execute(
            "SELECT * FROM post_event_artifacts WHERE session_id = ? ORDER BY created_at DESC",
            (payload["sessionId"],),
        ).fetchall()
        print(json.dumps({"artifacts": [public_post_event_artifact(row) for row in rows]}))
        return

    # ---- Peeps Jams ----

    if action == "dub_find_or_create":
        email = (payload.get("email") or "").strip().lower()
        row = conn.execute("SELECT * FROM dubs WHERE email = ?", (email,)).fetchone()
        if row:
            print(json.dumps({"dub": public_dub(row)}))
            return
        now = utc_now()
        conn.execute(
            "INSERT INTO dubs (id, user_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (payload["id"], payload.get("userId"), email, payload.get("displayName") or "", now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM dubs WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"dub": public_dub(row)}))
        return

    if action == "dub_set_display_name":
        now = utc_now()
        conn.execute(
            "UPDATE dubs SET display_name = ?, updated_at = ? WHERE id = ?",
            (payload.get("displayName") or "", now, payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM dubs WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"dub": public_dub(row)}))
        return

    if action == "jam_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO jams (
              id, organization_id, created_by_user_id, title, objective, participant_criteria_json,
              target_participant_count, compensation_json, consent_requirements_json, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
            """,
            (
                payload["id"],
                payload["organizationId"],
                payload["createdByUserId"],
                payload.get("title") or "",
                payload.get("objective") or "",
                json.dumps(payload.get("participantCriteria") or {}),
                int(payload.get("targetParticipantCount") or 0),
                json.dumps(payload.get("compensation") or {}),
                json.dumps(payload.get("consentRequirements") or []),
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM jams WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"jam": public_jam(row)}))
        return

    if action == "jam_list":
        rows = conn.execute(
            "SELECT * FROM jams WHERE organization_id = ? ORDER BY created_at DESC",
            (payload["organizationId"],),
        ).fetchall()
        jams = []
        for row in rows:
            entry = public_jam(row)
            counts = conn.execute(
                """
                SELECT
                  COUNT(*) AS total,
                  SUM(CASE WHEN status IN ('confirmed','attended','completed') THEN 1 ELSE 0 END) AS confirmed
                FROM jam_participants WHERE jam_id = ?
                """,
                (row["id"],),
            ).fetchone()
            entry["participantCount"] = counts["total"] or 0
            entry["confirmedCount"] = counts["confirmed"] or 0
            jams.append(entry)
        print(json.dumps({"jams": jams}))
        return

    if action == "jam_get":
        row = conn.execute(
            "SELECT * FROM jams WHERE id = ? AND organization_id = ?",
            (payload["id"], payload["organizationId"]),
        ).fetchone()
        if not row:
            print(json.dumps({"jam": None}))
            return
        entry = public_jam(row)
        counts = conn.execute(
            """
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN status IN ('confirmed','attended','completed') THEN 1 ELSE 0 END) AS confirmed
            FROM jam_participants WHERE jam_id = ?
            """,
            (row["id"],),
        ).fetchone()
        entry["participantCount"] = counts["total"] or 0
        entry["confirmedCount"] = counts["confirmed"] or 0
        print(json.dumps({"jam": entry}))
        return

    if action == "jam_get_by_id":
        # Internal-only lookup with no organization check — used to resolve a jam's own organizationId
        # server-side (e.g. from a Studio session's jam_id) before any membership check runs, same
        # precedent as session_get_organization above. Never exposed directly to a client response.
        row = conn.execute("SELECT * FROM jams WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"jam": public_jam(row)}))
        return

    if action == "jam_update":
        row = conn.execute(
            "SELECT * FROM jams WHERE id = ? AND organization_id = ?",
            (payload["id"], payload["organizationId"]),
        ).fetchone()
        if not row:
            print(json.dumps({"jam": None}))
            return
        fields = payload.get("fields") or {}
        column_map = {
            "title": "title",
            "objective": "objective",
            "targetParticipantCount": "target_participant_count",
            "scheduledAt": "scheduled_at",
            "timezone": "timezone",
        }
        sets = []
        values = []
        for key, column in column_map.items():
            if key in fields:
                sets.append(f"{column} = ?")
                values.append(fields[key])
        if "cancellationPolicy" in fields:
            sets.append("cancellation_policy_json = ?")
            values.append(json.dumps(fields["cancellationPolicy"] or {}))
        if "participantCriteria" in fields:
            sets.append("participant_criteria_json = ?")
            values.append(json.dumps(fields["participantCriteria"] or {}))
        if "compensation" in fields:
            sets.append("compensation_json = ?")
            values.append(json.dumps(fields["compensation"] or {}))
        if "consentRequirements" in fields:
            sets.append("consent_requirements_json = ?")
            values.append(json.dumps(fields["consentRequirements"] or []))
        if "status" in fields:
            sets.append("status = ?")
            values.append(fields["status"])
        now = utc_now()
        sets.append("updated_at = ?")
        values.append(now)
        values.append(payload["id"])
        if sets:
            conn.execute(f"UPDATE jams SET {', '.join(sets)} WHERE id = ?", values)
            conn.commit()
        row = conn.execute("SELECT * FROM jams WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"jam": public_jam(row)}))
        return

    if action == "jam_run_session":
        jam_row = conn.execute("SELECT * FROM jams WHERE id = ?", (payload["jamId"],)).fetchone()
        if not jam_row:
            print(json.dumps({"error": "not_found"}))
            return
        if jam_row["studio_session_id"]:
            session_row = conn.execute(
                "SELECT * FROM live_sessions WHERE id = ?", (jam_row["studio_session_id"],)
            ).fetchone()
            print(json.dumps({"created": False, "session": public_session(session_row), "jam": public_jam(jam_row)}))
            return
        now = utc_now()
        setup_json = json.dumps(payload.get("setup") or {})
        won = False
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                INSERT INTO live_sessions (
                  id, room_id, owner_user_id, organization_id, brand_id, title, status, created_at,
                  last_active_at, setup_json, jam_id
                ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
                """,
                (
                    payload["sessionId"],
                    payload["roomId"],
                    payload["ownerUserId"],
                    jam_row["organization_id"],
                    payload.get("brandId") or "",
                    jam_row["title"] or "",
                    now,
                    now,
                    setup_json,
                    jam_row["id"],
                ),
            )
            cursor = conn.execute(
                """
                UPDATE jams SET studio_session_id = ?, room_secret = ?, status = 'running', updated_at = ?
                WHERE id = ? AND studio_session_id IS NULL
                """,
                (payload["sessionId"], payload["roomSecret"], now, jam_row["id"]),
            )
            if cursor.rowcount == 1:
                conn.commit()
                won = True
            else:
                # A concurrent request already claimed this jam between our read above and this UPDATE —
                # undo the live_sessions insert we just made so no orphan row is left behind, then fall
                # through to report the winner's session.
                conn.rollback()
        except sqlite3.OperationalError:
            conn.rollback()
        if won:
            session_row = conn.execute("SELECT * FROM live_sessions WHERE id = ?", (payload["sessionId"],)).fetchone()
            jam_row = conn.execute("SELECT * FROM jams WHERE id = ?", (jam_row["id"],)).fetchone()
            print(json.dumps({"created": True, "session": public_session(session_row), "jam": public_jam(jam_row)}))
            return
        jam_row = conn.execute("SELECT * FROM jams WHERE id = ?", (payload["jamId"],)).fetchone()
        session_row = (
            conn.execute("SELECT * FROM live_sessions WHERE id = ?", (jam_row["studio_session_id"],)).fetchone()
            if jam_row and jam_row["studio_session_id"]
            else None
        )
        print(json.dumps({"created": False, "session": public_session(session_row), "jam": public_jam(jam_row)}))
        return

    if action == "jam_participant_create":
        participant_with_dub_sql = """
            SELECT jp.*, d.email AS email, d.display_name AS display_name
            FROM jam_participants jp JOIN dubs d ON d.id = jp.dub_id
            WHERE jp.id = ?
        """
        existing = conn.execute(
            "SELECT id FROM jam_participants WHERE jam_id = ? AND dub_id = ?",
            (payload["jamId"], payload["dubId"]),
        ).fetchone()
        if existing:
            row = conn.execute(participant_with_dub_sql, (existing["id"],)).fetchone()
            print(json.dumps({"participant": public_jam_participant(row)}))
            return
        now = utc_now()
        conn.execute(
            """
            INSERT INTO jam_participants (id, jam_id, dub_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'candidate', ?, ?)
            """,
            (payload["id"], payload["jamId"], payload["dubId"], now, now),
        )
        conn.commit()
        row = conn.execute(participant_with_dub_sql, (payload["id"],)).fetchone()
        print(json.dumps({"participant": public_jam_participant(row)}))
        return

    if action == "jam_participant_list":
        rows = conn.execute(
            """
            SELECT jp.*, d.email AS email, d.display_name AS display_name
            FROM jam_participants jp JOIN dubs d ON d.id = jp.dub_id
            WHERE jp.jam_id = ? ORDER BY jp.created_at ASC
            """,
            (payload["jamId"],),
        ).fetchall()
        print(json.dumps({"participants": [public_jam_participant(row) for row in rows]}))
        return

    if action == "jam_participant_get":
        row = conn.execute(
            """
            SELECT jp.*, d.email AS email, d.display_name AS display_name
            FROM jam_participants jp JOIN dubs d ON d.id = jp.dub_id
            WHERE jp.id = ?
            """,
            (payload["id"],),
        ).fetchone()
        print(json.dumps({"participant": public_jam_participant(row)}))
        return

    if action == "jam_participant_update":
        row = conn.execute("SELECT * FROM jam_participants WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"participant": None}))
            return
        fields = payload.get("fields") or {}
        column_map = {
            "status": "status",
            "consentCapturedAt": "consent_captured_at",
            "consentVersion": "consent_version",
            "compensationStatus": "compensation_status",
            "compensationAmount": "compensation_amount",
            "attendedAt": "attended_at",
            "completedAt": "completed_at",
            "removedAt": "removed_at",
            "removedReason": "removed_reason",
        }
        sets = []
        values = []
        for key, column in column_map.items():
            if key in fields:
                sets.append(f"{column} = ?")
                values.append(fields[key])
        now = utc_now()
        sets.append("updated_at = ?")
        values.append(now)
        values.append(payload["id"])
        if sets:
            conn.execute(f"UPDATE jam_participants SET {', '.join(sets)} WHERE id = ?", values)
            conn.commit()
        row = conn.execute(
            """
            SELECT jp.*, d.email AS email, d.display_name AS display_name
            FROM jam_participants jp JOIN dubs d ON d.id = jp.dub_id
            WHERE jp.id = ?
            """,
            (payload["id"],),
        ).fetchone()
        print(json.dumps({"participant": public_jam_participant(row)}))
        return

    if action == "jam_participant_invite_issue":
        now = utc_now()
        conn.execute(
            "INSERT INTO jam_participant_invites (id, jam_participant_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], payload["jamParticipantId"], payload["tokenHash"], payload["expiresAt"], now),
        )
        conn.execute(
            "UPDATE jam_participants SET status = 'invited', updated_at = ? WHERE id = ? AND status = 'candidate'",
            (now, payload["jamParticipantId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True, "id": payload["id"]}))
        return

    if action == "jam_participant_invite_get":
        row = conn.execute(
            "SELECT * FROM jam_participant_invites WHERE token_hash = ?",
            (payload["tokenHash"],),
        ).fetchone()
        if not row:
            print(json.dumps({"invite": None}))
            return
        participant = conn.execute(
            """
            SELECT jp.*, d.email AS email, d.display_name AS display_name
            FROM jam_participants jp JOIN dubs d ON d.id = jp.dub_id
            WHERE jp.id = ?
            """,
            (row["jam_participant_id"],),
        ).fetchone()
        invite = {
            "id": row["id"],
            "jamParticipantId": row["jam_participant_id"],
            "expiresAt": row["expires_at"],
            "revokedAt": row["revoked_at"],
        }
        print(json.dumps({"invite": invite, "participant": public_jam_participant(participant)}))
        return

    if action == "jam_participant_invite_revoke":
        now = utc_now()
        conn.execute(
            "UPDATE jam_participant_invites SET revoked_at = ? WHERE jam_participant_id = ? AND revoked_at IS NULL",
            (now, payload["jamParticipantId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "jam_event_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO jam_events (id, jam_id, jam_participant_id, type, detail_json, actor, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["jamId"],
                payload.get("jamParticipantId"),
                payload["type"],
                json.dumps(payload.get("detail") or {}),
                payload.get("actor") or "",
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM jam_events WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"event": public_jam_event(row)}))
        return

    if action == "jam_event_list":
        rows = conn.execute(
            "SELECT * FROM jam_events WHERE jam_id = ? ORDER BY created_at ASC",
            (payload["jamId"],),
        ).fetchall()
        print(json.dumps({"events": [public_jam_event(row) for row in rows]}))
        return

    if action == "jam_artifact_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO jam_artifacts (
              id, jam_id, studio_session_id, artifact_type, storage_reference, status, metadata_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"],
                payload["jamId"],
                payload.get("studioSessionId"),
                payload["artifactType"],
                payload.get("storageReference") or "",
                payload.get("status") or "pending",
                json.dumps(payload.get("metadata") or {}),
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM jam_artifacts WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"artifact": public_jam_artifact(row)}))
        return

    if action == "jam_artifact_list":
        rows = conn.execute(
            "SELECT * FROM jam_artifacts WHERE jam_id = ? ORDER BY created_at ASC",
            (payload["jamId"],),
        ).fetchall()
        print(json.dumps({"artifacts": [public_jam_artifact(row) for row in rows]}))
        return

    if action == "jam_artifact_get":
        row = conn.execute("SELECT * FROM jam_artifacts WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"artifact": public_jam_artifact(row)}))
        return

    if action == "jam_artifact_update":
        row = conn.execute("SELECT * FROM jam_artifacts WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"artifact": None}))
            return
        status = payload.get("status") or row["status"]
        storage_reference = payload.get("storageReference")
        if storage_reference is None:
            storage_reference = row["storage_reference"]
        conn.execute(
            "UPDATE jam_artifacts SET status = ?, storage_reference = ?, updated_at = ? WHERE id = ?",
            (status, storage_reference, utc_now(), payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM jam_artifacts WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"artifact": public_jam_artifact(row)}))
        return

    # ---- Peeps agent-to-human transaction lifecycle ----

    # ---- Dough ledger actions ----
    if action == "dough_get":
        subject_type = payload.get("subjectType") or "user"
        subject_id = payload["subjectId"]
        now = utc_now()
        conn.execute("INSERT OR IGNORE INTO dough_accounts (subject_type, subject_id, updated_at) VALUES (?, ?, ?)", (subject_type, subject_id, now))
        row = conn.execute("SELECT * FROM dough_accounts WHERE subject_type = ? AND subject_id = ?", (subject_type, subject_id)).fetchone()
        entries = conn.execute("SELECT * FROM dough_entries WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC LIMIT 50", (subject_type, subject_id)).fetchall()
        print(json.dumps({"account": {"subjectType": row["subject_type"], "subjectId": row["subject_id"], "spendBalance": row["spend_balance"], "earnedBalance": row["earned_balance"], "totalBalance": row["spend_balance"] + row["earned_balance"], "updatedAt": row["updated_at"]}, "entries": [{"id": e["id"], "bucket": e["bucket"], "direction": e["direction"], "amount": e["amount"], "kind": e["kind"], "referenceId": e["reference_id"], "status": e["status"], "metadata": _json_or(e["metadata_json"], {}), "createdAt": e["created_at"]} for e in entries]}))
        return

    if action == "dough_post":
        subject_type = payload.get("subjectType") or "user"
        subject_id = payload["subjectId"]
        bucket = payload["bucket"]
        direction = payload["direction"]
        raw_amount = payload.get("amount")
        # Never raise on a malformed amount -- an uncaught exception here exits the python process
        # non-zero, which the JS side can only surface as a generic 500. A clean {"error": ...} lets
        # callers turn this into an honest 400 instead. isfinite() also rejects NaN/Infinity, which
        # float() alone would happily accept from a permissive JSON payload.
        try:
            amount = round(float(raw_amount), 2)
        except (TypeError, ValueError):
            amount = float("nan")
        if not math.isfinite(amount) or amount <= 0 or bucket not in ("spend", "earned") or direction not in ("credit", "debit"):
            print(json.dumps({"posted": False, "error": "invalid_amount"}))
            return
        now = utc_now()
        conn.execute("INSERT OR IGNORE INTO dough_accounts (subject_type, subject_id, updated_at) VALUES (?, ?, ?)", (subject_type, subject_id, now))
        existing = None
        if payload.get("referenceId"):
            existing = conn.execute("SELECT id FROM dough_entries WHERE kind = ? AND reference_id = ? AND subject_type = ? AND subject_id = ?", (payload["kind"], payload["referenceId"], subject_type, subject_id)).fetchone()
        if existing:
            conn.commit()
            row = conn.execute("SELECT * FROM dough_accounts WHERE subject_type = ? AND subject_id = ?", (subject_type, subject_id)).fetchone()
            print(json.dumps({"posted": False, "idempotent": True, "account": {"spendBalance": row["spend_balance"], "earnedBalance": row["earned_balance"]}}))
            return
        column = "spend_balance" if bucket == "spend" else "earned_balance"
        row = conn.execute("SELECT * FROM dough_accounts WHERE subject_type = ? AND subject_id = ?", (subject_type, subject_id)).fetchone()
        current = float(row[column] or 0)
        if direction == "debit" and current + 1e-9 < amount:
            print(json.dumps({"posted": False, "insufficient": True, "available": current}))
            return
        delta = amount if direction == "credit" else -amount
        conn.execute(f"UPDATE dough_accounts SET {column} = {column} + ?, updated_at = ? WHERE subject_type = ? AND subject_id = ?", (delta, now, subject_type, subject_id))
        conn.execute("INSERT INTO dough_entries (id, subject_type, subject_id, bucket, direction, amount, kind, reference_id, status, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)", (payload["id"], subject_type, subject_id, bucket, direction, amount, payload["kind"], payload.get("referenceId"), json.dumps(payload.get("metadata") or {}), now))
        conn.commit()
        row = conn.execute("SELECT * FROM dough_accounts WHERE subject_type = ? AND subject_id = ?", (subject_type, subject_id)).fetchone()
        print(json.dumps({"posted": True, "account": {"spendBalance": row["spend_balance"], "earnedBalance": row["earned_balance"]}}))
        return

    if action == "dough_transfer_dub_to_user":
        dub_id, user_id, now = payload["dubId"], payload["userId"], utc_now()
        conn.execute("INSERT OR IGNORE INTO dough_accounts (subject_type, subject_id, updated_at) VALUES ('user', ?, ?)", (user_id, now))
        dub = conn.execute("SELECT * FROM dough_accounts WHERE subject_type = 'dub' AND subject_id = ?", (dub_id,)).fetchone()
        amount = float(dub["earned_balance"] or 0) if dub else 0
        if amount > 0:
            conn.execute("UPDATE dough_accounts SET earned_balance = 0, updated_at = ? WHERE subject_type = 'dub' AND subject_id = ?", (now, dub_id))
            conn.execute("UPDATE dough_accounts SET earned_balance = earned_balance + ?, updated_at = ? WHERE subject_type = 'user' AND subject_id = ?", (amount, now, user_id))
            ref = "claim:" + dub_id
            conn.execute("INSERT OR IGNORE INTO dough_entries (id, subject_type, subject_id, bucket, direction, amount, kind, reference_id, metadata_json, created_at) VALUES (?, 'user', ?, 'earned', 'credit', ?, 'dub_claim_transfer', ?, '{}', ?)", (payload["id"], user_id, amount, ref, now))
        conn.commit()
        print(json.dumps({"transferred": amount}))
        return

    if action == "dough_funding_intent_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO dough_funding_intents (
              id, user_id, amount, currency, method, provider, status, recipient_wallet, asset,
              crypto_amount, created_at, updated_at
            ) VALUES (?, ?, ?, 'USD', ?, ?, 'pending', ?, ?, ?, ?, ?)
            """,
            (
                payload["id"], payload["userId"], payload["amount"], payload["method"], payload.get("provider"),
                payload.get("recipientWallet"), payload.get("asset"), payload.get("cryptoAmount"), now, now,
            ),
        )
        conn.commit()
        print(json.dumps({"intent": public_dough_funding_intent(conn.execute("SELECT * FROM dough_funding_intents WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "dough_funding_intent_get":
        row = conn.execute("SELECT * FROM dough_funding_intents WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"intent": public_dough_funding_intent(row)}))
        return

    if action == "dough_funding_intent_set_provider_reference":
        conn.execute("UPDATE dough_funding_intents SET provider_reference = ?, updated_at = ? WHERE id = ?", (payload["providerReference"], utc_now(), payload["id"]))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    # Turns a funding intent into real, credited Dough — exactly once, no matter how many times a
    # provider (Stripe webhook retries; a client re-submitting a Solana confirm) calls this. The status
    # claim (WHERE status != 'paid', rowcount checked) and dough_post's own (kind, referenceId, subject)
    # uniqueness are two independent idempotency layers over the same operation.
    if action == "dough_funding_confirm":
        now = utc_now()
        row = conn.execute("SELECT * FROM dough_funding_intents WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"ok": False, "error": "not_found"}))
            return
        if row["status"] == "paid":
            print(json.dumps({"ok": True, "alreadyPaid": True, "amount": row["amount"]}))
            return
        if payload.get("transactionSignature") and conn.execute("SELECT 1 FROM peeps_economic_events WHERE transaction_signature = ?", (payload["transactionSignature"],)).fetchone():
            print(json.dumps({"ok": False, "error": "duplicate_reference"}))
            return
        try:
            cursor = conn.execute(
                "UPDATE dough_funding_intents SET status = 'paid', paid_at = ?, provider_reference = COALESCE(?, provider_reference), transaction_signature = ? WHERE id = ? AND status != 'paid'",
                (now, payload.get("providerReference"), payload.get("transactionSignature"), payload["id"]),
            )
        except sqlite3.IntegrityError:
            conn.rollback()
            print(json.dumps({"ok": False, "error": "duplicate_reference"}))
            return
        if cursor.rowcount != 1:
            conn.rollback()
            print(json.dumps({"ok": True, "alreadyPaid": True, "amount": row["amount"]}))
            return
        conn.execute("INSERT OR IGNORE INTO dough_accounts (subject_type, subject_id, updated_at) VALUES ('user', ?, ?)", (row["user_id"], now))
        conn.execute("UPDATE dough_accounts SET spend_balance = spend_balance + ?, updated_at = ? WHERE subject_type = 'user' AND subject_id = ?", (row["amount"], now, row["user_id"]))
        conn.execute(
            "INSERT OR IGNORE INTO dough_entries (id, subject_type, subject_id, bucket, direction, amount, kind, reference_id, metadata_json, created_at) VALUES (?, 'user', ?, 'spend', 'credit', ?, 'dough_funding', ?, ?, ?)",
            ("fund-" + payload["id"], row["user_id"], row["amount"], payload["id"], json.dumps({"method": row["method"], "provider": row["provider"]}), now),
        )
        conn.commit()
        print(json.dumps({"ok": True, "alreadyPaid": False, "amount": row["amount"]}))
        return

    if action == "dough_withdrawal_create":
        now = utc_now()
        conn.execute("INSERT INTO dough_withdrawals (id, user_id, amount, currency, method, destination, status, created_at, updated_at) VALUES (?, ?, ?, 'USD', ?, ?, 'requested', ?, ?)", (payload["id"], payload["userId"], payload["amount"], payload["method"], payload.get("destination"), now, now))
        conn.commit()
        print(json.dumps({"withdrawal": public_dough_withdrawal(conn.execute("SELECT * FROM dough_withdrawals WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "dough_withdrawal_get":
        row = conn.execute("SELECT * FROM dough_withdrawals WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"withdrawal": public_dough_withdrawal(row)}))
        return

    # Double-click/network-retry guard: an identical request from the same user, still in flight, within
    # the last few seconds is treated as the SAME withdrawal rather than reserving the money twice. Each
    # individual debit is still separately balance-checked, so this is about "did the user's one click
    # become two real requests," not about a balance ever going negative (dough_post already prevents
    # that on its own).
    if action == "dough_withdrawal_find_recent":
        row = conn.execute(
            "SELECT * FROM dough_withdrawals WHERE user_id = ? AND amount = ? AND method = ? AND destination = ? AND status IN ('requested','processing') AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
            (payload["userId"], payload["amount"], payload["method"], payload["destination"], payload["sinceIso"]),
        ).fetchone()
        print(json.dumps({"withdrawal": public_dough_withdrawal(row) if row else None}))
        return

    # Withdrawal state machine: requested -> processing -> paid, with failed/reversed reachable from
    # requested or processing (and reversed reachable even from paid, e.g. a later bank clawback). Only a
    # transition INTO failed/reversed ever refunds, and it refunds through dough_post with a reference
    # tied to the withdrawal id, so even calling this twice for the same terminal transition cannot
    # double-refund (the second call finds an invalid transition and does nothing).
    if action == "dough_withdrawal_update_status":
        now = utc_now()
        row = conn.execute("SELECT * FROM dough_withdrawals WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"ok": False, "error": "not_found"}))
            return
        new_status = payload["status"]
        valid_transitions = {
            "requested": {"processing", "failed", "reversed", "paid"},
            "processing": {"paid", "failed", "reversed"},
            "paid": {"reversed"},
        }
        if row["status"] not in valid_transitions or new_status not in valid_transitions[row["status"]]:
            print(json.dumps({"ok": False, "error": "invalid_transition", "from": row["status"], "to": new_status}))
            return
        cursor = conn.execute(
            "UPDATE dough_withdrawals SET status = ?, provider_reference = COALESCE(?, provider_reference), updated_at = ? WHERE id = ? AND status = ?",
            (new_status, payload.get("providerReference"), now, payload["id"], row["status"]),
        )
        if cursor.rowcount != 1:
            conn.rollback()
            print(json.dumps({"ok": False, "error": "conflict"}))
            return
        refunded = False
        if new_status in ("failed", "reversed"):
            ref_credit = conn.execute(
                "SELECT id FROM dough_entries WHERE kind = 'withdrawal_refund' AND reference_id = ? AND subject_type = 'user' AND subject_id = ?",
                ("refund:" + row["id"], row["user_id"]),
            ).fetchone()
            if not ref_credit:
                conn.execute("INSERT OR IGNORE INTO dough_accounts (subject_type, subject_id, updated_at) VALUES ('user', ?, ?)", (row["user_id"], now))
                conn.execute("UPDATE dough_accounts SET earned_balance = earned_balance + ?, updated_at = ? WHERE subject_type = 'user' AND subject_id = ?", (row["amount"], now, row["user_id"]))
                conn.execute(
                    "INSERT INTO dough_entries (id, subject_type, subject_id, bucket, direction, amount, kind, reference_id, metadata_json, created_at) VALUES (?, 'user', ?, 'earned', 'credit', ?, 'withdrawal_refund', ?, ?, ?)",
                    ("refund:" + row["id"], row["user_id"], row["amount"], "refund:" + row["id"], json.dumps({"withdrawalId": row["id"], "reason": new_status}), now),
                )
            refunded = True
        conn.commit()
        print(json.dumps({"ok": True, "status": new_status, "refunded": refunded}))
        return

    if action == "peeps_request_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO peeps_requests (
              id, organization_id, created_by_user_id, who_text, outcome_text,
              working_representation_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'researching', ?, ?)
            """,
            (
                payload["id"], payload["organizationId"], payload["createdByUserId"],
                payload.get("whoText") or "", payload.get("outcomeText") or "",
                json.dumps(payload.get("workingRepresentation") or {}), now, now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_requests WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"request": public_peeps_request(row)}))
        return

    if action == "peeps_request_get":
        row = conn.execute(
            "SELECT * FROM peeps_requests WHERE id = ? AND organization_id = ?",
            (payload["id"], payload["organizationId"]),
        ).fetchone()
        print(json.dumps({"request": public_peeps_request(row)}))
        return

    if action == "peeps_request_get_by_id":
        # Internal-only, no org check — mirrors jam_get_by_id's own precedent (never exposed directly to
        # a client response; used to resolve organizationId server-side before any membership check runs).
        row = conn.execute("SELECT * FROM peeps_requests WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"request": public_peeps_request(row)}))
        return

    if action == "peeps_request_list":
        rows = conn.execute(
            "SELECT * FROM peeps_requests WHERE organization_id = ? ORDER BY created_at DESC",
            (payload["organizationId"],),
        ).fetchall()
        print(json.dumps({"requests": [public_peeps_request(row) for row in rows]}))
        return

    if action == "peeps_request_update":
        fields = payload.get("fields") or {}
        sets = []
        values = []
        if "status" in fields:
            sets.append("status = ?")
            values.append(fields["status"])
        if "jamId" in fields:
            sets.append("jam_id = ?")
            values.append(fields["jamId"])
        if "workingRepresentation" in fields:
            sets.append("working_representation_json = ?")
            values.append(json.dumps(fields["workingRepresentation"] or {}))
        now = utc_now()
        sets.append("updated_at = ?")
        values.append(now)
        values.append(payload["id"])
        if sets:
            conn.execute(f"UPDATE peeps_requests SET {', '.join(sets)} WHERE id = ?", values)
            conn.commit()
        row = conn.execute("SELECT * FROM peeps_requests WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"request": public_peeps_request(row)}))
        return

    if action == "peeps_candidates_replace":
        # Only ever replaces candidates still in "proposed" state — an already authorized/rejected
        # candidate is a real human decision and must never be silently reset by a later resolver re-run
        # (e.g. from "keep searching for a replacement").
        now = utc_now()
        conn.execute("DELETE FROM peeps_candidates WHERE request_id = ? AND status = 'proposed'", (payload["requestId"],))
        for candidate in payload.get("candidates") or []:
            conn.execute(
                """
                INSERT INTO peeps_candidates (
                  id, request_id, dub_id, source, display_name, headline, evidence_json,
                  match_reason, match_score, reachability, contact_email, rank, status,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
                """,
                (
                    candidate["id"], payload["requestId"], candidate.get("dubId"),
                    candidate["source"], candidate.get("displayName") or "", candidate.get("headline") or "",
                    json.dumps(candidate.get("evidence") or []), candidate.get("matchReason") or "",
                    float(candidate.get("matchScore") or 0), candidate.get("reachability") or "unreachable",
                    candidate.get("contactEmail"), int(candidate.get("rank") or 0), now, now,
                ),
            )
        conn.commit()
        rows = conn.execute(
            "SELECT * FROM peeps_candidates WHERE request_id = ? ORDER BY rank ASC",
            (payload["requestId"],),
        ).fetchall()
        print(json.dumps({"candidates": [public_peeps_candidate(row) for row in rows]}))
        return

    if action == "peeps_candidate_list":
        rows = conn.execute(
            "SELECT * FROM peeps_candidates WHERE request_id = ? ORDER BY rank ASC",
            (payload["requestId"],),
        ).fetchall()
        print(json.dumps({"candidates": [public_peeps_candidate(row) for row in rows]}))
        return

    if action == "peeps_candidate_get":
        row = conn.execute("SELECT * FROM peeps_candidates WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"candidate": public_peeps_candidate(row)}))
        return

    if action == "peeps_candidate_update":
        now = utc_now()
        fields = payload.get("fields") or {}
        sets = []
        values = []
        if "status" in fields:
            sets.append("status = ?")
            values.append(fields["status"])
        if "dubId" in fields:
            sets.append("dub_id = ?")
            values.append(fields["dubId"])
        sets.append("updated_at = ?")
        values.append(now)
        values.append(payload["id"])
        conn.execute(f"UPDATE peeps_candidates SET {', '.join(sets)} WHERE id = ?", values)
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_candidates WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"candidate": public_peeps_candidate(row)}))
        return

    introduction_with_status_sql = """
        SELECT pi.*, jp.status AS participant_status
        FROM peeps_introductions pi LEFT JOIN jam_participants jp ON jp.id = pi.jam_participant_id
        WHERE pi.id = ?
    """

    if action == "peeps_introduction_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO peeps_introductions (
              id, request_id, candidate_id, dub_id, jam_id, jam_participant_id, status,
              authorized_at, authorized_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"], payload["requestId"], payload["candidateId"], payload["dubId"],
                payload.get("jamId"), payload.get("jamParticipantId"), payload.get("status") or "authorized",
                now, payload["authorizedByUserId"], now, now,
            ),
        )
        conn.commit()
        row = conn.execute(introduction_with_status_sql, (payload["id"],)).fetchone()
        print(json.dumps({"introduction": public_peeps_introduction(row)}))
        return

    if action == "peeps_introduction_list":
        rows = conn.execute(
            """
            SELECT pi.*, jp.status AS participant_status
            FROM peeps_introductions pi LEFT JOIN jam_participants jp ON jp.id = pi.jam_participant_id
            WHERE pi.request_id = ? ORDER BY pi.created_at ASC
            """,
            (payload["requestId"],),
        ).fetchall()
        print(json.dumps({"introductions": [public_peeps_introduction(row) for row in rows]}))
        return

    if action == "peeps_introduction_mark_outreach_sent":
        now = utc_now()
        conn.execute(
            "UPDATE peeps_introductions SET outreach_sent_at = ?, status = 'outreach_sent', updated_at = ? WHERE id = ?",
            (now, now, payload["id"]),
        )
        conn.commit()
        row = conn.execute(introduction_with_status_sql, (payload["id"],)).fetchone()
        print(json.dumps({"introduction": public_peeps_introduction(row)}))
        return

    if action == "peeps_introduction_decline":
        now = utc_now()
        conn.execute(
            "UPDATE peeps_introductions SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ?",
            (payload.get("reason") or "", now, payload["id"]),
        )
        conn.commit()
        row = conn.execute(introduction_with_status_sql, (payload["id"],)).fetchone()
        print(json.dumps({"introduction": public_peeps_introduction(row)}))
        return

    if action == "peeps_request_get_by_jam":
        row = conn.execute("SELECT * FROM peeps_requests WHERE jam_id = ?", (payload["jamId"],)).fetchone()
        print(json.dumps({"request": public_peeps_request(row)}))
        return

    if action == "peeps_introduction_list_by_jam":
        rows = conn.execute(
            """
            SELECT pi.*, jp.status AS participant_status, pc.evidence_json, pc.match_reason, pc.headline, pc.source
            FROM peeps_introductions pi
            LEFT JOIN jam_participants jp ON jp.id = pi.jam_participant_id
            LEFT JOIN peeps_candidates pc ON pc.id = pi.candidate_id
            WHERE pi.jam_id = ? ORDER BY pi.created_at ASC
            """,
            (payload["jamId"],),
        ).fetchall()
        result = []
        for row in rows:
            entry = public_peeps_introduction(row)
            entry["evidence"] = _json_or(row["evidence_json"], [])
            entry["matchReason"] = row["match_reason"]
            entry["headline"] = row["headline"]
            entry["candidateSource"] = row["source"]
            result.append(entry)
        print(json.dumps({"introductions": result}))
        return

    # ---- Peeps introduction execution ----

    if action == "peeps_intro_get":
        # Internal, server-only read joining everything the execution flow needs. The Node layer decides
        # what each audience may see — raw contact data (contactEmail, dub email) never leaves the server.
        row = conn.execute(
            """
            SELECT pi.*, jp.status AS participant_status
            FROM peeps_introductions pi LEFT JOIN jam_participants jp ON jp.id = pi.jam_participant_id
            WHERE pi.id = ?
            """,
            (payload["id"],),
        ).fetchone()
        if not row:
            print(json.dumps({"introduction": None}))
            return
        request_row = conn.execute("SELECT * FROM peeps_requests WHERE id = ?", (row["request_id"],)).fetchone()
        candidate_row = conn.execute("SELECT * FROM peeps_candidates WHERE id = ?", (row["candidate_id"],)).fetchone()
        dub_row = conn.execute("SELECT * FROM dubs WHERE id = ?", (row["dub_id"],)).fetchone()
        print(json.dumps({
            "introduction": public_peeps_introduction(row),
            "request": public_peeps_request(request_row),
            "candidate": public_peeps_candidate(candidate_row),
            "dub": public_dub(dub_row),
        }))
        return

    if action == "peeps_intro_update":
        expect = payload.get("expectStatuses")
        where, params = "", []
        if expect:
            where = f"AND status IN ({','.join('?' for _ in expect)})"
            params = list(expect)
        count = _apply_update(conn, "peeps_introductions", payload["id"], payload.get("fields") or {}, PEEPS_INTRO_COLUMNS, PEEPS_INTRO_JSON, where, params)
        row = conn.execute(introduction_with_status_sql, (payload["id"],)).fetchone()
        print(json.dumps({"updated": count == 1, "introduction": public_peeps_introduction(row)}))
        return

    if action == "peeps_intro_find_by_jam_participant":
        rows = conn.execute(
            """
            SELECT pi.*, jp.status AS participant_status
            FROM peeps_introductions pi LEFT JOIN jam_participants jp ON jp.id = pi.jam_participant_id
            WHERE pi.jam_participant_id = ? ORDER BY pi.created_at ASC
            """,
            (payload["jamParticipantId"],),
        ).fetchall()
        print(json.dumps({"introductions": [public_peeps_introduction(row) for row in rows]}))
        return

    if action == "peeps_request_set_availability":
        conn.execute(
            "UPDATE peeps_requests SET requester_availability_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(payload.get("availability") or {}), utc_now(), payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_requests WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"request": public_peeps_request(row)}))
        return

    if action == "peeps_candidate_set_contact_paths":
        conn.execute(
            "UPDATE peeps_candidates SET contact_paths_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(payload.get("contactPaths") or []), utc_now(), payload["id"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "peeps_channel_upsert":
        now = utc_now()
        conn.execute(
            """
            INSERT OR IGNORE INTO peeps_contact_channels (
              id, introduction_id, channel, adapter, destination_enc, destination_masked, destination_hash,
              public_reference, source, verification, confidence, priority, automatable, status,
              last_checked_at, authorization_context_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"], payload["introductionId"], payload["channel"], payload.get("adapter") or "",
                payload.get("destinationEnc") or "", payload.get("destinationMasked") or "",
                payload.get("destinationHash") or "", payload.get("publicReference") or "",
                payload.get("source") or "", payload.get("verification") or "unverified",
                payload.get("confidence") or "", int(payload.get("priority") or 99),
                1 if payload.get("automatable") else 0, payload.get("status") or "candidate", now,
                json.dumps(payload.get("authorizationContext") or {}), now, now,
            ),
        )
        conn.execute(
            "UPDATE peeps_contact_channels SET last_checked_at = ? WHERE introduction_id = ? AND channel = ? AND destination_hash = ?",
            (now, payload["introductionId"], payload["channel"], payload.get("destinationHash") or ""),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "peeps_channel_list":
        rows = conn.execute(
            "SELECT * FROM peeps_contact_channels WHERE introduction_id = ? ORDER BY priority ASC, created_at ASC",
            (payload["introductionId"],),
        ).fetchall()
        print(json.dumps({"channels": [public_peeps_channel(row) for row in rows]}))
        return

    if action == "peeps_channel_update":
        _apply_update(conn, "peeps_contact_channels", payload["id"], payload.get("fields") or {}, {
            "status": "status", "lastCheckedAt": "last_checked_at", "verification": "verification", "confidence": "confidence",
        })
        row = conn.execute("SELECT * FROM peeps_contact_channels WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"channel": public_peeps_channel(row)}))
        return

    if action == "peeps_message_create":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO peeps_outbound_messages (
              id, introduction_id, booking_id, channel_id, purpose, audience, adapter, provider_kind, status,
              thread_ref, attempt, template_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"], payload["introductionId"], payload.get("bookingId"), payload.get("channelId"),
                payload["purpose"], payload.get("audience") or "candidate", payload.get("adapter") or "",
                payload.get("providerKind") or "real", payload.get("status") or "queued",
                payload.get("threadRef") or "", int(payload.get("attempt") or 1),
                json.dumps(payload.get("template") or {}), now, now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_outbound_messages WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"message": public_peeps_message(row)}))
        return

    if action == "peeps_message_update":
        fields = payload.get("fields") or {}
        _apply_update(conn, "peeps_outbound_messages", payload["id"], fields, {
            "status": "status", "threadRef": "thread_ref", "providerMessageId": "provider_message_id",
            "error": "error", "attempt": "attempt", "testPayload": "test_payload_json", "adapter": "adapter",
            "providerKind": "provider_kind", "channelId": "channel_id",
        }, ("test_payload_json",))
        row = conn.execute("SELECT * FROM peeps_outbound_messages WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"message": public_peeps_message(row, bool(payload.get("includeTestPayload")))}))
        return

    if action == "peeps_message_get":
        row = conn.execute("SELECT * FROM peeps_outbound_messages WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"message": public_peeps_message(row, bool(payload.get("includeTestPayload")))}))
        return

    if action == "peeps_message_list":
        if payload.get("requestId"):
            rows = conn.execute(
                """
                SELECT m.* FROM peeps_outbound_messages m JOIN peeps_introductions pi ON pi.id = m.introduction_id
                WHERE pi.request_id = ? ORDER BY m.created_at ASC
                """,
                (payload["requestId"],),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM peeps_outbound_messages WHERE introduction_id = ? ORDER BY created_at ASC",
                (payload["introductionId"],),
            ).fetchall()
        include = bool(payload.get("includeTestPayload"))
        print(json.dumps({"messages": [public_peeps_message(row, include) for row in rows]}))
        return

    if action == "peeps_token_issue":
        now = utc_now()
        if payload.get("revokeExisting"):
            conn.execute(
                "UPDATE peeps_response_tokens SET revoked_at = ? WHERE introduction_id = ? AND revoked_at IS NULL",
                (now, payload["introductionId"]),
            )
        conn.execute(
            "INSERT INTO peeps_response_tokens (id, introduction_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], payload["introductionId"], payload["tokenHash"], payload["expiresAt"], now),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "peeps_token_get":
        row = conn.execute("SELECT * FROM peeps_response_tokens WHERE token_hash = ?", (payload["tokenHash"],)).fetchone()
        if not row:
            print(json.dumps({"token": None}))
            return
        if payload.get("touch"):
            now = utc_now()
            conn.execute(
                "UPDATE peeps_response_tokens SET use_count = use_count + 1, last_used_at = ?, first_used_at = COALESCE(first_used_at, ?) WHERE id = ?",
                (now, now, row["id"]),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM peeps_response_tokens WHERE id = ?", (row["id"],)).fetchone()
        print(json.dumps({"token": {
            "id": row["id"], "introductionId": row["introduction_id"], "expiresAt": row["expires_at"],
            "revokedAt": row["revoked_at"], "firstUsedAt": row["first_used_at"], "lastUsedAt": row["last_used_at"],
            "useCount": row["use_count"],
        }}))
        return

    if action == "peeps_token_revoke":
        conn.execute(
            "UPDATE peeps_response_tokens SET revoked_at = ? WHERE introduction_id = ? AND revoked_at IS NULL",
            (utc_now(), payload["introductionId"]),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    booking_columns = {
        "jamId": "jam_id", "jamParticipantId": "jam_participant_id", "studioSessionId": "studio_session_id",
        "startsAt": "starts_at", "endsAt": "ends_at", "requesterTimezone": "requester_timezone",
        "candidateTimezone": "candidate_timezone", "durationMinutes": "duration_minutes", "format": "format",
        "compensation": "compensation_json", "recordingState": "recording_state",
        "cancellationPolicy": "cancellation_policy_json", "status": "status", "calendar": "calendar_json",
        "planVersion": "plan_version", "notifiedHash": "notified_hash", "setup": "setup_json",
        "readyAt": "ready_at", "cancelledAt": "cancelled_at", "cancelledBy": "cancelled_by",
        "cancelReason": "cancel_reason", "lateCancellation": "late_cancellation", "sequence": "sequence",
    }
    booking_json = ("compensation_json", "cancellation_policy_json", "calendar_json", "setup_json")

    if action == "peeps_booking_create":
        # INSERT OR IGNORE on UNIQUE(introduction_id): the idempotency guarantee. Reports whether this call
        # actually created the row so callers only fire one-time side effects on the winner.
        now = utc_now()
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO peeps_bookings (
              id, request_id, introduction_id, organization_id, requester_user_id, candidate_dub_id, jam_id,
              jam_participant_id, starts_at, ends_at, requester_timezone, candidate_timezone, duration_minutes,
              format, compensation_json, recording_state, cancellation_policy_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)
            """,
            (
                payload["id"], payload["requestId"], payload["introductionId"], payload["organizationId"],
                payload["requesterUserId"], payload["candidateDubId"], payload.get("jamId"),
                payload.get("jamParticipantId"), payload["startsAt"], payload["endsAt"],
                payload.get("requesterTimezone") or "", payload.get("candidateTimezone") or "",
                int(payload.get("durationMinutes") or 45), payload.get("format") or "conversation",
                json.dumps(payload.get("compensation") or {}), payload.get("recordingState") or "unknown",
                json.dumps(payload.get("cancellationPolicy") or {}), now, now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_bookings WHERE introduction_id = ?", (payload["introductionId"],)).fetchone()
        print(json.dumps({"created": cursor.rowcount == 1, "booking": public_peeps_booking(row)}))
        return

    if action == "peeps_booking_get":
        if payload.get("id"):
            row = conn.execute("SELECT * FROM peeps_bookings WHERE id = ?", (payload["id"],)).fetchone()
        elif payload.get("introductionId"):
            row = conn.execute("SELECT * FROM peeps_bookings WHERE introduction_id = ?", (payload["introductionId"],)).fetchone()
        else:
            row = conn.execute("SELECT * FROM peeps_bookings WHERE studio_session_id = ? ORDER BY created_at ASC LIMIT 1", (payload["studioSessionId"],)).fetchone()
        print(json.dumps({"booking": public_peeps_booking(row)}))
        return

    if action == "peeps_booking_list":
        if payload.get("jamId"):
            rows = conn.execute("SELECT * FROM peeps_bookings WHERE jam_id = ? ORDER BY created_at ASC", (payload["jamId"],)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM peeps_bookings WHERE request_id = ? ORDER BY created_at ASC", (payload["requestId"],)).fetchall()
        print(json.dumps({"bookings": [public_peeps_booking(row) for row in rows]}))
        return

    if action == "peeps_booking_update":
        expect = payload.get("expectStatuses")
        where, params = "", []
        if expect:
            where = f"AND status IN ({','.join('?' for _ in expect)})"
            params = list(expect)
        count = _apply_update(conn, "peeps_bookings", payload["id"], payload.get("fields") or {}, booking_columns, booking_json, where, params)
        row = conn.execute("SELECT * FROM peeps_bookings WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"updated": count == 1, "booking": public_peeps_booking(row)}))
        return

    if action == "peeps_booking_bump_version":
        # Atomic increment so two concurrent organizer edits can never produce the same version number.
        conn.execute(
            "UPDATE peeps_bookings SET plan_version = plan_version + 1, updated_at = ? WHERE id = ?",
            (utc_now(), payload["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_bookings WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"booking": public_peeps_booking(row)}))
        return

    if action == "peeps_plan_version_add":
        try:
            conn.execute(
                """
                INSERT INTO peeps_plan_versions (id, booking_id, version, snapshot_json, change_json, participant_facing, edited_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["id"], payload["bookingId"], int(payload["version"]),
                    json.dumps(payload.get("snapshot") or {}), json.dumps(payload.get("change") or {}),
                    1 if payload.get("participantFacing") else 0, payload.get("editedBy") or "", utc_now(),
                ),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            pass
        print(json.dumps({"ok": True}))
        return

    if action == "peeps_plan_version_list":
        rows = conn.execute(
            "SELECT * FROM peeps_plan_versions WHERE booking_id = ? ORDER BY version DESC LIMIT ?",
            (payload["bookingId"], int(payload.get("limit") or 30)),
        ).fetchall()
        print(json.dumps({"versions": [{
            "id": r["id"], "bookingId": r["booking_id"], "version": r["version"],
            "snapshot": _json_or(r["snapshot_json"], {}), "change": _json_or(r["change_json"], {}),
            "participantFacing": bool(r["participant_facing"]), "editedBy": r["edited_by"], "createdAt": r["created_at"],
        } for r in rows]}))
        return

    if action == "peeps_opening_create":
        now = utc_now()
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO peeps_openings (
              id, request_id, jam_id, booking_id, replaces_introduction_id, context_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
            """,
            (
                payload["id"], payload["requestId"], payload.get("jamId"), payload.get("bookingId"),
                payload["replacesIntroductionId"], json.dumps(payload.get("context") or {}), now, now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_openings WHERE replaces_introduction_id = ?", (payload["replacesIntroductionId"],)).fetchone()
        print(json.dumps({"created": cursor.rowcount == 1, "opening": public_peeps_opening(row)}))
        return

    if action == "peeps_opening_get":
        row = conn.execute("SELECT * FROM peeps_openings WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"opening": public_peeps_opening(row)}))
        return

    if action == "peeps_opening_update":
        expect = payload.get("expectStatuses")
        where, params = "", []
        if expect:
            where = f"AND status IN ({','.join('?' for _ in expect)})"
            params = list(expect)
        count = _apply_update(conn, "peeps_openings", payload["id"], payload.get("fields") or {}, {
            "status": "status", "chosenCandidateId": "chosen_candidate_id",
            "replacementIntroductionId": "replacement_introduction_id", "context": "context_json",
        }, ("context_json",), where, params)
        row = conn.execute("SELECT * FROM peeps_openings WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"updated": count == 1, "opening": public_peeps_opening(row)}))
        return

    if action == "dub_preferences_get":
        row = conn.execute("SELECT * FROM dub_preferences WHERE dub_id = ?", (payload["dubId"],)).fetchone()
        print(json.dumps({"preferences": _json_or(row["preferences_json"], {}) if row else {}}))
        return

    if action == "dub_preferences_set":
        conn.execute(
            """
            INSERT INTO dub_preferences (dub_id, preferences_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(dub_id) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at
            """,
            (payload["dubId"], json.dumps(payload.get("preferences") or {}), utc_now()),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    # ---- Peeps completion / Breadcrumbs / Dub / settlement ----

    if action == "peeps_completion_upsert":
        now = utc_now()
        existing = conn.execute("SELECT * FROM peeps_completions WHERE jam_id = ?", (payload["jamId"],)).fetchone()
        if existing:
            # started/ended/metadata refresh as more real data arrives; the row itself is never duplicated.
            conn.execute(
                "UPDATE peeps_completions SET studio_session_id = COALESCE(?, studio_session_id), started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at), metadata_json = ?, updated_at = ? WHERE jam_id = ?",
                (payload.get("studioSessionId"), payload.get("startedAt"), payload.get("endedAt"), json.dumps(payload.get("metadata") or {}), now, payload["jamId"]),
            )
            created = False
        else:
            conn.execute(
                "INSERT INTO peeps_completions (id, jam_id, request_id, organization_id, studio_session_id, trigger, started_at, ended_at, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (payload["id"], payload["jamId"], payload["requestId"], payload["organizationId"], payload.get("studioSessionId"), payload.get("trigger") or "", payload.get("startedAt"), payload.get("endedAt"), json.dumps(payload.get("metadata") or {}), now, now),
            )
            created = True
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_completions WHERE jam_id = ?", (payload["jamId"],)).fetchone()
        print(json.dumps({"created": created, "completion": public_peeps_completion(row)}))
        return

    if action == "peeps_completion_get":
        if payload.get("jamId"):
            row = conn.execute("SELECT * FROM peeps_completions WHERE jam_id = ?", (payload["jamId"],)).fetchone()
        else:
            row = conn.execute("SELECT * FROM peeps_completions WHERE request_id = ?", (payload["requestId"],)).fetchone()
        print(json.dumps({"completion": public_peeps_completion(row)}))
        return

    if action == "peeps_completion_set_outcome":
        conn.execute("UPDATE peeps_completions SET outcome_json = ?, updated_at = ? WHERE jam_id = ?", (json.dumps(payload.get("outcome") or {}), utc_now(), payload["jamId"]))
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_completions WHERE jam_id = ?", (payload["jamId"],)).fetchone()
        print(json.dumps({"completion": public_peeps_completion(row)}))
        return

    if action == "peeps_transcript_create":
        cursor = conn.execute(
            "INSERT OR IGNORE INTO peeps_transcripts (id, jam_id, studio_session_id, source, content_hash, segments_json, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (payload["id"], payload["jamId"], payload.get("studioSessionId"), payload["source"], payload["contentHash"], json.dumps(payload.get("segments") or []), payload.get("submittedBy") or "", utc_now()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_transcripts WHERE jam_id = ? AND content_hash = ?", (payload["jamId"], payload["contentHash"])).fetchone()
        print(json.dumps({"created": cursor.rowcount == 1, "transcript": {"id": row["id"], "jamId": row["jam_id"], "source": row["source"], "segments": _json_or(row["segments_json"], []), "createdAt": row["created_at"]}}))
        return

    if action == "peeps_transcript_list":
        rows = conn.execute("SELECT * FROM peeps_transcripts WHERE jam_id = ? ORDER BY created_at ASC", (payload["jamId"],)).fetchall()
        include = bool(payload.get("includeSegments"))
        print(json.dumps({"transcripts": [{"id": r["id"], "jamId": r["jam_id"], "source": r["source"], "segmentCount": len(_json_or(r["segments_json"], [])), "createdAt": r["created_at"], **({"segments": _json_or(r["segments_json"], [])} if include else {})} for r in rows]}))
        return

    if action == "peeps_breadcrumb_create":
        now = utc_now()
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO peeps_breadcrumbs (
              id, jam_id, request_id, dub_id, jam_participant_id, kind, statement, evidence_class, status,
              topics_json, provenance_json, fingerprint, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["id"], payload["jamId"], payload["requestId"], payload["dubId"], payload.get("jamParticipantId"),
                payload["kind"], payload["statement"], payload["evidenceClass"], payload.get("status") or "proposed",
                json.dumps(payload.get("topics") or []), json.dumps(payload.get("provenance") or {}), payload["fingerprint"], now, now,
            ),
        )
        conn.commit()
        print(json.dumps({"created": cursor.rowcount == 1}))
        return

    if action == "peeps_breadcrumb_get":
        row = conn.execute("SELECT * FROM peeps_breadcrumbs WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"breadcrumb": public_peeps_breadcrumb(row)}))
        return

    if action == "peeps_breadcrumb_list":
        if payload.get("jamId"):
            rows = conn.execute("SELECT * FROM peeps_breadcrumbs WHERE jam_id = ? ORDER BY created_at ASC", (payload["jamId"],)).fetchall()
        elif payload.get("dubIds"):
            ids = payload["dubIds"]
            rows = conn.execute(f"SELECT * FROM peeps_breadcrumbs WHERE dub_id IN ({','.join('?' for _ in ids)}) ORDER BY created_at ASC", ids).fetchall()
        else:
            rows = conn.execute("SELECT * FROM peeps_breadcrumbs WHERE dub_id = ? ORDER BY created_at ASC", (payload["dubId"],)).fetchall()
        print(json.dumps({"breadcrumbs": [public_peeps_breadcrumb(r) for r in rows]}))
        return

    if action == "peeps_breadcrumb_review":
        # Compare-and-set on the review status so a double-click can't apply twice.
        now = utc_now()
        fields = payload.get("fields") or {}
        row = conn.execute("SELECT * FROM peeps_breadcrumbs WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"updated": False, "breadcrumb": None}))
            return
        expect = payload.get("expectStatuses")
        if expect and row["status"] not in expect:
            print(json.dumps({"updated": False, "breadcrumb": public_peeps_breadcrumb(row)}))
            return
        conn.execute(
            """
            UPDATE peeps_breadcrumbs SET status = COALESCE(?, status), corrected_statement = COALESCE(?, corrected_statement),
              evidence_class = COALESCE(?, evidence_class), reviewed_by_user_id = COALESCE(?, reviewed_by_user_id),
              reviewed_at = COALESCE(?, reviewed_at), corroborated_by_user_id = COALESCE(?, corroborated_by_user_id),
              corroborated_at = COALESCE(?, corroborated_at), topics_json = COALESCE(?, topics_json), updated_at = ?
            WHERE id = ?
            """,
            (
                fields.get("status"), fields.get("correctedStatement"), fields.get("evidenceClass"), fields.get("reviewedByUserId"),
                now if fields.get("reviewed") else None, fields.get("corroboratedByUserId"), now if fields.get("corroborated") else None,
                json.dumps(fields["topics"]) if "topics" in fields else None, now, payload["id"],
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM peeps_breadcrumbs WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"updated": True, "breadcrumb": public_peeps_breadcrumb(row)}))
        return

    if action == "dub_entry_upsert":
        now = utc_now()
        conn.execute(
            """
            INSERT INTO dub_profile_entries (id, dub_id, breadcrumb_id, kind, statement, evidence_class, topics_json, visibility, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(breadcrumb_id) DO UPDATE SET statement = excluded.statement, evidence_class = excluded.evidence_class,
              topics_json = excluded.topics_json, visibility = excluded.visibility, updated_at = excluded.updated_at
            """,
            (payload["id"], payload["dubId"], payload["breadcrumbId"], payload["kind"], payload["statement"], payload["evidenceClass"], json.dumps(payload.get("topics") or []), payload.get("visibility") or "public", now, now),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "dub_entry_delete":
        conn.execute("DELETE FROM dub_profile_entries WHERE breadcrumb_id = ?", (payload["breadcrumbId"],))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "dub_entry_list":
        ids = payload["dubIds"]
        rows = conn.execute(f"SELECT * FROM dub_profile_entries WHERE dub_id IN ({','.join('?' for _ in ids)}) ORDER BY created_at ASC", ids).fetchall() if ids else []
        print(json.dumps({"entries": [public_dub_entry(r) for r in rows]}))
        return

    if action == "dub_list_by_user":
        rows = conn.execute("SELECT * FROM dubs WHERE user_id = ?", (payload["userId"],)).fetchall()
        print(json.dumps({"dubs": [public_dub(r) for r in rows]}))
        return

    if action == "peeps_network_dubs":
        # Claimed Dubs (the person owns their profile) with at least one public, accepted entry: the only
        # people who can surface to organizations OTHER than the one they met, and only through the entries
        # they approved — never through a transcript.
        rows = conn.execute(
            """
            SELECT DISTINCT d.* FROM dubs d JOIN dub_profile_entries e ON e.dub_id = d.id
            WHERE d.user_id IS NOT NULL AND e.visibility = 'public' ORDER BY d.updated_at DESC LIMIT 200
            """
        ).fetchall()
        print(json.dumps({"dubs": [public_dub(r) for r in rows]}))
        return

    if action == "peeps_economic_event_get":
        row = conn.execute("SELECT * FROM peeps_economic_events WHERE idempotency_key = ?", (payload["idempotencyKey"],)).fetchone()
        print(json.dumps({"event": public_peeps_economic_event(row)}))
        return

    if action == "peeps_economic_event_list":
        rows = conn.execute("SELECT * FROM peeps_economic_events WHERE request_id = ? ORDER BY created_at ASC", (payload["requestId"],)).fetchall()
        print(json.dumps({"events": [public_peeps_economic_event(r) for r in rows]}))
        return

    # Single-shot per idempotencyKey. A replay returns the ORIGINAL event with created=false; a signature
    # already spent anywhere else (another request, Dough funding, org billing) is refused outright.
    if action == "record_peeps_economic_event":
        now = utc_now()
        sig = payload.get("transactionSignature") or None
        existing = conn.execute("SELECT * FROM peeps_economic_events WHERE idempotency_key = ?", (payload["idempotencyKey"],)).fetchone()
        if existing:
            print(json.dumps({"event": public_peeps_economic_event(existing), "created": False}))
            return
        if sig:
            used = (
                conn.execute("SELECT 1 FROM peeps_economic_events WHERE transaction_signature = ?", (sig,)).fetchone()
                or conn.execute("SELECT 1 FROM dough_funding_intents WHERE transaction_signature = ?", (sig,)).fetchone()
                or conn.execute("SELECT 1 FROM billing_payment_intents WHERE transaction_signature = ?", (sig,)).fetchone()
            )
            if used:
                print(json.dumps({"error": "duplicate_signature"}))
                return
        try:
            conn.execute(
                """
                INSERT INTO peeps_economic_events (
                  id, request_id, jam_id, kind, idempotency_key, rail, status, amount, currency, network, token_mint,
                  payer_wallet, payee_wallet, transaction_signature, slot, block_time, verified_at, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["id"], payload["requestId"], payload.get("jamId"), payload["kind"], payload["idempotencyKey"],
                    payload["rail"], payload["status"], payload["amount"], payload.get("currency") or "USDC", payload.get("network"),
                    payload.get("tokenMint"), payload.get("payerWallet"), payload.get("payeeWallet"), sig, payload.get("slot"),
                    payload.get("blockTime"), payload.get("verifiedAt"), json.dumps(payload.get("metadata") or {}), now,
                ),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            conn.rollback()
            raced = conn.execute("SELECT * FROM peeps_economic_events WHERE idempotency_key = ?", (payload["idempotencyKey"],)).fetchone()
            if raced:
                print(json.dumps({"event": public_peeps_economic_event(raced), "created": False}))
            else:
                print(json.dumps({"error": "duplicate_signature"}))
            return
        row = conn.execute("SELECT * FROM peeps_economic_events WHERE idempotency_key = ?", (payload["idempotencyKey"],)).fetchone()
        print(json.dumps({"event": public_peeps_economic_event(row), "created": True}))
        return

    # Paid, server-verified Solana Dough fundings for a user — receipt evidence of where the Dough came from.
    if action == "dough_funding_intent_list_onchain":
        rows = conn.execute(
            "SELECT * FROM dough_funding_intents WHERE user_id = ? AND status = 'paid' AND transaction_signature IS NOT NULL AND provider = 'solana-usdc' ORDER BY paid_at DESC LIMIT ?",
            (payload["userId"], int(payload.get("limit") or 5)),
        ).fetchall()
        print(json.dumps({"intents": [{**public_dough_funding_intent(r), "paidAt": r["paid_at"]} for r in rows]}))
        return

    # ---- Peeps waitlist actions ----
    if action == "peeps_waitlist_join":
        now = utc_now()
        try:
            conn.execute(
                "INSERT INTO peeps_waitlist (id, email, name, country, city, interest, description, status, consent_at, consent_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITLISTED', ?, ?, ?, ?)",
                (payload["id"], payload["email"], payload["name"], payload.get("country") or "", payload.get("city") or "", payload["interest"], payload.get("description") or "", now, payload["consentVersion"], now, now),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            conn.rollback()
            row = conn.execute("SELECT * FROM peeps_waitlist WHERE email = ?", (payload["email"],)).fetchone()
            print(json.dumps({"duplicate": True, "entry": public_peeps_waitlist(row)}))
            return
        print(json.dumps({"created": True, "entry": public_peeps_waitlist(conn.execute("SELECT * FROM peeps_waitlist WHERE id = ?", (payload["id"],)).fetchone())}))
        return

    if action == "peeps_waitlist_get":
        if payload.get("id"):
            row = conn.execute("SELECT * FROM peeps_waitlist WHERE id = ?", (payload["id"],)).fetchone()
        else:
            row = conn.execute("SELECT * FROM peeps_waitlist WHERE email = ?", (payload["email"],)).fetchone()
        print(json.dumps({"entry": public_peeps_waitlist(row, conn)}))
        return

    if action == "peeps_waitlist_set_email_status":
        conn.execute("UPDATE peeps_waitlist SET confirmation_email_status = ?, confirmation_email_at = ?, updated_at = ? WHERE id = ?", (payload["status"], utc_now(), utc_now(), payload["id"]))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "peeps_waitlist_withdraw_consent":
        conn.execute("UPDATE peeps_waitlist SET consent_withdrawn_at = COALESCE(consent_withdrawn_at, ?), updated_at = ? WHERE id = ?", (utc_now(), utc_now(), payload["id"]))
        conn.execute("UPDATE peeps_waitlist_invites SET revoked_at = COALESCE(revoked_at, ?) WHERE waitlist_id = ? AND used_at IS NULL", (utc_now(), payload["id"]))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "peeps_waitlist_list":
        limit_n = max(1, min(2000, int(payload.get("limit") or 500)))
        rows = conn.execute("SELECT * FROM peeps_waitlist ORDER BY created_at DESC LIMIT ?", (limit_n,)).fetchall()
        def tally(col, fallback):
            return {(r[0] or fallback): r[1] for r in conn.execute(f"SELECT {col}, COUNT(*) FROM peeps_waitlist GROUP BY {col} ORDER BY COUNT(*) DESC").fetchall()}
        countries = {}
        for r in conn.execute("SELECT LOWER(TRIM(country)), COUNT(*) FROM peeps_waitlist GROUP BY LOWER(TRIM(country)) ORDER BY COUNT(*) DESC").fetchall():
            countries[r[0] or "(not given)"] = r[1]
        total = conn.execute("SELECT COUNT(*) FROM peeps_waitlist").fetchone()[0]
        print(json.dumps({"total": total, "byInterest": tally("interest", "other"), "byStatus": tally("status", "WAITLISTED"), "byCountry": countries, "entries": [public_peeps_waitlist(r, conn) for r in rows]}))
        return

    # Issues a fresh single-use invitation (revoking any earlier unused one) and marks the person INVITED.
    # Only a WAITLISTED or already-INVITED person can be invited; ACTIVE/SUSPENDED are refused.
    if action == "peeps_waitlist_invite_create":
        now = utc_now()
        row = conn.execute("SELECT * FROM peeps_waitlist WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"error": "not_found"}))
            return
        if row["status"] not in ("WAITLISTED", "INVITED"):
            print(json.dumps({"error": "invalid_state", "status": row["status"]}))
            return
        if row["consent_withdrawn_at"]:
            print(json.dumps({"error": "consent_withdrawn"}))
            return
        conn.execute("UPDATE peeps_waitlist_invites SET revoked_at = ? WHERE waitlist_id = ? AND used_at IS NULL AND revoked_at IS NULL", (now, payload["id"]))
        conn.execute("INSERT INTO peeps_waitlist_invites (id, waitlist_id, token_hash, expires_at, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", (payload["inviteId"], payload["id"], payload["tokenHash"], payload["expiresAt"], payload.get("createdByUserId"), now))
        conn.execute("UPDATE peeps_waitlist SET status = 'INVITED', invited_at = ?, invited_by_user_id = ?, updated_at = ? WHERE id = ?", (now, payload.get("createdByUserId"), now, payload["id"]))
        conn.commit()
        print(json.dumps({"entry": public_peeps_waitlist(conn.execute("SELECT * FROM peeps_waitlist WHERE id = ?", (payload["id"],)).fetchone(), conn)}))
        return

    if action == "peeps_waitlist_invite_lookup":
        inv = conn.execute("SELECT * FROM peeps_waitlist_invites WHERE token_hash = ?", (payload["tokenHash"],)).fetchone()
        if not inv:
            print(json.dumps({"state": "invalid"}))
            return
        row = conn.execute("SELECT * FROM peeps_waitlist WHERE id = ?", (inv["waitlist_id"],)).fetchone()
        try:
            expired = datetime.fromisoformat(inv["expires_at"].replace("Z", "+00:00")) <= datetime.now(timezone.utc)
        except ValueError:
            expired = True
        state = "used" if inv["used_at"] else "revoked" if inv["revoked_at"] else "expired" if expired else "valid"
        if state == "valid" and row["status"] != "INVITED":
            state = "revoked"
        print(json.dumps({"state": state, "entry": public_peeps_waitlist(row)}))
        return

    # Atomic single-use claim. rowcount==1 means THIS call consumed the token.
    if action == "peeps_waitlist_invite_claim":
        now_dt = datetime.now(timezone.utc)
        inv = conn.execute("SELECT * FROM peeps_waitlist_invites WHERE token_hash = ?", (payload["tokenHash"],)).fetchone()
        if not inv:
            print(json.dumps({"claimed": False, "state": "invalid"}))
            return
        try:
            expired = datetime.fromisoformat(inv["expires_at"].replace("Z", "+00:00")) <= now_dt
        except ValueError:
            expired = True
        if expired:
            print(json.dumps({"claimed": False, "state": "expired"}))
            return
        cur = conn.execute("UPDATE peeps_waitlist_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL", (utc_now(), payload["tokenHash"]))
        conn.commit()
        if cur.rowcount != 1:
            print(json.dumps({"claimed": False, "state": "used"}))
            return
        row = conn.execute("SELECT * FROM peeps_waitlist WHERE id = ?", (inv["waitlist_id"],)).fetchone()
        if row["status"] != "INVITED":
            conn.execute("UPDATE peeps_waitlist_invites SET used_at = NULL WHERE token_hash = ?", (payload["tokenHash"],))
            conn.commit()
            print(json.dumps({"claimed": False, "state": "revoked"}))
            return
        print(json.dumps({"claimed": True, "entry": public_peeps_waitlist(row)}))
        return

    if action == "peeps_waitlist_invite_unclaim":
        conn.execute("UPDATE peeps_waitlist_invites SET used_at = NULL WHERE token_hash = ?", (payload["tokenHash"],))
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    # Admin/accept transitions. ACTIVE requires a linked user account; SUSPENDED revokes open invitations.
    if action == "peeps_waitlist_set_status":
        now = utc_now()
        row = conn.execute("SELECT * FROM peeps_waitlist WHERE id = ?", (payload["id"],)).fetchone()
        if not row:
            print(json.dumps({"error": "not_found"}))
            return
        status = payload["status"]
        user_id = payload.get("userId") or row["user_id"]
        if status == "ACTIVE":
            if not user_id:
                print(json.dumps({"error": "no_account"}))
                return
            conn.execute("UPDATE peeps_waitlist SET status = 'ACTIVE', user_id = ?, activated_at = COALESCE(activated_at, ?), suspended_at = NULL, updated_at = ? WHERE id = ?", (user_id, now, now, payload["id"]))
            if payload.get("markVerified"):
                conn.execute("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?", (now, now, user_id))
        elif status == "SUSPENDED":
            conn.execute("UPDATE peeps_waitlist SET status = 'SUSPENDED', suspended_at = ?, updated_at = ? WHERE id = ?", (now, now, payload["id"]))
            conn.execute("UPDATE peeps_waitlist_invites SET revoked_at = ? WHERE waitlist_id = ? AND used_at IS NULL AND revoked_at IS NULL", (now, payload["id"]))
        else:
            print(json.dumps({"error": "invalid_status"}))
            return
        conn.commit()
        print(json.dumps({"entry": public_peeps_waitlist(conn.execute("SELECT * FROM peeps_waitlist WHERE id = ?", (payload["id"],)).fetchone(), conn)}))
        return

    if action == "peeps_settlement_list":
        rows = conn.execute("SELECT * FROM peeps_settlements WHERE jam_id = ? ORDER BY created_at ASC", (payload["jamId"],)).fetchall()
        print(json.dumps({"settlements": [public_peeps_settlement(r) for r in rows]}))
        return

    if action == "peeps_settlement_transfer":
        # ONE transaction: settlement row + payer debit + payee credit. A Dough credit can never exist
        # without the matching debit, a retry can never move money twice, and "paid" is only written after
        # both ledger entries are committed.
        now = utc_now()
        amount = round(float(payload["amount"]), 2)
        if not math.isfinite(amount) or amount <= 0:
            print(json.dumps({"status": "invalid_amount"}))
            return
        pid = payload["jamParticipantId"]
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM peeps_settlements WHERE jam_participant_id = ?", (pid,)).fetchone()
            if row and row["status"] == "paid":
                conn.rollback()
                print(json.dumps({"status": "already_paid", "settlement": public_peeps_settlement(row)}))
                return
            if not row:
                conn.execute(
                    "INSERT INTO peeps_settlements (id, jam_id, jam_participant_id, request_id, payer_user_id, payee_subject_type, payee_subject_id, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
                    (payload["id"], payload["jamId"], pid, payload["requestId"], payload["payerUserId"], payload["payeeSubjectType"], payload["payeeSubjectId"], amount, now, now),
                )
            else:
                # The payee may have claimed their Dub since the last attempt; always pay the current owner.
                conn.execute("UPDATE peeps_settlements SET payee_subject_type = ?, payee_subject_id = ?, amount = ? WHERE jam_participant_id = ?", (payload["payeeSubjectType"], payload["payeeSubjectId"], amount, pid))
            conn.execute("INSERT OR IGNORE INTO dough_accounts (subject_type, subject_id, updated_at) VALUES ('user', ?, ?)", (payload["payerUserId"], now))
            conn.execute("INSERT OR IGNORE INTO dough_accounts (subject_type, subject_id, updated_at) VALUES (?, ?, ?)", (payload["payeeSubjectType"], payload["payeeSubjectId"], now))
            payer = conn.execute("SELECT * FROM dough_accounts WHERE subject_type = 'user' AND subject_id = ?", (payload["payerUserId"],)).fetchone()
            available = float(payer["spend_balance"] or 0)
            if available + 1e-9 < amount:
                conn.execute("UPDATE peeps_settlements SET status = 'pending', reason = 'requester_funding_required', available_at_attempt = ?, updated_at = ? WHERE jam_participant_id = ?", (available, now, pid))
                conn.commit()
                row = conn.execute("SELECT * FROM peeps_settlements WHERE jam_participant_id = ?", (pid,)).fetchone()
                print(json.dumps({"status": "insufficient", "available": available, "shortfall": round(amount - available, 2), "settlement": public_peeps_settlement(row)}))
                return
            conn.execute("UPDATE dough_accounts SET spend_balance = spend_balance - ?, updated_at = ? WHERE subject_type = 'user' AND subject_id = ?", (amount, now, payload["payerUserId"]))
            conn.execute("UPDATE dough_accounts SET earned_balance = earned_balance + ?, updated_at = ? WHERE subject_type = ? AND subject_id = ?", (amount, now, payload["payeeSubjectType"], payload["payeeSubjectId"]))
            conn.execute("INSERT INTO dough_entries (id, subject_type, subject_id, bucket, direction, amount, kind, reference_id, status, metadata_json, created_at) VALUES (?, 'user', ?, 'spend', 'debit', ?, 'peeps_settlement_out', ?, 'posted', ?, ?)", (payload["debitEntryId"], payload["payerUserId"], amount, "settle-out:" + pid, json.dumps({"jamId": payload["jamId"], "jamParticipantId": pid}), now))
            conn.execute("INSERT INTO dough_entries (id, subject_type, subject_id, bucket, direction, amount, kind, reference_id, status, metadata_json, created_at) VALUES (?, ?, ?, 'earned', 'credit', ?, 'jam_earning', ?, 'posted', ?, ?)", (payload["creditEntryId"], payload["payeeSubjectType"], payload["payeeSubjectId"], amount, "settle-in:" + pid, json.dumps({"jamId": payload["jamId"], "jamParticipantId": pid}), now))
            conn.execute("UPDATE peeps_settlements SET status = 'paid', reason = '', paid_at = ?, updated_at = ? WHERE jam_participant_id = ?", (now, now, pid))
            conn.commit()
        except sqlite3.OperationalError:
            conn.rollback()
            print(json.dumps({"status": "busy"}))
            return
        row = conn.execute("SELECT * FROM peeps_settlements WHERE jam_participant_id = ?", (pid,)).fetchone()
        print(json.dumps({"status": "paid", "settlement": public_peeps_settlement(row)}))
        return

    # ---- Dub claim (section 27) ----

    if action == "dub_get":
        row = conn.execute("SELECT * FROM dubs WHERE id = ?", (payload["id"],)).fetchone()
        print(json.dumps({"dub": public_dub(row)}))
        return

    if action == "dub_search_by_organization_history":
        # "Previous Peeps interactions" (section 3.D) — Dubs this org has already recruited into a Jam
        # before. Never crosses organization boundaries: only this org's own jam_participants rows.
        rows = conn.execute(
            """
            SELECT DISTINCT d.* FROM dubs d
            JOIN jam_participants jp ON jp.dub_id = d.id
            JOIN jams j ON j.id = jp.jam_id
            WHERE j.organization_id = ?
            ORDER BY d.updated_at DESC LIMIT 25
            """,
            (payload["organizationId"],),
        ).fetchall()
        print(json.dumps({"dubs": [public_dub(row) for row in rows]}))
        return

    if action == "dub_breadcrumbs_for_dub":
        rows = conn.execute(
            """
            SELECT je.* FROM jam_events je
            JOIN jam_participants jp ON jp.id = je.jam_participant_id
            WHERE jp.dub_id = ?
            ORDER BY je.created_at DESC LIMIT 50
            """,
            (payload["dubId"],),
        ).fetchall()
        print(json.dumps({"events": [public_jam_event(row) for row in rows]}))
        return

    if action == "dub_claim_invite_issue":
        now = utc_now()
        conn.execute(
            "INSERT INTO dub_claim_invites (id, dub_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], payload["dubId"], payload["tokenHash"], payload["expiresAt"], now),
        )
        conn.commit()
        print(json.dumps({"ok": True}))
        return

    if action == "dub_claim_invite_get":
        row = conn.execute("SELECT * FROM dub_claim_invites WHERE token_hash = ?", (payload["tokenHash"],)).fetchone()
        if not row:
            print(json.dumps({"invite": None, "dub": None}))
            return
        dub_row = conn.execute("SELECT * FROM dubs WHERE id = ?", (row["dub_id"],)).fetchone()
        print(json.dumps({
            "invite": {
                "id": row["id"], "dubId": row["dub_id"], "expiresAt": row["expires_at"], "claimedAt": row["claimed_at"],
            },
            "dub": public_dub(dub_row),
        }))
        return

    if action == "dub_claim":
        # Idempotent claim: only the FIRST caller to hit this WHERE user_id IS NULL wins — same one-shot
        # atomic-claim pattern as jam_run_session's studio_session_id claim. A Dub can never be hijacked
        # out from under whoever claimed it first, even under a concurrent double-claim attempt, and a
        # single UPDATE statement is already atomic under SQLite's single-writer model without needing an
        # explicit transaction wrapper.
        now = utc_now()
        cursor = conn.execute(
            "UPDATE dubs SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS NULL",
            (payload["userId"], now, payload["dubId"]),
        )
        won = cursor.rowcount == 1
        if won:
            conn.execute(
                "UPDATE dub_claim_invites SET claimed_at = ?, claimed_by_user_id = ? WHERE token_hash = ? AND claimed_at IS NULL",
                (now, payload["userId"], payload["tokenHash"]),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM dubs WHERE id = ?", (payload["dubId"],)).fetchone()
        print(json.dumps({"claimed": won, "dub": public_dub(row)}))
        return

    if action == "jam_get_by_session":
        # Internal lookup used by Studio's own read-only GET /api/sessions/:id/jam — resolves the jam a
        # session was launched from via live_sessions.jam_id, never trusting a client-supplied jamId.
        session_row = conn.execute("SELECT jam_id FROM live_sessions WHERE id = ?", (payload["sessionId"],)).fetchone()
        if not session_row or not session_row["jam_id"]:
            print(json.dumps({"jam": None}))
            return
        row = conn.execute("SELECT * FROM jams WHERE id = ?", (session_row["jam_id"],)).fetchone()
        if not row:
            print(json.dumps({"jam": None}))
            return
        entry = public_jam(row)
        counts = conn.execute(
            """
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN status IN ('confirmed','attended','completed') THEN 1 ELSE 0 END) AS confirmed
            FROM jam_participants WHERE jam_id = ?
            """,
            (row["id"],),
        ).fetchone()
        entry["participantCount"] = counts["total"] or 0
        entry["confirmedCount"] = counts["confirmed"] or 0
        print(json.dumps({"jam": entry}))
        return

    raise ValueError(f"Unknown action: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": "db_error", "detail": str(exc)}))
        sys.exit(1)
