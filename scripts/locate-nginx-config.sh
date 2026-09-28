#!/bin/bash
# Run ON the render host (via ssh ... bash locate-nginx-config.sh) to print the path of the nginx config
# file that contains this site's own toasty_settings rate-limit zone — i.e. the file
# scripts/sync-nginx-jam-routes.py needs to patch. Prints nothing and exits non-zero if it can't be found.
set -euo pipefail

NGINX_BIN="$(command -v nginx || true)"
for candidate in "$NGINX_BIN" /usr/sbin/nginx /usr/bin/nginx /sbin/nginx; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    NGINX_BIN="$candidate"
    break
  fi
done
if [[ -z "$NGINX_BIN" ]]; then
  echo "No nginx binary found on PATH or in common sbin locations." >&2
  exit 1
fi

"$NGINX_BIN" -T 2>/dev/null \
  | awk '/# configuration file/{f=$0} /moxie\/post-event-suggestions/{print f; exit}' \
  | sed -E 's/^# configuration file (.*):$/\1/'
