#!/usr/bin/env node
// Local search/fetch MCP server for the local-agent-bootstrap dry run.
//
// Tools:
//   web_search  - SearXNG JSON search, optionally deep (fetch+extract top N) and
//                 optionally summarized. Never fails hard: degrades to titles+snippets.
//   web_fetch   - crawl4ai /md readability extraction for a single URL.
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

const SEARXNG_URL = (env("SEARXNG_URL", "http://127.0.0.1:8080")).replace(/\/$/, "");
const CRAWL4AI_URL = (env("CRAWL4AI_URL", "http://127.0.0.1:11235")).replace(/\/$/, "");
const GROQ_MODEL = env("GROQ_MODEL", "llama-3.3-70b-versatile");
const GROQ_BASE = (env("GROQ_BASE_URL", "https://api.groq.com/openai/v1")).replace(/\/$/, "");
// "normal" = fetch + extract top results (+ optional summary); "shallow" = snippets only.
const DEFAULT_MODE = env("AGENT_SEARCH_MODE", "normal");
const FETCH_TIMEOUT_MS = Number(env("AGENT_FETCH_TIMEOUT_MS", "45000"));
const GROQ_TIMEOUT_MS = Number(env("AGENT_GROQ_TIMEOUT_MS", "30000"));
// Per-source character budget for the summarization prompt. 4 sources x 2200 chars is
// roughly 2.5k tokens, comfortably inside the measured 12k tokens/minute account limit.
const GROQ_CHARS_PER_SOURCE = Number(env("AGENT_GROQ_CHARS_PER_SOURCE", "2200"));

// Collect summarizer credentials in numeric order. Values are never logged.
const GROQ_KEYS = (() => {
  const merged = { ...fileEnv, ...process.env };
  return Object.keys(merged)
    .filter((k) => /^GROQ_API_KEY_\d+$/.test(k))
    .sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()))
    .map((k) => ({ name: k, key: merged[k] }))
    .filter((e) => e.key && e.key.trim().length > 0);
})();

let groqCursor = 0; // rotates the starting point between calls

// ---------------------------------------------------------------- helpers

async function withTimeout(ms, fn) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searxSearchOnce(query, count) {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await withTimeout(FETCH_TIMEOUT_MS, (signal) => fetch(url, { signal }));
  if (!res.ok) throw new Error(`searxng ${res.status}`);
  const data = await res.json();
  const unresponsive = data.unresponsive_engines || [];
  const results = (data.results || []).slice(0, count).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: (r.content || "").trim(),
    engine: r.engine || "",
  }));
  return { results, unresponsive };
}

/**
 * SearXNG returns HTTP 200 with an empty result set when every upstream engine is
 * rate-limited or CAPTCHA-suspended, which happens easily under bursty querying.
 * Retry once after a short backoff before reporting an empty result.
 */
async function searxSearch(query, count) {
  let last = await searxSearchOnce(query, count);
  if (last.results.length === 0) {
    log(`searxng: empty result set, retrying once (unresponsive: ${JSON.stringify(last.unresponsive)})`);
    await sleep(1500);
    last = await searxSearchOnce(query, count);
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

/**
 * Returns the completion text, or null if the summarizer is unavailable for any
 * reason. Never throws — the caller degrades silently to local-only output.
 */
async function groqComplete(messages, { maxTokens = 900 } = {}) {
  if (GROQ_KEYS.length === 0) {
    log("groq: no keys configured, skipping");
    return null;
  }
  const n = GROQ_KEYS.length;
  const start = groqCursor;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const entry = GROQ_KEYS[idx];
    try {
      const res = await withTimeout(GROQ_TIMEOUT_MS, (signal) =>
        fetch(`${GROQ_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${entry.key}`,
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
      if (!res.ok) {
        log(`groq: ${entry.name} -> HTTP ${res.status}, trying next key`);
        continue;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) {
        log(`groq: ${entry.name} -> empty completion, trying next key`);
        continue;
      }
      groqCursor = (idx + 1) % n; // next call starts at the following key
      log(`groq: ${entry.name} -> ok`);
      return text.trim();
    } catch (e) {
      log(`groq: ${entry.name} -> ${e.name === "AbortError" ? "timeout" : e.message}, trying next key`);
    }
  }
  log(`groq: all ${n} keys exhausted, falling back to local-only`);
  return null;
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web via a local SearXNG instance. In normal mode the top results are " +
      "fetched and extracted to readable text, and summarized if a remote summarizer is " +
      "available. In shallow mode only titles and snippets are returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: {
          type: "integer",
          description: "Number of results to consider (default 5, max 10)",
        },
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

  // Normal mode: fetch + extract the top few in parallel. Failures are dropped, not fatal.
  const toFetch = results.slice(0, Math.min(results.length, 4));
  const extracted = await Promise.all(
    toFetch.map(async (r) => {
      try {
        const text = await crawlExtract(r.url);
        return { ...r, text: text.slice(0, 6000) };
      } catch (e) {
        log(`extract failed for ${r.url}: ${e.message}`);
        return null;
      }
    }),
  );
  const good = extracted.filter(Boolean);

  if (good.length === 0) {
    lines.push("_(page extraction unavailable; snippets only)_");
    return lines.join("\n");
  }

  if (wantSummary) {
    // The provider's budget is token-per-minute and account-scoped, so an oversized
    // payload exhausts it regardless of routing. Keep this well inside the limit.
    const context = good
      .map((g, i) => `[${i + 1}] ${g.title}\nURL: ${g.url}\n${g.text.slice(0, GROQ_CHARS_PER_SOURCE)}`)
      .join("\n\n---\n\n");
    const summary = await groqComplete([
      {
        role: "system",
        content:
          "You summarize web search results for a coding agent. Be concise and factual. " +
          "Cite sources as [1], [2] matching the numbered inputs. If sources conflict, say so.",
      },
      { role: "user", content: `Question: ${query}\n\nSources:\n\n${context}` },
    ]);
    if (summary) {
      lines.push("## Summary", "", summary, "");
    }
    // summary === null -> Groq unavailable; we simply continue with extracted text below.
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
  const clipped = text.slice(0, maxChars);
  return `# ${url}\n\n${clipped}${text.length > maxChars ? "\n\n_(truncated)_" : ""}`;
}

// ---------------------------------------------------------------- JSON-RPC

const SERVER_INFO = { name: "local-search", version: "1.0.0" };

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function err(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

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
      return; // notification, no response

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
    `groq_keys=${GROQ_KEYS.length} groq_model=${GROQ_MODEL} mode=${DEFAULT_MODE}`,
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
