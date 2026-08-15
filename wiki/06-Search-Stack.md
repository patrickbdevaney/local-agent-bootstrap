# 06 — Search Stack

Four layers: **SearXNG and a set of structured APIs** find sources in parallel, **RRF** fuses them, an **extraction ladder** turns pages into readable text, and a small **MCP server** exposes the result as `web_search`, `web_fetch`, and `deep_research`. An optional **multi-provider inference pool** summarizes on top, and is never required.

---

## SearXNG

A metasearch proxy. Self-hosted, no API key, aggregates upstream engines.

```bash
docker run -d --name searxng -p 8080:8080 \
  -v "$PWD/searxng:/etc/searxng" searxng/searxng:latest
```

### JSON output is OFF by default

The single thing that trips everyone. Patch `settings.yml`:

```yaml
search:
  formats:
    - html
    - json          # <-- add this
```

Then `docker restart searxng`. Verify:

```bash
$ curl -s "http://localhost:8080/search?q=test&format=json" | head -c 200
{"query": "test", "results": [{"url": "https://en.wikipedia.org/wiki/Test", ...
```

On the validation box this was **already enabled** by prior work, so the container was left untouched.

### The empty 200 {#the-empty-200}

> **Read `unresponsive_engines`.** SearXNG returns **HTTP 200 with an empty `results` array** when its upstream engines are all throttled. It looks exactly like "no results found," and it is very easy to misdiagnose as a bug in your own client.

```json
{
  "query": "speculative decoding",
  "results": [],
  "unresponsive_engines": [
    ["brave", "Suspended: too many requests"],
    ["startpage", "Suspended: CAPTCHA"]
  ]
}
```

Throughout the validation session Brave was rate-limited and Startpage was CAPTCHA-suspended; **DuckDuckGo carried every result**. A burst of queries in quick succession reliably produced empty sets.

An early test returned zero results and looked like a client bug. It wasn't — the same query worked seconds later. The MCP server now retries once after a 1.5 s backoff and logs the unresponsive engine list:

```js
async function searxSearch(query, count) {
  let last = await searxSearchOnce(query, count);
  if (last.results.length === 0) {
    log(`searxng: empty result set, retrying once`);
    await sleep(1500);
    last = await searxSearchOnce(query, count);
  }
  return last.results;
}
```

**Expect degraded engine availability as the normal case**, not an exception.

---

## The extraction ladder

Extraction is a **ladder**, not a single backend. Rung 1 handles the common case cheaply; rung 2 exists for the pages that genuinely need a browser.

| Rung | What | When it runs |
|---|---|---|
| 1 | **extractd** — native Rust, `reqwest` + `dom_smoothie` + `htmd` | always first |
| 2 | **crawl4ai** — headless Chromium | only when rung 1 reports it could not render the page |

### Why the ladder, measured

Same 8 Wikipedia articles, uncapped:

| | extractd | crawl4ai |
|---|---|---|
| Wall clock, 8 URLs | **0.52 s** warm / 1.51 s cold | **19.43 s** |
| Content extracted | **876,656 chars** | 785,212 chars |
| Resident memory | **50 MiB** | 543 MiB |
| Artifact | 7.8 MB binary | 3.87 GB image |

**~13× faster cold, ~37× warm, ~11× less memory — extracting *more* content overall, not less.** Per-page the two disagree by **-8.8% to +44.2%** (one page shorter, seven longer): they draw the boilerplate line differently. Spot-checked output is clean article text either way.

A headless browser is the right tool for JS-rendered SPAs and little else. Making it the default path costs an order of magnitude on every page that did not need it. Full detail and API: [`extractor/README.md`](../extractor/README.md).

`extractAll()` sends the whole result list to `extractd`'s `/extract_batch` in one call — it bounds its own concurrency internally — then retries **only the URLs it could not render** on the browser rung. Results are positionally aligned, so misses map back to their URLs exactly.

### crawl4ai — the browser rung

```bash
docker run -d --name crawl4ai -p 11235:11235 unclecode/crawl4ai:latest
```

```bash
$ curl -s http://localhost:11235/health
{"status":"ok","timestamp":1786745639,"version":"0.8.6"}
```

### The `/md` endpoint

```bash
curl -s -X POST http://localhost:11235/md \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","f":"fit"}'
```

```json
{"url":"https://example.com","filter":"fit",
 "markdown":"# Example Domain\nThis domain is for use in documentation examples...",
 "success":true}
```

`f: "fit"` applies content-fit filtering — the readability pass that strips nav, ads, and boilerplate.

Other endpoints (`/crawl`, `/html`, `/screenshot`, `/pdf`, `/execute_js`, `/llm/{url}`) exist; `/md` is all this rung needs. Keep the container: it is the fallback that makes rung 1 safe to prefer.

---

## The MCP server

`mcp/search-server.mjs` — **dependency-free Node**, newline-delimited JSON-RPC 2.0 over stdio.

### Why no SDK

The MCP stdio protocol is small enough to implement directly: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Writing it against the wire format means **zero npm dependencies to break** on upgrade, and it is ~100 lines of protocol handling.

### Tools

**`web_search(query, count, mode, summarize)`**

1. Query SearXNG (retry once on empty)
2. In `normal` mode, fetch and extract the top 4 results in parallel via crawl4ai
3. Optionally summarize with citations if a remote summarizer is configured
4. Return summary (if any) + extracted content + all snippets

**`web_fetch(url, max_chars)`** — single-URL readability extraction.

**`deep_research(topic, breadth, depth)`** — a research cascade rather than a single query. It expands the topic into `breadth` distinct sub-queries, searches and extracts sources for each, summarizes the branches **concurrently**, then synthesizes one report with globally-numbered citations. Sources are deduplicated by URL across branches so nothing is extracted or summarized twice. Every stage degrades independently: if synthesis is unavailable you still get the per-branch findings; if summarization is unavailable you still get the extracted text; if extraction fails you still get snippets.

### Graceful degradation at every layer

Nothing in this chain is allowed to fail hard:

| Failure | Behavior |
|---|---|
| SearXNG unreachable | Returns `"Search backend unavailable"` as text, `isError: false` |
| SearXNG empty | Retries once, then returns snippets or a clear no-results message |
| extractd cannot render a page | That URL falls through to the browser rung |
| crawl4ai fails on one URL | That result is dropped; others proceed |
| Both rungs fail on all | Falls back to titles + snippets |
| Summarizer unavailable | Section omitted entirely; extracted content still returned |
| Tool throws | Returned as `isError: true` **content**, not a JSON-RPC protocol error, so the model can recover |

That last one matters: a protocol-level error can break the harness's tool loop, whereas an error returned *as content* lets the model read it and try something else.

### A real bug this caught

The first version exited on stdin close:

```js
rl.on("close", () => process.exit(0));
```

Requests in flight were silently killed — a piped test showed `tools/list` returning but `tools/call` never responding. Fixed with pending-request tracking:

```js
let pending = 0, stdinClosed = false;
const maybeExit = () => { if (stdinClosed && pending === 0) process.exit(0); };
rl.on("line", (line) => {
  pending++;
  handle(msg).catch(...).finally(() => { pending--; maybeExit(); });
});
rl.on("close", () => { stdinClosed = true; maybeExit(); });
```

### Testing without a harness

Drive it with plain stdin — much faster than debugging through OpenCode:

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"web_fetch","arguments":{"url":"https://example.com"}}}' \
| node mcp/search-server.mjs
```

---

## The optional summarizer

Configured through `.env` (gitignored). It is **strictly additive**: when available it prepends a cited summary; when not, the tool returns the same extracted content with the summary section simply absent.

All three failure modes were tested explicitly:

| Path | Result |
|---|---|
| Credentials valid | Summary returned with `[1]`/`[2]` citations |
| All credentials invalid | Silent fallback, `isError: false`, 13,933 chars of content returned |
| No credentials at all | Summarization skipped, identical 13,933-char result |

**The user never sees an error in any of these cases.** That was the design requirement and it holds.

`.env` was never edited to test this — failures were induced via environment overrides and a throwaway directory. Verified: md5 and mtime unchanged before and after.

> **Sizing note:** the provider's rate limit is **token-per-minute and account-scoped**. An oversized summarization prompt exhausts the budget regardless of how the request is routed. The fix is to size the prompt (`AGENT_GROQ_CHARS_PER_SOURCE=2200`, 4 sources ≈ 2.5k tokens), not to add capacity.

---

## Search-mode scaling

`agent.env` exposes a speed-linked degradation:

```bash
AGENT_SEARCH_MODE=normal    # fetch + extract + summarize
SPEED_THRESHOLD=0.70        # drop to shallow below 70% of saved baseline
```

`agent bench --save` records the box's own clean baseline (**78.60 tok/s** here). `effective_mode()` re-measures and drops to `shallow` — snippets only, no fetch, no summarization — when decode falls below 70% of it. The baseline is per-box and must never be imported from different hardware.

---

**Next:** [07 — OpenCode Configuration](07-OpenCode-Configuration.md)
