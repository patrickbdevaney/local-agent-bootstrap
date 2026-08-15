# Research Findings — Augmenting the Local Coding Agent

Executed against [`RESEARCH_PROMPT.md`](RESEARCH_PROMPT.md) on 2026-08-14. Two evidence classes, kept strictly separate:

- **[MEASURED HERE]** — run on this box, on this model, this session. Highest confidence.
- **[LITERATURE]** — published results. Flagged where the evidence comes only from frontier models and may not transfer to 4B–27B.

The headline: **the single most valuable finding was measured locally and inverts the obvious plan.**

---

## 0. The finding that reframes everything

### Prefix caching works on our recurrent hybrid, and it is worth 14–49× on prefill [MEASURED HERE]

A 21,042-token prompt, then a second turn sharing that prefix, then a repeat:

| Turn | Prompt tokens | Cached | Prefill time |
|---|---|---|---|
| 1 — cold | 21,042 | 0 | **11,651 ms** |
| 2 — shared prefix + 2 messages | 21,073 | 21,038 | **843 ms** (13.8×) |
| 2 — repeated | 21,073 | 21,069 | **238 ms** (49×) |

`--cache-ram` defaults to 8192 MiB in our build and host-memory prompt caching is on by default.

**Why this matters more than anything else in this document:** it makes *prompt prefix stability a first-class architectural constraint*, and it kills the most obvious form of the augmentation everyone reaches for first.

> **Injecting retrieved memories, RAG chunks, or a rebuilt "playbook" near the top of the prompt invalidates the prefix cache and costs ~11 seconds of prefill on every single turn.** A memory system that "helpfully" prepends 2k tokens of relevant context is not paying 2k tokens. It is paying 2k tokens **plus the entire prefill of the whole conversation, every turn.**

Everything below is filtered through this. The correct shape for augmentation is **append-only at the tail**, or **out-of-band entirely** (tool results, files on disk, between-turn work) — never a mutating prefix.

**Important nuance** [LITERATURE]: `--cache-reuse` (KV shifting to reuse a *non-prefix* chunk) genuinely does **not** work with recurrent-state models, and a llama.cpp discussion specifically about OpenCode reports that **switching agents mid-session** (Plan → Build) changes the system prompt and forces full reprocessing, with no flag-based workaround. So: plain longest-common-prefix continuation works and is fast; anything that edits earlier context does not.
Sources: [llama.cpp #22354](https://github.com/ggml-org/llama.cpp/discussions/22354), [llama.cpp #20574](https://github.com/ggml-org/llama.cpp/discussions/20574)

---

## 1. Context is the binding constraint, and bigger is worse

### Context rot is real and non-linear [LITERATURE]

Across 18 frontier models (GPT-4.1, Claude 4, Gemini 2.5, **Qwen3**), accuracy drops **30–50%** well before the documented context limit. Degradation is not gradual — models hit cliffs, fine at 32K and collapsing at 64K. One controlled study: reasoning accuracy fell **0.92 → 0.68** as inputs grew from a few hundred to three thousand tokens. Agentic solving rates drop from **25–35% at 0–4K tokens to 5–10% at 32K+**.

Counter-intuitive detail worth internalising: **coherent, well-structured input degrades attention *more* than shuffled input.**

**Implication for us:** our 131,072-token window is a *capacity* number, not a *usable* number. Running the agent at 100k occupied context is likely worse than running it at 20k with precise retrieval. **Aggressive compaction and precise retrieval are not optimizations — they are correctness features.**
Source: [ChromaDB Context Rot](https://www.zenml.io/llmops-database/context-rot-evaluating-llm-performance-degradation-with-increasing-input-tokens)

### Tool count: the literature said cliff at 46. Our model does not cliff at 150. [MEASURED HERE]

[LITERATURE] **~8B models peak at roughly 19 tools and fail at 46**, with a cliff rather than a slope; each tool definition costs 200–500 tokens.
Sources: [Speakeasy](https://www.speakeasy.com/mcp/tool-design/less-is-more/), [Jenova](https://www.jenova.ai/en/resources/mcp-tool-scalability-problem)

That number would have set a hard budget of ~8–12 new tools, so it was worth measuring directly rather than inheriting. `bin/toolcall-battery.py --sweep` pads the 3 real tools with plausible, partially-overlapping decoys and re-runs the same 10 cases:

| Tools | Passed | Rate | Tool-def tokens | Generated tokens |
|---|---|---|---|---|
| 3 | 10/10 | 100% | 179 | 326 |
| 10 | 10/10 | 100% | 568 | 326 |
| 20 | 10/10 | 100% | 1,113 | 326 |
| 30 | 10/10 | 100% | 1,671 | 326 |
| 40 | 10/10 | 100% | 2,197 | 326 |
| 50 | 10/10 | 100% | 2,728 | 338 |
| 60 | 10/10 | 100% | 3,277 | 326 |
| 80 | 10/10 | 100% | 4,390 | 326 |
| 100 | 10/10 | 100% | 5,457 | 326 |
| **150** | **10/10** | **100%** | **8,187** | 326 |

**No degradation at all, at 3× the count where the literature predicts total failure.** Generated tokens are flat too — the model is not doing more work to choose.

**Likely explanation:** llama.cpp's function-calling path constrains generation with its own internal grammar, so the tool *name* is mechanically restricted to the declared set. Hallucinated tool names are impossible by construction; only mis-selection among valid names is. That is a structural advantage of this stack that a JSON-prompted API does not have.

**Honest caveat:** the 10 cases span three clearly distinct domains (weather / file / SQL). The decoys include genuine overlaps (`list_files`, `write_file`, `read_logs`, `fetch_url`, `list_tables`), but a harder suite of near-synonymous tools might still find a cliff. **Treat 150 as a demonstrated floor on robustness, not a proven ceiling.**

**Revised implication — the constraint moved, it did not disappear.** Tool-selection accuracy is *not* the binding constraint for us. **Token cost is**: 150 tools is 8,187 tokens on every turn, which matters given context rot (§1).

But those tokens sit at the *front* of the prompt, in the stable region — so per §0 they are **prefix-cached and paid once**, not per turn. This is the synthesis: *tool definitions are cheap here precisely because they are prefix-stable.* The thing to protect is not the tool count. It is the stability of everything before the conversation tail.

## 2. Retrieval: the literature says do *less* than planned

### Agentic grep beats vector RAG for code, at exactly our model scale [LITERATURE]

**+24% relative over RAG for Qwen2.5-7B, +20% for the 3B model.** An LLM driving `ripgrep` in a loop beats a frozen embedding index on a codebase that changes every commit. Claude Code, Cursor, Codex CLI and Aider all use ripgrep as the primary code search. Ripgrep is 5–13× faster than GNU grep; agents run 10–30 searches per task, and 30 searches complete in under a second.

**Implication:** **do not build a code vector index.** It would cost an embedding model, a vector store, an indexing pipeline, staleness management, and VRAM or CPU — to underperform a tool OpenCode already has. This is the single largest piece of planned work the research kills.

The corpus case is different: **accumulated research prose** (not code) is stable, doesn't change every commit, and is genuinely a retrieval problem. That is where an index earns its place — and it can be CPU-only and small because the corpus is small.
Sources: [Better Call Grep (arXiv 2601.23254)](https://arxiv.org/abs/2601.23254), [CORE-Bench](https://arxiv.org/pdf/2606.11864)

---

## 3. Self-improvement: viable, but only offline

### GEPA works at small scale, and beats the alternatives [LITERATURE]

ICLR 2026 Oral. **On Qwen3-8B, GEPA beats GRPO by up to 20% using 35× fewer rollouts, and beats MIPROv2 by over 10%** (+12% on AIME-2025); +13% aggregate vs MIPROv2's +5.6%.

This is the rare self-improvement result with *small-open-model* evidence rather than frontier-only evidence, which is why it survives the §2.5 filter where most of the reflexion/self-refine literature does not.
Sources: [GEPA arXiv 2507.19457](https://arxiv.org/abs/2507.19457), [OpenReview](https://openreview.net/forum?id=RQm2KQTM5r)

### ACE: evolving playbooks, and the failure mode to avoid [LITERATURE]

Agentic Context Engineering treats context as an evolving playbook via Generator → Reflector → Curator. **+10.6% on agents, +8.6% on finance, matching a top production agent on AppWorld using a smaller open-source model.**

Its framing of the two failure modes is the most useful part:
- **Brevity bias** — summarization drops domain detail.
- **Context collapse** — iterative rewriting erodes information over time.

**But note the §2.1 and §0 conflict:** ACE rewrites the context. A rewritten prefix destroys the prompt cache. ACE-style curation must run **offline, between sessions**, producing a *stable* artifact that stays fixed during a session — not a live in-turn rewrite.
Source: [ACE arXiv 2510.04618](https://arxiv.org/abs/2510.04618)

### Sleep-time compute is the structural answer to the single-slot problem [LITERATURE]

Letta's sleep-time agents run on a background heartbeat with no user input: consolidate archival memory, rewrite memory blocks, summarize conversation into stable notes.

**This is the cleanest resolution of §2.1 in the whole document.** The GPU is idle at night. Every expensive LLM-driven augmentation — memory consolidation, prompt optimization, corpus curation, lesson extraction — can run then, contend with nothing, and produce artifacts that are *read cheaply* during the day.
Source: [Letta memory blocks](https://www.letta.com/blog/memory-blocks/)

---

## 4. Correctness and structure

### Constrained decoding is powerful — but conflicts with tool calling [LITERATURE]

Constrained decoding can be **~50% faster** than unconstrained, and one benchmark went from **0% accuracy at 37,705 tokens to 75% accuracy at 4,440 tokens** with constraints applied — an 8.5× token reduction *and* a correctness win. Output is guaranteed parseable: no retries, no fallback parser.

**The blocking caveat:** in llama.cpp, **grammar and function-calling cannot be used simultaneously** — function calling uses its own internal grammar. And there is published work on a "constraint tax": structured-output constraints can *suppress* tool calling in open-weight models.

**Implication:** GBNF is not available for the main agent loop while tool calling is in use. It **is** available for *auxiliary* generations — offline classification, extraction, corpus curation, structured summarization — where no tool calling is involved. Use it there.
Sources: [llama.cpp grammars](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md), [Constraint Tax (arXiv 2606.25605)](https://arxiv.org/pdf/2606.25605)

### The harness is worth 10–20 points [LITERATURE]

SWE-bench shows **harness variance of 10–20 percentage points on identical model weights.** Terminal-Bench 2.0 is the current standard for terminal agents: 89 tasks, 16 categories, Docker-isolated, locally runnable.

**This validates the entire exercise** — augmentation genuinely competes with model choice — and it names the eval we should be running.
Sources: [Terminal-Bench / SWE-bench guide](https://www.digitalapplied.com/blog/swe-bench-terminal-bench-benchmark-guide-2026)

---

## 5. Ranked shortlist

Each line: **what it costs per turn**, because §2.2 is the filter that matters.

### Tier 1 — foundation (build first, no dependencies)

| # | Capability | Why it wins here | §2 line |
|---|---|---|---|
| **1** | **Prefix-stability discipline + cache instrumentation** | 14–49× prefill, **measured here**. Costs nothing. Also *prevents* the most likely self-inflicted regression. | 0 tokens/turn, 0 MB, 0 services. Degrades to: current behavior. |
| **2** | **Eval harness** (extend `projects/`, Terminal-Bench-shaped) | Without it every later item is a guess; harness variance is 10–20 pts. | 0 tokens/turn (offline). Degrades to: no measurement. |
| **3** | **Token/latency observability per turn** | Cannot manage context without seeing it. llama-server already emits the data. | 0 tokens/turn. Degrades to: no telemetry. |
| **4** | **Verification gate** (tests/typecheck/lint as a hard done-gate) | Deterministic, beats any LLM critic at 4B, and *saves* tokens by killing "done" → "actually broken" loops. | ~1 tool (~300 tok), runs on demand. Degrades to: no gate. |

### Tier 2 — compounding (depends on Tier 1)

| # | Capability | Why it wins here | §2 line |
|---|---|---|---|
| **5** | **Append-only session journal + offline lesson extraction** | Accumulates knowledge without touching the prefix. Extraction runs at night. | 0 tokens/turn during session. Degrades to: plain log. |
| **6** | **Dual-corpus research memory** (human-readable linked markdown + CPU-only index) | The corpus is prose, small, and stable — the one place an index genuinely beats grep. Feeds `deep_research`. | ~1 tool. CPU-only embed. Degrades to: ripgrep over markdown. |
| **7** | **Sleep-time consolidation loop** (`agent sleep`) | Resolves the single-slot constraint structurally. Idle GPU does the expensive work. | 0 tokens/turn. Degrades to: no-op. |
| **8** | **GBNF-constrained auxiliary generation** | 8.5× token reduction where available; safe because no tool calling in these paths. | Offline only. Degrades to: unconstrained + validation. |

### Tier 3 — ambitious

| # | Capability | Why it wins here | Risk |
|---|---|---|---|
| **9** | **GEPA/ACE offline prompt+playbook optimization** | Best small-model evidence of any self-improvement method. | Needs #2 to prove it helped; needs many rollouts. |
| **10** | **Continuous goal loop** (`agent pursue`, runs until goal met or stopped) | The long-horizon ask. Needs #4 as the convergence signal. | Destructive drift without hard gates and checkpointing. |
| **11** | **Structural clamps on turns** (port from `hermes-max`) | Constrains a weak reasoner deterministically. | Tool-budget cost; must justify a slot. |
| **12** | **Model routing** (small router / large executor) | Plausible on 32 GB. | Swap cost may exceed benefit; unmeasured. |

---

## 6. Reject list — do not build these here

As required by §5.3. Each is killed by a specific constraint, not by taste.

| Rejected | Killed by |
|---|---|
| **Code vector index / semantic code search** | §2 + measured literature: agentic grep beats RAG by **20–24% at 3B–7B**. Costs an embedder, a store, an indexing pipeline and staleness management to *underperform* `ripgrep`, which OpenCode already has. |
| **Live memory injection into the prompt prefix** | **§0 [MEASURED HERE]** — destroys the prefix cache; costs ~11 s of prefill **per turn** on top of the injected tokens. The single most expensive mistake available to us. |
| **In-session context rewriting (naive ACE)** | Same as above. ACE's *offline* form is Tier 3; its online form is a cache catastrophe here. |
| ~~A large MCP tool suite~~ — **rejection withdrawn** | Killed by literature, then **revived by measurement**: our model holds 100% selection accuracy at 150 tools. The real limit is token cost, which prefix caching largely amortizes. Add tools on their own merits; do not budget-cap them at 12. |
| **GBNF on the main agent loop** | llama.cpp cannot combine grammars with function calling; published "constraint tax" shows constraints suppress tool calls. |
| **LLM-as-critic / reflexion loops on the local model** | §2.5 — the local model reasons weakly and this literature is frontier-model evidence. A test run is a better critic than a 4B opinion, and cheaper. |
| **Parallel sub-agent orchestration for throughput** | §2.1 — one inference slot. Sub-agents serialise. Justifiable *only* for context isolation, never for speed. |
| **Graph-RAG over the codebase** | Construction requires entity/relation extraction from a weak model; expensive ceremony versus tree-sitter + LSP, which are deterministic and free. |
| **A GPU embedding model** | §2.3 — 7.03 of 7.8 GB VRAM is committed. Any embedder evicts KV cache. CPU-only or nothing. |

---

## 7. Measurement plan

Nothing above ships without a before/after number.

| Metric | Instrument | Baseline (today) |
|---|---|---|
| Prefill ms / turn, cache hit rate | llama-server `timings` + `cached_tokens` | 11,651 ms cold / 843 ms warm @ 21k |
| Tokens per completed task | server log, summed per run | 3,134 for 5 projects |
| Task success rate | `projects/run-all.sh` | 38/38 checks, 5/5 |
| Decode tok/s in-loop | server log | 56.4 median |
| Tool-call validity | `bin/toolcall-battery.py` | 10/10 |
| Tool count vs selection accuracy | extend the battery as tools are added | 3 custom tools today |

**Kill criteria are mandatory.** Each capability states what measurement would prove it is not worth keeping — see the plan.

---

## 8. Open questions

1. ~~Where is our tool-count cliff?~~ **Answered by measurement: there isn't one below 150 tools.** The follow-up question is whether a deliberately adversarial suite of near-synonymous tools finds one. Worth an hour if we ever approach 50+ real tools.
2. **Does context rot bite at 4B the way it does at frontier scale?** If the effective window is ~20k rather than 131k, aggressive compaction becomes urgent rather than nice.
3. **Does OpenCode's agent switching invalidate our prefix cache in practice?** [LITERATURE] says yes for another model; unverified here and directly measurable.
4. **Can a 27B run GEPA on itself overnight to useful effect?** No evidence found either way at that scale.
5. **Is MTP's 1.45× preserved under heavy prefix-cache hits?** Unmeasured; the interaction is unobvious.

---

## Sources

- [llama.cpp: OpenCode agent cache reuse](https://github.com/ggml-org/llama.cpp/discussions/22354) · [Host-memory prompt caching](https://github.com/ggml-org/llama.cpp/discussions/20574) · [KV cache reuse tutorial](https://github.com/ggml-org/llama.cpp/discussions/13606) · [Grammars](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)
- [GEPA (arXiv 2507.19457)](https://arxiv.org/abs/2507.19457) · [OpenReview](https://openreview.net/forum?id=RQm2KQTM5r)
- [ACE (arXiv 2510.04618)](https://arxiv.org/abs/2510.04618)
- [Better Call Grep (arXiv 2601.23254)](https://arxiv.org/abs/2601.23254) · [CORE-Bench (arXiv 2606.11864)](https://arxiv.org/pdf/2606.11864)
- [Constraint Tax (arXiv 2606.25605)](https://arxiv.org/pdf/2606.25605)
- [Context Rot evaluation](https://www.zenml.io/llmops-database/context-rot-evaluating-llm-performance-degradation-with-increasing-input-tokens)
- [MCP tool scalability](https://www.jenova.ai/en/resources/mcp-tool-scalability-problem) · [Speakeasy: less is more](https://www.speakeasy.com/mcp/tool-design/less-is-more/)
- [Letta memory blocks](https://www.letta.com/blog/memory-blocks/)
- [SWE-bench vs Terminal-Bench 2026](https://www.digitalapplied.com/blog/swe-bench-terminal-bench-benchmark-guide-2026)
