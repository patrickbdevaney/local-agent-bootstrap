# Local Agent Bootstrap — Install Log

**Box:** Lenovo Legion 5, RTX 4060 Laptop 8GB, Ubuntu 24.04.4 LTS (noble), kernel 6.17.0-14-generic, native Linux (no WSL2).
**Purpose:** Dry run of the llama.cpp + OpenCode + local-search pattern before attempting it on the RTX 5090 Windows box. Absolute decode speed on this box is *not* the metric; "does the pipeline work end to end with clean fallback behavior" is.

---

## PHASE 0 — Inventory (2026-08-14)

### Repo location
- `local-agent-bootstrap` found at **`/home/patrickd/local-agent-bootstrap`** — this is the only one on the box (`find ~ -maxdepth 4`). No second directory created.
- Git repo initialized, remote `git@github.com:patrickbdevaney/local-agent-bootstrap.git`, branch `main`, **zero commits yet**.
- Contents before this run: `.env` and `.git` only. Effectively an empty scaffold.

### Related prior infrastructure on this box
Found (not touched):
- `/home/patrickd/hermes-max`, `/home/patrickd/.hermes-max`, `/home/patrickd/hermes-max-runs`, `/home/patrickd/hermes-validation`, `/home/patrickd/local-agent-hermes-test`, `/home/patrickd/.hermes` (with many `config.yaml.hermes-max*.bak` files)
- `/home/patrickd/prism-llama.cpp` — a **separate llama.cpp fork** (HEAD `7529fdaa`, 2026-07-19, "force qwen35 to treat IGPU like a GPU so DSpark does not fall back to CPU (#88)"). Has a `build-cpu/` dir only, **no CUDA build, no `build/bin/`**. Contains `ggml-vocab-qwen35.gguf` test vocab. Treated as another project's tree — **not reused, not modified.**

### Docker (already installed: Docker 29.2.1) — running containers
| Container | Image | Ports | Status |
|---|---|---|---|
| `searxng` | `searxng/searxng:latest` | **8080** → 8080 | Up 4 days |
| `crawl4ai` | `unclecode/crawl4ai:latest` | **11235** → 11235 | Up 4 days (healthy), v0.8.6 |
| `phoenix` | `arizephoenix/phoenix:latest` | 4317, 6006 | Up 4 days |

All three are pre-existing shared infra (~2 months old) from prior work. **Guardrail applied: none of these will be recreated, rebuilt, or removed by this directive.**

### SearXNG — already usable, no changes needed
- `curl "http://localhost:8080/search?q=test&format=json"` → **HTTP 200 with valid JSON results** (wikipedia result returned).
- **JSON output is already enabled.** Phase 4 is therefore "verify existing" and is already satisfied — no `settings.yml` patch, no container restart.
- Config lives in an anonymous Docker volume (`/etc/searxng` → `.../volumes/f5606789.../_data`), not a bind mount into this repo. Left as-is.

### Scraper — existing candidate found
- **crawl4ai** on `http://localhost:11235`, `/health` → `{"status":"ok","version":"0.8.6"}`.
- This is a direct substitute for the Rust `spider` + `article_scraper` binary the directive specifies for Phase 5. Reuse-first rule applies; will verify real extraction before committing to it.

### llama.cpp — existing CUDA build found
- `/home/patrickd/llama.cpp`, HEAD `990e4d96` (2026-03-21), tag **`b8467`**.
- Binary at `/home/patrickd/llama.cpp/build/bin/llama-server` (not on `PATH`).
- Build flags confirmed from `build/CMakeCache.txt`: `GGML_CUDA=ON`, `CMAKE_CUDA_ARCHITECTURES=89` (correct for Ada / RTX 4060), `GGML_CUDA_FA=ON`, `GGML_CUDA_GRAPHS=ON`.
- Startup banner: `found 1 CUDA devices ... RTX 4060 Laptop GPU, compute capability 8.9, VMM: yes, VRAM: 7815 MiB`. CUDA backend confirmed working.
- **Qwen3.5 support present:** `LLM_ARCH_QWEN35` / `LLM_ARCH_QWEN35MOE` in `src/llama-arch.cpp`; `GGML_OP_GATED_DELTA_NET` in `ggml/include/ggml.h`; QWEN35 special-cased in `llama_context::graph_max_nodes`. So this build genuinely handles the gated-delta hybrid.
- **MTP NOT supported in this build** — `--spec-type` accepts only `[none|ngram-cache|ngram-simple|ngram-map-k|ngram-map-k4v|ngram-mod]`. There is **no `draft-mtp`** option. Directive says skip cleanly if unavailable → MTP skipped. (See carry-forward notes.)
- `--jinja` is **default-enabled** in b8467 (`--jinja, --no-jinja ... (default: enabled)`), so passing it is a no-op rather than a requirement.

### Model — already on disk
- `/home/patrickd/qwen_35_4b_claude/`
  - `Qwen3.5-4B.Q4_K_M.gguf` — 2,708,800,320 bytes (**2583 MiB / 2.71 GB**)
  - `mmproj-BF16.gguf` — 675,568,864 bytes (vision projector; **not needed** for a coding agent, will not be loaded — it would only consume VRAM)
  - `config.json` — `model_name: unsloth/Qwen3.5-4B`, `unsloth_version: 2026.3.5`
- Downloaded 2026-03-21, same day as the llama.cpp build. Phase 2 is therefore largely "verify existing" (still checking HF for a better-quant option, see Phase 2).

### Model architecture (from `config.json`, for real KV math — not assumed from the 27B)
- `num_hidden_layers`: **32** total
- `layer_types`: `full_attention_interval: 4` → **8 full-attention layers, 24 linear_attention (GatedDeltaNet) layers**. Confirms the genuine hybrid architecture the dry run is meant to exercise.
- Full-attention layers: `num_attention_heads` 16, **`num_key_value_heads` 4** (GQA), **`head_dim` 256**
- GDN layers: `linear_num_key_heads` 16, `linear_num_value_heads` 32, `linear_key_head_dim` 128, `linear_value_head_dim` 128, `linear_conv_kernel_dim` 4
- `max_position_embeddings`: **262144** (262K — this small model *does* share the long context)
- `hidden_size` 2560, `intermediate_size` 9216, `vocab_size` 248320, `rope_theta` 1e7, `tie_word_embeddings` true
- `mtp_num_hidden_layers: 1` → the *model* has an MTP head, but the runtime doesn't expose it (see above).

### OpenCode
- **Not installed** (`opencode: command not found`, no `~/.config/opencode`, no `~/.opencode`). Phase 6 is a fresh install.

### Toolchain
- CUDA toolkit **12.8** (`/usr/local/cuda-12.8/bin/nvcc`, V12.8.93); driver **570.211.01**, driver CUDA 12.8. Matched — no toolkit install needed.
- cmake 3.28.3, gcc 13.3.0, cargo 1.88.0. All present.

### GPU (idle baseline, before loading anything)
```
NVIDIA GeForce RTX 4060 Laptop GPU
Driver 570.211.01 / CUDA 12.8
Memory: 11 MiB / 8188 MiB used at idle   (only Xorg, 4 MiB)
```
- **Real usable VRAM per llama.cpp: 7815 MiB.** Real free at idle: **~7804 MiB**.
- Note: the desktop session is barely touching the dGPU (hybrid graphics — the display is on the iGPU). This is *better* than the directive assumed; there is no meaningful compositor VRAM tax to subtract.

### RAM
```
              total   used   free  shared  buff/cache  available
Mem:           31Gi   18Gi   3.8Gi  807Mi   9.7Gi       12Gi
Swap:         8.0Gi   8.0Gi     0B
```
- ~58% of RAM in use (higher than the ~36% the owner mentioned), **12 GiB available**.
- **Swap is 100% full (8.0 GiB used, 0 B free).** Flagged as the one real memory-pressure signal on this box. 12 GiB of available RAM is ample for a 2.7 GB model load, but heavy steps will still be run **sequentially, not in parallel**, and `free -h` re-checked before each.

### Disk
- `/home` on `/dev/nvme0n1p9`: 297G total, **37G available (87% used)**. Sanity check only, per directive. Fine for a 2.7–4 GB model.

---

### Phase 0 conclusion — what's build-fresh vs verify-existing

| Phase | Status |
|---|---|
| 1 llama.cpp | **Verify existing** (b8467 CUDA/SM89 build, has QWEN35 + GDN) |
| 2 Model | **Verify existing** Q4_K_M; check HF for a higher-fidelity quant given the headroom |
| 3 Server launch | Build fresh — **must not use port 8080, SearXNG owns it** |
| 4 SearXNG | **Already satisfied** — running, JSON on |
| 5 Scraper | **Verify existing crawl4ai** instead of building the Rust binary |
| 6 OpenCode + MCP + remote summarizer | Build fresh (OpenCode absent); `.env` already has summarizer credentials to reuse |
| 7 `agent` wrapper | Build fresh |
| 8 Validation | Build fresh |

### `.env`
Contains pre-existing credentials for the optional remote summarizer. Values were never read into the log; only presence was checked.

No SearXNG URL, no MCP entries, no other config present. The file is **gitignored**, will be **extended, never overwritten**, and is restored exactly as found after any fallback testing.

### Deviations from the directive found in Phase 0
1. **Port 8080 is taken by SearXNG.** llama-server cannot use the directive's `--port 8080`. Will use **8090**.
2. **`--spec-type draft-mtp` does not exist** in llama.cpp b8467. MTP skipped (directive permits).
3. **`--jinja` is already the default** in b8467; harmless to pass explicitly.
4. **Phase 5's Rust scraper is redundant** — crawl4ai already provides `POST`-style extraction on 11235.
5. **RAM baseline is ~58% used, not ~36%**, and swap is fully consumed. Not blocking; proceeding cautiously and sequentially.

---

## PHASE 1 — llama.cpp

### Verification of the existing b8467 build
Loaded the pre-existing `Qwen3.5-4B.Q4_K_M.gguf` on the existing `~/llama.cpp` b8467 build at `-c 4096`.

**Result: works, and GDN fusion is confirmed active.** Startup log:
```
llama_memory_recurrent:      CUDA0 RS buffer size =    50.25 MiB
llama_memory_recurrent: size =   50.25 MiB (1 cells, 32 layers, 1 seqs), R (f32): 2.25 MiB, S (f32): 48.00 MiB
sched_reserve: resolving fused Gated Delta Net support:
sched_reserve: fused Gated Delta Net (autoregressive) enabled
sched_reserve: fused Gated Delta Net (chunked) enabled
```
Both the autoregressive **and** chunked fused GDN paths enabled — this is the exact string the directive asked for.

- Load time: **4 s** to healthy. VRAM at `-c 4096`: **3313 MiB**. Clean shutdown released VRAM to **11 MiB** (idle baseline). No leak.
- `/v1/models` reported `n_ctx_train = 262144`, `n_params = 4.21 B`.
- `print_info`: `arch = qwen35`, `n_layer 32`, `n_head 16`, `n_head_kv 4`, `n_embd_k_gqa 1024`, `n_embd_v_gqa 1024`, `file size 2.51 GiB (5.13 BPW)`.

**Flag deviations found (directive vs. reality):**
- `--np 1` is **invalid** → `error: invalid argument: --np`. The real flag is `-np` / `--parallel`. Used `--parallel 1`.
- `--jinja` is already default-enabled; passing it is a harmless no-op.

### Decision: rebuild against master
b8467 is from 2026-03-21, ~5 months stale, and critically **its `--spec-type` accepts only `[none|ngram-cache|ngram-simple|ngram-map-k|ngram-map-k4v|ngram-mod]` — no `draft-mtp`.**

Checked upstream `master` `common/arg.cpp`: it **does** define `COMMON_SPECULATIVE_TYPE_DRAFT_MTP`, with automatic MTP-head discovery/download. So MTP *is* supported upstream, just not in the installed build.

Since Unsloth also ships MTP-enabled GGUFs for this model (see Phase 2), rebuilding unlocks a real MTP test — the single most valuable carry-forward datum for the 5090 plan. Rebuilt.

**Guardrail applied:** cloned fresh into **`~/local-agent-bootstrap/llama.cpp`** rather than touching the shared `~/llama.cpp`. The known-good b8467 build stays intact as a fallback, and `~/prism-llama.cpp` (another project's fork) was never touched.

```
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git    # HEAD 16d222fc, 2026-08-15
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 -DLLAMA_CURL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j 10
```
`CMAKE_CUDA_ARCHITECTURES=89` confirmed still correct for Ada/RTX 4060 under current llama.cpp CMake conventions.

---

## PHASE 2 — Model

### Availability check (done before downloading — repo names were not assumed)
- **`unsloth/Qwen3.5-4B-GGUF` is still current** — last modified 2026-03-02, 1,186,242 downloads.
- **No newer same-size-class variant exists.** `unsloth/Qwen3.6-4B-GGUF` and `unsloth/Qwen3.8-4B-GGUF` both return **HTTP 401 (do not exist)**. The Qwen3.6/3.8 generations have no 4B dense GGUF release. Qwen3.5-4B remains the right dry-run model.
- **`unsloth/Qwen3.5-4B-MTP-GGUF` exists** (76,567 downloads, updated 2026-05-16) — same quant ladder, each file ~0.1 GB larger, i.e. the MTP head is bundled inline rather than shipped as a sidecar.

### Quant choice
Full ladder is available (Q3_K_S through BF16, plus Unsloth UD dynamic quants). Given ~7.8 GB usable VRAM against a 4B model, Q4_K_M leaves a lot on the table. Selected **`Qwen3.5-4B-UD-Q5_K_XL.gguf` from the MTP repo**:
- Unsloth dynamic quant — better quality per byte than plain Q5_K_M
- 3.30 GB (**3,304,827,200 bytes** on disk) vs 2.74 GB for Q4_K_M — only +0.56 GB
- Still leaves comfortable headroom at 128K context (see Phase 3)
- Carries the MTP head for speculative decoding

Downloaded to `~/local-agent-bootstrap/models/Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf`. The pre-existing `~/qwen_35_4b_claude/Qwen3.5-4B.Q4_K_M.gguf` was left in place untouched as a fallback.

`mmproj-BF16.gguf` (vision projector) deliberately **not** loaded — irrelevant to a coding agent and it would only consume VRAM.

### KV budget computed from *this* model's real numbers
From `config.json` / `print_info`, not from the 27B's:
- 32 layers, `full_attention_interval: 4` → **8 full-attention layers** carry a KV cache; the other 24 are GatedDeltaNet and carry a **fixed-size recurrent state instead**.
- `n_embd_k_gqa = n_embd_v_gqa = 1024` (4 KV heads x 256 head_dim).
- Per token, per full-attn layer, at `q8_0` (~1.0625 bytes/element):
  `(1024 + 1024) x 1.0625 = 2176 bytes`
- Across 8 full-attention layers: **17,408 bytes/token ≈ 17 KiB/token**.

Measured cross-check at `-c 4096`: 3313 MiB total = 2573 (weights) + 50 (GDN recurrent state) + 490 (compute buffer) + ~71 (KV) + ~129 (CUDA context). Matches the model.

The GDN recurrent state is **50.25 MiB flat regardless of context length** (1 cell) — the hybrid architecture's big win, and the thing worth carrying forward to the 27B sizing.


---

## PHASE 3 — Server config and launch

**Port: 8090, not 8080** — SearXNG owns 8080 on this box.

Final launch line (as emitted by `agent up`):
```
llama-server --model models/Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf --alias qwen3.5-4b \
  --n-gpu-layers 99 -c 131072 -fa on --cache-type-k q8_0 --cache-type-v q8_0 \
  --parallel 1 --host 127.0.0.1 --port 8090 --jinja --spec-type draft-mtp --reasoning off
```

### Measured VRAM at `-c 131072` (total 8188 MiB, 7815 usable)
| Component | MiB |
|---|---|
| Model weights on CUDA0 | 3141.27 |
| Model weights CPU_Mapped (token embedding) | 497.31 *(host, not VRAM)* |
| GDN recurrent state (RS buffer) | 201.00 |
| Compute buffer (CUDA0) | 690.28 |
| MTP draft context (`[spec] estimated memory usage`) | 682.02 |
| KV cache (131072 x 17 KiB, q8_0) | ~2176 |
| CUDA context overhead | ~140 |
| **Observed total (`nvidia-smi`)** | **7031–7053** |
| **Free** | **~1135–1157** |

Computed estimate and observation agree to within ~20 MiB.

**GDN confirmed active** (needs `-lv 5` — see deviations):
```
resolve_fused_ops: fused Gated Delta Net (autoregressive) enabled
resolve_fused_ops: fused Gated Delta Net (chunked) enabled
```
RS buffer is now `201.00 MiB (1 cells, 32 layers, 1 seqs, 3 rs_seq)` — 3 recurrent-state sequences because the MTP draft context needs its own. Without MTP it was 50.25 MiB. Still **flat with respect to context length**, which is the whole point of the hybrid.

### Long-context stress test (headroom is real, not theoretical)
31,492-token prompt:
- prefill **1795 tok/s**
- decode **67.5 tok/s** (vs ~80 at short context)
- **peak VRAM during prefill: 7051 MiB** — only ~20 MiB above steady state

The compute buffer is fully pre-reserved at load, so long prefills do **not** spike VRAM. 131072 is safe with ~1.1 GB to spare. 262144 (the model's full `n_ctx_train`) would need ~2.2 GB more KV and does **not** fit on 8 GB.

### MTP — measured, not assumed
| Config | decode tok/s (3 runs) | VRAM |
|---|---|---|
| `--spec-type draft-mtp` | 79.99 / 81.30 / 78.95 | 7043 MiB |
| `--spec-type none` | 55.16 / 55.33 / 56.19 | 6119 MiB |

**MTP = ~1.45x decode speedup for +924 MiB VRAM.** Kept on.

Acceptance statistics from the server:
```
draft acceptance = 0.71053 (108 accepted / 152 generated), mean len = 3.12
#acc rate/pos = (0.902, 0.725, 0.490)
```
Saved clean baseline: **78.60 tok/s** (`run/baseline_tps`).

Note: `agent bench` prefill numbers on the 17–24 token bench prompt (30–60 tok/s) are measurement noise, not real prefill throughput. The 31k-token figure (1795 tok/s) is the meaningful one.

---

## PHASE 4 — SearXNG

**Reused, unchanged.** The pre-existing container already served JSON. No `settings.yml` patch, no restart, no recreation.

Operational finding worth carrying: upstream engines rate-limit constantly.
```
unresponsive_engines: [["brave","Suspended: too many requests"],["startpage","Suspended: CAPTCHA"]]
```
DuckDuckGo carries the results. Under bursty querying **SearXNG returns HTTP 200 with an empty `results` array** rather than an error — which reads as "no results found" and is easy to misdiagnose as a bug in your own code. The MCP server now retries once after a 1.5 s backoff and logs the unresponsive engine list.

---

## PHASE 5 — Scraper

**Rust `spider` + `article_scraper` binary was NOT built.** The pre-existing crawl4ai container (v0.8.6, port 11235) already does exactly the job:

```
POST /md  {"url": "...", "f": "fit"}  ->  {"markdown": "...", "success": true}
```

Verified on `example.com` (clean) and on a real Wikipedia article (11,668 chars of clean readable markdown, no nav/chrome). Reuse-first rule applied — this saved the entire phase.

---

## PHASE 6 — OpenCode + MCP + optional remote summarizer

### OpenCode
- Installed `opencode-ai@1.18.18` via npm (Node v22.18.0 already present).
- **Config schema: V2-style.** `https://opencode.ai/config.json` resolves through `$ref` -> `$defs.Config`; the definitions are explicitly named `ConfigV2.*`. Provider shape is:
  `provider.<id>.{npm, name, options:{baseURL, apiKey, timeout, headerTimeout}, models:{<id>:{...}}}`
  and models are referenced globally as `"<provider>/<model>"`.
- Written to `~/.config/opencode/opencode.json` (global, so `agent code` works from any scratch repo).
- `npm: "@ai-sdk/openai-compatible"`, `baseURL: http://127.0.0.1:8090/v1`, `apiKey: "local-no-auth"` (llama-server ignores it but the SDK requires a value).
- `opencode models` confirms `local/qwen3.5-4b` is registered.

### MCP server
Written as `mcp/search-server.mjs` — **dependency-free Node**, newline-delimited JSON-RPC 2.0 over stdio. Avoiding the MCP SDK keeps it from breaking on npm churn. Exposes:
- `web_search(query, count, mode, summarize)` — SearXNG -> optional crawl4ai extraction of the top 4 -> optional remote summarization
- `web_fetch(url, max_chars)` — crawl4ai readability extraction

Bug found and fixed during testing: the server exited on stdin close while requests were still in flight, silently dropping responses. Now tracks pending work and only exits when it drains.

### Optional remote summarizer — all three paths tested against the real pre-existing credentials
The summarizer is strictly optional and additive. It is never required, and its failure is never surfaced to the OpenCode user.

1. **Credentials valid:** confirmed against the provider's `/v1/models` endpoint.
2. **Success path:** confirmed — summary returned with `[1][2]` citations matching the numbered sources.
3. **All-credentials-fail path:** forced by overriding every credential with an invalid value *in the environment* (`.env` never edited). Result: fallback to local-only. The tool returned **`isError: false`** with 13,933 chars of extracted content. **No error surfaced to the OpenCode user** — exactly the required behavior.
4. **No-credentials path:** tested with a temp root containing an empty `.env`. Result: summarization skipped, identical 13,933-char local-only result.

**`.env` integrity: md5 `4c95ded576d2f8b44dd625cb5120ba7f`, 1341 bytes, mtime `2026-08-14 18:04:06` — identical before and after all testing.** Never written to; the failure paths were induced via environment overrides and a throwaway directory instead. The file is gitignored and is not part of the pushed repository.

**Important finding — provider rate limits are token-per-minute and scoped to the account, not to the individual credential.** Measured on the summarization model: 12,000 TPM / 1,000 RPM. An oversized summarization payload therefore exhausts the budget no matter how the request is routed. The fix is to size the prompt to the TPM budget (`AGENT_GROQ_CHARS_PER_SOURCE=2200`, 4 sources ≈ 2.5k tokens), not to add capacity. Degradation to local-only is silent and correct.

### Speed-scaling rule
`agent bench --save` recorded this box's own baseline (**78.60 tok/s**) — the 5090's numbers were not imported. `effective_mode()` re-measures and drops `AGENT_SEARCH_MODE` to `shallow` (snippets only, no page fetch, no summarization) below 70% of that baseline; otherwise `normal`.

---

## PHASE 7 — The `agent` wrapper

`bin/agent` (bash), symlinked to `~/.local/bin/agent` (already on PATH). Config in `agent.env`.

- **`agent up`** — nohup + PID file, polls `/health`, verifies shared services, prints status. **Idempotent** (verified: second `agent up` reports "already live", no-op).
- **`agent down`** — SIGTERM via PID file, escalates to SIGKILL after 30 s, reports VRAM freed. Fallback match is `llama-server.*--port 8090` — targeted, never a blanket `pkill llama-server`.
- **`agent status` / `code` / `logs` / `bench` / `test`** — as specified.

**`agent down` deliberately does not touch SearXNG or crawl4ai.** Phase 0 established both are pre-existing shared infra from hermes-max, so stopping them would break another project. The scripts verify them and print `leaving shared containers running by design`.

Verified: cold start from a scrubbed environment (`env -i`) works; `agent code` refuses cleanly when the server is down; `agent down` returns VRAM to **11 MiB — the exact Phase 0 idle baseline**.

---

## PHASE 8 — Validation suite

### 1. Tool-call battery — 10/10 passed
`bin/toolcall-battery.py`: 10 prompts across 3 tool schemas, checking a single well-formed call, correct tool selection, JSON-parseable arguments, required fields present, and no runaway generation.
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
**Zero malformed, zero looping.** 26–45 tokens per call — tight, no preamble.

### 2. Baseline decode speed
**78.60 tok/s** saved as this box's clean baseline; 67.5 tok/s at 31k context. Plausible for a 4B Q5 model with MTP on a 115 W laptop Ada part. Sanity check only, as instructed.

### 3. Remote-summarizer success + fallback end-to-end
Confirmed through an actual OpenCode call — the model selected the MCP tool itself:
```
local-search_web_search {"query":"llama.cpp --cache-type-k flag","count":3,"summarize":true}
-> "The --cache-type-k flag in llama.cpp controls the precision of the KV cache for key
    tensors, with Q8_0 reducing cache memory by half with near-zero quality loss."
```
Correct answer, one clean tool call.

### 4. End-to-end coding task — green
Scratch repo `scratch-test/` (git-initialized, `mathutil.py` + passing test). Task: add `multiply`, add a test, run pytest.

OpenCode driving the local model produced 3 correct edits and ran the tests itself:
```
Edit mathutil.py        + def multiply(a, b): return a * b
Edit test_mathutil.py   - from mathutil import add
                        + from mathutil import add, multiply
Edit test_mathutil.py   + def test_multiply(): assert multiply(2, 3) == 6
$ python3 -m pytest -q
..                                                        [100%]
2 passed in 0.31s
```
Exit code 0. **Full pipeline works end to end.**

### 5. `agent down` -> VRAM idle
`VRAM: 7053 MiB -> 11 MiB (freed 7042 MiB)`. 11 MiB is the exact Phase 0 idle baseline. No leak, no orphaned process.

### `agent test` — all checks pass
```
ok  llama-server /health
ok  /v1/models -> qwen3.5-4b
ok  completion -> "READY"
ok  searxng JSON search
ok  crawl4ai /health
ok  mcp search-server tools/list -> web_search,web_fetch
ok  all checks passed
```

---

## CARRY-FORWARD NOTES (for the separate RTX 5090 Windows directive)

Factual scratchpad. Not a report.

**1. `--np 1` is not a valid flag.** It is `-np` / `--parallel`. `--np` fails hard with `error: invalid argument: --np`. Fix the 5090 directive's launch line.

**2. `--jinja` is default-enabled** in current llama.cpp. Harmless to pass, but it is not the switch that makes tool calling work — don't attribute behavior to it.

**3. MTP needs a recent llama.cpp; b8467 (2026-03) is too old.** b8467's `--spec-type` only offers ngram variants. Current master offers `none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,ngram-*`. If the 5090 box has any pre-built llama.cpp, check `--spec-type` output *first* — that one line tells you whether MTP is on the table.

**4. MTP is worth it and the numbers are concrete.** 1.45x decode (55 -> 80 tok/s) for +924 MiB. Draft acceptance 0.71, mean accepted length 3.12, per-position acceptance (0.90, 0.73, 0.49). Expect the VRAM cost to scale with model size — budget for it explicitly on the 27B rather than treating it as free. Unsloth ships `-MTP-GGUF` repos with the head **bundled inline** (files ~0.1 GB larger), not as a sidecar; llama.cpp picks it up automatically from the single file. Loading an MTP GGUF *without* `--spec-type draft-mtp` is harmless — the head's tensors are just logged as `unused tensor blk.32.* -- ignoring`.

**5. GDN sizing worked out almost exactly as computed, and the recurrent state is the surprise.** Per-token KV = full-attention-layers only. Here: 8 of 32 layers x (n_embd_k_gqa + n_embd_v_gqa = 2048) x 1.0625 B/elem @ q8_0 = **17 KiB/token**. Predicted vs observed VRAM agreed within ~20 MiB. The GDN recurrent state is **flat in context length** (50.25 MiB at 1 rs_seq, 201 MiB at 3 rs_seq with MTP) — it does not grow with `-c` at all. Use `n_embd_k_gqa`/`n_embd_v_gqa` from `print_info`, not hand-derived head math, and count only `full_attention` layers.

**6. The GDN confirmation string moved and is hidden by default.** It is now `resolve_fused_ops:` (was `sched_reserve:`) and default verbosity is 3, which **suppresses it entirely**. You need `-lv 5` to see `fused Gated Delta Net (autoregressive) enabled`. Don't conclude GDN is off just because the line is missing.

**7. New llama.cpp auto-fits params to free VRAM — and your explicit `-ngl` disables that.** Log line: `common_fit_params: failed to fit params to free device memory: n_gpu_layers already set by user to 99, abort`. On the 5090 with a 27B this auto-fit may be *more* useful than hand-picked values. Consider trying it without `-ngl`/`-c` first and seeing what it chooses.

**8. Long prefills do not spike VRAM.** The compute buffer is fully reserved at load. A 31k-token prefill moved VRAM by ~20 MiB. So you can size context right up to your margin without reserving extra for prefill spikes.

**9. Biggest single gotcha: the reasoning model runs away inside the agent harness.** Default (thinking on), a trivial OpenCode task generated **12,936 tokens in one completion with zero tool calls** before being killed — it never escaped its own reasoning loop. `--reasoning off` (sets `enable_thinking=false` in the chat template) fixed it completely: the same task then produced 3 correct edits and a green pytest run, and the tool-call battery went 10/10 at 26–45 tokens per call. **Check this before blaming the harness, the template, or the quant.** Whether a 27B needs the same treatment is untested — but test it early, it costs one flag.

**10. OpenCode config is V2 schema.** Definitions are literally named `ConfigV2.*`. Working shape is in `~/.config/opencode/opencode.json` — copy it. Notes: `npm: "@ai-sdk/openai-compatible"`; `apiKey` must be present even though llama-server ignores it; models are referenced as `provider/model`; set `limit.context` to match `-c` and `limit.output` conservatively. With `--reasoning off`, set `reasoning: false` and **omit `interleaved`** — `interleaved: "reasoning_content"` is only correct if thinking is left on.

**11. Remote summarizer: rate limits are token-per-minute and account-scoped, not per-credential.** An oversized request exhausts the budget regardless of how it is routed, so adding credentials does not add capacity. Measured on the summarization model: 12,000 TPM / 1,000 RPM. Size the summarization prompt to the TPM budget — that is the actual fix. The optional/additive silent-fallback design itself worked exactly as intended in all three paths, and the local-only result is fully usable without it.

**12. SearXNG returns HTTP 200 with an empty result array when its upstream engines are throttled.** Brave (`too many requests`) and Startpage (`CAPTCHA`) were suspended the whole session; only DuckDuckGo returned results. Always read `unresponsive_engines`, and retry once on an empty set before reporting "no results" — otherwise you will chase a phantom bug in your own client.

**13. Reuse beat rebuild twice.** crawl4ai (`POST /md {"url","f":"fit"}`) fully replaced the planned Rust `spider` + `article_scraper` binary — Phase 5 became a 2-minute verification. SearXNG already had JSON enabled. **Inventory first was worth more than any single build step here.** On the 5090 Windows box the equivalent question is what the friend already has running.

**14. Port collisions are real.** llama-server's documented default 8080 was already taken by SearXNG. Used 8090. Check `ss -tlnp` before committing to a port in the directive.

**15. Skip the vision projector.** The Qwen3.5 GGUF repos ship `mmproj-*.gguf`. A coding agent does not need it and loading it only costs VRAM.

**16. Trivia that cost time:** `Qwen3.6-4B` / `Qwen3.8-4B` GGUF repos **do not exist** (HF returns 401 for nonexistent repos, which reads like an auth problem — it isn't). `unsloth/Qwen3.5-4B-GGUF` remains current. Also, don't `pkill -f opencode` from a shell whose own command line contains that string.

---

## Final state

- `agent up` -> live in ~8 s, 7031 MiB VRAM, 131072 context, MTP on, thinking off
- `agent down` -> 11 MiB, shared containers untouched
- Nothing pre-existing was deleted, overwritten, or restructured. `~/llama.cpp` (b8467), `~/prism-llama.cpp`, `~/qwen_35_4b_claude/`, and all three Docker containers are exactly as found. `.env` is byte-identical.
