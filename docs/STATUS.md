# Status — where this work stands

**Last updated:** 2026-08-15

Read this first if you are picking the project up. It records what is finished and verified, what was in flight when work stopped, and the one open bug.

---

## The stack is complete and working

The core is done and does not need more work to be useful:

**OpenCode → llama.cpp → Qwen3.5-4B (GDN hybrid, MTP) → MCP services**, with `agent up` / `agent down` managing everything: llama-server, `extractd`, and the SearXNG + crawl4ai containers.

`agent test` passes 8/8. The agentic project suite passes 5/5 (38/38 checks). Numbers, transcripts and gotchas are in [`README.md`](../README.md), [`wiki/`](../wiki/README.md), [`INSTALL_LOG.md`](../INSTALL_LOG.md) and [`docs/AGENT_RUNS.md`](AGENT_RUNS.md).

**This is the intended stopping point.** Everything below is optional.

---

## Where work stopped

The augmentation programme ([`RESEARCH_FINDINGS.md`](RESEARCH_FINDINGS.md) → [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)) was paused partway through Tier 1, deliberately — the core stack is sufficient as it stands, and the remaining items are better done on the target box than here.

| Item | State |
|---|---|
| 1.1 Tool-count headroom measured | ✅ **done** — 100% at 150 tools, no cliff |
| 1.2 Prefix-cache behaviour measured | ✅ **done** — 14–49× on prefill |
| 1.3 Cache instrumentation (`agent cache`) | ✅ **done** — shipped and working |
| 1.4 Prefix-stability audit of a real OpenCode session | ✅ **done** — prefix is stable within a session; cold cost is per-session-start |
| 1.5 Verification gate MCP | ⬜ not started |
| 1.6 Eval harness expansion | ⬜ not started |
| Tier 2 / Tier 3 | ⬜ not started |

### 1.4 result — OpenCode keeps its prefix stable within a session

Measured across real `opencode run` sessions:

| | |
|---|---|
| Requests analysed | 5 |
| Warm turns (<500 tok reprocessed) | **3/5**, median **78 tokens** |
| Prefix similarity | median **0.995**, p10 0.990 |
| Cold turns | 2/5 — **both at session start** (530 and 7,431 tokens, 4.8 s total) |

**Within a session the prefix holds** — a mid-session turn reprocesses ~78 tokens against a 7,700-token context. The cold cost is **per-session-start**: each `opencode run` invocation pays ~7.4k tokens / 3.9 s to prime the cache, which is unavoidable and cheap relative to the work.

The published concern — that switching agents (Plan → Build) rewrites the system prompt and forces a full reprocess — **did not manifest** in the single-agent `run` flow. It remains plausible for the interactive TUI with agent switching, and is worth re-checking there.

Contrast with what *does* break the prefix, measured earlier: **changing the tool list mid-session** reprocessed up to 8,845 tokens per change. Keep the tool set stable within a session.

Use `agent cache --cold` to watch this on any box.

---

## Correction: the "OpenCode hangs at init" bug was a misdiagnosis

Recorded because the reasoning failure is worth more than the conclusion.

**What I believed:** `opencode run` hung at `init` on tool-using tasks, no requests reaching llama-server, and the cause was a wedged SQLite WAL.

**What was actually happening:** OpenCode was working the whole time. Requests *were* reaching the server. The completion count only looked frozen because I compared against a **stale log mark** captured before an earlier run had already advanced the log — so my "no requests reached the server" observation was an artefact of bad arithmetic, not an observation.

The real behaviour: a two-file task simply takes more turns than my timeout allowed, while a one-file task finishes in ~25 s. Nothing was hanging.

**Everything downstream of that bad measurement was wasted:** the WAL checkpointing, moving the database aside, adding an explicit permission block, disabling MCP, testing the working directory. Each "still hangs" result was really "still not finished inside my timeout."

**The lesson:** when a measurement says a component received *nothing*, verify the measurement before theorising about the component. One `grep -c` against the live log would have ended it in seconds — and `strace`, which I kept naming as the right next step, was never actually needed.

The permission block and the absolute `node` path were kept — both are correct hardening regardless.

---

## Recent additions

| Path | What |
|---|---|
| `extractor/` | `extractd` — Rust extraction service. 13–37× faster and 11× lighter than headless Chromium. |
| `mcp/sources.mjs` | Keyless structured adapters (arXiv, Semantic Scholar, HN, Stack Exchange, GitHub) + RRF fusion. |
| `mcp/lanes.mjs` | Per-provider inference lanes with cooldown; local llama-server as the last lane. |
| `bin/cache-stats.py`, `agent cache` | Prefix-cache hit rate and the turns that broke it. |
| `bin/toolcall-battery.py --sweep` | Tool-count cliff measurement. |
| `docs/RESEARCH_*.md`, `docs/IMPLEMENTATION_PLAN.md` | The augmentation research and its tiered plan. |
| `rtx_5090.md` | **Revision 2** of the target-box directive, corrected against everything measured here. Original preserved at `docs/rtx_5090_ORIGINAL.md`. |

---

## If you are heading to the RTX 5090 box

Start at [`rtx_5090.md`](../rtx_5090.md), then [`wiki/10-Gotchas-and-Deviations.md`](../wiki/10-Gotchas-and-Deviations.md) and [`wiki/11-Porting-to-27B.md`](../wiki/11-Porting-to-27B.md).

The four that will cost you the most time if skipped:

1. **`--reasoning off`.** 16–83× token cost. Neither a better prompt nor a bigger budget fixes it; a bigger budget makes it worse.
2. **`--parallel 1`, not `--np 1`.** The latter is not a flag.
3. **Check `--spec-type` lists `draft-mtp` before anything else.** If not, the build is too old. Worth 1.45×.
4. **Protect the prompt prefix.** Stable tool list, stable system prompt, nothing injected at the front. Worth 14–49× on prefill.

**Do not port the Tier 1–3 augmentations in the first pass.** Get the core green, then revisit with measurements. The governing risk is maximalism.
