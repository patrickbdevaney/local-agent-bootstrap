#!/usr/bin/env bash
# Verifies: shared module created, duplication actually removed, behaviour preserved.
set -uo pipefail
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }

check "formatting.py exists"                "test -f formatting.py"
check "format_currency lives in formatting" "grep -q 'def format_currency' formatting.py"
check "report_a no longer defines it"       "! grep -q 'def format_currency' report_a.py"
check "report_b no longer defines it"       "! grep -q 'def format_currency' report_b.py"
check "report_a imports from formatting"    "grep -q 'formatting' report_a.py"
check "report_b imports from formatting"    "grep -q 'formatting' report_b.py"
check "tests were NOT modified"             "diff -q test_reports.py ../../03-refactor-shared-module/seed/test_reports.py"
check "pytest passes"                       "python3 -m pytest -q"
exit $fail
