# 05 — Server Configuration

---

## The validated launch line

```bash
llama-server \
  --model models/Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf \
  --alias qwen3.5-4b \
  --n-gpu-layers 99 \
  -c 131072 \
  -fa on \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --parallel 1 \
  --host 127.0.0.1 --port 8090 \
  --jinja \
  --spec-type draft-mtp \
  --reasoning off
```

Boots in **~8 seconds** to healthy. VRAM 7,031 MiB.

---

## Every flag, justified

| Flag | Why |
|---|---|
| `--alias qwen3.5-4b` | Without it, `/v1/models` reports the **filename** (`Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf`) as the model id, and your OpenCode config breaks the moment you change quants. Pin a stable name. |
| `--n-gpu-layers 99` | Offload everything. See the auto-fit caveat below. |
| `-c 131072` | Computed in [04](04-VRAM-and-KV-Sizing.md). Not the model's 262,144 max — that doesn't fit in 8 GB. |
| `-fa on` | Flash attention. Required for quantized KV to be worthwhile. |
| `--cache-type-k/v q8_0` | Halves KV vs `f16` at negligible quality cost. |
| `--parallel 1` | One slot. A single-user coding agent gains nothing from more, and each slot multiplies KV. |
| `--host 127.0.0.1` | Localhost only. The server has **no auth and CORS `*`** — see the warning below. |
| `--port 8090` | **Not 8080** — SearXNG owns that. |
| `--jinja` | Already the default in current builds; harmless, kept for explicitness. |
| `--spec-type draft-mtp` | Speculative decoding via the model's built-in MTP head. **1.45×.** |
| `--reasoning off` | **The single most important flag here.** See below. |

---

## Flag traps

### `--np` is not a flag

The obvious-looking abbreviation fails hard:

```
$ llama-server ... --np 1
error: invalid argument: --np
```

It is `-np` (single dash) or `--parallel`:

```
-np,   --parallel N    number of server slots (default: -1, -1 = auto)
```

### `--jinja` is already the default

```
--jinja, --no-jinja    whether to use jinja template engine for chat (default: enabled)
```

Passing it is a no-op. Don't attribute working tool-calling to it — if tool calls are broken, `--jinja` is not the fix.

### Auto-fit, and how `-ngl` disables it {#auto-fit}

Current llama.cpp tries to fit parameters to available VRAM automatically. Setting `-ngl` explicitly aborts that:

```
W common_fit_params: failed to fit params to free device memory:
  n_gpu_layers already set by user to 99, abort
```

Harmless here — the hand-computed values were correct. But on a **large card with a large model**, where the layer-offload decision is genuinely non-obvious, it is worth launching **without** `-ngl` and `-c` first to see what auto-fit picks, then deciding whether to override.

### Security

```
W CORS is set to allow all origins ('*') and no API key is set
W this can be a security risk (cross-origin attacks)
```

Mitigated by binding to `127.0.0.1`. **Never bind this to `0.0.0.0` without adding `--api-key`.** Any page in your browser could otherwise drive your local model.

---

## The reasoning flag — the biggest single gotcha

Qwen3.5-4B is a reasoning model. Inside an agent harness with thinking enabled, it **does not stop**.

**With thinking on**, a trivial OpenCode task ("add a `multiply` function and a test"):

```
slot print_timing: n_gen = 12936, tg = 82.34 t/s
```

**12,936 tokens in a single completion, zero tool calls, zero file edits**, before being killed. It never escaped its own reasoning loop.

Even a one-line request burned its whole budget thinking:

```json
{"message":{"content":"","reasoning_content":"\nThinking Process:\n\n1. **Analyze the Request:** The user wants me to reply with exactly the string \""}}
```

**With `--reasoning off`:**

```json
{"message":{"content":"PIPELINE OK"}}     // 4 completion tokens
```

Same task, rerun: 3 correct edits, `pytest` green, exit 0. Tool-call battery went **10/10 at 26–45 tokens per call**.

`--reasoning off` sets `enable_thinking=false` in the chat template. Verify your model's template supports it:

```bash
curl -s http://127.0.0.1:8090/props | python3 -c "
import json,sys; ct=json.load(sys.stdin)['chat_template']
print('enable_thinking:', ct.count('enable_thinking'))"
```

Related flags: `--reasoning-effort LEVEL` (if the template reads it — this one does not), `--reasoning-format deepseek` (routes thoughts to `message.reasoning_content` instead of inline `<think>` tags).

> **Check this before blaming the harness, the chat template, or the quant.** Whether a 27B needs the same treatment is untested — but it costs one flag to find out, so test it early.

---

## MTP, measured {#mtp-measured}

Three runs each, same prompt, 160 tokens:

| Config | decode tok/s | VRAM |
|---|---|---|
| `--spec-type draft-mtp` | 79.99 / 81.30 / 78.95 | 7,043 MiB |
| `--spec-type none` | 55.16 / 55.33 / 56.19 | 6,119 MiB |

**1.45× for +924 MiB.**

Acceptance statistics reported by the server:

```
draft acceptance = 0.71053 (108 accepted / 152 generated), mean len = 3.12
#acc rate/pos = (0.902, 0.725, 0.490)
```

Read that as: the first drafted token is accepted 90% of the time, the second 73%, the third 49% — averaging 3.12 accepted tokens per draft cycle. That acceptance profile is what produces the 1.45×.

MTP is discovered automatically from the single GGUF:

```
srv load_model: [spec] estimated memory usage of MTP context is 682.02 MiB
common_speculative_init_result: creating MTP draft context against the target model
```

> **On a bigger model, budget for it explicitly.** 682 MiB here was ~9% of an 8 GB card. The absolute cost will grow with model size — do not treat MTP as free.

---

## Verifying a good boot

```bash
$ curl -s http://127.0.0.1:8090/v1/models | python3 -m json.tool
{"data":[{"id":"qwen3.5-4b","meta":{"n_ctx_train":262144,"n_params":4205751296}}]}

$ curl -s http://127.0.0.1:8090/health
{"status":"ok"}
```

Checklist:

1. `/health` returns ok
2. `/v1/models` reports your **alias**, not a filename
3. `-lv 5` log shows `fused Gated Delta Net (autoregressive) enabled`
4. `nvidia-smi` matches your predicted total within ~50 MiB
5. A long prompt does not spike VRAM
6. A short prompt returns `content`, not an empty string with `reasoning_content`

---

## Logging

Default verbosity is **3**, which hides the load-time detail — including the GDN confirmation and the memory breakdown. For diagnosis:

```bash
llama-server ... -lv 5
```

At `-lv 5` a boot produces ~4,000 lines including per-layer device placement, fused-op resolution, and full buffer accounting. Useful once; too noisy to leave on. `agent up` runs at default verbosity and takes `LLAMA_EXTRA_ARGS="-lv 5"` when needed.

---

**Next:** [06 — Search Stack](06-Search-Stack.md)
