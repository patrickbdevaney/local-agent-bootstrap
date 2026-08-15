# CLAUDE CODE DIRECTIVE — One-Shot Install: Fully-Local Terminal Coding Agent on this RTX 5090 Windows Machine (llama.cpp GGUF path)

You are Claude Code running on a Windows 11 machine with an NVIDIA RTX 5090 (32GB, consumer Blackwell SM120). Your job is to perform a complete, end-to-end, idempotent installation of a self-sovereign local coding-agent stack, then hand the owner two trivially simple commands: `agent up` / `agent down` and `agent code`. The owner is moderately technical: he will never edit configs, never debug a container runtime, never touch flags. Everything must work from PowerShell / Windows Terminal.

Work phase by phase. After each phase, run its verification step and do not proceed until it passes. If a step fails, diagnose and fix it yourself before moving on. Log everything installed and every file written into `C:\agent-stack\INSTALL_LOG.md` (create it) so a future session can audit or uninstall.

## Why this path (context for you, not the owner)

**Bare-metal Windows llama.cpp is the primary inference backend, not vLLM/WSL2/Docker.** This supersedes an earlier vLLM-based plan. Reasoning, verify each still holds before proceeding:

1. **KV cache math strongly favors GGUF here.** Qwen3.6/3.8-27B's hybrid architecture has only 16 of 64 layers carrying real KV cache (4 KV heads × 256 head-dim, GQA). At FP8/Q8_0 KV, that's ~32 KiB/token — the **full 262,144-token native context costs only ~8GiB of KV cache**. A GGUF weight file (Q5_K_M or Unsloth's UD dynamic quant, ~17-22GB for the 27B class) leaves 10GB+ of headroom, meaning full native context fits comfortably alongside the model with room to spare — verify actual file size and do the arithmetic yourself once the file is downloaded (32GB total − weights_GB − ~1-2GB Windows/driver/activation overhead = KV budget; KV budget ÷ 0.032GB/token = max context tokens; confirm it clears 262144).
2. **KV cache quantization on this hybrid architecture is reported as unusually low-loss**, because the surrounding linear-attention (GatedDeltaNet) layers act as error-correction, absorbing quantization noise introduced in the sparse full-attention layers — unlike a standard all-attention transformer where every layer's quantization error compounds. Default to `--cache-type-k q8_0 --cache-type-v q8_0`; if the owner or a future session validates it, `q4_0` KV is worth testing for even more headroom.
3. **llama.cpp's recurrent/hybrid cache manager is mature and native**, not an experimental flag with known correctness bugs. Prefer it over vLLM's align-mode prefix caching for this model family.
4. **MTP speculative decoding ships as a ready file**, not a moving-target nightly build: Unsloth publishes MTP-enabled GGUFs with a built-in draft head (`--spec-type draft-mtp`). No dependency on an unreleased inference-server version.
5. **Bare-metal Windows avoids WSL2 + Docker + vLLM's GPU-memory-utilization tuning, CUDA-graph pitfalls, and container lifecycle entirely** — llama-server is a single native .exe, model load/unload is a process start/stop, and there is no hidden VRAM reservation or `--gpu-memory-utilization` fraction to get wrong. This is the deciding factor for a low-friction, beginner-proof install.

### Runtime facts you MUST verify yourself before locking configs (may have changed since 2026-08-14):
1. Whether an MTP-enabled Unsloth GGUF exists for **Qwen3.8-27B** yet (check `unsloth/Qwen3.8-27B-GGUF` repo files for an `-MTP` variant or a `UD-*` quant with draft-head metadata). If not yet published, use `unsloth/Qwen3.6-27B-MTP-GGUF` tonight (proven, ships today) and note in the log to swap to the 3.8 MTP build once it appears — this is the single highest-value upgrade to watch for.
2. Confirm the exact llama.cpp flags for MTP on whichever quant you use (`--spec-type draft-mtp --spec-draft-n-max 2` is the documented Qwen3.6 invocation — check the model card for the exact flags, they may differ slightly for 3.8).
3. Confirm current mainline llama.cpp actually has fused Gated Delta Net support merged and stable (`sched_reserve: fused Gated Delta Net (autoregressive) enabled` should appear in server startup logs) — pull latest release, not an old cached build.
4. Confirm current recommended quant level from Unsloth's own guidance for this model (they periodically revise which K-quant/UD-quant is the recommended default) — prefer their current recommendation over a hardcoded Q5_K_M if it's changed.
5. Whether `-np 1` (single parallel slot) is still required with MTP (`-np > 1` and `--mmproj` were unsupported with MTP as of the last check) — the owner is single-user, so this is not a real constraint, just confirm the flag combination doesn't error.
6. Tool-calling: confirm which chat template / `--jinja` handling gives clean tool calls for this model in the current llama.cpp release; check the model repo's community discussions for any known template fixes needed for agentic tool use.

---

## PHASE 0 — Preflight

1. Confirm hardware: `nvidia-smi` shows RTX 5090, 32GB. Record driver version.
2. Confirm ≥ 100GB free disk (model file ~17-25GB, Docker Desktop + SearXNG image ~2GB, headroom for future quant swaps).
3. Confirm NVIDIA driver provides CUDA ≥ 13.0 (`nvidia-smi` header shows CUDA version).
4. Create `C:\agent-stack\` for scripts, config, and the install log.

**Verify:** all four checks recorded in INSTALL_LOG.md.

## PHASE 1 — llama.cpp (bare-metal Windows CUDA build)

1. **Prefer a prebuilt release** over compiling from source: check the `ggml-org/llama.cpp` GitHub Releases page for a Windows CUDA prebuilt binary matching the installed driver's CUDA version and `sm_120` (Blackwell) support. Download and extract to `C:\agent-stack\llama.cpp\`.
2. **If no matching prebuilt exists**, build from source: install Git, CMake, Visual Studio 2022 Community (Desktop C++ workload) and the CUDA Toolkit (matching driver) via winget if missing, then:
   ```
   git clone https://github.com/ggml-org/llama.cpp.git
   cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120
   cmake --build build --config Release -j
   ```
   Confirm `CMAKE_CUDA_ARCHITECTURES=120` (SM120/Blackwell) is correct for the current llama.cpp CMake conventions before running — check current docs, this value has shifted across CUDA/driver versions before.
3. Verify `llama-server.exe --version` runs and reports CUDA backend available.

**Verify:** `llama-server.exe -hf <any small test model> --n-gpu-layers 99` loads and responds on a quick smoke prompt; VRAM usage visible in `nvidia-smi`; process exits cleanly on Ctrl+C with VRAM released.

## PHASE 2 — Model download

1. Install `huggingface_hub[cli]` (or use llama.cpp's built-in `-hf` auto-download) via a Python install if not present, or rely on llama-server's native `-hf` fetch (simplest — no separate Python env needed).
2. Download the chosen GGUF (per Runtime Fact #1 above) into `C:\agent-stack\models\`. Use `LLAMA_CACHE` env var pointed there, or explicit `--model` path — pick whichever the current llama.cpp version handles most reliably and document the choice.
3. Record exact repo, quant level (e.g. UD-Q5_K_XL), file size, and SHA in the log.

**Verify:** file present, size matches HF listing, `llama-server.exe --model <path> --n-gpu-layers 99 -c 4096` boots without error (short context smoke test before committing to full context in Phase 3).

## PHASE 3 — Server config (the actual serving command)

Compute the KV budget yourself from the downloaded file's real size (see reasoning section above), then write the launch command into a config file `C:\agent-stack\llama-config.txt` (or equivalent) that the up-script reads. Target flags, adjust numerically once you know the real weight file size:

```
llama-server.exe
  --model C:\agent-stack\models\<file>.gguf
  --n-gpu-layers 99                    # full GPU offload, no CPU spillover
  -c <computed-max-context>            # aim for 262144 if the KV budget clears it; else the largest that fits with margin
  -fa on                               # flash attention; required for quantized KV cache
  --cache-type-k q8_0 --cache-type-v q8_0   # quantized KV; hybrid arch tolerates this well
  --spec-type draft-mtp --spec-draft-n-max 2   # only if using an MTP-enabled GGUF; omit otherwise
  --np 1                               # single-user, single slot
  --host 127.0.0.1 --port 8080
  --jinja                              # use the model's chat template (verify this is the correct current flag for tool-calling templates)
```
Leave real headroom below the computed max — do not run the arithmetic to the exact byte and then set `-c` to that number; subtract a safety margin (activation buffers, MTP draft-token buffers, and the OS/driver's own reserve) of at least 10-15% of remaining VRAM after weights.

**Verify:** server boots at the chosen `-c`, `nvidia-smi` shows sane VRAM usage (weights + KV + margin, no OOM), server log shows Gated Delta Net fused kernel active, `curl http://127.0.0.1:8080/v1/models` responds.

## PHASE 4 — SearXNG (Docker Desktop, Windows-native)

Use **Docker Desktop for Windows** here specifically (not WSL2-manual-docker) — it's the lower-friction, GUI-backed path for the one piece of this stack that genuinely wants a container, and it doesn't touch the inference server's simplicity.

1. Install Docker Desktop if absent (winget or manual installer); ensure WSL2 backend is enabled (Docker Desktop manages this itself, the owner doesn't need to touch WSL2 directly).
2. Run SearXNG: `docker run -d --name searxng -p 8081:8080 -v C:\agent-stack\searxng:/etc/searxng searxng/searxng:latest` (use port 8081, since 8080 is llama-server).
3. **Critical:** SearXNG ships with JSON API output disabled by default. After first boot writes `settings.yml`, edit it to add `json` to `search.formats`, set a non-default `server.secret_key`, then restart the container.

**Verify:** `curl "http://localhost:8081/search?q=test&format=json"` returns JSON.

## PHASE 5 — The `agent` wrapper (the whole point)

Write PowerShell scripts in `C:\agent-stack\bin\`, and put that directory on the user PATH so `agent up`, `agent down`, `agent code` work verbatim from any PowerShell/Terminal window.

- **`agent.ps1` (dispatcher)** — routes `up|down|status|code|logs|bench|test` to the functions below. Wrap as `agent.cmd` too (`@powershell -File "%~dp0agent.ps1" %*`) so it also works from cmd.exe.
- **`up`** — starts `llama-server.exe` as a background process (`Start-Process` with output redirected to a log file) using the Phase 3 config, polls `/v1/models` with a spinner ("Loading model into GPU… ~30-90s first time"), starts the SearXNG container if not running, prints a one-line status (model name, VRAM used via `nvidia-smi` parse, endpoint URLs). Idempotent — if already up, say so and exit 0.
- **`down`** — stops the llama-server process (graceful, then force after a timeout), stops the SearXNG container, prints VRAM freed (before/after `nvidia-smi` delta). Confirms GPU is idle.
- **`status`** — up/down per service, VRAM, last recorded benchmark.
- **`code`** — checks the endpoint is live (auto-runs `up` and waits if not, no prompting), then execs `opencode` in the current directory.
- **`logs`** — tails the llama-server log file.
- **`bench`** — sends a fixed prompt, measures decode tok/s, appends to a benchmarks file.
- **`test`** — the Phase 7 validation suite.

Rules: zero interactive prompts; every failure prints one actionable line; meaningful exit codes. Add a Windows Terminal profile and two desktop shortcuts ("Agent Up", "Agent Down") that call the .cmd shims.

**Verify:** from a fresh PowerShell window anywhere: `agent up` → both endpoints live; `agent down` → VRAM back to idle, SearXNG stopped; `agent code` in a scratch folder opens OpenCode.

## PHASE 6 — OpenCode + MCP + research arm

**Design principle for this phase: local-only must be the complete, default, zero-config product.** Groq is a pure speed-up bolted on top, never a dependency. Keep the whole thing simple — no job queues, no async ticket systems, no orchestration framework. A search is just an MCP tool call that returns results synchronously; the only "intelligence" is a one-line decision of how much work to do per call, based on measured local decode speed. Reference `github.com/patrickbdevaney/hermes-max` (docs/mcp-servers.md, docs/research-engine.md) for the already-solved patterns to port: SearXNG-backed search as the automatic fallback whenever a paid provider isn't configured or fails, and simple primary→auxiliary provider routing. Port those patterns; don't rebuild them from scratch.

1. Install OpenCode (npm or official installer); record version.
2. Write the provider config pointed at `http://127.0.0.1:8080/v1` — detect whether the installed OpenCode version uses the legacy `opencode.json` schema (`provider` + `auth.json` placeholder key) or the V2 schema (`providers` + `package: "@opencode-ai/ai/providers/openai-compatible"`), and write the matching form. Set default `model`/`small_model` to match the `--model` alias exposed by llama-server (confirm what model name llama-server reports at `/v1/models` — GGUF filename by default unless overridden — and match it exactly).
3. **Local scraper (the thing that makes local-only actually complete):** build a small, single-purpose Rust binary using the `spider` crate (`spider-rs/spider` — concurrency-first, streams pages, renders JS only when a page actually needs it, explicitly built for feeding AI agents; this avoids a heavyweight headless-browser default) plus `article_scraper` (embeds Mozilla Readability as a fallback content-extraction path) for clean text extraction. Wrap it as a tiny HTTP service (`POST /extract {url} -> {title, text}`) on `127.0.0.1:8082`. This is the "page contents" half of the pipeline; SearXNG is the "which pages" half. Keep it to the smallest binary that does the job — no proxy rotation, no anti-bot evasion, no distributed-worker mode; those are Spider's optional features and this box doesn't need them.
4. Register an MCP server in OpenCode that exposes two tools backed by SearXNG (`http://localhost:8081`) + the local scraper (`http://localhost:8082`): `web_search(query)` → SearXNG JSON results; `web_fetch(url)` → scraper's cleaned text. `mcp-searxng` may already cover both if its built-in URL reader is good enough — check before building a custom MCP server; only add the local Rust scraper as a distinct MCP tool if `mcp-searxng`'s extraction quality is insufficient on a real test page. Confirm both tools appear inside OpenCode.
5. **Groq — strictly optional, additive, never required.** `C:\agent-stack\.env`, restricted permissions, all lines commented out by default:
   ```
   # GROQ_API_KEY_1=
   # GROQ_API_KEY_2=
   # GROQ_API_KEY_3=
   ```
   Support any number of enumerated `GROQ_API_KEY_<N>` entries (the owner may want to round-robin across separate, unaffiliated Groq accounts to multiply his free-tier rate limit — don't assume just one key). The search/research MCP tool logic, in order, on every call:
   - If zero `GROQ_API_KEY_*` are set → skip Groq entirely, go straight to local SearXNG + scraper. This must be silent and instant, not an error path — local-only is a first-class mode, not a degraded one.
   - If one or more keys are set → try the next key in round-robin order for a single summarization/decomposition call to Groq `openai/gpt-oss-120b`. On **any** failure — invalid key, 429, 400, timeout, connection error — immediately try the next key in the list if one remains; if all configured keys have failed on this call, fall back to local SearXNG + scraper for that call and move on. Never retry-loop, never block the coding agent waiting on Groq.
   - This whole decision is a few lines of logic (try key list in order, catch-and-fallthrough, done) — do not build a health-check daemon, a circuit breaker, or a persistent failure-tracking store. Simple per-call fallback is sufficient at this scale.
6. **Scale search depth to local decode speed, automatically, with one simple rule.** Read the last recorded `agent bench` decode tok/s (Phase 3/7). If it's below a threshold you set based on the observed baseline for this box (roughly: below ~70% of the clean baseline number recorded right after install indicates the box is under load or something's degraded) → use **shallow mode**: one SearXNG query, snippets only, no page fetches, no Groq call even if configured. Otherwise → **normal mode**: one SearXNG query, fetch and extract the top 3-5 results, optionally summarize via Groq if configured and working. This is the entire "scaling" logic — one threshold, two modes. Do not build a multi-tier adaptive system; the goal is that search never competes with the coding agent for GPU time, not that the search subsystem is clever.
7. Skip RAG/vector-DB unless it integrates trivially with the installed OpenCode version — the owner's simplicity outranks feature completeness.

**Verify:** in a scratch git repo, with `.env` fully commented out (zero Groq keys) — `agent code` → OpenCode successfully (a) writes a file via tool call, (b) runs a shell command, (c) performs a web search via MCP using only SearXNG + local scraper, with zero malformed tool calls and no errors surfaced about missing Groq config. Then add one fake/invalid `GROQ_API_KEY_1` and confirm the same search still succeeds via silent fallback. Then (if the owner supplies a real key later) confirm Groq is actually used when valid and working, and that a second, deliberately-invalid `GROQ_API_KEY_2` gets skipped over correctly in round-robin order.

## PHASE 7 — Claude Code coexistence + validation suite

1. Install Claude Code per current official docs. Confirm it coexists cleanly (separate tool, no port/config collisions).
2. Automate and run, recording results in the log:
   - `/v1/models` responds correctly.
   - Tool-call battery: 10 tool-using requests, zero malformed/looping calls. If any fail, fix the chat template/`--jinja` handling before proceeding.
   - If MTP is active: check llama-server's spec-decode acceptance stats in logs; if acceptance is poor or it destabilizes, drop `--spec-draft-n-max` to 1 or remove `--spec-type draft-mtp` entirely and log why.
   - `agent bench` decode tok/s recorded as the baseline reference.
   - Long-context sanity: send a large prompt (~50K+ tokens) and confirm no OOM and reasonable TTFT; record it so the owner's expectations are set.
   - End-to-end: scratch repo, OpenCode implements a small feature + test, runs it to green.
   - `agent down` → VRAM back to idle, confirmed via `nvidia-smi`.

## PHASE 8 — Handoff docs

Write `C:\agent-stack\README.md` in plain language:
- The three commands: `agent up`, `agent code`, `agent down`. Nothing else needed.
- What loading looks like, how long it takes, what `agent status` shows.
- Web search just works out of the box, no setup — it's local by default. Groq is a completely optional speed boost: only mention it as "if you ever want, put a Groq API key in the .env file for faster research; the agent runs perfectly fine without it" — one sentence, not a setup section. Do not present it as something the owner needs to configure or understand.
- Never touch: the CUDA architecture flag, the GGUF file, the chat template — ask Claude Code instead.
- If broken: `agent logs`, then paste into Claude Code with "fix my local agent stack, files are in C:\agent-stack".
- Watch-items, date-stamped: an MTP-enabled Qwen3.8-27B GGUF appearing (swap the model file); any llama.cpp release notes mentioning Gated Delta Net fixes or speedups (update the binary); Unsloth's recommended-quant guidance changing.

## Global guardrails

- Idempotency: every phase re-runnable safely; check-before-create everywhere.
- Groq key (if added later) lives only in `.env`, never copied into any config that might get shared.
- If bare-metal Windows CUDA build genuinely cannot be gotten working after reasonable effort (rare — this path is simpler than the alternatives, so treat failures as solvable), the sanctioned fallback is WSL2 + Docker + llama.cpp (not vLLM) inside a container, keeping the same `agent` wrapper semantics via a `wsl -e` shim. Do not fall back to vLLM — the reasoning above for avoiding it still applies. Log the switch and why.
- If live docs/`--help` output contradicts a flag name or value in this directive, trust the live source, substitute, and record the deviation + evidence in INSTALL_LOG.md.