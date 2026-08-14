# 01 — Inventory First

> **The rule:** the first phase is cataloguing, not installing. On this box it collapsed three planned phases into verification and saved an entire build.

---

## Why

A dev box that has run prior ML work is never empty. It has containers, half-built toolchains, downloaded models, and configuration that another still-active project depends on. Installing over that is how you break something you weren't looking at.

The inventory answers two questions per component:

1. **Does it already exist and work?** → verify and reuse
2. **Is something else depending on it?** → build alongside, never replace

---

## The inventory commands

```bash
# Where does the project live? Is there more than one?
find ~ -maxdepth 4 -iname "local-agent-bootstrap" -type d

# What containers exist, running or not?
docker ps -a
docker images

# Is there already an inference server?
which llama-server
find ~ -maxdepth 5 -name "llama-server" -type f
find ~ -maxdepth 4 -iname "llama.cpp" -type d

# Are there already models on disk?
find ~ -maxdepth 6 -name "*.gguf"

# Harness?
which opencode; opencode --version; ls -d ~/.config/opencode ~/.opencode

# Toolchain
nvcc --version; cmake --version; gcc --version; node --version

# Real hardware baselines, taken at idle BEFORE loading anything
nvidia-smi
free -h
df -h ~

# What ports are already claimed?
ss -tlnp
```

For credentials, log **presence only**:

```bash
grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*' .env
```

Never `cat` a `.env` into a log you intend to publish.

---

## What the inventory found here

| Component | Expected | Actually found | Consequence |
|---|---|---|---|
| SearXNG | build fresh | **already running** on :8080, **JSON already enabled** | Phase skipped entirely |
| Scraper | build a Rust `spider` + `article_scraper` binary | **crawl4ai v0.8.6 already running** on :11235 with readability extraction | **Entire phase eliminated** |
| llama.cpp | build fresh | existing CUDA/SM89 build, but **5 months stale** | Rebuilt — for a specific reason, see below |
| Model | download | `Qwen3.5-4B.Q4_K_M.gguf` already on disk | Used as a fallback; a better quant was fetched |
| OpenCode | check | **absent** | Genuine fresh install |
| CUDA toolkit | maybe install | **12.8 present**, matching the driver | No install needed |
| Port 8080 | free (llama-server default) | **taken by SearXNG** | llama-server moved to 8090 |

Also found and **deliberately left alone**: a second llama.cpp fork (`~/prism-llama.cpp`) belonging to another project, several `hermes-*` trees, and a `phoenix` observability container.

---

## The two decisions the inventory drove

### Reuse: crawl4ai replaced a whole build phase

The plan called for a small Rust binary wrapping the `spider` crate plus `article_scraper` for readability fallback, exposed as `POST /extract {url} -> {title, text}`.

The box already had crawl4ai running, which does exactly that:

```bash
curl -s -X POST http://localhost:11235/md \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","f":"fit"}'
```
```json
{"url":"https://example.com","filter":"fit","markdown":"# Example Domain\n...","success":true}
```

Verified against a real article (11,668 chars of clean markdown, no nav chrome) and adopted. **A two-minute verification replaced a multi-hour build.**

### Rebuild — but alongside, never over

The existing llama.cpp was tag `b8467` (2026-03-21). It worked, and it supported the model. It was rebuilt anyway, for one concrete reason:

```bash
$ ~/llama.cpp/build/bin/llama-server --help | grep -A1 -- "--spec-type"
--spec-type [none|ngram-cache|ngram-simple|ngram-map-k|ngram-map-k4v|ngram-mod]
```

No `draft-mtp`. Upstream master has it. MTP turned out to be worth **1.45× decode speed**, so the rebuild paid for itself.

**Critically, the rebuild went into `local-agent-bootstrap/llama.cpp`, not over `~/llama.cpp`.** The old build stays intact as a known-good fallback, and any other project depending on it is unaffected. When in doubt, build alongside.

---

## Baselines worth capturing at idle

These are the denominators for every later decision. Take them **before** loading anything.

```
GPU:  11 MiB / 8188 MiB used   (only Xorg, 4 MiB — display is on the iGPU)
      llama.cpp reports usable VRAM as 7815 MiB, not the nominal 8188
RAM:  31Gi total, 12Gi available, swap 8.0Gi / 8.0Gi FULL
Disk: 297G total, 37G available
```

Two things to notice:

- **Nominal VRAM is not usable VRAM.** llama.cpp reported 7815 MiB against a nominal 8188. Size against the number the runtime reports, not the spec sheet.
- **Swap was 100% consumed** at inventory time. That is a memory-pressure signal even when "available" RAM looks fine. It resolved on its own when another workload finished, but it is why heavy steps were run sequentially with a `free -h` check before each.

---

## The guardrail that mattered

> Do not modify, delete, or restructure existing infrastructure without confirming nothing else depends on it. When in doubt, build alongside and note the ambiguity rather than guessing.

Applied three times:

1. `~/llama.cpp` (b8467) — **not** rebuilt in place; new clone in the project directory
2. `~/prism-llama.cpp` — another project's fork; never touched
3. `searxng` / `crawl4ai` / `phoenix` containers — verified, never recreated, and **`agent down` is written so it cannot stop them**

Final state: nothing pre-existing was deleted, overwritten, or restructured. `.env` is byte-identical (md5 verified before and after).

---

**Next:** [02 — llama.cpp Build](02-llama-cpp-Build.md)
