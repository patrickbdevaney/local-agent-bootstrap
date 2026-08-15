#!/usr/bin/env node
// Local search/fetch/research MCP server for local-agent-bootstrap.
//
// Tools:
//   web_search     - SearXNG JSON search, optionally deep (fetch+extract top N)
//                    and optionally summarized. Degrades to titles+snippets.
//   web_fetch      - crawl4ai /md readability extraction for a single URL.
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
const CRAWL4AI_URL = env("CRAWL4AI_URL", "http://127.0.0.1:11235").replace(/\/$/, "");
const GROQ_MODEL = env("GROQ_MODEL", "llama-3.3-70b-versatile");
const GROQ_BASE = env("GROQ_BASE_URL", "https://api.groq.com/openai/v1").replace(/\/$/, "");
// "normal" = fetch + extract top results (+ optional summary); "shallow" = snippets only.
const DEFAULT_MODE = env("AGENT_SEARCH_MODE", "normal");
const FETCH_TIMEOUT_MS = Number(env("AGENT_FETCH_TIMEOUT_MS", "45000"));
const GROQ_TIMEOUT_MS = Number(env("AGENT_GROQ_TIMEOUT_MS", "30000"));
// Per-source character budget for a summarization prompt. Keeps each individual
// request well inside the provider's per-minute token allowance.
const GROQ_CHARS_PER_SOURCE = Number(env("AGENT_GROQ_CHARS_PER_SOURCE", "2200"));
// Cool-off applied to an endpoint slot that reports throttling, when the response
// carries no Retry-After header.
const GROQ_COOLDOWN_MS = Number(env("AGENT_GROQ_COOLDOWN_MS", "62000"));
// How long a summarization request waits for a free slot before giving up.
const GROQ_ACQUIRE_TIMEOUT_MS = Number(env("AGENT_GROQ_ACQUIRE_TIMEOUT_MS", "20000"));
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
 * Endpoint slots for the optional summarizer, in declared order. A slot is leased
 * for the duration of one request, so independent requests proceed in parallel
 * rather than serialising behind one another. A slot that reports throttling is
 * put on a short cool-off and skipped until it expires, which stops a saturated
 * slot from consuming attempts. Capacity scales with however many are configured.
 */
const SLOTS = (() => {
  const merged = { ...fileEnv, ...process.env };
  return Object.keys(merged)
    .filter((k) => /^GROQ_API_KEY_\d+$/.test(k))
    .sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()))
    .map((k) => merged[k])
    .filter((v) => v && v.trim().length > 0)
    .map((secret, i) => ({ id: i + 1, secret, busy: false, cooldownUntil: 0 }));
})();

const SUMMARIZER_ENABLED = SLOTS.length > 0;
/** Upper bound on useful parallelism for summarization work. */
const SUMMARIZE_CONCURRENCY = Math.max(1, SLOTS.length);

let cursor = 0;

function acquireSlot() {
  const now = Date.now();
  for (let i = 0; i < SLOTS.length; i++) {
    const idx = (cursor + i) % SLOTS.length;
    const s = SLOTS[idx];
    if (!s.busy && s.cooldownUntil <= now) {
      s.busy = true;
      cursor = (idx + 1) % SLOTS.length;
      return s;
    }
  }
  return null;
}

const releaseSlot = (s) => {
  s.busy = false;
};

function coolOff(slot, res) {
  let ms = GROQ_COOLDOWN_MS;
  const ra = res?.headers?.get?.("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs > 0) ms = Math.min(secs * 1000 + 500, 300000);
  }
  slot.cooldownUntil = Date.now() + ms;
  return ms;
}

/**
 * Run one summarization request. Returns the completion text, or null if the
 * summarizer is unavailable for any reason. Never throws — callers degrade to
 * local-only output.
 */
async function summarize(messages, { maxTokens = 900 } = {}) {
  if (!SUMMARIZER_ENABLED) return null;

  const deadline = Date.now() + GROQ_ACQUIRE_TIMEOUT_MS;
  let attemptsLeft = SLOTS.length;

  while (attemptsLeft > 0) {
    const slot = acquireSlot();
    if (!slot) {
      // Everything is either in flight or cooling off; wait briefly and re-check.
      if (Date.now() >= deadline) break;
      await sleep(200);
      continue;
    }
    attemptsLeft--;
    try {
      const res = await withTimeout(GROQ_TIMEOUT_MS, (signal) =>
        fetch(`${GROQ_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${slot.secret}`,
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            max_tokens: maxTokens,
            temperature: 0.2,
          }),
          signal,
        }),
      );
      if (res.status === 429 || res.status === 503) {
        const ms = coolOff(slot, res);
        log(`summarizer[${slot.id}]: throttled (${res.status}), cooling ${Math.round(ms / 1000)}s`);
        continue;
      }
      if (!res.ok) {
        log(`summarizer[${slot.id}]: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) {
        log(`summarizer[${slot.id}]: empty completion`);
        continue;
      }
      return text.trim();
    } catch (e) {
      log(`summarizer[${slot.id}]: ${e.name === "AbortError" ? "timeout" : e.message}`);
    } finally {
      releaseSlot(slot);
    }
  }

  log("summarizer: unavailable, continuing local-only");
  return null;
}

/** Run several summarization requests concurrently. Missing results come back null. */
const summarizeMany = (jobs, opts = {}) =>
  mapLimit(jobs, SUMMARIZE_CONCURRENCY, (j) => summarize(j, opts));

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

/** Fetch and extract a list of results, dropping the ones that fail. */
async function extractAll(results, perDocChars = 6000) {
  const got = await mapLimit(results, EXTRACT_CONCURRENCY, async (r) => {
    try {
      return { ...r, text: (await crawlExtract(r.url)).slice(0, perDocChars) };
    } catch (e) {
      log(`extract failed for ${r.url}: ${e.message}`);
      return null;
    }
  });
  return got.filter(Boolean);
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

  let results;
  try {
    results = await searxSearch(query, count);
  } catch (e) {
    return `Search backend unavailable (${e.message}). No results.`;
  }
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
  const text = await crawlExtract(url);
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
    try {
      return { query: q, results: await searxSearch(q, depth) };
    } catch (e) {
      log(`deep_research: search failed for "${q}": ${e.message}`);
      return { query: q, results: [] };
    }
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

log(
  `starting: searxng=${SEARXNG_URL} crawl4ai=${CRAWL4AI_URL} ` +
    `summarizer=${SUMMARIZER_ENABLED ? "enabled" : "disabled"} model=${GROQ_MODEL} mode=${DEFAULT_MODE}`,
);

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
