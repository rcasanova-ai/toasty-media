#!/usr/bin/env bash
set -euo pipefail

SSH_ALIAS="toasty-spaceship"
PROD_ROOT="/home/fmxgijyvpq/toasty.media"
EXPECTED_LOCAL_ROOT="/Users/ricardocasanova/Projects/toasty-media"
MODE="dry-run"

if [[ "${1:-}" == "--execute" ]]; then
  MODE="execute"
elif [[ "${1:-}" == "--dry-run" || -z "${1:-}" ]]; then
  MODE="dry-run"
else
  echo "Usage: scripts/deploy-production.sh [--dry-run|--execute]" >&2
  exit 64
fi

if [[ "$(pwd)" != "$EXPECTED_LOCAL_ROOT" ]]; then
  echo "Refusing to run outside $EXPECTED_LOCAL_ROOT" >&2
  exit 1
fi

MANAGED_PATHS=(
  ".htaccess"
  "index.html"
  "site"
  "ricardo"
  "studio"
  "experts"
  "app"
  "admin"
  "css"
  "js"
  "shared"
  "assets"
  "articles"
  "eloquencebonus"
  "thank-you.html"
  "5-Day Executive Program.pdf"
  "Eloquence Cheat Sheet.pdf"
  "casanova_case_study.pdf"
  "ricardo_casanova_resumeJune2026.pdf"
)

EXCLUDED_PATHS=(
  "dominion-investor-dashboard"
  "incitech"
)

for path in "${MANAGED_PATHS[@]}"; do
  if [[ "$path" == "dominion-investor-dashboard"* || "$path" == "incitech"* ]]; then
    echo "Managed path accidentally includes excluded path: $path" >&2
    exit 1
  fi
  if [[ ! -e "$path" ]]; then
    echo "Managed path does not exist locally: $path" >&2
    exit 1
  fi
done

echo "Mode: $MODE"
echo "Target: $SSH_ALIAS:$PROD_ROOT"
echo "Managed paths:"
printf '  %s\n' "${MANAGED_PATHS[@]}"
echo "Excluded paths:"
printf '  %s\n' "${EXCLUDED_PATHS[@]}"

if [[ "$MODE" == "dry-run" ]]; then
  ssh "$SSH_ALIAS" "test -d '$PROD_ROOT'"
  echo
  echo "Dry run only. No production files were changed."
  echo "Run with APPROVE_TOASTY_DEPLOY=production scripts/deploy-production.sh --execute after explicit approval."
  exit 0
fi

if [[ "${APPROVE_TOASTY_DEPLOY:-}" != "production" ]]; then
  echo "Refusing real deployment without APPROVE_TOASTY_DEPLOY=production" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$PROD_ROOT/_backups/toasty-media-$STAMP"

# Build one remote backup command so the deploy does not open a new SSH session
# for every managed path. This also avoids repeating remote locale warnings.
REMOTE_BACKUP_CMD="set -e; test -d '$PROD_ROOT'; mkdir -p '$BACKUP_DIR';"
for path in "${MANAGED_PATHS[@]}"; do
  dir="$(dirname "$path")"
  REMOTE_BACKUP_CMD+=" if [ -e '$PROD_ROOT/$path' ]; then mkdir -p '$BACKUP_DIR/$dir'; cp -a '$PROD_ROOT/$path' '$BACKUP_DIR/$path'; fi;"
done

ssh "$SSH_ALIAS" "$REMOTE_BACKUP_CMD"

git archive --format=tar HEAD -- "${MANAGED_PATHS[@]}" | ssh "$SSH_ALIAS" "set -e; cd '$PROD_ROOT'; tar -xf -"

echo "Deployment complete. Backup: $BACKUP_DIR"
