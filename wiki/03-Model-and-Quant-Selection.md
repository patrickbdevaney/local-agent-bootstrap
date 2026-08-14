# 03 — Model and Quant Selection

---

## Verify the repo exists before you plan around it

Model names in a plan written weeks earlier are unreliable. The ecosystem moves. Check with the API rather than the browser:

```bash
curl -s "https://huggingface.co/api/models/unsloth/Qwen3.5-4B-GGUF?blobs=true" \
| python3 -c "
import json,sys
d=json.load(sys.stdin)
print('id:',d['id'],'| lastModified:',d['lastModified'],'| downloads:',d['downloads'])
for s in d['siblings']:
    if s['rfilename'].endswith('.gguf'):
        print(f\"{(s.get('size') or 0)/1e9:8.2f} GB  {s['rfilename']}\")
"
```

Results:

```
unsloth/Qwen3.5-4B-GGUF     200   lastModified 2026-03-02, 1,186,242 downloads   ← current
unsloth/Qwen3.6-4B-GGUF     401   does not exist
unsloth/Qwen3.8-4B-GGUF     401   does not exist
```

> **Trap:** Hugging Face returns **HTTP 401** for a repository that does not exist, not 404. It reads like an auth failure. It isn't — there is simply no 4B dense GGUF for the Qwen3.6 or 3.8 generations.

Search the hub for anything newer in the same size class before committing:

```bash
curl -s "https://huggingface.co/api/models?search=Qwen3.5-4B&filter=gguf&limit=20&sort=downloads&direction=-1"
```

That search is what surfaced `unsloth/Qwen3.5-4B-MTP-GGUF` — which changed the plan.

---

## Why this model

Qwen3.5-4B is a **genuine gated-delta hybrid**, the same architectural family as the 27B models that are the real target. From `config.json`:

```json
"num_hidden_layers": 32,
"full_attention_interval": 4,
"layer_types": ["linear_attention","linear_attention","linear_attention","full_attention", ...],
"num_attention_heads": 16,
"num_key_value_heads": 4,
"head_dim": 256,
"linear_num_key_heads": 16,
"linear_num_value_heads": 32,
"linear_key_head_dim": 128,
"linear_value_head_dim": 128,
"max_position_embeddings": 262144,
"mtp_num_hidden_layers": 1
```

**24 GatedDeltaNet layers interleaved with 8 full-attention layers** (every 4th). That interleaving is the entire point — it makes this a real architectural rehearsal rather than "some small model." The KV math, the flat recurrent state, and the GDN fused kernels all behave the same way they will at 27B, just smaller.

It also carries `mtp_num_hidden_layers: 1` — an MTP head — and a full 262,144-token training context, which the smaller family members were not guaranteed to share.

---

## The quant ladder

`unsloth/Qwen3.5-4B-GGUF` ships the full range:

```
 1.52 GB  UD-IQ2_XXS        2.74 GB  Q4_K_M
 1.76 GB  UD-IQ2_M          2.91 GB  UD-Q4_K_XL
 1.94 GB  UD-Q2_K_XL        3.02 GB  Q5_K_S
 1.95 GB  UD-IQ3_XXS        3.14 GB  Q5_K_M
 2.11 GB  Q3_K_S            3.25 GB  UD-Q5_K_XL
 2.29 GB  Q3_K_M            3.53 GB  Q6_K
 2.44 GB  UD-Q3_K_XL        4.15 GB  UD-Q6_K_XL
 2.48 GB  IQ4_XS            4.48 GB  Q8_0
 2.58 GB  IQ4_NL            5.95 GB  UD-Q8_K_XL
 2.59 GB  Q4_K_S            8.42 GB  BF16
```

`UD-*` are Unsloth Dynamic quants — mixed precision chosen per-tensor, generally better quality per byte than the plain `K` quants at the same size.

### Choosing

Q4_K_M is the reflexive default, but it is the wrong default when you have headroom. At 4B parameters against ~7.8 GB of usable VRAM, a 2.74 GB file leaves quality on the table for no reason.

The constraint that actually binds is **weights + KV + MTP + compute buffer ≤ usable VRAM at your target context**. Working backwards from 131,072 tokens ([see 04](04-VRAM-and-KV-Sizing.md)):

| Quant | File | Fits 128K ctx + MTP? | Headroom |
|---|---|---|---|
| Q4_K_M | 2.74 GB | yes | ~1.7 GB |
| **UD-Q5_K_XL** | **3.30 GB** | **yes** | **~1.1 GB** ← chosen |
| Q6_K | 3.64 GB | marginal | ~0.8 GB |
| UD-Q6_K_XL | 4.26 GB | no, unless context drops | — |

**UD-Q5_K_XL** was chosen: a meaningful quality gain over Q4_K_M for +0.56 GB, with real headroom preserved at full 128K context.

> **Rule of thumb:** pick the largest quant that still leaves ~1 GB of VRAM free at your target context. Below that margin you are trading a real risk of OOM under load for a marginal quality gain.

---

## The MTP repo

The hub search surfaced a second repository:

```
unsloth/Qwen3.5-4B-MTP-GGUF    76,567 downloads, updated 2026-05-16
```

Same quant ladder, every file **~0.1 GB larger**. That delta is the **MTP head bundled inline** — there is no separate sidecar file, and llama.cpp picks it up automatically from the single GGUF.

This is worth **1.45× decode speed** ([05](05-Server-Configuration.md#mtp-measured)), so the MTP variant was used:

```bash
curl -L --fail -C - -o models/Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf \
  "https://huggingface.co/unsloth/Qwen3.5-4B-MTP-GGUF/resolve/main/Qwen3.5-4B-UD-Q5_K_XL.gguf"
```

Downloaded: **3,304,827,200 bytes**.

> **Safe to use either way.** Loading an MTP GGUF *without* `--spec-type draft-mtp` is harmless — the extra tensors are simply logged and skipped:
> ```
> W model has unused tensor blk.32.attn_q.weight -- ignoring
> W model has unused tensor blk.32.nextn.eh_proj.weight -- ignoring
> ```
> So there is no downside to preferring the MTP repo even if you haven't decided about speculative decoding yet.

---

## Skip the vision projector

These repos also ship `mmproj-BF16.gguf` / `mmproj-F16.gguf` / `mmproj-F32.gguf` (0.67–1.33 GB). They are the multimodal vision projector.

**A coding agent does not need it, and loading it only consumes VRAM.** Don't pass `--mmproj` unless you actually want image input.

---

## Verifying the download

```bash
$ ls -la models/
-rw-rw-r-- 1 patrickd patrickd 3304827200  Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf
```

Then a short-context smoke load before committing to a full-context launch:

```bash
llama-server --model models/Qwen3.5-4B-MTP-UD-Q5_K_XL.gguf \
  --n-gpu-layers 99 -c 4096 -fa on \
  --cache-type-k q8_0 --cache-type-v q8_0 --parallel 1 \
  --host 127.0.0.1 --port 8090
```

`-c 4096` first, always. If something is wrong with the file, the flags, or the architecture support, you find out in seconds instead of after a full-context allocation attempt.

What the server reports on a good load:

```
print_info: arch              = qwen35
print_info: n_layer           = 32
print_info: n_head            = 16
print_info: n_head_kv         = 4
print_info: n_embd_k_gqa      = 1024
print_info: n_embd_v_gqa      = 1024
print_info: n_ctx_train       = 262144
print_info: model params      = 4.21 B
```

Those `n_embd_k_gqa` / `n_embd_v_gqa` values are what you feed into the KV arithmetic — **not** hand-derived head math.

---

**Next:** [04 — VRAM and KV Sizing](04-VRAM-and-KV-Sizing.md)
