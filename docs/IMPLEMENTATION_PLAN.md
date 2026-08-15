# Implementation Plan

Derived from [`RESEARCH_FINDINGS.md`](RESEARCH_FINDINGS.md). Every item states its cost per turn, what it degrades to, and **the measurement that would kill it**. Nothing ships without a before/after number.

**Status legend:** ✅ done · 🔨 in progress · ⬜ planned

---

## The two measurements that reorganised this plan

Both were run locally, and both inverted a conclusion taken from the literature:

1. **Prefix caching works on our recurrent hybrid: 11,651 ms → 843 ms → 238 ms.** Prompt-prefix stability is now the top architectural constraint, and live memory injection is disqualified rather than desirable.
2. **No tool-count cliff at 150 tools** (100% selection accuracy), against a literature prediction of failure at 46. The tool budget is not the constraint; prefix stability is.

Read together: **put augmentation at the tail or out of band, and stop worrying about tool count.**

---

## Tier 1 — foundation

### 1.1 ✅ Tool-count headroom measured
`bin/toolcall-battery.py --sweep 3,10,...,150`. Result: 100% at every size. Establishes that new MCP tools may be added on their own merits.
**Kill criterion:** n/a — this is the measurement itself. Re-run when the model changes.

### 1.2 ✅ Prefix-cache behaviour measured
Documented in findings §0. `--cache-ram` is on by default at 8192 MiB.
**Kill criterion:** n/a.

### 1.3 ⬜ Cache-hit instrumentation — `agent cache`
llama-server already returns `usage.prompt_tokens_details.cached_tokens` and `timings.prompt_ms`. Surface hit rate and prefill cost per turn from the server log; add a `cache` subcommand and a line in `agent status`.
**Cost:** 0 tokens/turn, 0 services. **Degrades to:** no telemetry.
**Kill criterion:** if measured hit rate in real OpenCode sessions is already >90% and stable, the instrumentation has told us what we needed and can stop being a live feature.

### 1.4 ⬜ Prefix-stability audit of the OpenCode integration
[LITERATURE] reports that switching OpenCode agents mid-session (Plan → Build) rewrites the system prompt and forces full reprocessing, with no flag-based workaround. **Unverified here and directly measurable.** Run a real session, log `cached_tokens` per request, find what invalidates the prefix.
**Cost:** 0. **Degrades to:** current behavior.
**Kill criterion:** if nothing invalidates the prefix in practice, close it and move on.

### 1.5 ⬜ Verification gate MCP — `verify_done`
One tool: run the project's tests / typecheck / lint and return a structured verdict. Deterministic, beats a 4B critic, and *saves* tokens by ending "done → actually broken" loops.
**Cost:** ~1 tool (~300 tok, prefix-cached), invoked on demand. **Degrades to:** absent tool, agent behaves as today.
**Kill criterion:** if task success on `projects/run-all.sh` does not improve and token-per-task does not fall, drop it.

### 1.6 ⬜ Eval harness expansion
`projects/` is already the skeleton: seed → prompt → verify, with per-run metadata. Grow it toward Terminal-Bench shape (more tasks, difficulty tiers, category tags) and add a `--compare` mode that diffs two runs.
**Cost:** offline only. **Degrades to:** the 5 projects that exist.
**Kill criterion:** none — this is the instrument everything else is judged by.

---

## Tier 2 — compounding

### 2.1 ⬜ Append-only session journal
Every turn appends a structured record (task, tools used, files touched, verdict, tokens) to `~/.local-agent/journal/`. **Never read into context during a session** — it exists for offline consumption.
**Cost:** 0 tokens/turn. **Degrades to:** a log file nobody reads.
**Kill criterion:** if offline consumers (2.3, 2.4) never ship, this is dead weight — delete it.

### 2.2 ⬜ Dual-corpus research memory
`deep_research` output becomes a **growing human-readable corpus**: linked markdown, front-matter provenance, dated, deduplicated by URL — plus a **CPU-only** index over it. This is the one place an index beats grep, because the corpus is prose, small, and stable (findings §2).
**Cost:** ~2 tools. CPU embedding, no VRAM. **Degrades to:** ripgrep over markdown, which is genuinely fine.
**Kill criterion:** if retrieval from the corpus does not beat `rg` over the same markdown on a fixed question set, ship the ripgrep version and delete the index.

### 2.3 ⬜ Sleep-time consolidation — `agent sleep`
The structural answer to the single-slot constraint (findings §3). Runs when the box is idle: consolidate the journal into lessons, curate the corpus, rebuild indexes, prune duplicates. Uses **GBNF-constrained generation** — safe here because no tool calling is involved (findings §4).
**Cost:** 0 during sessions. **Degrades to:** no-op.
**Kill criterion:** if lessons produced are not measurably used or useful after a month, stop.

### 2.4 ⬜ Stable playbook artifact
Offline ACE-style curation produces **one stable file** injected at a fixed position and **frozen for the session**. This is the only safe form of evolving context here: it changes between sessions, never within one, so the prefix cache survives.
**Cost:** bounded, prefix-cached. **Degrades to:** empty file.
**Kill criterion:** if eval scores do not move, the playbook is decoration.

---

## Tier 3 — ambitious

### 3.1 ⬜ Continuous goal loop — `agent pursue "<goal>"`
Runs until the goal verifies or the user stops it. **Depends on 1.5** for the convergence signal — without a hard gate this is a drift generator. Needs checkpointing, a progress detector, and a hard iteration cap.
**Risk:** destructive drift. **Kill criterion:** if it cannot converge on tasks a human solves in three turns, it is not ready.

### 3.2 ⬜ GEPA/ACE offline optimization
Best small-model evidence available (findings §3). Needs 1.6 to prove it helped and many rollouts, run overnight.
**Risk:** rollout cost at 27B; unproven at that scale.

### 3.3 ⬜ Structural clamps
Port from `hermes-max`. Now unblocked by the tool-budget finding.
**Risk:** may constrain a model that did not need constraining — measure against 1.6.

---

## Explicitly not building

| Rejected | Reason |
|---|---|
| Code vector index / semantic code search | Agentic grep beats RAG by 20–24% at 3B–7B. Costs an embedder, a store, and staleness management to underperform `ripgrep`. |
| Live memory injection into the prompt prefix | **Measured:** destroys the prefix cache, ~11 s prefill penalty per turn. |
| In-session context rewriting | Same. Offline curation only (2.4). |
| GBNF on the main agent loop | llama.cpp cannot combine grammars with function calling; published constraint-tax suppresses tool calls. |
| LLM-as-critic on the local model | A test run is a better and cheaper critic than a 4B opinion. |
| Parallel sub-agents for throughput | One inference slot; they serialise. |
| GPU embedding model | 7.03 of 7.8 GB VRAM committed; any embedder evicts KV cache. |

---

## Sequencing

**1.3 → 1.4 → 1.5 → 1.6** first. Instrumentation and the gate before anything that claims to improve things, because harness variance is 10–20 points and unmeasured changes are guesses.

Then **2.1 → 2.3 → 2.2 → 2.4**, because the journal must exist before consolidation has anything to consolidate.

Tier 3 only after 1.6 can tell us whether Tier 2 helped.

**The governing risk is maximalism.** A stack that does everything and is slow, fragile, or context-starved is worse than the agent that works today. Every item above must earn its place against a measurement, and the reject list is as load-bearing as the build list.
