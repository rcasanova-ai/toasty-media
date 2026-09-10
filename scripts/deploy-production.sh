#!/usr/bin/env bash
set -euo pipefail
SSH_ALIAS="toasty-spaceship"
PROD_ROOT="/home/fmxgijyvpq/toasty.media"
EXPECTED_LOCAL_ROOT="/Users/ricardocasanova/Projects/toasty-media"
MODE="dry-run"; SCOPE="full"
for arg in "$@"; do case "$arg" in --execute) MODE="execute";; --dry-run) MODE="dry-run";; --expertise) SCOPE="expertise";; *) echo "Usage: scripts/deploy-production.sh [--dry-run|--execute] [--expertise]" >&2; exit 64;; esac; done
if [[ "$(pwd)" != "$EXPECTED_LOCAL_ROOT" ]]; then echo "Refusing to run outside $EXPECTED_LOCAL_ROOT" >&2; exit 1; fi
FULL_PATHS=(".htaccess" "index.html" "site" "ricardo" "studio" "admin" "css" "js" "shared" "assets" "articles" "eloquencebonus" "thank-you.html" "5-Day Executive Program.pdf" "Eloquence Cheat Sheet.pdf" "casanova_case_study.pdf" "ricardo_casanova_resumeJune2026.pdf")
EXPERTISE_PATHS=("index.html" "admin" "css/expertise-platform.css" "css/sales-executive.css" "js/expertise-admin.js" "js/brand-themes.js" "js/video-engine.js")
if [[ "$SCOPE" == "expertise" ]]; then MANAGED_PATHS=("${EXPERTISE_PATHS[@]}"); else MANAGED_PATHS=("${FULL_PATHS[@]}"); fi
for path in "${MANAGED_PATHS[@]}"; do if [[ ! -e "$path" ]]; then echo "Managed path does not exist locally: $path" >&2; exit 1; fi; done
echo "Mode: $MODE"; echo "Scope: $SCOPE"; echo "Target: $SSH_ALIAS:$PROD_ROOT"; echo "Paths:"; printf '  %s\n' "${MANAGED_PATHS[@]}"
SSH=(env LANG=C LC_ALL=C LC_CTYPE=C ssh "$SSH_ALIAS"); REMOTE_ENV="export LANG=C LC_ALL=C LC_CTYPE=C;"
if [[ "$MODE" == "dry-run" ]]; then "${SSH[@]}" "$REMOTE_ENV test -d '$PROD_ROOT'; echo 'Remote connection OK'"; echo "Dry run only. No production files were changed."; exit 0; fi
if [[ "${APPROVE_TOASTY_DEPLOY:-}" != "production" ]]; then echo "Refusing real deployment without APPROVE_TOASTY_DEPLOY=production" >&2; exit 1; fi
STAMP="$(date +%Y%m%d-%H%M%S)"; BACKUP_DIR="$PROD_ROOT/_backups/toasty-media-$STAMP"; REMOTE_BACKUP_CMD="$REMOTE_ENV set -e; test -d '$PROD_ROOT'; mkdir -p '$BACKUP_DIR';"
for path in "${MANAGED_PATHS[@]}"; do dir="$(dirname "$path")"; REMOTE_BACKUP_CMD+=" echo 'Backing up: $path'; if [ -e '$PROD_ROOT/$path' ]; then mkdir -p '$BACKUP_DIR/$dir'; cp -a '$PROD_ROOT/$path' '$BACKUP_DIR/$path'; fi;"; done
"${SSH[@]}" "$REMOTE_BACKUP_CMD"
echo "Uploading deployment..."; git archive --format=tar HEAD -- "${MANAGED_PATHS[@]}" | "${SSH[@]}" "$REMOTE_ENV set -e; cd '$PROD_ROOT'; tar -xf -"; echo "Deployment complete. Backup: $BACKUP_DIR"
