#!/usr/bin/env python3
"""One-time, narrowly-scoped patch for the render host's LIVE nginx config: adds the new
"Peeps agent-to-human transaction lifecycle" location blocks (/api/peeps/*, /api/dubs/*/claim-invite,
/api/dub-claims/*) to the live file.

This is a SEPARATE script from scripts/sync-nginx-jam-routes.py on purpose, even though the pattern is
identical: that script's own JAM_BLOCK_START marker is already present in the live config (it ran
successfully during the previous Jam lifecycle rollout), so it now permanently no-ops — including for any
NEW content later added inside that same block's span in the .example file. A second, independently
marker-gated script is the only way to land a second wave of routes without either editing that
"one-time" script's meaning after the fact or building a general nginx sync pipeline (explicitly out of
scope — see that script's own header).

Deliberately does NOT overwrite the live file wholesale -- that file has host-specific content (real cert
paths, server_name) this repo's own .example mirror does not carry. New content is derived PURELY from
scripts/nginx-render.conf.example (never hardcoded here).

Usage: cat <live nginx config> | python3 scripts/sync-nginx-peeps-agent-routes.py scripts/nginx-render.conf.example > merged.conf
Exits non-zero (with the ORIGINAL content unwritten) only if the REQUIRED block markers aren't found in
the .example file, the block is already present in the live config (idempotent no-op, exit 0), or the
catch-all anchor is missing/ambiguous.
"""
import sys

BLOCK_START = "    # ---- Peeps agent-to-human transaction lifecycle ----"
BLOCK_END_ANCHOR = "    # Organizer-authenticated: disable/re-enable one campaign link (never a hard delete"
CATCH_ALL_ANCHOR = "    location / {\n        return 404;\n    }\n"


def main():
    if len(sys.argv) != 2:
        print("usage: sync-nginx-peeps-agent-routes.py <path to nginx-render.conf.example>", file=sys.stderr)
        return 2
    example = open(sys.argv[1], "r", encoding="utf-8").read()
    live = sys.stdin.read()

    start_idx = example.find(BLOCK_START)
    end_idx = example.find(BLOCK_END_ANCHOR)
    if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
        print("FAIL: could not find the Peeps agent-to-human lifecycle block markers in the .example file", file=sys.stderr)
        return 1
    block = example[start_idx:end_idx]

    if BLOCK_START in live:
        print("NOOP: the Peeps agent-to-human lifecycle block is already present in the live config", file=sys.stderr)
        sys.stdout.write(live)
        return 0

    if live.count(CATCH_ALL_ANCHOR) != 1:
        print(f"FAIL: expected exactly 1 occurrence of the catch-all 'location / {{ return 404; }}' block in the live config, found {live.count(CATCH_ALL_ANCHOR)}. Dumping every 'location' line for diagnosis:", file=sys.stderr)
        for line in live.splitlines():
            if "location" in line:
                print(f"  {line}", file=sys.stderr)
        return 1

    merged = live.replace(CATCH_ALL_ANCHOR, block + "\n" + CATCH_ALL_ANCHOR, 1)
    sys.stdout.write(merged)
    print("OK: Peeps agent-to-human lifecycle location blocks applied.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
