# Experiment — Can prompt specificity or a bigger token budget rescue thinking mode?

**Run date:** 2026-08-14 · **Model:** Qwen3.5-4B UD-Q5_K_XL · 8 runs

---

## Why

The install run hit a hard blocker: with thinking enabled, a trivial coding task generated **12,936 tokens in one completion with no visible progress**, and was **killed by the operator**. It was fixed by disabling thinking (`--reasoning off`), and the repo documented it as a "runaway."

That conclusion had a hole in it. The run was terminated, so nobody actually knew whether it would have finished. And the fix — a server flag — was never tested against the two obvious alternatives: **write a more specific prompt**, or **give it a bigger token budget**.

This experiment holds the task fixed and varies only those.

| Cell | Thinking | Prompt | Output cap | Runs |
|---|---|---|---|---|
| **A** | on | loose (the original one-liner) | 8,192 | 3 |
| **B** | on | highly specific, step-numbered | **32,768** | 2 |
| **C** | off | highly specific, step-numbered | 8,192 | 3 |

Task in all cells: add `multiply(a, b)` to `mathutil.py`, add a test, run `pytest`, get 2 passed. Same seed, same verification, fresh working tree each run.

```bash
./run.sh                                  # all cells
REPEAT_A=5 REPEAT_B=1 REPEAT_C=5 ./run.sh # adjust repeats
```

The server is restarted with `--reasoning on/off` between cells. Output caps and the `reasoning`/`interleaved` fields are set with a **workspace-local `opencode.json`**, so the global config is never touched. The server is restored to the repo default at the end.

---

## Results

| Cell | Runs | Mean tokens | Range | Mean time | Largest completion | Verified |
|---|---|---|---|---|---|---|
| **A** thinking + loose, cap 8,192 | 3 | **6,458** | 4,901–8,705 | 80 s | 8,192 | **3/3** |
| **B** thinking + specific, cap 32,768 | 2 | **32,702** | 32,669–32,736 | 381 s | 32,000 | **2/2** |
| **C** no thinking + specific, cap 8,192 | 3 | **395** | 341–456 | 12 s | 125 | **3/3** |

```
A-thinking-loose        16.3x the tokens,  6.7x the wall time of C
B-thinking-specific     82.8x the tokens, 31.8x the wall time of C
```

---

## What this changes

### 1. It is not a correctness failure. All 8 runs produced correct code.

Every cell, including both thinking-on cells, edited both files correctly and got `2 passed`. **The original run was killed, not stuck** — the repo previously described it as a runaway that "never escaped its own reasoning loop," and that was an overstatement. It would very likely have finished.

The real failure is **cost**, not correctness: 16–83× the tokens and 7–32× the wall time for identical output.

### 2. Prompt specificity did not help.

Cell B used a maximally explicit prompt — four numbered steps, exact code to insert, an instruction to *"call a tool on your very first response, and keep any prose under two sentences,"* and a stop condition. It was the **most expensive cell by a wide margin**.

Being more specific gave the model *more material to reason about*, not less.

### 3. A bigger token budget made it strictly worse.

This is the sharp finding. Cell B consumed **essentially its entire 32,768-token cap** — and did so with almost no variance:

```
B run 1: 32,669 tokens
B run 2: 32,736 tokens
```

Both runs had **one single completion of 32,000 tokens** out of 8 total completions. In cell A, one completion hit exactly the 8,192 cap.

> **Token spend under thinking is governed by the output cap, not by the task.** One completion expands to fill whatever ceiling you set. Raising the cap does not buy headroom — it buys waste, proportionally.

The work itself was done cheaply in the first few tool calls. The budget was burned on a later completion, after the file edits had already succeeded.

### 4. The flag remains the fix.

`--reasoning off` is not a workaround for a bad prompt. It is the only lever of the three that worked, and it worked by two orders of magnitude — **395 tokens versus 32,702**, from a *more* specific prompt in both cases.

---

## Carry-forward for the 27B

- **Do not try to prompt-engineer your way out of this.** It was tested and it does not work.
- **Do not raise `limit.output` to "give it room to think."** Room to think is room to burn. If you run with thinking on, cap output *tightly* — the cap is the actual governor.
- **Re-run this experiment on the 27B before deciding.** A 27B may reason far more efficiently, and the tradeoff could invert: 16× the tokens for meaningfully better output on hard tasks might be worth it, where 16× for identical output on an easy task plainly is not. This experiment only shows what happens at 4B **on a task that is trivially easy**, which is the case least favourable to thinking. `./run.sh` ports as-is.
- **Judge on cost, not correctness.** "It completed" is not the metric — all 8 runs completed. Measure tokens and wall time.

---

## Files

```
seed/                 starting state (mathutil.py + one passing test)
PROMPT-loose.md       cell A's prompt — the original one-liner
PROMPT-specific.md    cells B and C — four numbered steps, exact code, stop condition
VERIFY.sh             identical verification for every cell
run.sh                the harness; restarts the server per cell, restores it at the end
summarize.py          aggregates results/*.meta.txt into the table above
results/              per-run transcript, verify output, and metadata
work/                 per-run working tree (recreated each run)
```
