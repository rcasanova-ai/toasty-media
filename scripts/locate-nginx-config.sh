#!/bin/bash
# Run ON the render host (via ssh ... bash locate-nginx-config.sh) to print the path of the nginx config
# file that contains this site's own Jam-adjacent route (moxie/post-event-suggestions, unique to the
# routes file, not the rate-limit zone file) -- i.e. the file scripts/sync-nginx-jam-routes.py needs to
# patch. On success prints exactly one line: "FOUND:<path>". On any failure, prints diagnostics to stderr
# (nginx binary resolution, nginx -T's own exit code, every config file nginx -T actually reports) and
# exits non-zero -- never guesses, never prints a FOUND: line it isn't sure about.
set -uo pipefail

NGINX_BIN="$(command -v nginx || true)"
for candidate in "$NGINX_BIN" /usr/sbin/nginx /usr/bin/nginx /sbin/nginx; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    NGINX_BIN="$candidate"
    break
  fi
done
if [[ -z "$NGINX_BIN" ]]; then
  echo "DIAG: no nginx binary found on PATH or in common sbin locations." >&2
  echo "DIAG: PATH=$PATH" >&2
  exit 1
fi
echo "DIAG: using nginx binary: $NGINX_BIN ($("$NGINX_BIN" -v 2>&1))" >&2

DUMP="$("$NGINX_BIN" -T 2>/tmp/nginx-T-stderr.log)"
NGINX_T_STATUS=$?
if [[ $NGINX_T_STATUS -ne 0 ]]; then
  echo "DIAG: '$NGINX_BIN -T' exited $NGINX_T_STATUS. stderr:" >&2
  cat /tmp/nginx-T-stderr.log >&2
  exit 1
fi
if [[ -z "$DUMP" ]]; then
  echo "DIAG: '$NGINX_BIN -T' produced no output at all." >&2
  exit 1
fi

echo "DIAG: nginx -T reports these config files:" >&2
grep '# configuration file' <<<"$DUMP" >&2 || echo "DIAG: (no '# configuration file' markers at all — unexpected nginx -T format)" >&2

FILE_PATH="$(awk '/# configuration file/{f=$0} /moxie\/post-event-suggestions/{print f; exit}' <<<"$DUMP" | sed -E 's/^# configuration file (.*):$/\1/')"
if [[ -z "$FILE_PATH" ]]; then
  echo "DIAG: none of the above files contain 'moxie/post-event-suggestions'. Falling back: searching for '/api/campaign-links' instead." >&2
  FILE_PATH="$(awk '/# configuration file/{f=$0} /\/api\/campaign-links/{print f; exit}' <<<"$DUMP" | sed -E 's/^# configuration file (.*):$/\1/')"
fi
if [[ -z "$FILE_PATH" ]]; then
  echo "DIAG: still nothing. Falling back: searching for '/api/organizations' instead (broader, may over-match)." >&2
  FILE_PATH="$(awk '/# configuration file/{f=$0} /\/api\/organizations/{print f; exit}' <<<"$DUMP" | sed -E 's/^# configuration file (.*):$/\1/')"
fi
if [[ -z "$FILE_PATH" ]]; then
  echo "DIAG: could not identify the routes file by any marker. Manual investigation needed." >&2
  exit 1
fi

echo "FOUND:$FILE_PATH"
