#!/usr/bin/env python3
"""One-time, single-line patch for the render host's LIVE nginx config: extends the already-live
`/api/jam-participants/...` location block's alternation with `|/compensation` so the new
POST /api/jam-participants/:id/compensation route (jam participant pay amount) actually reaches the app.

That location block's own marker is already live in production (from the original Jam lifecycle sync),
so scripts/sync-nginx-jam-routes.py's own block-presence check would treat this as already-done and
no-op — same reason scripts/sync-nginx-peeps-agent-routes.py had to be a separate script rather than an
extension of that one. This is narrower still: a single alternation line, not a whole block, patched the
same old-line -> new-line way sync-nginx-jam-routes.py's own best-effort alternation logic works, just
run unconditionally since there is no block presence to gate on here.

Usage: cat <live nginx config> | python3 scripts/sync-nginx-jam-participant-compensation-route.py scripts/nginx-render.conf.example > merged.conf
Exits non-zero (content unwritten) only if the new alternation line can't be derived from the .example
file, or the OLD line isn't found in the live config exactly once (already patched, or the live config
has drifted further and needs a broader sync pass first).
"""
import sys

NEW_LINE_MARKER = "/mark-paid|/compensation)?$"


def main():
    if len(sys.argv) != 2:
        print("usage: sync-nginx-jam-participant-compensation-route.py <path to nginx-render.conf.example>", file=sys.stderr)
        return 2
    example = open(sys.argv[1], "r", encoding="utf-8").read()
    live = sys.stdin.read()

    idx = example.find(NEW_LINE_MARKER)
    if idx == -1:
        print("FAIL: could not find the updated jam-participants alternation line in the .example file", file=sys.stderr)
        return 1
    line_start = example.rfind("\n", 0, idx) + 1
    line_end = example.find("\n", idx)
    new_line = example[line_start:line_end]
    old_line = new_line.replace("|/compensation)?$", ")?$")
    if old_line == new_line:
        print("FAIL: could not derive the pre-compensation alternation line from the .example file", file=sys.stderr)
        return 1

    if new_line in live:
        print("NOOP: the live config already has the /compensation alternation", file=sys.stderr)
        sys.stdout.write(live)
        return 0

    occurrences = live.count(old_line)
    if occurrences != 1:
        print(f"FAIL: expected exactly 1 occurrence of the old jam-participants alternation line in the live config, found {occurrences}. The live config may have drifted further and needs a broader sync pass.", file=sys.stderr)
        return 1

    merged = live.replace(old_line, new_line, 1)
    sys.stdout.write(merged)
    print("OK: jam-participants /compensation alternation applied.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
