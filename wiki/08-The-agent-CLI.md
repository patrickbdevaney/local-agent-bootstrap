# 08 — The `agent` CLI

A single bash script (`bin/agent`) with all configuration in `agent.env`. Installed by symlink:

```bash
ln -sf "$PWD/bin/agent" ~/.local/bin/agent
```

---

## Commands

```
agent up               start llama-server, verify shared services, print status (idempotent)
agent down             stop llama-server only; leaves searxng/crawl4ai running
agent status           endpoints, model, VRAM, RAM, search mode
agent code [path]      launch OpenCode against the local endpoint
agent logs [-f|N]      tail the llama-server log
agent bench [--save]   measure decode tok/s; --save records the clean baseline
agent test             health + tool battery across every component
agent help
```

---

## `agent up`

```
$ agent up
  free VRAM before load: 7806 MiB
  starting: llama-server --model Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf -c 131072 --spec-type draft-mtp
  ok  llama-server up (pid 4114813) after 8s
  ok  searxng reachable at http://127.0.0.1:8080 (pre-existing container, not managed here)
  ok  crawl4ai reachable at http://127.0.0.1:11235 (pre-existing container, not managed here)

agent status
  ok  llama-server  http://127.0.0.1:8090  (pid 4114813)
    model:   qwen3.5-4b
    context: 131072   kv: q8_0   spec: draft-mtp
    VRAM: 7031 / 8188 MiB
    RAM:  7.2Gi used, 23Gi available
    baseline: 78.60 tok/s   search mode: normal
```

Design points:

- **`nohup` + PID file** rather than a systemd unit — the repo has no systemd conventions, and a PID file is trivial to reason about and inspect.
- **Idempotent.** A second `agent up` reports `already live ... (idempotent no-op)` and does nothing.
- **Stale PID files are cleaned** — if the recorded pid isn't alive, the file is removed and startup proceeds.
- **Startup failure surfaces the log**, not a bare exit code:
  ```bash
  if ! llama_pid >/dev/null; then
    bad "llama-server died during startup - last lines of $LLAMA_LOG:"
    tail -15 "$LLAMA_LOG" | sed 's/^/      /'
  fi
  ```
- **Polls `/health` for up to 180 s** while checking the process is still alive, so a crash is reported immediately rather than after the full timeout.

---

## `agent down` — and what it refuses to do

```
$ agent down
  ok  llama-server stopped (was pid 4096109)
  VRAM: 7053 MiB -> 11 MiB (freed 7042 MiB)
  leaving shared containers running by design: searxng, crawl4ai
```

**It stops llama-server and nothing else.** On the validation box both containers predate this project and are shared with other work; stopping them would break something the user did not ask to touch. The inventory phase established that, and the script encodes it.

If you own those containers exclusively, that policy is one block in `bin/agent`.

Shutdown sequence:

1. SIGTERM the recorded pid
2. Poll up to 30 s for exit
3. SIGKILL only if it hasn't exited, with a warning
4. Report VRAM before → after

**The fallback match is deliberately narrow:**

```bash
pkill -f "llama-server.*--port $LLAMA_PORT"
```

Scoped to *our* port. Never a blanket `pkill llama-server` — another project could be running its own server on another port, and a blunt kill would take it down.

Verified: VRAM returns to **11 MiB**, the exact idle baseline recorded before anything was installed. No leak, no orphan.

---

## `agent bench`

```
$ agent bench --save
  ok  decode:  78.60 tok/s   (160 tokens generated)
  ok  prefill: 61.00 tok/s
  ok  saved as clean baseline -> run/baseline_tps
```

Without `--save`, it compares against the stored baseline:

```
  ok  decode:  55.20 tok/s   (160 tokens generated)
    70% of baseline (78.60 tok/s), threshold 70%
    -> search mode: shallow
```

> **The prefill number here is noise.** The bench prompt is ~24 tokens, so prefill throughput is dominated by fixed overhead. The meaningful prefill figure came from a 31,492-token prompt: **1,795 tok/s**. Don't quote `agent bench`'s prefill as a real number.

**Baselines are per-box.** `run/baseline_tps` must never be copied between machines — the whole point is measuring *this* hardware's clean speed so degradation is detectable.

---

## `agent test`

```
$ agent test
  ok  llama-server /health
  ok  /v1/models -> qwen3.5-4b
  ok  completion -> "READY"
  ok  searxng JSON search
  ok  crawl4ai /health
  ok  mcp search-server tools/list -> web_search,web_fetch

  ok  all checks passed
```

The MCP check had a bug worth recording. The original:

```bash
mcp_out=$(... | grep -c '"tools"')
[ "$mcp_out" = "1" ] && ok ... || bad ...
```

This **always failed** — the `initialize` response also contains `"tools"` inside `capabilities`, so the count was 2, not 1. A passing component reported as broken. Fixed by matching the `tools/list` reply by id and comparing actual tool names:

```bash
| python3 -c '
import json,sys
for line in sys.stdin:
    d=json.loads(line)
    if d.get("id")==2: print(",".join(t["name"] for t in d["result"]["tools"]))'
```

**Grepping for a substring across a JSON-RPC stream is fragile.** Parse and match on structure.

---

## `agent code`

```bash
cmd_code() {
  llama_healthy || { bad "llama-server is not up - run 'agent up' first"; return 1; }
  command -v opencode >/dev/null || { bad "opencode is not installed"; return 1; }
  AGENT_SEARCH_MODE=$(effective_mode)
  export AGENT_SEARCH_MODE
  exec opencode "$@"
}
```

Guards first, then re-measures decode speed to pick `normal` vs `shallow` search, exports it for the MCP subprocess, and `exec`s so OpenCode replaces the shell (signals and the TUI behave correctly).

---

## Configuration

Everything lives in `agent.env`, sourced by the script, with every value overridable from the environment:

```bash
LLAMA_PORT="${LLAMA_PORT:-8090}"
LLAMA_CTX="${LLAMA_CTX:-131072}"
LLAMA_SPEC_TYPE="${LLAMA_SPEC_TYPE:-draft-mtp}"
LLAMA_REASONING="${LLAMA_REASONING:-off}"
LLAMA_EXTRA_ARGS="${LLAMA_EXTRA_ARGS:-}"
```

Which makes experiments one-liners that never touch a file:

```bash
LLAMA_SPEC_TYPE=none agent up          # measure without MTP
LLAMA_EXTRA_ARGS="-lv 5" agent up      # debug the GDN/memory breakdown
LLAMA_CTX=65536 agent up               # halve the KV budget
```

That pattern is how the MTP on/off comparison in [05](05-Server-Configuration.md#mtp-measured) was produced without editing anything.

---

## Verified behaviors

| Check | Result |
|---|---|
| Cold start from a scrubbed environment (`env -i`) | works |
| `agent up` when already up | idempotent no-op |
| `agent code` with server down | refuses with a clear message |
| `agent down` | VRAM → 11 MiB, exact idle baseline |
| `agent down` | shared containers untouched |
| `agent test` | 6/6 |

---

**Next:** [09 — Validation Results](09-Validation-Results.md)
