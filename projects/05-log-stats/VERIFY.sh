#!/usr/bin/env bash
# Verifies: script produces correct aggregates from the seeded data.
set -uo pipefail
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }

check "stats.py exists"      "test -f stats.py"
check "test_stats.py exists" "test -f test_stats.py"
check "pytest passes"        "python3 -m pytest -q"
check "stats.py runs"        "python3 stats.py"

out=$(python3 stats.py 2>/dev/null)
check "total is 6"           "echo \"\$out\" | grep -qE 'total: *6'"
check "info count is 3"      "echo \"\$out\" | grep -qiE 'info: *3'"
check "error count is 2"     "echo \"\$out\" | grep -qiE 'error: *2'"
check "warn count is 1"      "echo \"\$out\" | grep -qiE 'warn: *1'"
check "api avg is 200.0"     "echo \"\$out\" | grep -qE 'api: *200(\.0)?'"
check "db avg is 100.0"      "echo \"\$out\" | grep -qE 'db: *100(\.0)?'"
check "cache avg is 10.0"    "echo \"\$out\" | grep -qE 'cache: *10(\.0)?'"
exit $fail
