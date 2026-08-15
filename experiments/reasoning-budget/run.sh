#!/usr/bin/env bash
# Does prompt specificity + a larger token budget rescue the reasoning runaway?
#
# The documented failure: with thinking enabled, a trivial coding task generated
# 12,936 tokens in one completion and emitted zero tool calls. It was fixed with
# `--reasoning off`. This asks whether the prompt and the output cap were the real
# problem instead, by holding the task fixed and varying only those.
#
#   A  thinking ON   loose prompt      output cap  8192   (reproduce the failure)
#   B  thinking ON   specific prompt   output cap 32768   (the retry)
#   C  thinking OFF  specific prompt   output cap  8192   (control)
#
# Thinking-on behavior is high variance, so each cell is repeated. Override the
# counts with REPEAT_A / REPEAT_B / REPEAT_C.
#
# Token counts come from the llama-server log, summed over each run's window.
# Requires `agent` on PATH. Restores the server to the repo default when done.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$HERE/work"
RESULTS="$HERE/results"
SRVLOG="$ROOT/logs/llama-server.log"
MODEL="local/qwen3.5-4b"

REPEAT_A="${REPEAT_A:-3}"
REPEAT_B="${REPEAT_B:-2}"
REPEAT_C="${REPEAT_C:-3}"

mkdir -p "$WORK" "$RESULTS"
export PATH="$HOME/.local/bin:$PATH"

# Decode tokens generated since a given log line offset (excludes prompt-eval lines).
tokens_since() {
  tail -n +"$1" "$SRVLOG" 2>/dev/null \
    | grep -E "\|[[:space:]]+eval time" | grep -v "prompt eval" \
    | grep -oE "/ *[0-9]+ tokens" | grep -oE "[0-9]+"
}

# Writes a workspace-local opencode.json so the global config is never touched.
write_local_config() {
  local dir="$1" reasoning="$2" out_limit="$3" interleaved=""
  [ "$reasoning" = "true" ] && interleaved='"interleaved": "reasoning_content",'
  cat > "$dir/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local llama.cpp",
      "options": {
        "baseURL": "http://127.0.0.1:8090/v1",
        "apiKey": "local-no-auth",
        "timeout": 1800000,
        "headerTimeout": 180000
      },
      "models": {
        "qwen3.5-4b": {
          "name": "Qwen3.5-4B",
          "tool_call": true,
          "reasoning": $reasoning,
          $interleaved
          "temperature": true,
          "limit": { "context": 131072, "output": $out_limit },
          "cost": { "input": 0, "output": 0 }
        }
      }
    }
  },
  "model": "local/qwen3.5-4b",
  "small_model": "local/qwen3.5-4b"
}
JSON
}

run_variant() {
  local name="$1" prompt_file="$2" reasoning="$3" out_limit="$4" timeout_s="$5"
  local dir="$WORK/$name"

  rm -rf "$dir"; mkdir -p "$dir"
  cp -r "$HERE/seed/." "$dir/"
  write_local_config "$dir" "$reasoning" "$out_limit"
  ( cd "$dir" && git init -q && git add -A \
    && git -c user.email=a@b -c user.name=a commit -qm seed ) >/dev/null 2>&1 || true

  local log_start; log_start=$(( $(wc -l < "$SRVLOG" 2>/dev/null || echo 0) + 1 ))
  local start; start=$(date +%s)

  ( cd "$dir" && timeout "$timeout_s" opencode run --model "$MODEL" \
      "$(cat "$prompt_file")" ) > "$RESULTS/$name.transcript.txt" 2>&1
  local rc=$?
  local elapsed=$(( $(date +%s) - start ))

  local total_tok max_tok n_compl
  total_tok=$(tokens_since "$log_start" | awk '{s+=$1} END {print s+0}')
  max_tok=$(tokens_since "$log_start" | sort -n | tail -1); max_tok=${max_tok:-0}
  n_compl=$(tokens_since "$log_start" | grep -c .); n_compl=${n_compl:-0}

  ( cd "$dir" && bash "$HERE/VERIFY.sh" ) > "$RESULTS/$name.verify.txt" 2>&1
  local vrc=$?
  local passes fails
  passes=$(grep -c '^  PASS' "$RESULTS/$name.verify.txt"); passes=${passes:-0}
  fails=$(grep -c '^  FAIL' "$RESULTS/$name.verify.txt"); fails=${fails:-0}

  {
    echo "variant=$name"
    echo "reasoning=$reasoning"
    echo "output_limit=$out_limit"
    echo "elapsed_seconds=$elapsed"
    echo "agent_exit=$rc"
    echo "completions=$n_compl"
    echo "decode_tokens_total=$total_tok"
    echo "largest_single_completion=$max_tok"
    echo "checks_passed=$passes"
    echo "checks_failed=$fails"
    echo "verify_exit=$vrc"
  } > "$RESULTS/$name.meta.txt"

  printf '%-26s %-9s %7s %7ss %9s %9s  %s %s/%s\n' \
    "$name" "$reasoning" "$out_limit" "$elapsed" "$total_tok" "$max_tok" \
    "$([ "$vrc" = 0 ] && echo PASS || echo FAIL)" "$passes" "$((passes+fails))"
}

printf '%-26s %-9s %7s %8s %9s %9s  %s\n' \
  "RUN" "THINKING" "OUTCAP" "TIME" "TOKENS" "MAXCOMPL" "RESULT"
printf '%s\n' "---------------------------------------------------------------------------------------"

# --- thinking ON ---
agent down >/dev/null 2>&1
LLAMA_REASONING=on agent up >/dev/null 2>&1 || { echo "failed to start server with reasoning on"; exit 1; }

for i in $(seq 1 "$REPEAT_A"); do
  run_variant "A-thinking-loose-$i" "$HERE/PROMPT-loose.md" true 8192 600
done
for i in $(seq 1 "$REPEAT_B"); do
  run_variant "B-thinking-specific-$i" "$HERE/PROMPT-specific.md" true 32768 1200
done

# --- thinking OFF (control) ---
agent down >/dev/null 2>&1
agent up >/dev/null 2>&1 || { echo "failed to restart server"; exit 1; }

for i in $(seq 1 "$REPEAT_C"); do
  run_variant "C-nothinking-specific-$i" "$HERE/PROMPT-specific.md" false 8192 600
done

echo
python3 "$HERE/summarize.py" "$RESULTS"

echo
echo "server restored to repo default (reasoning off)"
echo "transcripts + verify output: $RESULTS/"
