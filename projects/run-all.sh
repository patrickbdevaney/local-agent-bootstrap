#!/usr/bin/env bash
# Runs every project in this directory through the local agent and verifies the result.
#
# For each project:
#   1. reset work/<name>/ from <name>/seed/
#   2. git init (so OpenCode can snapshot and diff)
#   3. run `opencode run` with <name>/PROMPT.md as the instruction
#   4. run <name>/VERIFY.sh inside the work dir
#   5. record wall time, exit codes, and per-check results
#
# Usage: ./run-all.sh [project-dir ...]     (default: all)

set -uo pipefail

PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$PROJ_DIR/.." && pwd)"
WORK="$PROJ_DIR/work"
RESULTS="$PROJ_DIR/results"
MODEL="${AGENT_MODEL:-local/qwen3.5-4b}"
TIMEOUT="${AGENT_TIMEOUT:-900}"

mkdir -p "$WORK" "$RESULTS"

if [ "$#" -gt 0 ]; then
  PROJECTS=("$@")
else
  mapfile -t PROJECTS < <(cd "$PROJ_DIR" && ls -d [0-9]*/ | tr -d /)
fi

command -v opencode >/dev/null || { echo "opencode not found on PATH"; exit 1; }
curl -sf -m 5 "http://127.0.0.1:${LLAMA_PORT:-8090}/health" >/dev/null || {
  echo "llama-server is not up - run 'agent up' first"; exit 1; }

printf '%-28s %8s %8s %8s\n' "PROJECT" "TIME" "AGENT" "VERIFY"
printf '%s\n' "--------------------------------------------------------"

overall=0
for p in "${PROJECTS[@]}"; do
  src="$PROJ_DIR/$p"
  [ -f "$src/PROMPT.md" ] || { echo "skip $p (no PROMPT.md)"; continue; }

  # 1-2. reset work dir from seed
  rm -rf "${WORK:?}/$p"
  mkdir -p "$WORK/$p"
  if [ -d "$src/seed" ] && [ -n "$(ls -A "$src/seed" 2>/dev/null)" ]; then
    cp -r "$src/seed/." "$WORK/$p/"
  fi
  # A project with an empty seed has nothing to commit; that is fine, keep it quiet.
  ( cd "$WORK/$p" && git init -q && git add -A \
    && git -c user.email=agent@local -c user.name=agent commit -qm seed ) >/dev/null 2>&1 || true

  # 3. run the agent
  start=$(date +%s)
  ( cd "$WORK/$p" && timeout "$TIMEOUT" opencode run --model "$MODEL" \
      "$(cat "$src/PROMPT.md")" ) > "$RESULTS/$p.transcript.txt" 2>&1
  agent_rc=$?
  end=$(date +%s)
  elapsed=$((end - start))

  # 4. verify
  ( cd "$WORK/$p" && bash "$src/VERIFY.sh" ) > "$RESULTS/$p.verify.txt" 2>&1
  verify_rc=$?

  # 5. record
  # NOTE: `grep -c` prints 0 *and* exits 1 on no match, so `|| echo 0` would emit "0\n0".
  passes=$(grep -c '^  PASS' "$RESULTS/$p.verify.txt" 2>/dev/null); passes=${passes:-0}
  fails=$(grep -c '^  FAIL' "$RESULTS/$p.verify.txt" 2>/dev/null); fails=${fails:-0}
  status=$([ "$verify_rc" = "0" ] && echo "PASS" || echo "FAIL")
  [ "$verify_rc" = "0" ] || overall=1

  {
    echo "project=$p"
    echo "elapsed_seconds=$elapsed"
    echo "agent_exit=$agent_rc"
    echo "verify_exit=$verify_rc"
    echo "checks_passed=$passes"
    echo "checks_failed=$fails"
  } > "$RESULTS/$p.meta.txt"

  printf '%-28s %7ss %8s %5s %s/%s\n' "$p" "$elapsed" \
    "$([ "$agent_rc" = "0" ] && echo ok || echo "rc=$agent_rc")" \
    "$status" "$passes" "$((passes + fails))"
done

echo
[ "$overall" = "0" ] && echo "all projects verified" || echo "one or more projects failed verification"
echo "transcripts + verify output: $RESULTS/"
exit $overall
