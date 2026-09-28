#!/usr/bin/env python3
"""One-time, narrowly-scoped patch for the render host's LIVE nginx config: adds the Jam-lifecycle
location blocks (docs/ROADMAP.md Gate 2, PR #83) and, best-effort, extends the session sub-resource
alternation with "|jam" so /api/sessions/:id/jam also works.

Deliberately does NOT overwrite the live file wholesale -- that file has host-specific content (real cert
paths, server_name) this repo's own .example mirror does not carry. Both pieces of new content are derived
PURELY from scripts/nginx-render.conf.example (never hardcoded here, so this can't drift from what's
actually in the repo).

Discovered live (see the first real run, 2026-09-28): the live config has fallen behind the .example
mirror by more than just the Jam routes -- it predates several earlier Event Growth Layer routes too, so
the session sub-resource alternation line this script would otherwise patch doesn't exist in a recognizable
form. Rather than fail the whole run over a route nobody's using yet, the Jam location-block insertion
(the actual point of this script) is REQUIRED and anchored on the catch-all `location / { return 404; }`
block -- a structural fixture of every version of this file, unlike any one feature's own routes -- while
the alternation-line patch for /api/sessions/:id/jam is best-effort: applied if found, skipped with a
clear warning (not a failure) if not.

Usage: cat <live nginx config> | python3 scripts/sync-nginx-jam-routes.py scripts/nginx-render.conf.example > merged.conf
Exits non-zero (with the ORIGINAL content unwritten) only if the REQUIRED catch-all anchor isn't found
exactly once, the Jam block is already present (idempotent no-op, exit 0), or the catch-all is ambiguous.
"""
import sys

ALTERNATION_MARKER = "moxie/post-event-suggestions|artifacts|jam)$\" {"
JAM_BLOCK_START = "    # ---- Peeps Jam lifecycle (docs/ROADMAP.md Gate 2) ----"
JAM_BLOCK_END_ANCHOR = "    # Organizer-authenticated: disable/re-enable one campaign link (never a hard delete"
CATCH_ALL_ANCHOR = "    location / {\n        return 404;\n    }\n"


def main():
    if len(sys.argv) != 2:
        print("usage: sync-nginx-jam-routes.py <path to nginx-render.conf.example>", file=sys.stderr)
        return 2
    example = open(sys.argv[1], "r", encoding="utf-8").read()
    live = sys.stdin.read()

    # ---- Required: the Jam location blocks themselves ----
    start_idx = example.find(JAM_BLOCK_START)
    end_idx = example.find(JAM_BLOCK_END_ANCHOR)
    if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
        print("FAIL: could not find the Jam lifecycle block markers in the .example file", file=sys.stderr)
        return 1
    jam_block = example[start_idx:end_idx]

    if JAM_BLOCK_START in live:
        print("NOOP: the Jam lifecycle block is already present in the live config", file=sys.stderr)
        sys.stdout.write(live)
        return 0

    if live.count(CATCH_ALL_ANCHOR) != 1:
        print(f"FAIL: expected exactly 1 occurrence of the catch-all 'location / {{ return 404; }}' block in the live config, found {live.count(CATCH_ALL_ANCHOR)}. Dumping every 'location' line for diagnosis:", file=sys.stderr)
        for line in live.splitlines():
            if "location" in line:
                print(f"  {line}", file=sys.stderr)
        return 1

    merged = live.replace(CATCH_ALL_ANCHOR, jam_block + "\n" + CATCH_ALL_ANCHOR, 1)

    # ---- Best-effort: extend the session sub-resource alternation with |jam ----
    alt_idx = example.find(ALTERNATION_MARKER)
    if alt_idx == -1:
        print("WARN: could not find the session sub-resource alternation line in the .example file -- skipping the /api/sessions/:id/jam extension (Jam block insertion above still applies).", file=sys.stderr)
    else:
        line_start = example.rfind("\n", 0, alt_idx) + 1
        line_end = example.find("\n", alt_idx)
        new_alt_line = example[line_start:line_end]
        old_alt_line = new_alt_line.replace("|jam)$\" {", ")$\" {")
        occurrences = merged.count(old_alt_line)
        if old_alt_line == new_alt_line:
            print("WARN: could not derive the pre-Jam alternation line -- skipping.", file=sys.stderr)
        elif new_alt_line in merged:
            print("INFO: the session sub-resource alternation already includes |jam.", file=sys.stderr)
        elif occurrences == 1:
            merged = merged.replace(old_alt_line, new_alt_line, 1)
            print("OK: extended the session sub-resource alternation with |jam.", file=sys.stderr)
        else:
            print(f"WARN: the live config's session sub-resource alternation line doesn't match the .example file (found {occurrences} exact matches, expected 1) -- it has likely fallen behind by more than just the Jam routes. Skipping /api/sessions/:id/jam for now; the core Jam block insertion above still applies. This needs a separate, broader nginx sync pass to catch up the live config to current main.", file=sys.stderr)

    sys.stdout.write(merged)
    print("OK: Jam location blocks applied.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
