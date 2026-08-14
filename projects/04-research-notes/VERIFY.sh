#!/usr/bin/env bash
# Verifies: the MCP search path was exercised and produced a sourced writeup.
set -uo pipefail
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }

check "KV_NOTES.md exists"        "test -f KV_NOTES.md"
check "has cache-type-k section"  "grep -qi 'cache-type-k' KV_NOTES.md"
check "has flash attention section" "grep -qi 'flash' KV_NOTES.md"
check "has a Sources section"     "grep -qi '^## *Sources' KV_NOTES.md"
check "cites at least one URL"    "grep -qE 'https?://' KV_NOTES.md"
check "is substantive (>400 chars)" "test \$(wc -c < KV_NOTES.md) -gt 400"
exit $fail
