# 02 — llama.cpp Build

---

## Prerequisites, verified

```bash
$ nvcc --version | tail -3
Cuda compilation tools, release 12.8, V12.8.93

$ nvidia-smi | head -4
NVIDIA-SMI 570.211.01   Driver Version: 570.211.01   CUDA Version: 12.8

$ cmake --version | head -1
cmake version 3.28.3
$ gcc --version | head -1
gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0
```

Driver CUDA (12.8) and toolkit CUDA (12.8) matched, so no toolkit install was needed. If they don't match on your box, install the toolkit through NVIDIA's official repo for your distro release rather than assuming the distro package is current.

---

## The build

```bash
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
export PATH=/usr/local/cuda-12.8/bin:$PATH
export CUDACXX=/usr/local/cuda-12.8/bin/nvcc

cmake -B build \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DLLAMA_CURL=ON \
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release -j 10
```

Built commit: `16d222fc5ead59d20039501a37251c9ed457a454` (2026-08-15). Wall clock: **~7 minutes** at `-j 10` on an 8-core laptop. The CUDA template instantiations (flash-attention and MMQ kernels) dominate; the C++ half is quick.

### `CMAKE_CUDA_ARCHITECTURES`

Set this to your GPU's compute capability with the dot removed. Get it from the runtime, don't guess:

```bash
$ ./build/bin/llama-server --version
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 7815 MiB):
  Device 0: NVIDIA GeForce RTX 4060 Laptop GPU, compute capability 8.9, VMM: yes
```

`8.9` → `89`. Common values:

| GPU | Architecture | Value |
|---|---|---|
| RTX 3090 / 3080 | Ampere | `86` |
| RTX 4060 / 4090 | Ada Lovelace | `89` |
| RTX 5090 | Blackwell | `120` |

Building for the wrong architecture either fails to compile or silently falls back to slower paths. Building for several (`"86;89"`) works but multiplies build time.

`-DLLAMA_CURL=ON` enables llama.cpp's built-in Hugging Face model resolution (`-hf user/repo`) and, on recent builds, **automatic MTP-head discovery**.

---

## Verifying a build before you trust it

Three checks. Run them on any pre-existing build before deciding to reuse it.

### 1. Is CUDA actually on?

```bash
$ ./build/bin/llama-server --version
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 7815 MiB): ...
version: 0.1.0-dev (build 1, commit 16d222f)
```

Or read the cache directly:

```bash
$ grep -E "GGML_CUDA|CMAKE_CUDA_ARCH" build/CMakeCache.txt
CMAKE_CUDA_ARCHITECTURES:UNINITIALIZED=89
GGML_CUDA:BOOL=ON
GGML_CUDA_FA:BOOL=ON
GGML_CUDA_GRAPHS:BOOL=ON
```

### 2. Does it know the architecture?

For a Qwen3.5 gated-delta hybrid:

```bash
$ grep -rn "LLM_ARCH_QWEN35" src/llama-arch.cpp | head -2
42:    { LLM_ARCH_QWEN35,    "qwen35"    },
43:    { LLM_ARCH_QWEN35MOE, "qwen35moe" },

$ grep -n "GGML_OP_GATED_DELTA_NET" ggml/include/ggml.h
561:        GGML_OP_GATED_DELTA_NET,
```

### 3. Does it support MTP? — **check this first**

This single line decides whether you rebuild:

```bash
$ ./build/bin/llama-server --help | grep -A2 -- "--spec-type"
```

**Stale build (b8467, 2026-03):**
```
--spec-type [none|ngram-cache|ngram-simple|ngram-map-k|ngram-map-k4v|ngram-mod]
```

**Current master (2026-08):**
```
--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,
            ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache
```

No `draft-mtp` → rebuild. MTP measured **1.45× decode speedup** here ([05](05-Server-Configuration.md#mtp-measured)), which is worth far more than seven minutes of compiling.

---

## Confirming GDN fused kernels are active

This is the check that proves the hybrid architecture is being served properly rather than falling back to a generic path. **It is hidden at default verbosity.**

```bash
llama-server --model model.gguf ... -lv 5 2>&1 | grep -i "gated delta"
```

```
resolve_fused_ops: resolving fused Gated Delta Net support:
resolve_fused_ops: fused Gated Delta Net (autoregressive) enabled
resolve_fused_ops: fused Gated Delta Net (chunked) enabled
```

Two things changed here versus older builds and older documentation:

1. **The prefix moved** from `sched_reserve:` to `resolve_fused_ops:`.
2. **Default verbosity is 3, which suppresses the line entirely.** You must pass `-lv 5`.

Absence of this line at default verbosity means nothing. Don't conclude GDN is off without raising the log level first.

The same block also reports other fused paths the build supports (`Lightning Indexer`, `DeepSeek V4 HC`) — useful for confirming a build is genuinely current.

---

## Build artifacts

```
build/bin/llama-server        the server
build/bin/llama-cli           one-shot CLI
build/bin/libggml-cuda.so     ~55 MB — the bulk of the build
build/bin/libllama.so
```

Disk cost of source + CUDA build: **~1.2 GB**.

---

**Next:** [03 — Model and Quant Selection](03-Model-and-Quant-Selection.md)
