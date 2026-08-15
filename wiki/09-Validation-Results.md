# 09 — Validation Results

All figures measured 2026-08-14 on the box described in the [wiki index](README.md). Nothing here is estimated.

---

## Summary

| Test | Result |
|---|---|
| GDN fused kernels | autoregressive **and** chunked enabled |
| VRAM @ 131,072 ctx | 7,031–7,053 / 8,188 MiB |
| Predicted vs observed VRAM | within **~20 MiB** |
| Decode (short ctx) | **78.6 tok/s** |
| Decode (31k ctx) | 67.5 tok/s |
| Prefill (31,492 tokens) | **1,795 tok/s** |
| MTP speedup | **1.45×** (80 vs 55.5) |
| Draft acceptance | 0.711, mean length 3.12 |
| Tool-call battery | **10/10** |
| End-to-end coding task | green, exit 0 |
| Failure paths | 3/3 degrade silently |
| Cold start | ~8 s |
| Shutdown | VRAM → 11 MiB idle |

---

## 1. Architecture verification

```
resolve_fused_ops: resolving fused Gated Delta Net support:
resolve_fused_ops: fused Gated Delta Net (autoregressive) enabled
resolve_fused_ops: fused Gated Delta Net (chunked) enabled
```

```
print_info: arch         = qwen35
print_info: n_layer      = 32
print_info: n_head_kv    = 4
print_info: n_embd_k_gqa = 1024
print_info: n_embd_v_gqa = 1024
print_info: n_ctx_train  = 262144
print_info: model params = 4.21 B
```

The hybrid is being served on its fused path, not a generic fallback.

---

## 2. Memory

Predicted from [04](04-VRAM-and-KV-Sizing.md), then measured:

| Component | MiB |
|---|---|
| Weights (CUDA0) | 3,141.27 |
| Weights (CPU_Mapped) | 497.31 *(host)* |
| GDN recurrent state | 201.00 |
| Compute buffer | 690.28 |
| MTP draft context | 682.02 |
| KV (131,072 × 17 KiB) | ~2,176 |
| CUDA context | ~140 |
| **Predicted** | **~7,031** |
| **Observed** | **7,031–7,053** |

Recurrent state is **flat in context length**: 50.25 MiB without MTP, 201 MiB with it (3 `rs_seq`), identical at 4,096 and 131,072 tokens.

---

## 3. Throughput

### MTP on vs off

Three runs each, identical 160-token prompt:

| Config | Run 1 | Run 2 | Run 3 | VRAM |
|---|---|---|---|---|
| `draft-mtp` | 79.99 | 81.30 | 78.95 | 7,043 MiB |
| `none` | 55.16 | 55.33 | 56.19 | 6,119 MiB |

**1.45× for +924 MiB.**

```
draft acceptance = 0.71053 (108 accepted / 152 generated), mean len = 3.12
#acc rate/pos = (0.902, 0.725, 0.490)
```

### Long context

31,492-token prompt:

```
prefill:  1795.0 tok/s
decode:     67.5 tok/s
peak VRAM:  7051 MiB   (steady state 7031 — ~20 MiB movement)
```

Sustained generation observed during an agent task held **81–83 tok/s over 12,000+ tokens**, so throughput does not degrade with generation length.

Saved baseline: **78.60 tok/s** (`run/baseline_tps`).

---

## 4. Tool-call battery — 10/10

`bin/toolcall-battery.py` fires 10 prompts across 3 tool schemas and checks: exactly one tool call, correct tool selected, arguments parse as JSON, required fields present, no runaway generation.

```
 1. ok  27 tok  get_weather({"city":"Tokyo"})
 2. ok  41 tok  get_weather({"city":"Reykjavik","unit":"f"})
 3. ok  27 tok  read_file({"path":"/etc/hostname"})
 4. ok  27 tok  read_file({"path":"src/main.rs"})
 5. ok  45 tok  run_sql({"query":"SELECT * FROM users WHERE signup_date >= '2023-01-...})
 6. ok  30 tok  run_sql({"query":"SELECT COUNT(*) FROM orders"})
 7. ok  27 tok  get_weather({"city":"Sao Paulo"})
 8. ok  26 tok  read_file({"path":"package.json"})
 9. ok  37 tok  run_sql({"query":"SELECT * FROM events ORDER BY id DESC LIMIT 10"})
10. ok  39 tok  get_weather({"city":"Oslo","unit":"c"})

tool-call battery: 10/10 passed
```

**Zero malformed, zero looping.** 26–45 tokens per call — no preamble, no commentary, correct optional-argument handling (`unit` supplied only when the prompt implied it).

> These numbers are with `--reasoning off`. With thinking on the model still emits valid tool calls, but spends 16–83× the tokens reaching the same result — see [`experiments/reasoning-budget`](../experiments/reasoning-budget/README.md).

---

## 5. End-to-end coding task

Scratch git repo with `mathutil.py` (one function) and a passing test.

**Prompt:** *"Add a function multiply(a, b) to mathutil.py that returns a\*b, and add a test for it in test_mathutil.py. Then run 'python3 -m pytest -q' to verify it passes."*

```
Edit mathutil.py
+ def multiply(a, b):
+     return a * b

Edit test_mathutil.py
- from mathutil import add
+ from mathutil import add, multiply

Edit test_mathutil.py
+ def test_multiply():
+     assert multiply(2, 3) == 6

$ python3 -m pytest -q
..                                                        [100%]
2 passed in 0.31s

Done. Added `multiply(a, b)` to `mathutil.py` and a test for it in `test_mathutil.py`.
Both tests pass.
```

Exit code 0. Read, multi-file edit, import fix, shell execution, and self-verification — all correct.

Broader project runs are in [`docs/AGENT_RUNS.md`](../docs/AGENT_RUNS.md).

---

## 6. MCP search through the harness

The model selected the tool itself:

```
⚙ local-search_web_search {"query":"llama.cpp --cache-type-k flag","count":3,"summarize":true}

The --cache-type-k flag in llama.cpp controls the precision of the KV cache for key
tensors, with Q8_0 reducing cache memory by half with near-zero quality loss.
```

Correct answer, one clean call, no retries.

---

## 7. Failure paths

The requirement was that remote-dependency failure is **never surfaced to the user**. All three modes tested:

| Path | Method | Result |
|---|---|---|
| Credentials valid | Normal operation | Summary with `[1]`/`[2]` citations |
| All credentials invalid | Overridden in environment | Silent fallback, `isError: false`, **13,933 chars** returned |
| No credentials | Temp root with empty `.env` | Summarization skipped, **identical 13,933-char** result |

**`.env` was never edited.** Verified byte-identical before and after:

```
md5  4c95ded576d2f8b44dd625cb5120ba7f
size 1341 bytes
mtime 2026-08-14 18:04:06.978316306 -0400
```

Failures were induced via environment overrides and a throwaway directory — the correct way to test a credential path you must not disturb.

---

## 8. Lifecycle

| Check | Result |
|---|---|
| Cold start (`env -i` scrubbed shell) | live in ~8 s |
| `agent up` when already up | idempotent no-op |
| `agent code` with server down | clean refusal |
| `agent down` | `7053 MiB -> 11 MiB (freed 7042 MiB)` |
| Idle baseline match | **11 MiB — exactly Phase 0** |
| Orphaned processes | none |
| Shared containers after `agent down` | still running, untouched |

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

---

## What this does and doesn't prove

**Proven:** the pattern works end to end on constrained hardware. Hybrid GGUF serving with fused GDN, MTP speculative decoding, reliable tool calling, MCP-mediated local search, silent degradation of every remote dependency, and clean lifecycle management.

**Not proven:** that a 4B model is a *good* coding agent. It handles small, well-specified tasks correctly. It was not evaluated on large refactors, ambiguous requirements, or long autonomous sessions — that is what the 27B target is for. This run validates the **plumbing**, and the plumbing is what the next install inherits.

---

**Next:** [10 — Gotchas and Deviations](10-Gotchas-and-Deviations.md)
