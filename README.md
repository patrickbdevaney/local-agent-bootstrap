# local-agent-bootstrap

A **fully local coding agent**: [OpenCode](https://opencode.ai) as the harness, [llama.cpp](https://github.com/ggml-org/llama.cpp) as the inference server, a Qwen3.5 gated-delta hybrid GGUF as the model, and a local search stack (SearXNG + crawl4ai) exposed to the agent over MCP. No cloud inference. No API key required to code.

This repository is **not a plan**. Every command, flag, config file, and number in it comes from a real end-to-end install that was executed and validated on 2026-08-14. It exists to be the calibrated reference for a second, larger install — **Qwen3.8-27B on an RTX 5090 under Windows/WSL2** — so that run does not have to rediscover the same dozen gotchas.

> **Scope note.** This build targets an 8 GB RTX 4060 Laptop GPU deliberately. The point was never decode speed; it was to prove the *pattern* — hybrid-architecture GGUF serving, MTP speculative decoding, tool calling, MCP search, and clean failure behavior — on hardware small enough that every constraint bites. Everything that bites at 8 GB is easier on the 32 GB target.

---

## Validated result

| | |
|---|---|
| **Model** | `unsloth/Qwen3.5-4B-MTP-GGUF` → `Qwen3.5-4B-UD-Q5_K_XL.gguf` (3.30 GB) |
| **Context** | 131,072 tokens |
| **VRAM** | 7,031–7,053 MiB of 8,188 MiB (~1.1 GB free) |
| **Decode** | **78.6 tok/s** short context, 67.5 tok/s at 31k context |
| **MTP speculative decoding** | **1.45×** (80 vs 55.5 tok/s), 0.71 draft acceptance |
| **Prefill** | 1,795 tok/s on a 31,492-token prompt |
| **Tool-call battery** | **10/10**, zero malformed, zero looping, 26–45 tokens/call |
| **End-to-end coding task** | 3 correct edits, `pytest` green, exit 0 |
| **Agentic project suite** | **5/5 projects, 38/38 checks**, 275 s total |
| **Thinking on vs off** | same task, **395 vs 6,458–32,702 tokens** (16–83×) |
| **Cold start** | `agent up` → live in ~8 s |
| **Shutdown** | `agent down` → VRAM back to 11 MiB idle, no leak |

Full transcripts: [`INSTALL_LOG.md`](INSTALL_LOG.md) (install) and [`docs/AGENT_RUNS.md`](docs/AGENT_RUNS.md) (agentic project runs).

---

## Architecture

```
                        ┌──────────────────────────────┐
                        │  you  ·  `agent code`        │
                        └───────────────┬──────────────┘
                                        │
                        ┌───────────────▼──────────────┐
                        │  OpenCode 1.18.18 (TUI/CLI)  │
                        │  provider: openai-compatible │
                        └───────┬───────────────┬──────┘
                                │ /v1           │ MCP (stdio)
                                │               │
        ┌───────────────────────▼──┐   ┌────────▼─────────────────────┐
        │  llama-server :8090      │   │  mcp/search-server.mjs       │
        │  Qwen3.5-4B UD-Q5_K_XL   │   │  web_search  ·  web_fetch    │
        │  -c 131072  ·  fa on     │   └────┬──────────────────┬──────┘
        │  KV q8_0  ·  MTP draft   │        │                  │
        │  GDN fused kernels       │   ┌────▼──────┐   ┌───────▼────────┐
        └──────────┬───────────────┘   │ SearXNG   │   │ crawl4ai       │
                   │                   │ :8080     │   │ :11235  POST/md│
             ┌─────▼──────┐            │ (docker)  │   │ (docker)       │
             │ RTX 4060   │            └───────────┘   └────────────────┘
             │ 8 GB CUDA  │                  │                 │
             └────────────┘            search results     readable text
                                              └────────┬────────┘
                                                       │  optional, never required
                                              ┌────────▼─────────┐
                                              │ remote summarizer│
                                              │ (silent fallback)│
                                              └──────────────────┘
```

Everything below the OpenCode box runs on localhost. The remote summarizer is the only optional outbound call, and the pipeline is fully functional with it disabled, misconfigured, or unreachable — verified in three separate failure modes.

---

## Environment as validated

| Component | Version / value |
|---|---|
| OS | Ubuntu 24.04.4 LTS (noble), kernel 6.17.0-14 — **native Linux, no WSL2** |
| GPU | NVIDIA RTX 4060 Laptop, 8188 MiB, compute capability **8.9** (Ada) |
| Driver / CUDA | 570.211.01 / CUDA 12.8 (toolkit `/usr/local/cuda-12.8`, nvcc V12.8.93) |
| llama.cpp | master `16d222fc`, built 2026-08-15 |
| Build flags | `-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 -DLLAMA_CURL=ON -DCMAKE_BUILD_TYPE=Release` |
| Model | `Qwen3.5-4B-UD-Q5_K_XL.gguf`, 3,304,827,200 bytes |
| OpenCode | `opencode-ai@1.18.18` (npm), config schema **V2** |
| Node | v22.18.0 |
| Docker | 29.2.1 — `searxng/searxng:latest`, `unclecode/crawl4ai:latest` v0.8.6 |
| cmake / gcc | 3.28.3 / 13.3.0 |

---

## Quickstart

Assumes CUDA toolkit, Docker, Node, and an NVIDIA driver are already present.

```bash
git clone git@github.com:patrickbdevaney/local-agent-bootstrap.git
cd local-agent-bootstrap

# 1. Build llama.cpp with CUDA (set CMAKE_CUDA_ARCHITECTURES for YOUR GPU)
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
cmake -S llama.cpp -B llama.cpp/build \
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DLLAMA_CURL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build llama.cpp/build --config Release -j

# 2. Fetch the model
mkdir -p models && curl -L --fail -C - \
  -o models/Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf \
  "https://huggingface.co/unsloth/Qwen3.5-4B-MTP-GGUF/resolve/main/Qwen3.5-4B-UD-Q5_K_XL.gguf"

# 3. Search stack (skip either if you already run it)
docker run -d --name searxng  -p 8080:8080  searxng/searxng:latest
docker run -d --name crawl4ai -p 11235:11235 unclecode/crawl4ai:latest
# SearXNG ships with JSON output OFF by default — see the wiki for the settings.yml patch.

# 4. Harness
npm install -g opencode-ai@latest
mkdir -p ~/.config/opencode && cp config/opencode.json ~/.config/opencode/opencode.json

# 5. Go
ln -sf "$PWD/bin/agent" ~/.local/bin/agent
agent up
agent test
agent code
```

`agent.env` holds every tunable. Nothing else needs editing for a same-spec box.

---

## The `agent` CLI

```
agent up               start llama-server, verify shared services, print status (idempotent)
agent down             stop llama-server only; leaves searxng/crawl4ai running
agent status           endpoints, model, VRAM, RAM, search mode
agent code [path]      launch OpenCode against the local endpoint
agent logs [-f|N]      tail the llama-server log
agent bench [--save]   measure decode tok/s; --save records this box's clean baseline
agent test             health + tool battery across every component
```

`agent down` deliberately **never** touches the SearXNG or crawl4ai containers. On the validation box both predate this project and are shared with other work; stopping them would break something else. If you own those containers exclusively, that policy is one line in `bin/agent`.

---

## What the install actually taught us

The eleven findings below cost real time to discover. They are the reason this repo exists. Each links to its full write-up.

| # | Finding | Impact |
|---|---|---|
| 1 | **A reasoning model burns 16–83× the tokens inside an agent harness.** Thinking on, a trivial task cost 6,458–32,702 tokens vs **395** with `--reasoning off`. Neither a more specific prompt nor a bigger budget helps — the bigger budget makes it worse. | Biggest cost sink. [→](wiki/10-Gotchas-and-Deviations.md#1-the-reasoning-runaway) |
| 2 | `--np 1` is **not a valid flag**. It is `-np` / `--parallel`. | Hard startup failure. [→](wiki/10-Gotchas-and-Deviations.md#2-flag-drift) |
| 3 | **MTP needs recent llama.cpp.** A 5-month-old build offered no `draft-mtp`. Current master does. | Worth 1.45× decode. [→](wiki/02-llama-cpp-Build.md) |
| 4 | **The GDN confirmation line is hidden at default verbosity** and was renamed to `resolve_fused_ops:`. You need `-lv 5`. | You'd wrongly conclude GDN is off. [→](wiki/10-Gotchas-and-Deviations.md#4-the-gdn-line-moved-and-hid) |
| 5 | **Only full-attention layers cost KV.** 8 of 32 layers here → 17 KiB/token. The GDN recurrent state is **flat in context length**. | The whole sizing model. [→](wiki/04-VRAM-and-KV-Sizing.md) |
| 6 | **Long prefills do not spike VRAM** — the compute buffer is pre-reserved at load. A 31k prefill moved VRAM ~20 MiB. | You can size right up to your margin. [→](wiki/04-VRAM-and-KV-Sizing.md#prefill-does-not-spike) |
| 7 | **New llama.cpp auto-fits params to free VRAM**, and an explicit `-ngl` disables that. | Possibly better than hand-tuning on a big card. [→](wiki/05-Server-Configuration.md#auto-fit) |
| 8 | **SearXNG returns HTTP 200 with an empty array** when upstream engines are throttled. | Reads as a bug in your client. It isn't. [→](wiki/06-Search-Stack.md#the-empty-200) |
| 9 | **OpenCode uses the V2 config schema.** Definitions are literally named `ConfigV2.*`. | Copy the working file. [→](wiki/07-OpenCode-Configuration.md) |
| 10 | **Port 8080 collides** — llama-server's documented default is often already taken. | Used 8090. [→](wiki/10-Gotchas-and-Deviations.md#10-port-collisions) |
| 11 | **Inventory first beat building twice.** An existing crawl4ai container replaced an entire planned Rust scraper phase. | Saved a whole phase. [→](wiki/01-Inventory-First.md) |

---

## Documentation map

| Document | What's in it |
|---|---|
| [`INSTALL_LOG.md`](INSTALL_LOG.md) | The raw chronological install log — every command, output, and deviation, as it happened |
| [`docs/AGENT_RUNS.md`](docs/AGENT_RUNS.md) | Five agentic engineering projects run against this stack, with results and analysis |
| [`projects/`](projects/) | Those projects — seeds, prompts, verification scripts, and the run harness |
| [`experiments/reasoning-budget/`](experiments/reasoning-budget/README.md) | Controlled 8-run test of whether prompt specificity or a bigger token budget can replace `--reasoning off` (they can't) |
| [`wiki/`](wiki/) | Structured reference, one page per subsystem — start at [`wiki/README.md`](wiki/README.md) |
| [`wiki/11-Porting-to-27B.md`](wiki/11-Porting-to-27B.md) | **The sizing method and worked numbers for the 27B Windows/WSL2 target** |

---

## Porting to Qwen3.8-27B on an RTX 5090 (Windows/WSL2)

That is the reason this exists. The full method — including how to compute the KV budget for a model you have not downloaded yet, and a worked 32 GB budget — is in **[`wiki/11-Porting-to-27B.md`](wiki/11-Porting-to-27B.md)**.

The short version:

1. **Inventory the target box before installing anything.** It saved an entire phase here.
2. **Check `llama-server --help | grep -A2 spec-type` first.** That one line tells you whether MTP is available. If it isn't, rebuild before anything else.
3. **Count only `full_attention` layers** when computing KV. Use `n_embd_k_gqa` / `n_embd_v_gqa` from `print_info`, not hand-derived head math.
4. **Test `--reasoning off` immediately.** It is one flag and it was the single biggest blocker here.
5. **Try the auto-fit** (omit `-ngl` and `-c`) on a large card before hand-picking values.

---

## Repository layout

```
agent.env                 every tunable, sourced by bin/agent
bin/agent                 the CLI
bin/toolcall-battery.py   10-case tool-calling validation
config/opencode.json      working OpenCode V2 provider + MCP config
mcp/search-server.mjs     dependency-free MCP server (web_search, web_fetch)
projects/                 agentic engineering projects run against the stack
experiments/              controlled experiments (reasoning cost vs prompt/budget)
docs/AGENT_RUNS.md        results of those runs
wiki/                     structured reference documentation
INSTALL_LOG.md            raw install log
```

`.env`, `models/`, `llama.cpp/`, `logs/`, and `run/` are gitignored.

---

## License / status

Personal reference build. No warranty, no support. The numbers are real and reproducible on the stated hardware; treat everything as a starting point rather than a guarantee on yours.
