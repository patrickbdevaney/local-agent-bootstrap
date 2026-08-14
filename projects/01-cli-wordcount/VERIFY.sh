#!/usr/bin/env bash
# Verifies: files created, tests pass, CLI runs and produces correct top word.
set -uo pipefail
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }

check "wordcount.py exists"            "test -f wordcount.py"
check "test_wordcount.py exists"       "test -f test_wordcount.py"
check "count_words is defined"         "grep -q 'def count_words' wordcount.py"
check "argparse is used"               "grep -q 'argparse' wordcount.py"
check "pytest passes"                  "python3 -m pytest -q"
check "sample.txt NOT modified"         "diff -q sample.txt ../../01-cli-wordcount/seed/sample.txt"
check "CLI runs"                       "python3 wordcount.py sample.txt --top 3"

out=$(python3 wordcount.py sample.txt --top 3 2>/dev/null)
check "top word is 'the' with count 4" "echo \"\$out\" | head -1 | grep -qE '^the +4$'"
check "prints 3 lines"                 "test \$(echo \"\$out\" | grep -c .) -eq 3"
exit $fail
