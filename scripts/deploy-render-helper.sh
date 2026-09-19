#!/usr/bin/env bash
# Copy ONLY the canonical Git auth helper onto the Ubuntu render host and restart that
# Node service. This is a different machine from the LiteSpeed static site
# (toasty.media / .github/workflows/deploy-production.yml).
#
# Never copies the SQLite DB, environment files, secrets, nginx config, or the Node
# server itself. Dry-run unless APPROVE_TOASTY_RENDER_HELPER=production and --execute.
set -euo pipefail

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --execute) MODE="execute" ;;
    --dry-run) MODE="dry-run" ;;
    *) echo "Usage: scripts/deploy-render-helper.sh [--dry-run|--execute]" >&2; exit 64 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_HELPER="$ROOT/scripts/toasty-auth-db.py"
SSH_HOST="${TOASTY_RENDER_SSH_HOST:-}"
SSH_USER="${TOASTY_RENDER_SSH_USER:-}"
SSH_PORT="${TOASTY_RENDER_SSH_PORT:-22}"
SSH_KEY="${TOASTY_RENDER_SSH_KEY:-}"
REMOTE_HELPER="${TOASTY_RENDER_HELPER_PATH:-}"
REMOTE_UNIT="${TOASTY_RENDER_UNIT:-}"

if [[ ! -f "$LOCAL_HELPER" ]]; then
  echo "Missing local helper: $LOCAL_HELPER" >&2
  exit 1
fi

missing=()
[[ -n "$SSH_HOST" ]] || missing+=("TOASTY_RENDER_SSH_HOST")
[[ -n "$SSH_USER" ]] || missing+=("TOASTY_RENDER_SSH_USER")
[[ -n "$REMOTE_HELPER" ]] || missing+=("TOASTY_RENDER_HELPER_PATH")
[[ -n "$REMOTE_UNIT" ]] || missing+=("TOASTY_RENDER_UNIT")
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Render-host deploy is not configured. Missing: ${missing[*]}" >&2
  echo "The static GitHub Actions job cannot ship this file: it SSHes to LiteSpeed toasty.media, not render.toasty.media." >&2
  echo "Set the variables above to the Ubuntu render host path (AUTH_DB_HELPER default: <dir-of-render-production-server.mjs>/toasty-auth-db.py) and the systemd unit that runs scripts/render-production-server.mjs." >&2
  exit 2
fi

if [[ "$REMOTE_HELPER" != /* || "$REMOTE_HELPER" == *..* ]]; then
  echo "TOASTY_RENDER_HELPER_PATH must be an absolute path without .." >&2
  exit 1
fi
if [[ "$(basename "$REMOTE_HELPER")" != "toasty-auth-db.py" ]]; then
  echo "TOASTY_RENDER_HELPER_PATH must end with toasty-auth-db.py (refusing to overwrite an unrelated file)" >&2
  exit 1
fi
if [[ "$REMOTE_UNIT" =~ [^a-zA-Z0-9@._-] ]]; then
  echo "TOASTY_RENDER_UNIT contains unsafe characters" >&2
  exit 1
fi

LOCAL_HASH="$(sha256sum "$LOCAL_HELPER" | awk '{print $1}')"
SSH_OPTS=(-p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi
SSH=(ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST")
SCP=(scp -P "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [[ -n "$SSH_KEY" ]]; then
  SCP+=(-i "$SSH_KEY")
fi

echo "Mode: $MODE"
echo "Local helper: $LOCAL_HELPER"
echo "Local sha256: $LOCAL_HASH"
echo "Remote host: $SSH_USER@$SSH_HOST:$SSH_PORT"
echo "Remote helper: $REMOTE_HELPER"
echo "Remote unit: $REMOTE_UNIT"

echo "Checking remote helper path and unit..."
"${SSH[@]}" "set -euo pipefail
  test -d \"\$(dirname '$REMOTE_HELPER')\"
  systemctl list-unit-files --type=service --no-legend | awk '{print \$1}' | grep -Fx '$REMOTE_UNIT' >/dev/null
  if [[ -f '$REMOTE_HELPER' ]]; then sha256sum '$REMOTE_HELPER'; else echo 'MISSING $REMOTE_HELPER'; fi
  systemctl is-active '$REMOTE_UNIT' || true
"

if [[ "$MODE" != "execute" ]]; then
  echo "Dry run only. No remote files were changed. No service was restarted."
  exit 0
fi

if [[ "${APPROVE_TOASTY_RENDER_HELPER:-}" != "production" ]]; then
  echo "Refusing real helper deploy without APPROVE_TOASTY_RENDER_HELPER=production" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
echo "Backing up existing remote helper (if any) and copying canonical Git file..."
"${SSH[@]}" "set -euo pipefail
  if [[ -f '$REMOTE_HELPER' ]]; then
    cp -a '$REMOTE_HELPER' '$REMOTE_HELPER.bak-$STAMP'
  fi
"
"${SCP[@]}" "$LOCAL_HELPER" "$SSH_USER@$SSH_HOST:$REMOTE_HELPER"

echo "Hash-verifying remote helper and restarting $REMOTE_UNIT..."
REMOTE_HASH="$("${SSH[@]}" "set -euo pipefail
  test -f '$REMOTE_HELPER'
  sha256sum '$REMOTE_HELPER' | awk '{print \$1}'
  sudo -n systemctl restart '$REMOTE_UNIT'
  systemctl is-active '$REMOTE_UNIT'
")"
REMOTE_SHA="$(printf '%s\n' "$REMOTE_HASH" | sed -n '1p')"
REMOTE_ACTIVE="$(printf '%s\n' "$REMOTE_HASH" | sed -n '2p')"

echo "Remote sha256: $REMOTE_SHA"
echo "Unit status: $REMOTE_ACTIVE"
if [[ "$REMOTE_SHA" != "$LOCAL_HASH" ]]; then
  echo "HASH MISMATCH: local Git helper != production helper" >&2
  exit 1
fi
if [[ "$REMOTE_ACTIVE" != "active" ]]; then
  echo "Service $REMOTE_UNIT is not active after restart" >&2
  exit 1
fi
echo "Render helper deploy complete. DB, env, secrets, and nginx were not touched."
