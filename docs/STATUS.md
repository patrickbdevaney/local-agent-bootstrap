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
| 1.4 Prefix-stability audit of a real OpenCode session | ⚠️ **blocked** — OpenCode hangs on tool-using tasks, see below. Partial data obtained by other means. |
| 1.5 Verification gate MCP | ⬜ not started |
| 1.6 Eval harness expansion | ⬜ not started |
| Tier 2 / Tier 3 | ⬜ not started |

### What 1.4 was trying to establish

Whether a real OpenCode session keeps its prompt prefix stable, and what breaks it. This matters because prefill is **11.6 s cold versus 0.8 s warm** at 21k tokens on this box — so anything that rewrites the prefix mid-session costs ~11 s per turn, invisibly.

Published reports say OpenCode's agent switching (Plan → Build) rewrites the system prompt and forces a full reprocess, with no flag-based workaround. **That remains unverified here.**

Partial results already in hand, from instrumenting other work:

- Over 108 requests: **91% of turns were warm** (median 23 tokens reprocessed), but the **9% cold turns consumed 29 of the 53 total seconds of prefill** — over half the prefill cost in under a tenth of the turns.
- The cold turns were traced to **changing the tool list mid-session** (the tool-count sweep), which reprocessed up to 8,845 tokens per change. That confirms the mechanism on this stack, just not yet via OpenCode's own behaviour.

`agent cache --cold` lists the offending turns with timestamps, similarity and token counts. **The instrument is finished; only the OpenCode-specific run is missing.**

---

## The open bug: OpenCode hangs at `init`

**Symptom.** `opencode run` prints its startup lines, logs `message=init`, and then hangs indefinitely. No request ever reaches llama-server (`agent cache` shows no new events). The process sits in `do_wait` on a child that is not running.

**It is not:** llama-server (healthy throughout), the MCP server (0.2 s handshake standalone, and the hang reproduces with MCP disabled), disk, or RAM.

**The discriminator.** `opencode run "Reply with exactly: PING"` **succeeds**. The same command with a task requiring the edit/bash tools **hangs**. That is the sharpest clue available: it is not startup in general, it is something on the tool-using path.

**Things ruled out by test, not by assumption:**

| Hypothesis | Test | Result |
|---|---|---|
| llama-server down | `/health`, pid check | healthy throughout |
| MCP server broken | standalone handshake; then MCP disabled entirely | 0.2 s handshake; **hang reproduces with MCP off** |
| `node` not on PATH for the MCP subprocess | switched config to an absolute node path | no change (kept anyway — it is correct) |
| Wedged SQLite WAL | `pragma wal_checkpoint(TRUNCATE)` | PING started working — **but this was misleading** |
| Corrupt database | `pragma integrity_check` | `ok` |
| Stale DB state | **moved `opencode.db*` aside entirely, fresh DB** | **still hangs** |
| Permission prompt with no TTY | added explicit `permission: {read/edit/bash/... : "allow"}` to the config | **still hangs** |
| Disk / RAM | `df`, `free` | 119 GB free, 21 GB available |

So the WAL was **not** the root cause. Checkpointing appeared to fix it only because the follow-up test was `PING`, which does not touch tools.

**Still untried, in order:**

1. `strace -f -e trace=wait4,clone,execve,openat` on the hung process — identify the child it waits on. This is the fastest path to an answer and should have been step one.
2. Working-directory dependence: every hang was under the scratchpad (`/tmp/claude-.../oc-audit`); every success earlier in the session was under `projects/work/`. **Test the identical task in a normal repo path.** OpenCode snapshots the working directory (`~/.local/share/opencode/snapshot/`, 21 dirs accumulated) and a snapshot of a `/tmp` path is a plausible thing to block on.
3. `opencode run --print-logs --log-level DEBUG` for anything past `message=init`.
4. Bisect by reverting `~/.config/opencode/opencode.json` to the version that demonstrably worked during the agentic project suite.

**A contributing self-inflicted factor.** Several process kills came from `pkill -f` patterns that also matched the shell running them — **three separate times**. Use `pgrep -x <name>` and kill by PID; never `pkill -f` on a string that appears in your own command line. Documented in [`wiki/10-Gotchas-and-Deviations.md`](../wiki/10-Gotchas-and-Deviations.md).

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
