# 10 — Gotchas and Deviations

Every place reality contradicted the plan. **If you read one page before the 27B install, read this one.**

---

## 1. The reasoning runaway {#1-the-reasoning-runaway}

**Severity: blocking. Cost the most time.**

Qwen3.5-4B is a reasoning model. With thinking enabled inside an agent harness, it does not stop.

A trivial OpenCode task — add a two-line function and a test:

```
slot print_timing: n_gen = 12936, tg = 82.34 t/s
```

**12,936 tokens in a single completion. Zero tool calls. Zero file edits.** It never escaped its own reasoning loop. Throughput was fine (82 tok/s); the model simply never emitted an action.

Even a one-line instruction consumed its budget thinking:

```json
{"message": {"content": "",
  "reasoning_content": "\nThinking Process:\n\n1. **Analyze the Request:** The user wants me to reply with exactly the string \""}}
```

**Fix — one flag:**

```bash
llama-server ... --reasoning off
```

```json
{"message": {"content": "PIPELINE OK"}}    // 4 tokens
```

Same task rerun: 3 correct edits, `pytest` green, exit 0. Tool-call battery went **10/10 at 26–45 tokens per call**.

`--reasoning off` sets `enable_thinking=false` in the chat template. Confirm your template supports it:

```bash
curl -s http://127.0.0.1:8090/props \
| python3 -c "import json,sys; print('enable_thinking:', json.load(sys.stdin)['chat_template'].count('enable_thinking'))"
```

Keep the harness in sync: `"reasoning": false` and **omit `interleaved`** in the OpenCode model config.

> Test this on the 27B immediately. It costs one flag, and if it behaves the same way you will otherwise spend hours suspecting the harness, the template, or the quant.

---

## 2. Flag drift {#2-flag-drift}

### `--np` is not a flag

```
$ llama-server ... --np 1
error: invalid argument: --np
```

It is `-np` (single dash) or `--parallel`. A plan written from memory will get this wrong.

### `--jinja` is already the default

```
--jinja, --no-jinja    (default: enabled)
```

Passing it is a no-op. Don't credit it for working tool calls.

### `--spec-type` options changed entirely

| Build | Options |
|---|---|
| b8467 (2026-03) | `none, ngram-cache, ngram-simple, ngram-map-k, ngram-map-k4v, ngram-mod` |
| master (2026-08) | `none, draft-simple, draft-eagle3, **draft-mtp**, draft-dflash, draft-dspark, ngram-*` |

**Check `llama-server --help | grep -A2 spec-type` before anything else.** That one line decides whether you rebuild, and MTP is worth 1.45×.

---

## 3. MTP needs a current build, and the head ships inline

`unsloth/*-MTP-GGUF` repos carry the MTP head **bundled in the same file** (~0.1 GB larger), not as a sidecar. llama.cpp finds it automatically:

```
srv load_model: [spec] estimated memory usage of MTP context is 682.02 MiB
common_speculative_init_result: creating MTP draft context against the target model
```

Loading an MTP GGUF **without** `--spec-type draft-mtp` is harmless:

```
W model has unused tensor blk.32.attn_q.weight -- ignoring
W model has unused tensor blk.32.nextn.eh_proj.weight -- ignoring
```

So prefer the MTP repo even before deciding about speculative decoding. **Budget its VRAM explicitly** — 682 MiB was ~9% of an 8 GB card, and it grows with model size.

---

## 4. The GDN line moved and hid {#4-the-gdn-line-moved-and-hid}

The confirmation that fused Gated Delta Net kernels are active:

- **Renamed** from `sched_reserve:` to `resolve_fused_ops:`
- **Suppressed at default verbosity** (3). You need `-lv 5`.

```bash
llama-server ... -lv 5 2>&1 | grep -i "gated delta"
```
```
resolve_fused_ops: fused Gated Delta Net (autoregressive) enabled
resolve_fused_ops: fused Gated Delta Net (chunked) enabled
```

**Absence of this line at default verbosity means nothing.** Raise the log level before concluding GDN is off.

---

## 5. Only full-attention layers cost KV

In a gated-delta hybrid, GDN layers carry a **fixed-size recurrent state**, not a per-token cache. Count only the `full_attention` layers:

```
bytes/token = full_attn_layers × (n_embd_k_gqa + n_embd_v_gqa) × element_bytes
```

Here: 8 of 32 layers → **17 KiB/token** at `q8_0`. A dense equivalent would be 69.6 KiB/token — **4×**.

Use `n_embd_k_gqa` / `n_embd_v_gqa` from `print_info` rather than hand-deriving from head counts; they already fold in GQA grouping. Predicted vs observed VRAM agreed within ~20 MiB using this method.

The recurrent state is **constant in context length**: 50.25 MiB at 4,096 and at 131,072 (201 MiB with MTP's extra sequences).

---

## 6. Prefill does not spike VRAM

The compute buffer is fully reserved at load. A 31,492-token prefill moved VRAM by **~20 MiB** (7,031 → 7,051).

You can therefore size context right up to your margin. The margin only needs to cover the desktop and driver, not a prefill balloon.

---

## 7. Auto-fit exists, and `-ngl` disables it

```
W common_fit_params: failed to fit params to free device memory:
  n_gpu_layers already set by user to 99, abort
```

Current llama.cpp will fit parameters to free VRAM on its own. Setting `-ngl` explicitly turns that off. On a large card with a large model, try launching **without** `-ngl` and `-c` first and see what it chooses.

---

## 8. SearXNG's empty 200

SearXNG returns **HTTP 200 with `"results": []`** when its upstream engines are throttled:

```json
{"results": [], "unresponsive_engines": [
   ["brave", "Suspended: too many requests"],
   ["startpage", "Suspended: CAPTCHA"]]}
```

Throughout the session Brave was rate-limited and Startpage CAPTCHA-suspended; DuckDuckGo carried everything. Bursty querying reliably produced empty sets — one early test looked exactly like a client bug and wasn't.

**Always read `unresponsive_engines`, and retry once on empty** before reporting no results.

Also: JSON output is **off by default** in a fresh SearXNG. Add `json` under `search.formats` in `settings.yml`.

---

## 9. OpenCode config is V2

Schema definitions are literally named `ConfigV2.*`. The root is a `$ref` into `$defs.Config`, so naively reading top-level `properties` returns an empty list.

Two field traps:

- **`apiKey` is required** even though llama-server ignores it — the SDK won't construct a client without it.
- **`reasoning` / `interleaved` must match the server.** With `--reasoning off`, set `"reasoning": false` and omit `interleaved`. Mismatched, the agent appears to return empty responses.

And always set `--alias` on the server, or the model id is the GGUF filename and your config breaks on every quant change.

---

## 10. Port collisions {#10-port-collisions}

llama-server's documented default **8080** was already taken by SearXNG. Moved to **8090**.

```bash
ss -tlnp | grep -E ':(8080|8090|11235) '
```

Check before committing to a port in a plan.

---

## 11. Remote-dependency rate limits are account-scoped

Rate limits on the optional summarizer are **token-per-minute and scoped to the account**, not to an individual credential. An oversized request exhausts the budget regardless of how it is routed — adding credentials does not add capacity.

Measured: 12,000 TPM / 1,000 RPM on the summarization model.

**The fix is sizing the prompt to the budget** (4 sources × 2,200 chars ≈ 2.5k tokens), not adding capacity. The optional/additive silent-fallback design worked correctly in all three failure modes, and the local-only result is fully usable without it.

---

## 12. Hugging Face returns 401 for repos that don't exist

```
unsloth/Qwen3.5-4B-GGUF     200
unsloth/Qwen3.6-4B-GGUF     401     ← does not exist, not an auth problem
unsloth/Qwen3.8-4B-GGUF     401     ← same
```

It reads like a credentials failure. It isn't. There simply is no 4B dense GGUF for those generations.

---

## 13. Small tooling traps

- **`grep -c '"tools"'` across a JSON-RPC stream double-counts** — the `initialize` response contains `"tools"` in `capabilities`. `agent test` reported a healthy MCP server as broken until it parsed by message id instead.
- **An MCP server must not exit on stdin close while requests are in flight.** Track pending work; otherwise responses vanish silently.
- **`pkill -f opencode` will kill your own shell** if the shell's command line contains that string. Ask how this was discovered.
- **Python inside single-quoted `-c` can't contain single quotes.** `t.get('predicted_n')` silently broke the bench script; `t.get("predicted_n")` works.
- **`nvidia-smi` nominal ≠ usable.** 8,188 nominal vs 7,815 reported by llama.cpp. Size against the runtime's number.

---

## 14. Reuse beat rebuild, twice

An existing crawl4ai container (`POST /md {"url","f":"fit"}`) fully replaced a planned Rust `spider` + `article_scraper` build — a multi-hour phase became a two-minute verification. SearXNG already had JSON enabled.

**Inventory first was worth more than any single build step.** On the next box, the equivalent question is what is already running there.

---

**Next:** [11 — Porting to 27B](11-Porting-to-27B.md)
