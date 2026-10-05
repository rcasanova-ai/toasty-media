#!/usr/bin/env python3
"""One-time, narrowly-scoped patch for the render host's LIVE nginx config: adds the dedicated Studio
broadcast location block (/api/organizations/creator-broadcast/*) ABOVE the generic
`location ~ ^/api/organizations(/.*)?$` block (regex locations match in file order, so ordering is the
whole point). Same shape as scripts/sync-nginx-peeps-agent-routes.py: block text is derived purely from
scripts/nginx-render.conf.example, never hardcoded here, and the live file is never overwritten wholesale.

Usage: cat <live nginx config> | python3 scripts/sync-nginx-studio-broadcast-route.py scripts/nginx-render.conf.example > merged.conf
"""
import sys

BLOCK_START = "    # ---- Studio broadcast (Program -> X / YouTube / ...) ----"
BLOCK_END = "    # ---- end Studio broadcast ----\n"
GENERIC_ANCHOR = "    location ~ ^/api/organizations(/.*)?$ {"


def main():
    if len(sys.argv) != 2:
        print("usage: sync-nginx-studio-broadcast-route.py <path to nginx-render.conf.example>", file=sys.stderr)
        return 2
    example = open(sys.argv[1], "r", encoding="utf-8").read()
    live = sys.stdin.read()
    start = example.find(BLOCK_START)
    end = example.find(BLOCK_END)
    if start == -1 or end == -1 or end <= start:
        print("FAIL: Studio broadcast block markers not found in the .example file", file=sys.stderr)
        return 1
    block = example[start:end + len(BLOCK_END)] + "\n"
    if BLOCK_START in live:
        print("NOOP: Studio broadcast block already present in the live config", file=sys.stderr)
        sys.stdout.write(live)
        return 0
    if live.count(GENERIC_ANCHOR) != 1:
        print(f"FAIL: expected exactly 1 generic /api/organizations location in the live config, found {live.count(GENERIC_ANCHOR)}", file=sys.stderr)
        return 1
    sys.stdout.write(live.replace(GENERIC_ANCHOR, block + GENERIC_ANCHOR, 1))
    print("OK: Studio broadcast location block applied above the generic /api/organizations block.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
