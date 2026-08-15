# 11 — Porting to Qwen3.8-27B on an RTX 5090 (Windows/WSL2)

The handoff page. Everything validated on the 8 GB Linux box, translated into what changes on the target.

> **Target: RTX 5090 — 32 GB, Blackwell, compute capability 12.0 (`SM120`).** Confirmed. Build with `-DCMAKE_CUDA_ARCHITECTURES=120` and a **CUDA 12.8 or newer** toolkit; older toolkits do not know SM120 and will fail or silently fall back.

---

## What carries over unchanged

- The **sizing method** in [04](04-VRAM-and-KV-Sizing.md) — architecture-general, only constants change
- The **`agent` CLI** and `agent.env` — port and paths are the only edits
- The **MCP search server** — no changes at all
- The **OpenCode config shape** — change `baseURL`, alias, and `limit.context`
- **Every gotcha in [10](10-Gotchas-and-Deviations.md)**

## What changes

| | This build | 27B target |
|---|---|---|
| GPU | RTX 4060 Laptop, 8 GB, SM89 | **RTX 5090, 32 GB, SM120** |
| `CMAKE_CUDA_ARCHITECTURES` | `89` | **`120`** |
| OS | native Ubuntu | **Windows + WSL2** |
| Display on the GPU | none (iGPU drives it) | **Windows desktop shares the card** |
| Model | 4B, 3.3 GB | 27B, ~15–20 GB depending on quant |

---

## Step 1 — Get the architecture numbers *before* downloading

You can compute the entire VRAM budget from the model's `config.json` without downloading a single GGUF:

```bash
curl -s "https://huggingface.co/<org>/<Qwen3.8-27B-repo>/resolve/main/config.json" \
| python3 -c "
import json,sys
c=json.load(sys.stdin)
t=c.get('text_config', c)
lt=t.get('layer_types',[])
full=sum(1 for x in lt if x=='full_attention')
print('total layers      :', t.get('num_hidden_layers'))
print('full-attn layers  :', full or 'derive from full_attention_interval')
print('interval          :', t.get('full_attention_interval'))
print('num_kv_heads      :', t.get('num_key_value_heads'))
print('head_dim          :', t.get('head_dim'))
print('max_position_emb  :', t.get('max_position_embeddings'))
print('mtp layers        :', t.get('mtp_num_hidden_layers'))
print()
kv_heads=t.get('num_key_value_heads'); hd=t.get('head_dim')
if full and kv_heads and hd:
    per_tok = full * 2 * kv_heads * hd * 1.0625   # q8_0
    print('KV bytes/token @ q8_0: %.0f  (%.1f KiB)' % (per_tok, per_tok/1024))
"
```

**Do not assume the 4B's numbers.** The 4B has 8 full-attention layers of 32, `n_embd_k_gqa = 1024`, giving 17 KiB/token. A 27B will differ in every one of those.

Confirm against the runtime once loaded — `print_info` reports `n_embd_k_gqa` / `n_embd_v_gqa` directly, and those already fold in GQA grouping:

```
print_info: n_embd_k_gqa = ....
print_info: n_embd_v_gqa = ....
```

```
KV bytes/token = full_attn_layers × (n_embd_k_gqa + n_embd_v_gqa) × 1.0625
```

---

## Step 2 — Budget the card

```
context_tokens = (usable − weights − recurrent − compute − MTP − CUDA − margin) / KV_bytes_per_token
```

### Constants to expect

| Term | 4B measured | 27B expectation |
|---|---|---|
| Weights (GPU) | 3,141 MiB | **~15,000–20,000 MiB** — the dominant term; read the actual file size |
| Recurrent state | 201 MiB (with MTP) | scales with GDN layer count, still **flat in context** |
| Compute buffer | 690 MiB | larger; read it from the `-lv 5` log |
| MTP context | 682 MiB | **scales with model size — do not assume it stays small** |
| CUDA context | ~140 MiB | similar |

### Margin — **bigger on Windows**

On the validation box the desktop used **4 MiB** of dGPU because the display ran on the iGPU. That will not be true on the target.

> **On Windows, the desktop compositor, browser, and any GPU-accelerated app share the card.** Budget **1.5–2 GB** of margin rather than the ~1 GB used here, and measure the real idle baseline with a normal desktop session running — not a freshly rebooted one.

```powershell
# in Windows, with your normal apps open
nvidia-smi --query-gpu=memory.used,memory.free --format=csv
```

### The budget on 32 GB

| | |
|---|---|
| Nominal | 32,768 MiB |
| Expect usable (runtime-reported) | ~31,000 MiB |
| Less Windows desktop margin | ~29,000 MiB |

A worked template — **the two starred rows must be measured, not assumed**:

```
usable (runtime-reported)                        ~31,000 MiB
− Windows desktop / browser margin                 2,000
− model weights (Q5-class 27B)  *measure*        ~19,000
− MTP draft context             *measure*         2,000–4,000
− compute buffer                                  1,000–1,500
− GDN recurrent state                               ~500
− CUDA context                                      ~200
                                                 ───────────
  available for KV                                ~4,000–6,300 MiB
```

At 34–51 KiB/token that lands somewhere around **80K–180K context**, which is comfortable. 32 GB means you are **not** forced to trade quant against context against MTP — expect a Q5- or Q6-class quant, long context, and MTP all at once.

> **The two numbers to measure first.** Weights come straight from the GGUF file size. The MTP draft context is the one that could surprise you: it was 682 MiB against 3,141 MiB of weights on the 4B (~22%). If that ratio holds it is ~4 GB on a 19 GB model — still affordable at 32 GB, but read it from the log rather than assuming:
> ```
> srv load_model: [spec] estimated memory usage of MTP context is XXXX MiB
> ```

### Context lookup

Once you know KV bytes/token, read across:

| KV/token | 32K ctx | 64K ctx | 128K ctx | 256K ctx |
|---|---|---|---|---|
| 17 KiB *(the 4B)* | 0.53 GB | 1.06 GB | 2.13 GB | 4.25 GB |
| 34 KiB | 1.06 GB | 2.13 GB | 4.25 GB | 8.50 GB |
| 51 KiB | 1.59 GB | 3.19 GB | 6.38 GB | 12.75 GB |
| 68 KiB | 2.13 GB | 4.25 GB | 8.50 GB | 17.00 GB |

Then **verify with a real long prompt** — prefill does not spike ([06 in gotchas](10-Gotchas-and-Deviations.md#6-prefill-does-not-spike-vram)), so the measurement is the whole check.

---

## Step 3 — WSL2 specifics

These are the ones that differ from a native Linux install.

### Driver and toolkit

> **Do not install an NVIDIA display driver inside WSL2.** The Windows driver provides GPU access through `/dev/dxg`. Installing a Linux driver in the distro breaks it.

1. Install the current **NVIDIA Windows driver** (it includes WSL support)
2. Inside WSL2, install **only the CUDA toolkit** — use NVIDIA's WSL-Ubuntu repo, not the generic Linux one, which would pull a driver
3. Verify inside WSL2:
   ```bash
   nvidia-smi                     # should list the GPU
   nvcc --version                 # toolkit
   ls /usr/lib/wsl/lib/           # libcuda.so.1 lives here on WSL
   ```

If `nvidia-smi` works but builds can't find `libcuda`, add `/usr/lib/wsl/lib` to the linker path.

### Build flags

```bash
# RTX 5090 (Blackwell, SM120)
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 -DLLAMA_CURL=ON -DCMAKE_BUILD_TYPE=Release
```

Blackwell needs a **CUDA 12.8 or newer toolkit**; older ones do not know SM120 and will fail to compile or silently fall back to a slower path. Confirm the compute capability from the runtime rather than from a table:

```bash
./build/bin/llama-server --version   # prints "compute capability X.Y"
```

### WSL2 memory

WSL2 gets a fraction of system RAM by default, and model loading is RAM-hungry even when weights end up on the GPU (mmap plus the CPU-mapped embedding tensor — 497 MiB even on the 4B). If loads are slow or OOM, raise it in `%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=32GB
swap=16GB
```

Then `wsl --shutdown` and restart.

### Filesystem

> **Keep the repo and models inside the WSL filesystem** (`/home/you/...`), never under `/mnt/c/...`. Cross-OS filesystem access is dramatically slower and will make model loading and builds painful.

### Docker

Either works:
- **Docker Desktop** with the WSL2 backend — containers are reachable from WSL at `localhost`
- **Docker installed inside the distro** — closer to the validated setup

Either way, SearXNG and crawl4ai bind the same ports and the MCP server needs no change.

### Networking

WSL2 forwards `localhost` to Windows in both directions for listening sockets, so `127.0.0.1:8090` works from both sides. **That also means binding `0.0.0.0` exposes your unauthenticated llama-server more widely than you expect.** Keep `--host 127.0.0.1`.

### systemd

Recent WSL2 supports systemd via `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

Only worth it if you want `agent up` replaced by a user unit. The `nohup` + PID-file approach in `bin/agent` works fine without it.

---

## Step 4 — The order that saves time

1. **Inventory the box first.** It eliminated an entire phase here. Check what's already running, what ports are taken, what's already downloaded.
2. **`llama-server --help | grep -A2 spec-type`** — before anything else. No `draft-mtp` → rebuild first, don't discover it later.
3. **Build with the right `CMAKE_CUDA_ARCHITECTURES`.**
4. **Pull `config.json` and compute the KV budget** before downloading 15–20 GB of weights.
5. **Smoke load at `-c 4096`.** Seconds to fail instead of minutes.
6. **Try auto-fit** — launch without `-ngl` and `-c` and see what it picks. On a big card this is more likely to beat hand-tuning than it was here.
7. **Test `--reasoning off` immediately.** One flag. It was the single biggest blocker.
8. **Measure MTP on vs off.** It was 1.45× here for +682 MiB. At 32 GB the VRAM cost should be easy to absorb, but confirm the speedup actually holds at 27B rather than assuming it transfers.
9. **Verify with a long prompt** at ~25% of target context and confirm VRAM doesn't move.
10. **Then** wire OpenCode and the MCP server — they are the parts least likely to surprise you.

---

## Step 5 — Config deltas

`agent.env`:
```bash
LLAMA_MODEL="$BOOTSTRAP_ROOT/models/<the-27B>.gguf"
LLAMA_ALIAS="qwen3.8-27b"
LLAMA_CTX=<computed>
LLAMA_PORT=8090            # still check `ss -tlnp` first
LLAMA_SPEC_TYPE=draft-mtp  # if the GGUF has a head and it fits
LLAMA_REASONING=off        # verify on the 27B
```

`opencode.json`:
```json
"models": { "qwen3.8-27b": { "limit": { "context": <computed>, "output": 8192 } } },
"model": "local/qwen3.8-27b",
"small_model": "local/qwen3.8-27b"
```

Nothing else needs to change. `mcp/search-server.mjs` is model-agnostic.

---

## Open questions this run could not answer

Stated plainly so they aren't mistaken for settled:

1. **Does the 27B reason more efficiently?** At 4B, thinking-on cost 16–83× the tokens for *identical* output on an easy task, and neither a tighter prompt nor a bigger budget helped ([experiment](../experiments/reasoning-budget/README.md)). A 27B may reason far more efficiently, and on genuinely hard tasks the extra tokens might buy something real — this was only measured on a task that is trivially easy, which is the case least favourable to thinking. `experiments/reasoning-budget/run.sh` ports as-is. Judge on **cost**, not correctness: every thinking-on run completed.
2. **Does MTP still pay at 27B?** The draft context scales with model size — likely 2–4 GB. At 32 GB that is affordable; the open question is whether the 0.71 draft-acceptance rate and 1.45× speedup hold at 27B, or whether a larger target model makes the small draft head less useful.
3. **Is a 27B good enough for large refactors?** The 4B handled small, well-specified tasks correctly ([09](09-Validation-Results.md), [`docs/AGENT_RUNS.md`](../docs/AGENT_RUNS.md)) and was never evaluated beyond that. **This run validates the plumbing, not the model's ceiling.**
4. **Windows desktop VRAM tax.** The validation box had effectively none. Measure it early — it comes straight out of your context budget.

---

**Back to:** [wiki index](README.md)
