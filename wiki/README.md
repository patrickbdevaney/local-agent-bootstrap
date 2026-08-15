# Wiki

A plain markdown documentation directory — read it here on GitHub, in your editor, or with any static-site generator. Nothing in it depends on GitHub's wiki feature.

Structured reference for a **validated** local coding-agent stack: OpenCode → llama.cpp → Qwen3.5-4B (gated-delta hybrid GGUF), with SearXNG + crawl4ai exposed over MCP.

Everything here was executed on real hardware on **2026-08-14**. Nothing is aspirational. Where a directive's assumption turned out to be wrong, the wrong assumption is documented alongside the correction, because that is the part worth carrying forward.

---

## Purpose

This is the **dry run**. The real target is Qwen3.8-27B on an RTX 5090 (32 GB) under Windows/WSL2. Proving the pattern on an 8 GB laptop GPU first was deliberate: every constraint that bites at 8 GB — VRAM budget, KV sizing, quant choice, speculative-decoding overhead — is looser at 32 GB, but the *mechanisms* are identical. A gotcha found here is a gotcha avoided there.

---

## Pages

### Process
| Page | Contents |
|---|---|
| [01 — Inventory First](01-Inventory-First.md) | Why the first phase is cataloguing, not installing. What was already on the box and what that saved. |
| [10 — Gotchas and Deviations](10-Gotchas-and-Deviations.md) | Every place reality contradicted the plan. **Read this one if you read nothing else.** |

### Inference stack
| Page | Contents |
|---|---|
| [02 — llama.cpp Build](02-llama-cpp-Build.md) | CUDA build, architecture flags, how to tell whether a build supports MTP and GDN. |
| [03 — Model and Quant Selection](03-Model-and-Quant-Selection.md) | Verifying repos actually exist, the quant ladder, why UD-Q5_K_XL, why the MTP repo. |
| [04 — VRAM and KV Sizing](04-VRAM-and-KV-Sizing.md) | The arithmetic. Hybrid-architecture KV math, measured vs predicted, prefill behavior. |
| [05 — Server Configuration](05-Server-Configuration.md) | The launch line, every flag justified, MTP measurements, auto-fit. |

### Agent stack
| Page | Contents |
|---|---|
| [06 — Search Stack](06-Search-Stack.md) | SearXNG JSON, crawl4ai extraction, the MCP server, graceful degradation. |
| [07 — OpenCode Configuration](07-OpenCode-Configuration.md) | The V2 schema, provider wiring, MCP registration, the reasoning-flag interaction. |
| [08 — The agent CLI](08-The-agent-CLI.md) | Wrapper design, idempotency, why it refuses to stop shared containers. |

### Evidence
| Page | Contents |
|---|---|
| [09 — Validation Results](09-Validation-Results.md) | Benchmarks, tool-call battery, end-to-end task, failure-path tests. |
| [`experiments/reasoning-budget`](../experiments/reasoning-budget/README.md) | Controlled 8-run test: can prompt specificity or a bigger token budget replace `--reasoning off`? (No — and the bigger budget makes it worse.) |
| [11 — Porting to 27B](11-Porting-to-27B.md) | **The handoff.** Sizing method, worked 32 GB budget, WSL2 specifics, checklist. |

---

## The five-line summary

1. **Inventory before you install.** An existing container replaced an entire planned build phase.
2. **Check `--spec-type` before anything else.** It tells you if your llama.cpp is current enough for MTP, which is worth 1.45× decode.
3. **Only full-attention layers cost KV** in a hybrid model. The recurrent state is flat in context length.
4. **Turn thinking off** for agent work at small scale. Measured across 8 runs: 395 tokens with it off versus 6,458–32,702 with it on, for identical correct output. Prompt specificity doesn't help and a bigger budget hurts.
5. **Make failure silent and local.** Every remote dependency in this stack degrades to a working local-only path, and all three failure modes were tested.
