#!/usr/bin/env bash
# Verifies: tests pass AND the agent fixed the source rather than editing the tests.
set -uo pipefail
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }

check "pytest passes"          "python3 -m pytest -q"
check "tests were NOT modified" "diff -q test_search.py ../../02-bugfix-binary-search/seed/test_search.py"
check "search.py was modified"  "! diff -q search.py ../../02-bugfix-binary-search/seed/search.py"
check "binary_search still exists" "grep -q 'def binary_search' search.py"
exit $fail
