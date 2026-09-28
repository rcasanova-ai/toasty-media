#!/usr/bin/env python3
"""One-time, narrowly-scoped patch for the render host's LIVE nginx config: adds the Jam-lifecycle
location blocks and extends the session sub-resource alternation with "|jam", closing the gap where
scripts/nginx-render.conf.example was updated (PR #83) but neither deploy workflow ever touches live
nginx config (see docs/DEPLOYMENT.md's own warning about this exact failure mode).

Deliberately does NOT overwrite the live file wholesale -- that file has host-specific content (real cert
paths, server_name) this repo's own .example mirror does not carry. Instead this derives the two
substitutions PURELY from scripts/nginx-render.conf.example (never hardcoded here, so it can't drift from
what's actually in the repo) and applies them to whatever live content is piped in on stdin, failing
loudly instead of guessing if either anchor isn't found exactly once.

Usage: cat <live nginx config> | python3 scripts/sync-nginx-jam-routes.py scripts/nginx-render.conf.example > merged.conf
Exits non-zero (with the ORIGINAL content unwritten) if anything doesn't match exactly once, or if both
substitutions are already present (already applied -- idempotent no-op, reported on stderr, original
content echoed to stdout unchanged, exit 0).
"""
import sys

ALTERNATION_MARKER = "moxie/post-event-suggestions|artifacts|jam)$\" {"
JAM_BLOCK_START = "    # ---- Peeps Jam lifecycle (docs/ROADMAP.md Gate 2) ----"
JAM_BLOCK_END_ANCHOR = "    # Organizer-authenticated: disable/re-enable one campaign link (never a hard delete"


def main():
    if len(sys.argv) != 2:
        print("usage: sync-nginx-jam-routes.py <path to nginx-render.conf.example>", file=sys.stderr)
        return 2
    example = open(sys.argv[1], "r", encoding="utf-8").read()
    live = sys.stdin.read()

    # ---- Extract the two pieces of new content from the .example file itself ----
    alt_idx = example.find(ALTERNATION_MARKER)
    if alt_idx == -1:
        print("FAIL: could not find the session sub-resource alternation line in the .example file", file=sys.stderr)
        return 1
    line_start = example.rfind("\n", 0, alt_idx) + 1
    line_end = example.find("\n", alt_idx)
    new_alt_line = example[line_start:line_end]
    old_alt_line = new_alt_line.replace("|jam)$\" {", ")$\" {")
    if old_alt_line == new_alt_line:
        print("FAIL: could not derive the pre-Jam alternation line (no |jam)$ suffix found)", file=sys.stderr)
        return 1

    start_idx = example.find(JAM_BLOCK_START)
    end_idx = example.find(JAM_BLOCK_END_ANCHOR)
    if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
        print("FAIL: could not find the Jam lifecycle block markers in the .example file", file=sys.stderr)
        return 1
    jam_block = example[start_idx:end_idx]

    # ---- Idempotency: already applied? ----
    already_alt = new_alt_line in live
    already_block = JAM_BLOCK_START in live
    if already_alt and already_block:
        print("NOOP: both changes are already present in the live config", file=sys.stderr)
        sys.stdout.write(live)
        return 0
    if already_alt != already_block:
        print(f"FAIL: live config is in a half-applied state (alternation present={already_alt}, block present={already_block}) -- refusing to guess, needs a human", file=sys.stderr)
        return 1

    # ---- Validate anchors are unambiguous in the live file ----
    if live.count(old_alt_line) != 1:
        print(f"FAIL: expected exactly 1 occurrence of the pre-Jam alternation line in the live config, found {live.count(old_alt_line)}", file=sys.stderr)
        return 1
    if live.count(JAM_BLOCK_END_ANCHOR) != 1:
        print(f"FAIL: expected exactly 1 occurrence of the campaign-links anchor comment in the live config, found {live.count(JAM_BLOCK_END_ANCHOR)}", file=sys.stderr)
        return 1

    merged = live.replace(old_alt_line, new_alt_line, 1)
    merged = merged.replace(JAM_BLOCK_END_ANCHOR, jam_block + JAM_BLOCK_END_ANCHOR, 1)

    sys.stdout.write(merged)
    print("OK: both substitutions applied", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
