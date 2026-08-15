# Agentic Engineering Runs

Five short software-engineering projects executed **by the local agent** — OpenCode driving `llama-server` serving **Qwen3.5-4B UD-Q5_K_XL** with MTP speculative decoding and thinking disabled — against the stack documented in [`../README.md`](../README.md).

Each project exercises a distinct capability of the pipeline. Every one was seeded from a clean directory, run non-interactively, and verified by a script the agent never saw.

**Run date:** 2026-08-14 · **Model:** `local/qwen3.5-4b` · **Harness:** OpenCode 1.18.18

---

## Results

| # | Project | Capability exercised | Time | Checks | Result |
|---|---|---|---|---|---|
| 01 | [CLI word counter](#01--cli-word-counter) | Create files from scratch, argparse, write + run tests | **27 s** | 9/9 | **PASS** |
| 02 | [Binary-search bug fix](#02--binary-search-bug-fix) | Read, diagnose from a failing suite, minimal fix | **16 s** | 4/4 | **PASS** |
| 03 | [Refactor to a shared module](#03--refactor-to-a-shared-module) | Multi-file edit, extract duplication, preserve behaviour | **18 s** | 8/8 | **PASS** |
| 04 | [Research notes](#04--research-notes) | **MCP `web_search`** → SearXNG → crawl4ai → writeup | **185 s** | 6/6 | **PASS** |
| 05 | [Log statistics](#05--log-statistics) | JSON parsing, exact output format, testable design | **29 s** | 11/11 | **PASS** |
| | **Total** | | **275 s** | **38/38** | **5/5** |

Reproduce with:

```bash
agent up
projects/run-all.sh              # or: projects/run-all.sh 02-bugfix-binary-search
```

Transcripts and per-check output land in `projects/results/`; the agent's working trees in `projects/work/`.

---

## Throughput during agent work

Measured from the server log across the whole suite:

| Metric | Value |
|---|---|
| Completions | 40 |
| Tokens generated (total) | **3,134** |
| Decode | median **56.4 tok/s** (range 38.6–88.5) |
| Prefill | median **158 tok/s**, peak 2,009 tok/s |

Two things worth reading carefully:

**Decode during agent work (56.4) is below the bench baseline (78.6).** That is expected and not a regression. `agent bench` measures one 160-token generation, where MTP's draft pipeline stays saturated. An agent loop is dominated by *many short* completions — tool calls of 20–40 tokens — where per-request overhead and speculative warmup have less to amortise against. **Quote the bench number as a ceiling, not as what you'll see in a session.**

**3,134 tokens for five completed projects** is the number to hold next to the thinking-mode measurements: a *single* trivial task costs 6,458–32,702 tokens with thinking on, versus 395 with it off — for identical, correct output ([experiment](../experiments/reasoning-budget/README.md), [gotcha #1](../wiki/10-Gotchas-and-Deviations.md#1-the-reasoning-runaway)). Turning thinking off is worth **16–83×** at the task level.

---

## 01 — CLI word counter

**Capability:** create files from scratch, `argparse` CLI, write and run its own tests.

**Task:** create `wordcount.py` with `count_words(text)` plus an `argparse` CLI printing the top N words; create `test_wordcount.py`; run pytest; run the CLI against a provided `sample.txt`.

**Result: 9/9 in 27 s.** Produced `wordcount.py` and `test_wordcount.py`, pytest green, CLI output correct (`the 4` as the top word).

```python
def count_words(text):
    """Lowercase the text, split on whitespace, return dict mapping words to counts."""
    words = text.lower().split()
    return Counter(words)
```

It reached for `collections.Counter` and `most_common()` unprompted — idiomatic rather than a hand-rolled loop.

### The interesting failure, first time round

On the first attempt this project scored **7/8: the agent overwrote `sample.txt`** with its own invented content instead of reading the file that was already there. The code was entirely correct; the *input data* had been replaced, so the expected top-word assertion failed.

The prompt had said "reads the file" but never said the file already existed. The model filled the gap by creating one.

Two changes fixed it, and both are worth carrying forward:

1. **State what already exists and must not change.** The prompt now says: *"`sample.txt` already exists in this directory and is the input data. Do NOT modify, overwrite, or recreate it."*
2. **Verify input integrity, not just output.** `VERIFY.sh` now asserts `sample.txt` is byte-identical to the seed.

> **Carry-forward:** a small model will invent missing context rather than ask. Anything pre-existing that matters should be named explicitly as pre-existing, and your verification should check that the agent didn't quietly rewrite its own inputs. A test suite that only checks outputs will happily pass a run that destroyed the fixtures.

---

## 02 — Binary-search bug fix

**Capability:** run a failing suite, diagnose from output, make a minimal fix, respect a constraint.

**Task:** six tests fail against a seeded off-by-one bug in `search.py`. Fix the source. **Do not modify the tests.**

**Result: 4/4 in 16 s** — the fastest project.

```diff
 def binary_search(items, target):
     lo = 0
     hi = len(items) - 1
-    while lo < hi:
+    while lo <= hi:
```

**A one-character fix.** Not a rewrite, not a reimplementation — exactly the minimal correct change. Then, unprompted, a correct plain-English diagnosis:

> *"The bug was that the loop condition used `lo < hi` instead of `lo <= hi`, causing the search to terminate prematurely when the target was at the last position or in a single-element array."*

That is the actual failure mode, including both edge cases the tests covered.

The verification explicitly guards against the obvious cheat:

```
PASS  pytest passes
PASS  tests were NOT modified      ← diffed against the seed
PASS  search.py was modified
```

> **Carry-forward:** when a task says "don't touch the tests," verify it by diffing rather than trusting it. Editing the assertions is the shortest path to green, and it's worth knowing whether a model takes it. This one didn't.

---

## 03 — Refactor to a shared module

**Capability:** coordinated multi-file edit, remove duplication, preserve behaviour.

**Task:** `report_a.py` and `report_b.py` both define an identical `format_currency`. Extract it into `formatting.py`, import it in both, keep tests passing.

**Result: 8/8 in 18 s.** Three files touched coherently — one created, two edited.

```python
# formatting.py  (new)
def format_currency(amount):
    return "$%.2f" % amount
```
```python
# report_a.py  (edited)
from formatting import format_currency


def sales_report(rows):
    return "\n".join("%s: %s" % (n, format_currency(v)) for n, v in rows)
```

The duplicated definition was **removed** from both modules, not merely shadowed by an import — verified explicitly (`! grep -q 'def format_currency' report_a.py`). Behaviour preserved; both tests still pass.

> **Carry-forward:** "extract the duplication" is a task where a model can produce something that *imports* correctly while leaving the dead copy behind. Assert the absence, not just the presence.

---

## 04 — Research notes

**Capability:** the full MCP path — `web_search` → SearXNG → crawl4ai extraction → optional summarization → a written artifact with citations.

**Task:** research llama.cpp's `--cache-type-k` and `-fa` flags using the `local-search` tool, then write `KV_NOTES.md` with a section per flag and a `## Sources` section.

**Result: 6/6 in 185 s** — by far the longest, and the only one bounded by network rather than compute.

It issued **six** `web_search` calls, escalating its own parameters when early results were thin:

```
local-search_web_search {"query":"llama.cpp --cache-type-k flag meaning explanation","summarize":true}
local-search_web_search {"query":"llama.cpp flash attention -fa flag explanation","summarize":true}
local-search_web_search {"query":"llama.cpp cache type k KV cache type","summarize":true}
local-search_web_search {"query":"llama.cpp flash attention implementation","summarize":true}
local-search_web_search {"query":"--cache-type-k llama.cpp","count":10,"mode":"normal","summarize":true}
local-search_web_search {"query":"llama.cpp flash attention -fa","count":10,"mode":"normal","summarize":true}
```

Note the last two: it raised `count` to 10 and set `mode` explicitly after the earlier queries under-delivered. That is sensible tool use, and it is also why this project took 185 s — each `normal`-mode search fetches and extracts up to four pages.

The output is accurate:

> **`--cache-type-k`** — *"sets the KV cache data type for the K attention projection, controlling memory efficiency versus precision. The allowed values are f32, f16, bf16, and various quantized formats (q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1), with f16 being the default."*
>
> **flash attention** — *"enables Flash Attention, an optimized attention implementation... When set to 'on', Flash Attention is always used; 'off' disables it entirely; and 'auto' (the default) enables it when the hardware backend supports it."*

Both descriptions match the real flag semantics, including the `on`/`off`/`auto` tri-state. It cited its source (the llama.cpp CLI README).

**One honest weakness:** six searches yielded **one** cited URL. The notes are correct and sourced, but the sourcing is thinner than the search effort suggests. A 4B model summarising four extracted pages tends to converge on the single most authoritative one rather than synthesising across them.

> **Carry-forward:** this project is the end-to-end proof that MCP search works under real agent control — the model chose the tool, chose its arguments, and adapted them. Budget for it being **slow**: it was 7× the median project time, entirely in network and extraction. If interactive latency matters, `shallow` mode (snippets only) is the lever.

---

## 05 — Log statistics

**Capability:** JSON parsing, exact output-format compliance, structuring code so it's testable.

**Task:** read `events.json`, print totals, per-level counts, and per-service average ms in a **precisely specified format**; put the averaging logic in an importable function and test it.

**Result: 11/11 in 29 s.** Every aggregate correct, format matched exactly:

```
total: 6
level error: 2
level info: 3
level warn: 1
avg api: 200.0
avg cache: 10.0
avg db: 100.0
```

Both orderings alphabetical as specified, averages rounded to one decimal. It also honoured the testability requirement, splitting `calculate_averages(events)` out from `print_stats(events)` so the test could import the logic without capturing stdout.

> **Carry-forward:** the strictest-format task passed cleanly, which suggests format compliance is not where a 4B struggles — **specification completeness is** (see project 01). Precise instructions get precise results.

---

## What this does and doesn't show

**Shown.** The full pipeline works under real agent control: file creation, targeted editing across multiple files, shell execution, reading its own test output, diagnosing from failures, honouring negative constraints ("don't modify the tests"), MCP tool selection with adaptive arguments, and exact output-format compliance. **38/38 checks, 5/5 projects, no runaway generation, no malformed tool calls.**

**Not shown.** These are small, well-specified tasks completed in 16–185 seconds. Nothing here says a 4B model handles large refactors, ambiguous requirements, unfamiliar codebases, or long autonomous sessions — and project 01's first attempt shows exactly how it fails when a specification has a gap: **it invents the missing piece instead of asking.**

That gap is what the 27B target is for. What these runs establish is that **the plumbing underneath is sound** — and the plumbing is what the next install inherits.

---

**See also:** [wiki/09 — Validation Results](../wiki/09-Validation-Results.md) · [wiki/10 — Gotchas](../wiki/10-Gotchas-and-Deviations.md) · [wiki/11 — Porting to 27B](../wiki/11-Porting-to-27B.md)
