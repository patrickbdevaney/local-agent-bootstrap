# extractd

A lean, concurrent extraction service in Rust: **fetch → readability → markdown**, over plain HTTP. No browser, no Playwright, no Python.

It is rung 1 of the [extraction ladder](../wiki/06-Search-Stack.md). It handles static and server-rendered pages — the overwhelming majority — and reports failure cleanly on anything that genuinely needs JS execution, so the caller falls through to a browser-backed extractor instead of getting a half-rendered page.

---

## Measured against the browser extractor

Same 8 Wikipedia articles, same machine, uncapped output:

| | extractd | crawl4ai (headless Chromium) |
|---|---|---|
| Wall clock, 8 URLs | **0.52 s** warm / 1.51 s cold | **19.43 s** |
| Content extracted | **876,656 chars** | 785,212 chars |
| Resident memory | **50 MiB** | 543 MiB |
| Per-document | 216–508 ms | ~2.4 s |
| Startup | instant | container + browser boot |
| Binary / image | **7.8 MB** | 3.87 GB |

**~13× faster cold, ~37× warm, ~11× less memory — while extracting *more* content**, because readability keeps the article body that the browser extractor's fit-filter sometimes trims. Per-page output is within ±20% of crawl4ai on every URL tested, so fidelity is comparable rather than traded away.

The browser is still worth keeping for the pages that need it. It just should not be the default path.

---

## API

```
GET  /health
POST /extract        {url, max_chars?, format?}          -> one document
POST /extract_batch  {urls[], max_chars?, format?}       -> many, concurrently
```

`format` is `markdown` (default), `text`, or `html`. `max_chars` defaults to 20,000.

```bash
curl -s -X POST http://127.0.0.1:11236/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```
```json
{
  "url": "https://example.com",
  "ok": true,
  "title": "Example Domain",
  "content": "This domain is for use in documentation examples...",
  "chars": 143,
  "truncated": false,
  "elapsed_ms": 88
}
```

Failures are reported in-band, never as a transport error:

```json
{"url":"https://…","ok":false,"error":"unsupported content-type: application/pdf","chars":0,"elapsed_ms":41}
```

`/extract_batch` returns results **positionally aligned with the input**, so a caller can map misses back to their URLs and retry just those on another rung.

---

## Design

- **`reqwest` + `tokio`** — one shared connection pool with keep-alive, HTTP/2, gzip/brotli/deflate/zstd, and a 5-redirect limit. Warm connections are why the second run is 3× faster than the first.
- **`dom_smoothie`** for readability. Actively maintained (0.18, 2026-06); the older `readability` crate has been untouched since 2023.
- **`htmd`** for HTML→Markdown.
- **Bounded concurrency via a semaphore, not via batch size.** A caller can submit 200 URLs and only `EXTRACTD_CONCURRENCY` fetches are ever in flight. Batch size and load are independent.
- **Parsing runs on the blocking pool.** Readability is pure CPU and `dom_smoothie::Readability` is `!Send`; it is constructed and dropped entirely inside `spawn_blocking`, so it never crosses a thread boundary and never stalls the reactor.
- **Content-type gating** — PDFs and binaries are rejected before reaching the parser rather than producing garbage.
- **Size ceiling** (`EXTRACTD_MAX_BYTES`, 8 MB) so one pathological page cannot exhaust memory.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `EXTRACTD_PORT` | 11236 | Listen port (binds `127.0.0.1` only) |
| `EXTRACTD_CONCURRENCY` | 32 | Max simultaneous outbound fetches |
| `EXTRACTD_TIMEOUT_SECS` | 25 | Per-request timeout |
| `EXTRACTD_MAX_BYTES` | 8388608 | Reject documents larger than this |

## Build and run

```bash
cargo build --release
./target/release/extractd
```

`agent up` builds it automatically on first run and manages it thereafter (`run/extractd.pid`, `logs/extractd.log`).

## What it deliberately does not do

No JS execution, no crawling/link-following, no screenshots, no PDF parsing. Those belong to the browser rung. Keeping this service to one job is what makes it 7.8 MB and 50 MiB resident.
