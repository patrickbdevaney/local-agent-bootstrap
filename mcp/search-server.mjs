#!/usr/bin/env node
// Local search/fetch/research MCP server for local-agent-bootstrap.
//
// Tools:
//   web_search     - SearXNG JSON search, optionally deep (fetch+extract top N)
//                    and optionally summarized. Degrades to titles+snippets.
//   web_fetch      - readability extraction for a single URL, via the extraction ladder.
//   deep_research  - multi-query research cascade: expands a topic into sub-queries,
//                    searches and extracts each, summarizes the branches concurrently,
//                    then synthesizes one cited report.
//
// The remote summarizer is strictly optional and additive. Any failure (invalid
// credentials, 429, 400, timeout, network) degrades silently to local-only behavior,
// with no error surfaced to the caller. Search and fetch work fully without it.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio. No npm dependencies.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { buildLanes, Pool } from "./lanes.mjs";
import * as sources from "./sources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const log = (...a) => process.stderr.write(`[search-mcp] ${a.join(" ")}\n`);

// ---------------------------------------------------------------- config

function loadEnvFile(p) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(ROOT, ".env"));
const env = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

const SEARXNG_URL = env("SEARXNG_URL", "http://127.0.0.1:8080").replace(/\/$/, "");
const EXTRACTD_URL = env("EXTRACTD_URL", "http://127.0.0.1:11236").replace(/\/$/, "");
const CRAWL4AI_URL = env("CRAWL4AI_URL", "http://127.0.0.1:11235").replace(/\/$/, "");
// "normal" = fetch + extract top results (+ optional summary); "shallow" = snippets only.
const DEFAULT_MODE = env("AGENT_SEARCH_MODE", "normal");
const FETCH_TIMEOUT_MS = Number(env("AGENT_FETCH_TIMEOUT_MS", "45000"));
const GROQ_TIMEOUT_MS = Number(env("AGENT_GROQ_TIMEOUT_MS", "30000"));
// Per-source character budget for a summarization prompt. Keeps each individual
// request well inside the provider's per-minute token allowance.
const GROQ_CHARS_PER_SOURCE = Number(env("AGENT_GROQ_CHARS_PER_SOURCE", "2200"));
// SearXNG's upstream engines throttle per-engine and recover over time, so queries
// are serialised behind a minimum interval rather than issued concurrently. Firing a
// research cascade in parallel reliably CAPTCHAs every engine at once.
const SEARCH_PACING_MS = Number(env("AGENT_SEARCH_PACING_MS", "1500"));
const SEARCH_RETRIES = Number(env("AGENT_SEARCH_RETRIES", "2"));
const SEARCH_RETRY_BACKOFF_MS = Number(env("AGENT_SEARCH_RETRY_BACKOFF_MS", "2500"));
const EXTRACT_CONCURRENCY = Number(env("AGENT_EXTRACT_CONCURRENCY", "6"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(ms, fn) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(t);
  }
}

/** Run fn over items with at most `limit` in flight. Result order is preserved. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    new Array(width).fill(0).map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await fn(items[i], i);
        } catch {
          out[i] = null;
        }
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- summarizer transport

/**
 * Inference lanes for the optional summarizer. One lane per PROVIDER, because
 * free-tier limits are account-scoped: stacking credentials on one account does not
 * multiply throughput, but a second provider does. Total in-flight is the sum of
 * lane concurrencies. See mcp/lanes.mjs.
 *
 * The local lane is the llama-server this stack already runs. It is last and
 * single-slot: it exists so research still works with no provider configured at
 * all, not to add capacity. Set POOL_DISABLE_LOCAL=1 to leave it out.
 */
const POOL = new Pool({
  lanes: buildLanes(
    { ...fileEnv, ...process.env },
    { localBaseURL: env("LOCAL_BASE_URL", "http://127.0.0.1:8090/v1"), localModel: "qwen3.5-4b" },
  ),
  timeoutMs: GROQ_TIMEOUT_MS,
  log,
});

const SUMMARIZER_ENABLED = POOL.available();

/**
 * One summarization request across the lanes. Returns null when no lane can serve
 * it — callers degrade to local-only output rather than surfacing an error.
 */
async function summarize(messages, { maxTokens = 900 } = {}) {
  if (!SUMMARIZER_ENABLED) return null;
  const out = await POOL.completeOne(messages, { maxTokens });
  if (!out) log("summarizer: no lane could serve the request, continuing local-only");
  return out;
}

/** Fan out several summarization requests across every lane at once. */
const summarizeMany = (jobs, opts = {}) => POOL.map(jobs, opts);

// ---------------------------------------------------------------- search + extract

// Global gate: one SearXNG query at a time, with a minimum gap between them.
let searchChain = Promise.resolve();
let lastSearchAt = 0;

function paced(fn) {
  const p = searchChain.then(async () => {
    const wait = SEARCH_PACING_MS - (Date.now() - lastSearchAt);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastSearchAt = Date.now();
    }
  });
  searchChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

async function searxSearchOnce(query, count) {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await withTimeout(FETCH_TIMEOUT_MS, (signal) => fetch(url, { signal }));
  if (!res.ok) throw new Error(`searxng ${res.status}`);
  const data = await res.json();
  return {
    unresponsive: data.unresponsive_engines || [],
    results: (data.results || []).slice(0, count).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: (r.content || "").trim(),
      engine: r.engine || "",
    })),
  };
}

/**
 * SearXNG returns HTTP 200 with an empty result set when every upstream engine is
 * rate-limited or CAPTCHA-suspended, which happens easily under bursty querying.
 * Retry once after a short backoff before reporting an empty result.
 */
async function searxSearch(query, count) {
  let last = await paced(() => searxSearchOnce(query, count));
  for (let i = 0; i < SEARCH_RETRIES && last.results.length === 0; i++) {
    log(
      `searxng: empty result set, retry ${i + 1}/${SEARCH_RETRIES} ` +
        `(unresponsive: ${JSON.stringify(last.unresponsive)})`,
    );
    await sleep(SEARCH_RETRY_BACKOFF_MS * (i + 1));
    last = await paced(() => searxSearchOnce(query, count));
  }
  if (last.unresponsive.length > 0) {
    log(`searxng: unresponsive engines: ${JSON.stringify(last.unresponsive)}`);
  }
  return last.results;
}

/**
 * Extraction ladder. Rung 1 is extractd, a native concurrent fetch+readability
 * service that handles static and server-rendered pages for a fraction of the cost
 * of a browser. Rung 2 is crawl4ai, a headless-Chromium extractor that gets what
 * genuinely needs JS execution. Rung 1 reports failure rather than guessing, so a
 * page it cannot handle falls through cleanly.
 */
async function extractdOne(url, maxChars) {
  const res = await withTimeout(FETCH_TIMEOUT_MS, (signal) =>
    fetch(`${EXTRACTD_URL}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, max_chars: maxChars }),
      signal,
    }),
  );
  if (!res.ok) throw new Error(`extractd ${res.status}`);
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || "extractd could not render the page");
  return { text: (d.content || "").trim(), title: d.title || "" };
}

async function extractdBatch(urls, maxChars) {
  const res = await withTimeout(FETCH_TIMEOUT_MS * 2, (signal) =>
    fetch(`${EXTRACTD_URL}/extract_batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, max_chars: maxChars }),
      signal,
    }),
  );
  if (!res.ok) throw new Error(`extractd ${res.status}`);
  return res.json();
}

async function crawlExtract(url) {
  const res = await withTimeout(FETCH_TIMEOUT_MS, (signal) =>
    fetch(`${CRAWL4AI_URL}/md`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, f: "fit" }),
      signal,
    }),
  );
  if (!res.ok) throw new Error(`crawl4ai ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error("crawl4ai extraction failed");
  return (data.markdown || "").trim();
}

/** Single-URL extraction through the ladder. Throws only if every rung fails. */
async function extractDoc(url, maxChars = 20000) {
  try {
    const d = await extractdOne(url, maxChars);
    if (d.text.length > 0) return d.text;
    throw new Error("empty document");
  } catch (e1) {
    log(`extractd miss for ${url}: ${e1.message} - falling back to browser rung`);
    try {
      return (await crawlExtract(url)).slice(0, maxChars);
    } catch (e2) {
      throw new Error(`${e1.message}; browser rung: ${e2.message}`);
    }
  }
}

/**
 * Fetch and extract a list of results, dropping the ones that fail. The whole list
 * goes to extractd in one batch call (it bounds its own concurrency), and only the
 * URLs it could not render are retried on the browser rung.
 */
async function extractAll(results, perDocChars = 6000) {
  if (results.length === 0) return [];

  let batch = null;
  try {
    batch = await extractdBatch(results.map((r) => r.url), perDocChars);
  } catch (e) {
    log(`extractd batch unavailable (${e.message}); using browser rung for all`);
  }

  const out = new Array(results.length).fill(null);
  const misses = [];

  results.forEach((r, i) => {
    const d = batch && batch[i];
    if (d && d.ok && (d.content || "").trim().length > 0) {
      out[i] = { ...r, title: r.title || d.title || "", text: d.content.trim() };
    } else {
      if (d && d.error) log(`extractd miss for ${r.url}: ${d.error}`);
      misses.push(i);
    }
  });

  if (misses.length > 0) {
    await mapLimit(misses, EXTRACT_CONCURRENCY, async (i) => {
      try {
        out[i] = { ...results[i], text: (await crawlExtract(results[i].url)).slice(0, perDocChars) };
      } catch (e) {
        log(`extract failed for ${results[i].url}: ${e.message}`);
      }
    });
  }

  return out.filter(Boolean);
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web via a local SearXNG instance. In normal mode the top results are " +
      "fetched and extracted to readable text, and summarized when a summarizer is " +
      "available. In shallow mode only titles and snippets are returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "integer", description: "Number of results to consider (default 5, max 10)" },
        mode: {
          type: "string",
          enum: ["normal", "shallow"],
          description: "normal = fetch + extract page text; shallow = snippets only",
        },
        summarize: {
          type: "boolean",
          description: "Ask for a synthesized answer in addition to the sources (default true)",
        },
        structured: {
          type: "boolean",
          description:
            "Also query structured sources (papers, Q&A, discussions) and fuse them with the web results (default true)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a single URL and return its main readable content as markdown, using the " +
      "local crawl4ai extraction service.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to fetch" },
        max_chars: {
          type: "integer",
          description: "Truncate the returned text to this many characters (default 20000)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "deep_research",
    description:
      "Research a topic in depth. Expands the topic into several distinct sub-queries, " +
      "searches and extracts sources for each, summarizes the branches concurrently, and " +
      "synthesizes one cited report. Slower than web_search but far more thorough — use it " +
      "for open-ended questions where a single query would miss most of the picture.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The research question or topic" },
        breadth: {
          type: "integer",
          description: "Number of sub-queries to explore (default 4, max 12)",
        },
        depth: {
          type: "integer",
          description: "Sources to fetch and extract per sub-query (default 3, max 6)",
        },
      },
      required: ["topic"],
    },
  },
];

async function doWebSearch(args) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query is required");
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
  const mode = args.mode || DEFAULT_MODE;
  const wantSummary = args.summarize !== false;

  // The web layer and the structured APIs are queried CONCURRENTLY and fused, so
  // neither is a single point of failure. SearXNG's upstream engines throttle and
  // CAPTCHA constantly; keyless structured sources do not.
  const useStructured = args.structured !== false;
  const [webResults, fanout] = await Promise.all([
    searxSearch(query, count).catch((e) => {
      log(`searxng unavailable: ${e.message}`);
      return [];
    }),
    useStructured
      ? sources.sourceFanout(query, { extraLists: [] }).catch((e) => {
          log(`structured sources failed: ${e.message}`);
          return { results: [], perSource: {} };
        })
      : Promise.resolve({ results: [], perSource: {} }),
  ]);

  const results = useStructured
    ? sources.rrfFuse([webResults, fanout.results]).slice(0, Math.max(count, 6))
    : webResults;

  if (results.length === 0) return `No results for: ${query}`;

  const lines = [`# Search results for: ${query}`, ""];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  });

  if (mode === "shallow") {
    lines.push("_(shallow mode: snippets only, pages not fetched)_");
    return lines.join("\n");
  }

  const good = await extractAll(results.slice(0, 4));
  if (good.length === 0) {
    lines.push("_(page extraction unavailable; snippets only)_");
    return lines.join("\n");
  }

  if (wantSummary) {
    const context = good
      .map((g, i) => `[${i + 1}] ${g.title}\nURL: ${g.url}\n${g.text.slice(0, GROQ_CHARS_PER_SOURCE)}`)
      .join("\n\n---\n\n");
    const summary = await summarize([
      {
        role: "system",
        content:
          "You summarize web search results for a coding agent. Be concise and factual. " +
          "Cite sources as [1], [2] matching the numbered inputs. If sources conflict, say so.",
      },
      { role: "user", content: `Question: ${query}\n\nSources:\n\n${context}` },
    ]);
    if (summary) lines.push("## Summary", "", summary, "");
  }

  lines.push("## Extracted content", "");
  good.forEach((g, i) => {
    lines.push(`### [${i + 1}] ${g.title}`);
    lines.push(g.url, "");
    lines.push(g.text.slice(0, 4000), "");
  });

  return lines.join("\n");
}

async function doWebFetch(args) {
  const url = String(args.url || "").trim();
  if (!url) throw new Error("url is required");
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 20000, 500), 100000);
  const text = await extractDoc(url, maxChars);
  return `# ${url}\n\n${text.slice(0, maxChars)}${text.length > maxChars ? "\n\n_(truncated)_" : ""}`;
}

/** Expand a topic into distinct sub-queries. Falls back to templates when offline. */
async function planSubQueries(topic, breadth) {
  const plan = await summarize(
    [
      {
        role: "system",
        content:
          "You plan web research. Given a topic, return exactly N distinct search queries " +
          "that together cover it from different angles (definition, mechanism, tradeoffs, " +
          "practical use, criticism). Return ONLY the queries, one per line, no numbering, " +
          "no commentary.",
      },
      { role: "user", content: `Topic: ${topic}\nN: ${breadth}` },
    ],
    { maxTokens: 300 },
  );

  if (plan) {
    const qs = plan
      .split("\n")
      .map((l) => l.replace(/^\s*[-*\d.)\]]+\s*/, "").trim())
      .filter((l) => l.length > 2)
      .slice(0, breadth);
    if (qs.length > 0) return qs;
  }

  const angles = [
    (t) => t,
    (t) => `${t} how it works`,
    (t) => `${t} tradeoffs limitations`,
    (t) => `${t} practical example`,
    (t) => `${t} best practices`,
    (t) => `${t} comparison alternatives`,
    (t) => `${t} common problems`,
    (t) => `${t} benchmark performance`,
    (t) => `${t} configuration`,
    (t) => `${t} criticism`,
    (t) => `${t} tutorial`,
    (t) => `${t} documentation`,
  ];
  return angles.slice(0, breadth).map((f) => f(topic));
}

async function doDeepResearch(args) {
  const topic = String(args.topic || "").trim();
  if (!topic) throw new Error("topic is required");
  const breadth = Math.min(Math.max(Number(args.breadth) || 4, 1), 12);
  const depth = Math.min(Math.max(Number(args.depth) || 3, 1), 6);

  const queries = await planSubQueries(topic, breadth);
  log(`deep_research: "${topic}" -> ${queries.length} sub-queries, depth ${depth}`);

  // Search each branch. `searxSearch` paces itself globally, so this is safe to
  // hand off in bulk - the queries still go out one at a time, spaced apart.
  const searched = await mapLimit(queries, queries.length, async (q) => {
    const [web, fan] = await Promise.all([
      searxSearch(q, depth).catch((e) => {
        log(`deep_research: web search failed for "${q}": ${e.message}`);
        return [];
      }),
      sources.sourceFanout(q).catch((e) => {
        log(`deep_research: structured sources failed for "${q}": ${e.message}`);
        return { results: [] };
      }),
    ]);
    return { query: q, results: sources.rrfFuse([web, fan.results]).slice(0, depth) };
  });

  // Deduplicate sources by URL across branches before spending extraction on them.
  const seen = new Set();
  const branches = [];
  for (const b of searched.filter(Boolean)) {
    const fresh = b.results.filter((r) => r.url && !seen.has(r.url));
    fresh.forEach((r) => seen.add(r.url));
    branches.push({ ...b, results: fresh });
  }

  const extracted = await mapLimit(branches, 2, async (b) => ({
    ...b,
    docs: await extractAll(b.results, GROQ_CHARS_PER_SOURCE),
  }));

  const live = extracted.filter((b) => b && b.docs.length > 0);
  if (live.length === 0) {
    return (
      `# Deep research: ${topic}\n\nNo sources could be retrieved. Sub-queries attempted:\n` +
      queries.map((q) => `- ${q}`).join("\n")
    );
  }

  // Number every source globally so citations are stable across the whole report.
  let n = 0;
  const sources = [];
  for (const b of live) {
    for (const d of b.docs) {
      d.n = ++n;
      sources.push(d);
    }
  }

  // Summarize the branches concurrently — one request per branch, run in parallel.
  const branchSummaries = await summarizeMany(
    live.map((b) => [
      {
        role: "system",
        content:
          "Summarize these sources into 3-5 factual sentences answering the sub-question. " +
          "Cite as [n] using the given source numbers. Omit anything the sources do not support.",
      },
      {
        role: "user",
        content:
          `Sub-question: ${b.query}\n\nSources:\n\n` +
          b.docs
            .map((d) => `[${d.n}] ${d.title}\nURL: ${d.url}\n${d.text.slice(0, GROQ_CHARS_PER_SOURCE)}`)
            .join("\n\n---\n\n"),
      },
    ]),
    { maxTokens: 500 },
  );

  const out = [`# Deep research: ${topic}`, ""];
  const usable = live
    .map((b, i) => ({ ...b, summary: branchSummaries[i] }))
    .filter((b) => b.summary);

  if (usable.length > 0) {
    const synthesis = await summarize(
      [
        {
          role: "system",
          content:
            "You are writing the overview section of a research report. Synthesize the " +
            "sub-findings into a coherent answer to the main question. Keep citations [n]. " +
            "Note disagreements between sources. Be concise and factual.",
        },
        {
          role: "user",
          content:
            `Main question: ${topic}\n\nSub-findings:\n\n` +
            usable.map((b) => `### ${b.query}\n${b.summary}`).join("\n\n"),
        },
      ],
      { maxTokens: 900 },
    );
    if (synthesis) out.push("## Overview", "", synthesis, "");

    out.push("## Findings by sub-question", "");
    for (const b of usable) out.push(`### ${b.query}`, "", b.summary, "");
  } else {
    out.push("_(synthesis unavailable; extracted source material follows)_", "", "## Extracted content", "");
    for (const b of live) {
      out.push(`### ${b.query}`, "");
      for (const d of b.docs) {
        out.push(`#### [${d.n}] ${d.title}`, d.url, "", d.text.slice(0, 2500), "");
      }
    }
  }

  out.push("## Sources", "");
  for (const s of sources) out.push(`[${s.n}] ${s.title} — ${s.url}`);

  return out.join("\n");
}

// ---------------------------------------------------------------- JSON-RPC

const SERVER_INFO = { name: "local-search", version: "1.1.0" };

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;

    case "notifications/initialized":
    case "initialized":
      return;

    case "ping":
      ok(id, {});
      return;

    case "tools/list":
      ok(id, { tools: TOOLS });
      return;

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        let text;
        if (name === "web_search") text = await doWebSearch(args);
        else if (name === "web_fetch") text = await doWebFetch(args);
        else if (name === "deep_research") text = await doDeepResearch(args);
        else {
          err(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        ok(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // Report as a tool-level error so the model can recover, not a protocol error.
        ok(id, {
          content: [{ type: "text", text: `Tool ${name} failed: ${e.message}` }],
          isError: true,
        });
      }
      return;
    }

    default:
      if (id !== undefined) err(id, -32601, `Method not found: ${method}`);
  }
}

sources.setLogger(log);

log(
  `starting: searxng=${SEARXNG_URL} extractd=${EXTRACTD_URL} crawl4ai=${CRAWL4AI_URL} mode=${DEFAULT_MODE}`,
);
{
  const st = POOL.stats();
  log(
    `inference: mode=${st.mode} lanes=[${st.lanes.map((l) => `${l.name}:${l.concurrency}`).join(" ")}] ` +
      `total_concurrency=${st.totalConcurrency}`,
  );
}

// Track in-flight work so closing stdin doesn't kill requests that are still running.
let pending = 0;
let stdinClosed = false;
const maybeExit = () => {
  if (stdinClosed && pending === 0) process.exit(0);
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  pending++;
  handle(msg)
    .catch((e) => {
      log(`handler error: ${e.stack || e.message}`);
      if (msg.id !== undefined) err(msg.id, -32603, String(e.message));
    })
    .finally(() => {
      pending--;
      maybeExit();
    });
});
rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});
