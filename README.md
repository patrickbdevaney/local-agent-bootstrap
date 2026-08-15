# local-agent-bootstrap

A **fully local coding agent**, and the reference build for standing one up again on different hardware.

[OpenCode](https://opencode.ai) is the terminal harness. [llama.cpp](https://github.com/ggml-org/llama.cpp) serves a Qwen gated-delta-hybrid GGUF. A local search stack — SearXNG plus keyless structured APIs, fused by RRF, extracted by a native Rust service — reaches the agent over MCP. One command brings the whole thing up; one command tears it down. **No cloud inference. No API key required to code.**

Every command, flag, config value, and number here comes from a real end-to-end install executed and validated on 2026-08-14. Nothing is aspirational.

---

## The core is portable; the rest is parameters

The five pieces that matter — **terminal harness → inference server → GGUF → gated-delta architecture → MCP services** — do not change between machines. What changes is a handful of values:

| Parameter | This build | The 27B target |
|---|---|---|
| GPU | RTX 4060 Laptop, 8 GB, `SM89` | RTX 5090, 32 GB, `SM120` |
| Model | Qwen3.5-4B UD-Q5_K_XL | Qwen3.8-27B |
| Context | 131,072 | computed the same way |
| OS | Ubuntu 24.04, native | Windows + WSL2 |
| Remote summarizer | optional | optional |

Everything else — the launch flags, the OpenCode config shape, the MCP servers, the extraction ladder, the `agent` CLI, the failure modes — transfers unchanged. The 8 GB card was chosen deliberately: **every constraint that bites at 8 GB is looser at 32 GB, but the mechanisms are identical.** A gotcha found here is a gotcha avoided there.

Sizing method and the WSL2 specifics: **[`wiki/11-Porting-to-27B.md`](wiki/11-Porting-to-27B.md)**.

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
| **Agentic project suite** | **5/5 projects, 38/38 checks**, 275 s total |
| **Thinking on vs off** | same task, **395 vs 6,458–32,702 tokens** (16–83×) |
| **Extraction** | **~13–37× faster, ~11× lighter** than headless Chromium |
| **Cold start / shutdown** | `agent up` ~8 s · `agent down` → VRAM back to 11 MiB idle |

Transcripts: [`INSTALL_LOG.md`](INSTALL_LOG.md), [`docs/AGENT_RUNS.md`](docs/AGENT_RUNS.md).

---

## Architecture

```
                      ┌────────────────────────────────┐
                      │  you  ·  `agent code`          │
                      └───────────────┬────────────────┘
                                      │
                      ┌───────────────▼────────────────┐
                      │  OpenCode (TUI/CLI harness)    │
                      └──────┬──────────────────┬──────┘
                             │ /v1              │ MCP (stdio)
                             │                  │
        ┌────────────────────▼─────┐   ┌────────▼───────────────────────┐
        │  llama-server :8090      │   │  mcp/search-server.mjs         │
        │  Qwen3.5-4B UD-Q5_K_XL   │   │  web_search · web_fetch        │
        │  -c 131072 · fa on       │   │  deep_research                 │
        │  KV q8_0 · MTP draft     │   └──┬──────────────┬──────────┬───┘
        │  GDN fused kernels       │      │              │          │
        └──────────┬───────────────┘   ┌──▼────────┐  ┌──▼───────┐  │
                   │                   │ SearXNG   │  │ arXiv/S2 │  │
             ┌─────▼──────┐            │ :8080     │  │ HN/SO/GH │  │
             │  the GPU   │            │ (docker)  │  │ (keyless)│  │
             └────────────┘            └─────┬─────┘  └────┬─────┘  │
                                             └──── RRF ────┘        │
                                                    │               │
                                          ┌─────────▼──────────┐    │
                                          │ extractd :11236    │    │
                                          │ (rust, native)     │    │
                                          │   ↓ fallback rung  │    │
                                          │ crawl4ai :11235    │    │
                                          └─────────┬──────────┘    │
                                                    │               │
                                          ┌─────────▼───────────────▼──┐
                                          │ inference lanes            │
                                          │ groq → cerebras → local    │
                                          │ (optional; degrades local) │
                                          └────────────────────────────┘
```

Everything except the optional summarizer lanes runs on localhost. **Every layer has a fallback, and each one has been observed failing in practice** — SearXNG's engines CAPTCHA, structured APIs 429, cloud credentials throttle. The pipeline keeps producing usable output through all of it.

---

## Quickstart

Assumes an NVIDIA driver, CUDA toolkit, Docker, Node, and Rust are present.

```bash
git clone git@github.com:patrickbdevaney/local-agent-bootstrap.git
cd local-agent-bootstrap

# 1. Build llama.cpp with CUDA (set CMAKE_CUDA_ARCHITECTURES for YOUR GPU: 89=Ada, 120=Blackwell)
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
cmake -S llama.cpp -B llama.cpp/build \
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DLLAMA_CURL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build llama.cpp/build --config Release -j

# 2. Fetch the model
mkdir -p models && curl -L --fail -C - \
  -o models/Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf \
  "https://huggingface.co/unsloth/Qwen3.5-4B-MTP-GGUF/resolve/main/Qwen3.5-4B-UD-Q5_K_XL.gguf"

# 3. Harness
npm install -g opencode-ai@latest
mkdir -p ~/.config/opencode && cp config/opencode.json ~/.config/opencode/opencode.json

# 4. Go — creates the containers, builds extractd, starts everything
ln -sf "$PWD/bin/agent" ~/.local/bin/agent
agent up
agent test
agent code
```

`agent up` creates the SearXNG and crawl4ai containers if they don't exist, **patches SearXNG to serve JSON** (off by default in a fresh image), builds `extractd` on first run, and starts llama-server. `agent.env` holds every tunable.

Optional: put summarizer credentials in `.env` (gitignored) to enable remote summarization. The pipeline works fully without it.

---

## The `agent` CLI

```
agent up               bring up the whole stack — llama-server, extractd, containers
agent down             tear it back down
agent status           endpoints, model, VRAM, RAM, search mode
agent code [path]      launch OpenCode against the local endpoint
agent logs [-f|N]      tail the llama-server log
agent bench [--save]   measure decode tok/s; --save records this box's clean baseline
agent test             health + tool battery across every component
```

`agent up` is idempotent. By default `agent down` stops only the containers it started, so a box where SearXNG or crawl4ai are shared with another project keeps them running; `AGENT_STOP_CONTAINERS=always` overrides.

---

## What the install actually taught us

Sixteen findings that cost real time. Each links to its write-up.

| # | Finding | Impact |
|---|---|---|
| 1 | **A reasoning model burns 16–83× the tokens inside an agent harness.** Thinking on, a trivial task cost 6,458–32,702 tokens vs **395** with `--reasoning off`. Neither a more specific prompt nor a bigger budget helps — the bigger budget makes it worse. | Biggest cost sink. [→](wiki/10-Gotchas-and-Deviations.md#1-the-reasoning-runaway) |
| 2 | `--np 1` is **not a valid flag**. It is `-np` / `--parallel`. | Hard startup failure. [→](wiki/10-Gotchas-and-Deviations.md#2-flag-drift) |
| 3 | **MTP needs recent llama.cpp.** A 5-month-old build offered no `draft-mtp`. | Worth 1.45× decode. [→](wiki/02-llama-cpp-Build.md) |
| 4 | **The GDN confirmation line is hidden at default verbosity** and renamed to `resolve_fused_ops:`. You need `-lv 5`. | You'd wrongly conclude GDN is off. [→](wiki/10-Gotchas-and-Deviations.md#4-the-gdn-line-moved-and-hid) |
| 5 | **Only full-attention layers cost KV.** 8 of 32 here → 17 KiB/token; the GDN recurrent state is **flat in context length**. | The whole sizing model. [→](wiki/04-VRAM-and-KV-Sizing.md) |
| 6 | **Long prefills do not spike VRAM.** A 31k prefill moved VRAM ~20 MiB. | Size right up to your margin. [→](wiki/04-VRAM-and-KV-Sizing.md#prefill-does-not-spike) |
| 7 | **New llama.cpp auto-fits params to free VRAM**, and an explicit `-ngl` disables that. | May beat hand-tuning on a big card. [→](wiki/05-Server-Configuration.md#auto-fit) |
| 8 | **SearXNG returns HTTP 200 with an empty array** when its engines are throttled. | Reads as a bug in your client. It isn't. [→](wiki/06-Search-Stack.md#the-empty-200) |
| 9 | **OpenCode uses the V2 config schema**, and `reasoning`/`interleaved` must match the server. | Copy the working file. [→](wiki/07-OpenCode-Configuration.md) |
| 10 | **Port 8080 collides** — llama-server's documented default is often taken. | Used 8090. [→](wiki/10-Gotchas-and-Deviations.md#10-port-collisions) |
| 11 | **Inventory first beat building twice.** An existing container stood the search stack up in minutes. | Saved a whole phase. [→](wiki/01-Inventory-First.md) |
| 12 | **A headless browser is the wrong default for extraction.** A 7.8 MB Rust service is **~13–37× faster and ~11× lighter** than headless Chromium while extracting *more* content. | [→](extractor/README.md) |
| 13 | **SearXNG cannot be the only source layer.** All three engines went down mid-session and search returned nothing; keyless structured APIs fused by RRF answered the same query with six relevant papers. | [→](wiki/06-Search-Stack.md) |
| 14 | **Rate limits are account-scoped, not credential-scoped.** More credentials on one account add no throughput; a second *provider* does. | [→](wiki/06-Search-Stack.md) |
| 15 | **Prefix caching works on this recurrent hybrid and is worth 14–49× on prefill** (11,651 → 843 → 238 ms at 21k tokens). Prompt-prefix stability is now the top design constraint: injecting retrieved context at the front costs ~11 s of prefill *every turn*. | [→](docs/RESEARCH_FINDINGS.md) |
| 16 | **No tool-count cliff at 150 tools** (100% selection accuracy), against a literature prediction of failure at 46. llama.cpp's function-calling grammar restricts names structurally. Tool budget is not the constraint. | [→](docs/RESEARCH_FINDINGS.md) |

---

## Documentation map

| Document | What's in it |
|---|---|
| [`wiki/`](wiki/README.md) | Structured reference, one page per subsystem — **start here** |
| [`wiki/11-Porting-to-27B.md`](wiki/11-Porting-to-27B.md) | Sizing method, worked 32 GB budget, WSL2 specifics |
| [`wiki/10-Gotchas-and-Deviations.md`](wiki/10-Gotchas-and-Deviations.md) | Every place reality contradicted the plan |
| [`INSTALL_LOG.md`](INSTALL_LOG.md) | Raw chronological install log |
| [`docs/AGENT_RUNS.md`](docs/AGENT_RUNS.md) | Five agentic engineering projects, with results |
| [`extractor/README.md`](extractor/README.md) | extractd — design and the browser comparison |
| [`experiments/reasoning-budget/`](experiments/reasoning-budget/README.md) | Can a better prompt or bigger budget replace `--reasoning off`? (No.) |
| [`docs/RESEARCH_PROMPT.md`](docs/RESEARCH_PROMPT.md) | The deep-research prompt used to plan augmentations — constraint filter, search surface, required output |
| [`docs/RESEARCH_FINDINGS.md`](docs/RESEARCH_FINDINGS.md) | Its results. Two local measurements inverted the literature — see §0 and §1 |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Tiered plan with per-item cost, degradation, and kill criteria |

---

## Repository layout

```
agent.env                 every tunable, sourced by bin/agent
bin/agent                 the CLI
bin/toolcall-battery.py   10-case tool-calling validation
config/opencode.json      working OpenCode V2 provider + MCP config
extractor/                extractd — native Rust extraction service (rung 1)
mcp/search-server.mjs     dependency-free MCP server (web_search, web_fetch, deep_research)
mcp/sources.mjs           structured source adapters + RRF fusion
mcp/lanes.mjs             multi-provider inference lanes
projects/                 agentic engineering projects run against the stack
experiments/              controlled experiments
docs/                     run results and research
wiki/                     structured reference documentation
INSTALL_LOG.md            raw install log
```

`.env`, `models/`, `llama.cpp/`, `extractor/target/`, `logs/`, and `run/` are gitignored.

---

## Status

Personal reference build. No warranty, no support. The numbers are real and reproducible on the stated hardware; treat them as a starting point rather than a guarantee on yours.
