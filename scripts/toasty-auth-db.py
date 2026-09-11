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
    conn.commit()


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

    raise ValueError(f"Unknown action: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": "db_error", "detail": str(exc)}))
        sys.exit(1)
