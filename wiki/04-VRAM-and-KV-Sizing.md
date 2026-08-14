# 04 — VRAM and KV Sizing

> The single most transferable page. The arithmetic here is architecture-general; only the constants change between a 4B and a 27B.

---

## The budget equation

```
usable VRAM  ≥  weights(GPU)  +  KV cache  +  recurrent state  +  compute buffer
                              +  MTP context (if enabled)  +  CUDA context  +  margin
```

Solve for context length:

```
context_tokens  =  (usable − weights − recurrent − compute − MTP − CUDA − margin) / KV_bytes_per_token
```

Every term below was measured, not assumed.

---

## Start from usable VRAM, not nominal

```bash
$ nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader
8188 MiB, 11 MiB
```

```
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 7815 MiB)
```

**8188 nominal, 7815 usable.** A ~370 MiB gap the spec sheet does not mention. Size against the number the runtime prints.

Also take the idle baseline before loading anything. Here it was 11 MiB, because the display runs on the iGPU — a desktop compositor on the dGPU can easily consume 300–800 MiB, and that comes straight out of your budget.

---

## KV cache: only full-attention layers count

**This is the hybrid-architecture insight.** In a gated-delta hybrid, most layers are linear-attention (GatedDeltaNet). Those carry a **fixed-size recurrent state**, not a per-token KV cache. Only the interleaved full-attention layers cost KV per token.

For Qwen3.5-4B: `full_attention_interval: 4`, 32 layers → **8 full-attention layers**, 24 GDN layers.

### Per-token cost

```
bytes/token = full_attn_layers × (n_embd_k_gqa + n_embd_v_gqa) × bytes_per_element
```

Take `n_embd_k_gqa` and `n_embd_v_gqa` straight from `print_info` — they already fold in GQA head count and head dimension, so you cannot get the grouping wrong:

```
n_embd_k_gqa = 1024      # 4 KV heads × 256 head_dim
n_embd_v_gqa = 1024
```

At `q8_0` (34 bytes per 32 elements = **1.0625 bytes/element**):

```
8 layers × (1024 + 1024) × 1.0625  =  17,408 bytes/token  ≈  17 KiB/token
```

### Element sizes by cache type

| `--cache-type-k/v` | bytes/element |
|---|---|
| `f16` | 2.0 |
| `q8_0` | 1.0625 |
| `q5_1` | 0.75 |
| `q4_0` | 0.5625 |

`q8_0` is the right default: roughly half the memory of `f16` at negligible quality cost. Going below `q8_0` for a coding agent is usually a false economy — long-context recall degrades noticeably.

### What that buys

| Context | KV @ q8_0 | KV @ f16 |
|---|---|---|
| 32,768 | 544 MiB | 1,024 MiB |
| 65,536 | 1,088 MiB | 2,048 MiB |
| **131,072** | **2,176 MiB** | 4,096 MiB |
| 262,144 | 4,352 MiB | 8,192 MiB |

### Compare against a dense model

A dense 32-layer model with the same head config would cost `32 × 2048 × 1.0625 = 69.6 KiB/token` — **4× more**. At 131k context that is 8.7 GB of KV instead of 2.1 GB.

**That 4× is the entire reason the hybrid architecture matters for long-context agent work**, and it scales: the ratio is `total_layers / full_attention_layers`.

---

## The recurrent state is flat in context length

The GDN layers' state does **not** grow with `-c`:

```
llama_memory_recurrent: CUDA0 RS buffer size = 50.25 MiB
llama_memory_recurrent: size = 50.25 MiB (1 cells, 32 layers, 1 seqs)
                        R (f32): 2.25 MiB, S (f32): 48.00 MiB
```

**50.25 MiB at 4096 context. 50.25 MiB at 131,072 context.** Identical.

With MTP enabled it becomes 201 MiB, because the draft context needs its own sequences:

```
llama_memory_recurrent: size = 201.00 MiB (1 cells, 32 layers, 1 seqs  3 rs_seq)
```

Still flat with respect to context. Budget it as a constant.

---

## Measured breakdown at `-c 131072`

From `-lv 5` startup output plus `nvidia-smi`:

| Component | MiB | Scales with |
|---|---|---|
| Model weights (CUDA0) | 3,141.27 | quant |
| Model weights (CPU_Mapped, token embedding) | 497.31 | *host RAM, not VRAM* |
| GDN recurrent state | 201.00 | **constant** |
| Compute buffer (CUDA0) | 690.28 | batch size, ~constant |
| MTP draft context | 682.02 | model size |
| KV cache (131,072 × 17 KiB) | ~2,176 | **context** |
| CUDA context overhead | ~140 | constant |
| **Total predicted** | **~7,031** | |
| **Observed (`nvidia-smi`)** | **7,031–7,053** | |
| **Free** | **~1,135–1,157** | |

**Prediction matched observation to within ~20 MiB.** The model is trustworthy — you can size a context before downloading a model, given its config.

Note the **497 MiB `CPU_Mapped` buffer**: the tied token-embedding tensor stays in host RAM. It does not consume VRAM, but it does mean `-ngl 99` is not literally "everything on GPU."

---

## Prefill does not spike {#prefill-does-not-spike}

A worry worth eliminating: does a long prefill balloon VRAM beyond steady state?

**No.** The compute buffer is fully reserved at load time.

Test: a **31,492-token** prompt against the running server, sampling `nvidia-smi` every 3 s.

```
prompt_tokens: 31492
prefill:  1795.0 tok/s
decode:     67.5 tok/s
peak VRAM during prefill: 7051 MiB    (steady state: 7031 MiB)
```

**~20 MiB of movement.** So you can size context right up to your margin without reserving extra headroom for prefill spikes — the margin only needs to cover the desktop and driver.

Decode drops from ~80 to 67.5 tok/s at 31k context, which is normal attention-cost scaling.

---

## Worked example: choosing the context

Given usable 7,815 MiB, UD-Q5_K_XL weights, and MTP on:

```
fixed  = 3141 (weights) + 201 (recurrent) + 690 (compute) + 682 (MTP) + 140 (CUDA)
       = 4854 MiB

available for KV = 7815 − 4854 − 1000 (margin) = 1961 MiB
                 → 1961 MiB / 0.017 MiB per token ≈ 115,000 tokens
```

131,072 was chosen anyway — it consumes the margin down to ~1,135 MiB rather than 1,000, which the prefill test confirmed is safe because nothing spikes. **262,144 does not fit**: it needs 2,176 MiB more KV than the card has.

> Round to a power of two at or below your computed ceiling, then **verify with a real long-context request** before trusting it. The arithmetic gets you close; the measurement is what makes it safe.

---

## Checklist for a new model

1. `nvidia-smi` at idle → real free VRAM
2. Load at `-c 4096` → read `n_layer`, `n_embd_k_gqa`, `n_embd_v_gqa`, and the `full_attention` count from the model's `config.json`
3. `bytes/token = full_attn_layers × (k_gqa + v_gqa) × element_bytes`
4. Note weights, recurrent, compute, and MTP from the `-lv 5` startup log
5. Solve for context, subtract ~1 GB margin, round down to a power of two
6. Launch, compare `nvidia-smi` to prediction
7. **Fire a prompt at ~25% of full context** and confirm no spike

---

**Next:** [05 — Server Configuration](05-Server-Configuration.md)
