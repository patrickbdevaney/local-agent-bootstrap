#!/usr/bin/env bash
# Same verification for every variant: did the task actually get done?
set -uo pipefail
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }

check "multiply defined in mathutil.py" "grep -q 'def multiply' mathutil.py"
check "add still defined"               "grep -q 'def add' mathutil.py"
check "test_multiply exists"            "grep -q 'def test_multiply' test_mathutil.py"
check "multiply imported in test"       "grep -q 'import.*multiply' test_mathutil.py"
check "pytest reports 2 passed"         "python3 -m pytest -q 2>&1 | grep -q '2 passed'"
exit $fail
