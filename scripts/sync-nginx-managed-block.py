#!/usr/bin/env python3
"""Idempotent sync of marked, repo-managed nginx blocks into the render host's LIVE config.

The repo's scripts/nginx-render.conf.example carries blocks wrapped in

    # BEGIN toasty-managed:<name>
    ...
    # END toasty-managed:<name>

For each such block this script makes the live config match the repo: if the live file already has the same
markers the content between them is replaced, otherwise the block is inserted just before the catch-all
`location / { return 404; }`. Everything outside the markers (cert paths, server_name, other routes) is left
alone. It fails closed: a missing or ambiguous anchor, unbalanced markers or a duplicated block exits non-zero
and writes nothing. Running it twice produces identical output.

Usage: python3 scripts/sync-nginx-managed-block.py scripts/nginx-render.conf.example < live.conf > merged.conf
"""
import re
import sys

CATCH_ALL = "    location / {\n        return 404;\n    }\n"
BLOCK_RE = re.compile(r"^[ \t]*# BEGIN toasty-managed:([a-z0-9-]+)\n.*?^[ \t]*# END toasty-managed:\1\n", re.S | re.M)


def blocks(text, label):
    found = {}
    for m in BLOCK_RE.finditer(text):
        if m.group(1) in found:
            raise SystemExit(f"FAIL: duplicate managed block '{m.group(1)}' in {label}")
        found[m.group(1)] = m
    begins = len(re.findall(r"# BEGIN toasty-managed:", text))
    ends = len(re.findall(r"# END toasty-managed:", text))
    if begins != ends or begins != len(found):
        raise SystemExit(f"FAIL: unbalanced toasty-managed markers in {label}")
    return found


def main():
    if len(sys.argv) != 2:
        print("usage: sync-nginx-managed-block.py <nginx-render.conf.example>", file=sys.stderr)
        return 2
    example = open(sys.argv[1], encoding="utf-8").read()
    live = sys.stdin.read()
    wanted = blocks(example, "the .example file")
    if not wanted:
        print("FAIL: no managed blocks in the .example file", file=sys.stderr)
        return 1
    have = blocks(live, "the live config")
    merged = live
    for name, m in wanted.items():
        text = m.group(0)
        if name in have:
            if have[name].group(0) == text:
                print(f"NOOP: {name} already current", file=sys.stderr)
                continue
            merged = merged.replace(have[name].group(0), text, 1)
            have = blocks(merged, "merged config")
            print(f"OK: updated {name}", file=sys.stderr)
        else:
            if merged.count(CATCH_ALL) != 1:
                print(f"FAIL: expected exactly 1 catch-all location block, found {merged.count(CATCH_ALL)}", file=sys.stderr)
                return 1
            merged = merged.replace(CATCH_ALL, text + "\n" + CATCH_ALL, 1)
            have = blocks(merged, "merged config")
            print(f"OK: inserted {name}", file=sys.stderr)
    sys.stdout.write(merged)
    return 0


if __name__ == "__main__":
    sys.exit(main())
