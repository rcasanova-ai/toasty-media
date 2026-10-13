#!/usr/bin/env python3
"""One-time, narrowly-scoped patch for the render host's LIVE nginx config: adds the Studio recording
jobs location block (/api/recordings/jobs*) next to the existing /api/recordings/finalize block. Same shape as scripts/sync-nginx-peeps-agent-routes.py: block text is derived purely from
scripts/nginx-render.conf.example, never hardcoded here, and the live file is never overwritten wholesale.

Usage: cat <live nginx config> | python3 scripts/sync-nginx-studio-recording-jobs-route.py scripts/nginx-render.conf.example > merged.conf
"""
import sys

BLOCK_START = "    # ---- Studio recording jobs (WebM -> MP4) ----"
BLOCK_END = "    # ---- end Studio recording jobs ----\n"
GENERIC_ANCHOR = "    location = /api/recordings/finalize {"


def main():
    if len(sys.argv) != 2:
        print("usage: sync-nginx-studio-recording-jobs-route.py <path to nginx-render.conf.example>", file=sys.stderr)
        return 2
    example = open(sys.argv[1], "r", encoding="utf-8").read()
    live = sys.stdin.read()
    start = example.find(BLOCK_START)
    end = example.find(BLOCK_END)
    if start == -1 or end == -1 or end <= start:
        print("FAIL: Studio recording jobs block markers not found in the .example file", file=sys.stderr)
        return 1
    block = example[start:end + len(BLOCK_END)] + "\n"
    if BLOCK_START in live:
        # Already installed: bring it up to date with the .example (idempotent — identical text is a no-op).
        live_start = live.find(BLOCK_START)
        live_end = live.find(BLOCK_END, live_start)
        if live_end == -1:
            print("FAIL: the live Studio recording jobs block has no end marker", file=sys.stderr)
            return 1
        current = live[live_start:live_end + len(BLOCK_END)] + "\n"
        if current == block:
            print("NOOP: Studio recording jobs block already up to date in the live config", file=sys.stderr)
            sys.stdout.write(live)
            return 0
        sys.stdout.write(live[:live_start] + block + live[live_end + len(BLOCK_END) + 1:])
        print("OK: Studio recording jobs block updated in place.", file=sys.stderr)
        return 0

    if live.count(GENERIC_ANCHOR) != 1:
        print(f"FAIL: expected exactly 1 /api/recordings/finalize location in the live config, found {live.count(GENERIC_ANCHOR)}", file=sys.stderr)
        return 1
    sys.stdout.write(live.replace(GENERIC_ANCHOR, block + GENERIC_ANCHOR, 1))
    print("OK: Studio recording jobs location block applied.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
