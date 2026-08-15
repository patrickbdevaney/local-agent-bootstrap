# Deep Research Prompt — Augmenting a Local Sequential Terminal Coding Agent

> **How to use this.** Hand this whole document to a research agent with web access. It is written to be executed, not skimmed: §2 is the hard constraint filter that every candidate must survive, §4 is the search surface, §5 is the required output shape. The value of the answer is decided almost entirely by whether §2 is enforced honestly.

---

## 1. The system under augmentation

A **fully local, single-user, sequential terminal coding agent**, already built and validated:

| Layer | What runs |
|---|---|
| Harness | **OpenCode** (TUI/CLI), MCP over stdio, OpenAI-compatible provider |
| Inference | **llama.cpp** `llama-server`, one process, **`--parallel 1` (a single slot)** |
| Model | Qwen gated-delta hybrid GGUF — 4B here, 27B on the target box |
| Context | 131,072 tokens, KV `q8_0`, flash attention, MTP speculative decoding |
| Search | SearXNG + keyless structured APIs (arXiv, Semantic Scholar, HN, Stack Exchange, GitHub), fused by Reciprocal Rank Fusion |
| Extraction | `extractd` — native Rust, `reqwest`+`dom_smoothie`+`htmd`; headless Chromium demoted to a fallback rung |
| Inference lanes | optional remote providers, per-provider lanes, **local llama-server as the last lane** |
| Lifecycle | `agent up` / `agent down` — one command brings up every service and tears it down |

**Measured behavior that constrains everything below:**

- Decode **~78 tok/s** at 4B / short context; **~56 tok/s** median inside a real agent loop (short tool-call completions dominate).
- Prefill **~1,795 tok/s**; a 31k-token prompt costs roughly 18 s of prefill alone.
- **One inference slot.** Any augmentation that calls the local model *during* an agent turn serialises behind that turn. There is no spare capacity on the GPU.
- **VRAM is fully committed**: 7.03 GB of 7.8 GB usable at 128k context. An augmentation needing a GPU embedding model must justify evicting KV cache.
- A reasoning model in an agent loop burns **16–83× the tokens** for identical output; the fix was a server flag, not prompting. **Assume the model is cheap to run but expensive to think.**
- Tool calls are reliable and terse (26–45 tokens each, 10/10 well-formed) — **the model follows tool schemas well but reasons weakly.** Push structure into tools, not into prompts.

---

## 2. The constraint filter — apply to every candidate, reject on any failure

This is the part that makes the research useful rather than a survey. **A capability that fails any of these is not a candidate, however impressive it is.**

1. **No contention for the single inference slot during a turn.** Anything invoking an LLM mid-turn must either use a *different* provider lane, run *between* turns, or run offline/batch. State explicitly which.
2. **No context bloat.** The agent's context window is the scarcest resource. Every augmentation must state its **token cost per turn** and its **worst case**. An "inject relevant memories" scheme that adds 4k tokens to every turn is a regression, not a feature — it costs more context than it saves. Prefer capabilities that *reduce* tokens (compaction, precise retrieval, structural clamps that avoid retry loops).
3. **No VRAM contention** unless the tradeoff is quantified against lost KV cache. CPU-only embedding, or reuse of the already-loaded model, is strongly preferred.
4. **Degrades to a no-op.** If the component is missing, misconfigured, or down, the agent must work exactly as before. This is non-negotiable — every existing layer in this stack already meets it.
5. **Survives a weak reasoner.** The model follows schemas well and reasons poorly. Capabilities requiring sophisticated multi-step self-reflection *from the local model* will fail. Deterministic tooling, tight schemas, and verification beat prompting.
6. **Sequential-safe.** Single user, single agent, no parallel-agent orchestration assumed. It may be *added*, but nothing may *depend* on it.
7. **Bounded operational complexity.** Each addition costs a service to start, a failure mode to reason about, and a thing to debug at 2am. Justify it against `agent up` staying one command.
8. **Local-first.** Cloud is optional and additive, never load-bearing.

For each finalist, produce an explicit line: *"Costs N tokens/turn, M MB RAM, K MB VRAM, adds S services, degrades to: …"*.

---

## 3. The question

**What is the maximally powerful set of augmentations to a local sequential terminal coding agent that survives §2 — and what is the correct order to build them in?**

Optimize for: **long-horizon, complex prompt-to-engineering loops.** A user states a goal; the system works toward it across many turns, many sessions, and many projects, accumulating knowledge and improving, without human babysitting each step, and without the context window or the runtime becoming the bottleneck.

The benchmark to beat is a SOTA cloud terminal agent (Claude Code and peers) on *usefulness to one user with one GPU* — not on raw model quality, which is not winnable. **Where can a local stack be genuinely better?** Candidate asymmetries to investigate rather than assume: unlimited tokens at zero marginal cost, total data locality, persistence across every project on the machine, arbitrarily long-running background loops, and full control of the inference server.

---

## 4. Research surface

Go wide **and** deep. For each area: what is state of the art, what actually works at 4B–27B local scale, what the measured gains are, what it costs under §2, and what the credible criticism is.

### 4.1 Memory, retrieval, and knowledge accumulation
The central problem: the agent should get better at *this codebase* and *this user's work* over months.

- **Long-term agent memory architectures** — MemGPT/**Letta**, self-editing memory, memory blocks, sleep-time compute. What survives a weak local reasoner?
- **RAG for code specifically** — repo-level retrieval, AST/tree-sitter chunking, symbol-graph retrieval, hybrid BM25+dense, late-interaction (ColBERT), reranking. What actually beats plain `ripgrep` for a coding agent, and by how much? Be skeptical: measured comparisons, not vendor claims.
- **Embedding models that are cheap enough** — CPU-only or shared-GPU, small, code-aware. Concrete throughput on commodity CPU.
- **Vector stores at single-user scale** — embedded (sqlite-vec, LanceDB, Qdrant embedded, DuckDB VSS) vs a service. What is the actual cost of *not* running a server?
- **Knowledge graphs for code and for accumulated research** — GraphRAG, code property graphs, entity/relation extraction. When does a graph beat a vector index, and when is it expensive ceremony? What does graph construction cost when the only available extractor is a weak local model?
- **The dual corpus requirement** — knowledge must be *simultaneously* good for vector retrieval **and** a growing, organized, human-readable corpus. Zettelkasten/Obsidian-style linked markdown, docs-as-code, provenance and citation tracking, deduplication, staleness/decay. What are the real designs here, and how do they avoid becoming write-only?
- **Cross-project memory** — sharing knowledge across repos without leaking one project's specifics into another. Namespacing, scoping, promotion of a local lesson to a global one.

### 4.2 Context engineering
Context is the binding constraint. This deserves disproportionate attention.

- **Compaction and summarization strategies** — what to keep, what to drop, when to trigger, how to avoid losing the thread. Measured effects on task success.
- **Context offloading** — files/scratchpads/notes as external memory instead of in-context history.
- **Sub-agent context isolation** — spawning a bounded task with its own window and returning only the conclusion. *Note the §2.1 conflict: with one inference slot, sub-agents serialise. Is it still worth it purely for context isolation?*
- **Retrieval precision over recall** — the failure mode of dumping 20 chunks into context.
- **KV cache reuse / prefix caching** — llama.cpp specifics. Prompt structure that maximises cache hits across turns is potentially a very large, very cheap win. Quantify it.
- **Structured output and constrained decoding** — GBNF grammars, JSON schema enforcement in llama.cpp. What does forcing valid structure buy in reliability and in *tokens saved from retries*?

### 4.3 Correctness, verification, and structural clamps
The local model reasons weakly. Determinism is the compensating advantage.

- **Verification-before-done gates** — tests, type checks, linters, build success as hard gates on task completion.
- **Formal and semi-formal methods at agent scale** — property-based testing, SMT, contract checking, differential testing. What is tractable to *invoke* automatically, versus what needs an expert?
- **Structural clamps on agentic turns** — constraining what an agent may do at each step so it cannot wander. Prior art in the user's `hermes-max` repo; find the SOTA equivalents.
- **Self-consistency and critic patterns** — reflexion, self-refine, LLM-as-judge. **Be skeptical**: most of this literature assumes a strong model. What survives at 4B–27B, and what is measured?
- **Static analysis as tool surface** — LSP, tree-sitter, semgrep, type checkers. Cheap, deterministic, high-signal. Probably underrated relative to anything LLM-based here.
- **Supply-chain and malware gates** on dependency installation.

### 4.4 Self-improvement and optimization
- **GEPA** (reflective prompt evolution with Pareto selection), **DSPy** (programmatic prompt optimization, MIPROv2, BootstrapFewShot), TextGrad. **Critical question: what do these need to run?** Most assume a strong optimizer model and many rollouts. Can a local 27B optimize prompts for itself overnight, offline, between sessions? What is the measured gain and the compute cost?
- **Offline/batch self-improvement** — the machine is idle at night. What can it do then? Prompt optimization, memory consolidation, index rebuilds, corpus curation, test generation. **This sidesteps §2.1 entirely and may be the single most promising direction.**
- **Learning from the agent's own history** — mining past sessions for failures, building a lessons corpus, few-shot example selection from real successes.
- **Trajectory/eval harnesses** — measuring whether an augmentation actually helped. SWE-bench-style local evals, regression suites for agent behavior. **Without this, everything else is guesswork.**

### 4.5 Long-horizon autonomy and control flow
- **Agentic loop topologies** — plan/execute/verify, graph-structured workflows (LangGraph and peers), blackboard architectures, hierarchical task decomposition. What is worth stealing for a *single sequential* agent?
- **Continuous/cron agentic loops** — run until the goal is met or the user stops it. Convergence criteria, progress detection, avoiding infinite loops, avoiding destructive drift. Idle-time work queues.
- **Checkpointing and resumability** — snapshot/rollback of agent state and worktree; recovery from a bad trajectory.
- **Task/goal persistence** across sessions and reboots.
- **Human-in-the-loop checkpoints** that do not require constant attention — batching approvals, escalation policy, "wake me when X".

### 4.6 Tooling and the MCP surface
- **What belongs as an MCP tool vs a CLI vs a hook** — the harness already has file/bash/edit primitives. Where is the real marginal value?
- **Tool design for weak reasoners** — schema design, tool count vs selection accuracy, deferred/searchable tool surfaces, namespacing. **How many tools before selection accuracy collapses at this model scale?** This is a concrete, measurable, high-value question.
- **Editing reliability** — search/replace vs diff vs whole-file vs AST-aware edits; measured failure rates by format at small model scale.
- **Sandboxing and safe execution** of agent-generated code.
- **Observability** — traces, token accounting, cost/latency attribution per turn. Cheap and high-leverage for tuning.

### 4.7 Inference-layer optimizations
- **llama.cpp specifics**: prefix/prompt caching across turns, slot reuse, `--parallel` tradeoffs, speculative decoding beyond MTP, grammar-constrained decoding cost, context shifting/rope scaling, quantization quality-vs-speed for *agentic* work specifically.
- **Model routing** — a small fast model for classification/routing and a large one for reasoning, on one GPU. Is swapping worth the load cost? Can one server host both?
- **Draft-model economics** at 27B.
- **When is the local model the wrong tool** and a remote lane should be used instead — a routing policy question, not a loyalty question.

### 4.8 Adjacent and non-obvious
Deliberately look outside the agent literature: build systems and incremental computation, IDE/LSP architecture, database query planning, compiler-driven development, notebook and REPL workflows, literate programming, CI/CD patterns, formal methods tooling, PKM systems. **The best augmentation may not come from an agent paper.**

---

## 5. Required output

### 5.1 A ranked shortlist
For each of the top **12–20** capabilities:

| Field | Content |
|---|---|
| Name and one-line description | |
| **Why it wins here** | Specific to a local single-slot sequential agent, not generic praise |
| **Evidence** | Measured results with sources. Distinguish benchmark results from vendor claims from anecdote. Say when evidence is thin. |
| **§2 compliance line** | *"Costs N tokens/turn, M MB RAM, K MB VRAM, adds S services, degrades to: …"* |
| **Implementation sketch** | What actually gets built, in this stack, concretely |
| **Effort** | S / M / L, with the main risk named |
| **Kill criterion** | What measurement would prove this is not worth keeping |

### 5.2 A dependency-ordered roadmap
Three tiers, each independently shippable and independently valuable:

- **Tier 1 — foundation.** Highest value-to-effort, no dependencies. What must exist before anything else is measurable (strongly consider: an eval harness, and token/latency observability).
- **Tier 2 — compounding.** Depends on Tier 1; gets better with use.
- **Tier 3 — ambitious.** High ceiling, high risk, or needs the 27B.

### 5.3 An explicit reject list
**Required, and as valuable as the shortlist.** Capabilities that look attractive and should *not* be built here, each with the specific §2 constraint that kills it. Name the ones most likely to be pitched by someone who hasn't read §2.

### 5.4 The measurement plan
How to know any of it worked. What is the local benchmark, what is the baseline, what is the regression suite? **Anything unmeasurable is a guess** — say so.

### 5.5 Open questions
What could not be resolved from available evidence, and what experiment would resolve it. Flag any claim resting on a single source or on vendor marketing.

---

## 6. Standing instructions for the researcher

- **Prefer measurements to claims.** A number with a source beats an adjective. Where you find no measurement, say "no measured evidence found" rather than reaching for plausibility.
- **Be adversarial about hype.** Much agent-memory and self-improvement literature assumes frontier models and does not transfer to 4B–27B. Explicitly flag every finding whose evidence comes only from frontier-model experiments.
- **Prefer boring, deterministic, and local** where it competes. A tree-sitter query that always works beats an LLM call that usually works.
- **Cite everything.** Papers, repos, benchmarks, issue threads. Prefer primary sources and note dates — this area moves fast, and a 2024 result may already be obsolete.
- **Name the tradeoff.** Every recommendation must say what it costs, not only what it gives.
- **The failure mode to avoid is maximalism.** A stack that does everything and is slow, fragile, or context-starved is worse than the working agent that exists today. **When in doubt, recommend the smaller thing** — and say what you'd measure to justify the bigger one later.
