// Structured source adapters + Reciprocal Rank Fusion.
//
// Ported from the design in hermes-max/mcp-research/sources.py. These sit ALONGSIDE
// the SearXNG web layer, not in front of it. The point is that SearXNG is a single
// point of failure: its upstream engines throttle and CAPTCHA constantly, and when
// they all trip at once it returns HTTP 200 with an empty array and research stops
// dead. Keyless structured APIs do not behave that way.
//
// Design rules, kept from the original:
//   * NEVER throw — every adapter resolves {ok, source, results[], error?} so a dead
//     or blocked source degrades to an empty list rather than failing the caller.
//   * Presence-gated — an adapter needing a token no-ops when the token is absent.
//     Keyless sources (arXiv, Semantic Scholar, HN Algolia, Stack Exchange) always run.
//   * Nothing is load-bearing — the router ALWAYS includes searxng, so the web layer
//     answers even with every structured adapter down.
//
// Normalized item shape:
//   {title, url, content, sourceType, authors[], date, citationCount, extra{}}

const ARXIV_API = "https://export.arxiv.org/api/query";
const S2_API = "https://api.semanticscholar.org/graph/v1";
const GITHUB_API = "https://api.github.com";
const HN_API = "https://hn.algolia.com/api/v1/search";
const SE_API = "https://api.stackexchange.com/2.3";

const env = (k, d = "") => (process.env[k] || d).trim();
const HTTP_TIMEOUT_MS = Number(env("RESEARCH_SOURCE_TIMEOUT_MS", "12000"));
const RRF_K = Number(env("RESEARCH_RRF_K", "60"));

let log = () => {};
export const setLogger = (fn) => {
  log = fn;
};

// ---------------------------------------------------------------- transport

async function req(url, { params, headers, accept = "json" } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(u, {
      headers: { "User-Agent": "local-agent-bootstrap/1.0", ...(headers || {}) },
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: accept === "text" ? await res.text() : await res.json() };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

const item = (title, url, content = "", sourceType = "web", extras = {}) => ({
  title: (title || "").trim(),
  url: (url || "").trim(),
  content: (content || "").trim(),
  sourceType,
  authors: extras.authors || [],
  date: extras.date || "",
  citationCount: extras.citationCount ?? null,
  extra: extras.extra || {},
});

const stripTags = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s) =>
  (s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const empty = (source) => ({ ok: true, source, results: [] });

// ---------------------------------------------------------------- adapters

/**
 * arXiv Atom API. Keyless, ~1 req/3s upstream. `categories` targets cs.LG / cs.AI
 * / cs.CR etc. No recency filter by default so seminal work stays reachable.
 */
export async function arxivSearch(query, { categories = [], limit = 8 } = {}) {
  query = (query || "").trim();
  if (!query) return empty("arxiv");
  limit = Math.max(1, Math.min(limit, 50));

  const cats = (categories || []).filter(Boolean).map((c) => `cat:${c.trim()}`);
  const terms = cats.length ? [`(${cats.join(" OR ")})`, `all:${query}`] : [`all:${query}`];

  const r = await req(ARXIV_API, {
    accept: "text",
    params: {
      search_query: terms.join(" AND "),
      start: 0,
      max_results: limit,
      sortBy: "relevance",
      sortOrder: "descending",
    },
  });
  if (!r.ok) return { ok: false, source: "arxiv", error: r.error, results: [] };

  // Atom parsed with regex rather than pulling in an XML dependency; the feed
  // shape is stable and this stays zero-dependency.
  const results = [];
  for (const m of r.body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const pick = (tag) => {
      const mm = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return mm ? decode(mm[1].replace(/\s+/g, " ").trim()) : "";
    };
    const link = e.match(/<id>([\s\S]*?)<\/id>/);
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) =>
      decode(a[1].trim()),
    );
    const title = pick("title");
    if (!title) continue;
    results.push(
      item(title, link ? link[1].trim() : "", pick("summary").slice(0, 1500), "arxiv", {
        authors,
        date: pick("published").slice(0, 10),
      }),
    );
    if (results.length >= limit) break;
  }
  return { ok: true, source: "arxiv", results };
}

/** Semantic Scholar. Keyless pool works; SEMANTIC_SCHOLAR_API_KEY lifts the limit. */
export async function semanticScholarSearch(query, { limit = 8 } = {}) {
  query = (query || "").trim();
  if (!query) return empty("semantic_scholar");
  const key = env("SEMANTIC_SCHOLAR_API_KEY");
  const r = await req(`${S2_API}/paper/search`, {
    params: {
      query,
      limit: Math.max(1, Math.min(limit, 50)),
      fields: "title,abstract,year,authors,citationCount,url,externalIds",
    },
    headers: key ? { "x-api-key": key } : {},
  });
  if (!r.ok) return { ok: false, source: "semantic_scholar", error: r.error, results: [] };

  const results = (r.body?.data || []).map((p) =>
    item(
      p.title,
      p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : ""),
      (p.abstract || "").slice(0, 1500),
      "semantic_scholar",
      {
        authors: (p.authors || []).map((a) => a.name).filter(Boolean),
        date: p.year ? String(p.year) : "",
        citationCount: p.citationCount ?? null,
      },
    ),
  );
  return { ok: true, source: "semantic_scholar", results: results.filter((x) => x.url) };
}

/** HN via Algolia. Keyless. Good signal for what practitioners actually use. */
export async function hnSearch(query, { limit = 8, tags = "story" } = {}) {
  query = (query || "").trim();
  if (!query) return empty("hn");
  const r = await req(HN_API, {
    params: { query, tags, hitsPerPage: Math.max(1, Math.min(limit, 50)) },
  });
  if (!r.ok) return { ok: false, source: "hn", error: r.error, results: [] };

  const results = (r.body?.hits || []).slice(0, limit).map((h) => {
    const oid = h.objectID || "";
    const hnUrl = oid ? `https://news.ycombinator.com/item?id=${oid}` : "";
    return item(
      h.title || h.story_title || "",
      h.url || hnUrl,
      (h.story_text || h.comment_text || "").slice(0, 1000),
      "hn",
      {
        authors: [h.author].filter(Boolean),
        date: (h.created_at || "").slice(0, 10),
        extra: { points: h.points, comments: h.num_comments, hnUrl },
      },
    );
  });
  return { ok: true, source: "hn", results: results.filter((x) => x.url && x.title) };
}

/** Stack Exchange. Keyless 300/day; STACKEXCHANGE_KEY lifts it to 10k/day. */
export async function stackExchangeSearch(query, { limit = 8, site = "stackoverflow" } = {}) {
  query = (query || "").trim();
  if (!query) return empty("stackexchange");
  const key = env("STACKEXCHANGE_KEY");
  const r = await req(`${SE_API}/search/advanced`, {
    params: {
      order: "desc",
      sort: "relevance",
      q: query,
      site,
      pagesize: Math.max(1, Math.min(limit, 50)),
      filter: "withbody",
      ...(key ? { key } : {}),
    },
  });
  if (!r.ok) return { ok: false, source: "stackexchange", error: r.error, results: [] };

  const results = (r.body?.items || []).slice(0, limit).map((q) =>
    item(decode(q.title || ""), q.link || "", stripTags(q.body).slice(0, 1500), "stackexchange", {
      authors: [q.owner?.display_name].filter(Boolean),
      extra: { score: q.score, tags: q.tags, answered: q.is_answered },
    }),
  );
  return { ok: true, source: "stackexchange", results: results.filter((x) => x.url) };
}

/** GitHub code/repo search. Token-gated: no-ops without GITHUB_TOKEN. */
export async function githubSearch(query, { limit = 8, searchType = "repositories" } = {}) {
  query = (query || "").trim();
  if (!query) return empty("github");
  const token = env("GITHUB_TOKEN") || env("GITHUB_ACCESS_TOKEN");
  if (!token) return { ok: true, source: "github", skipped: true, results: [] };

  const r = await req(`${GITHUB_API}/search/${searchType}`, {
    params: { q: query, per_page: Math.max(1, Math.min(limit, 50)), sort: "stars" },
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) return { ok: false, source: "github", error: r.error, results: [] };

  const results = (r.body?.items || []).slice(0, limit).map((it) =>
    item(it.full_name || it.name || "", it.html_url || "", (it.description || "").slice(0, 800), "github", {
      date: (it.pushed_at || it.updated_at || "").slice(0, 10),
      extra: { stars: it.stargazers_count, language: it.language },
    }),
  );
  return { ok: true, source: "github", results: results.filter((x) => x.url) };
}

// ---------------------------------------------------------------- fusion

/**
 * Reciprocal Rank Fusion: score(d) = Σ 1/(k + rank). Rewards documents that rank
 * consistently across independent sources. Pure arithmetic, no model needed — the
 * best robustness-per-effort step in the whole pipeline.
 */
export function rrfFuse(rankedLists, { k = RRF_K, key = "url" } = {}) {
  const scores = new Map();
  const merged = new Map();
  const contributing = new Map();

  for (const list of rankedLists || []) {
    (list || []).forEach((it, rank) => {
      const kv = (it?.[key] || "").trim().toLowerCase();
      if (!kv) return;
      scores.set(kv, (scores.get(kv) || 0) + 1 / (k + rank + 1));
      if (!contributing.has(kv)) contributing.set(kv, new Set());
      contributing.get(kv).add(it.sourceType || "web");
      const prev = merged.get(kv);
      // Keep the richer copy when the same URL arrives from several sources.
      if (!prev || (!prev.content && it.content)) merged.set(kv, { ...it });
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kv, score]) => ({
      ...merged.get(kv),
      rrfScore: Number(score.toFixed(6)),
      rrfSources: [...contributing.get(kv)].sort(),
    }));
}

// ---------------------------------------------------------------- router

const ML_KW = [
  "neural", "transformer", "llm", "language model", "deep learning", "diffusion",
  "embedding", "fine-tun", "reinforcement learning", "rlhf", "gradient", "dataset",
  "benchmark", "attention", "quantization", "inference", "pretrain", "model weights",
  "convolution", "tokeniz", "gguf", "kv cache",
];
const LIB_KW = [
  "how to", "install", "error", "exception", "traceback", "library", "package",
  "api usage", "tutorial", "example", "import", "deprecated", "version", "config",
  "command", "cli", "function", "method", "syntax", "stack trace", "flag",
];
const SYS_KW = [
  "kernel", "cuda", "gpu", "compiler", "rust", "concurrency", "throughput",
  "latency", "memory", "allocator", "protocol", "distributed",
];

const count = (q, kws) => kws.reduce((n, kw) => n + (q.includes(kw) ? 1 : 0), 0);

/**
 * Map a query to a source set and per-source budget. Always includes searxng as
 * the catch-all, so the web layer answers even when every structured source is
 * down — and, equally, structured sources answer when SearXNG is throttled.
 */
export function classifyQuery(query) {
  const q = (query || "").toLowerCase();
  const ml = count(q, ML_KW);
  const lib = count(q, LIB_KW);
  const sys = count(q, SYS_KW);

  let category;
  let budgets;
  let arxivCategories = [];

  if (ml && ml >= lib) {
    category = "applied_ml";
    budgets = { arxiv: 6, semantic_scholar: 8, hn: 4, github: 5, searxng: 6 };
    arxivCategories = ["cs.LG", "cs.AI"];
  } else if (lib && lib >= sys) {
    category = "library";
    budgets = { stackexchange: 6, github: 6, hn: 4, searxng: 8 };
  } else if (sys) {
    category = "systems";
    budgets = { arxiv: 4, github: 6, hn: 5, stackexchange: 4, searxng: 8 };
    arxivCategories = ["cs.DC", "cs.PF"];
  } else {
    category = "general";
    budgets = { semantic_scholar: 4, hn: 4, github: 4, searxng: 8 };
  }

  if (!budgets.searxng) budgets.searxng = 6; // invariant: web is always present
  return { query, category, sources: Object.keys(budgets), budgets, arxivCategories };
}

const REGISTRY = {
  arxiv: (q, n, plan) => arxivSearch(q, { limit: n, categories: plan.arxivCategories }),
  semantic_scholar: (q, n) => semanticScholarSearch(q, { limit: n }),
  hn: (q, n) => hnSearch(q, { limit: n }),
  stackexchange: (q, n) => stackExchangeSearch(q, { limit: n }),
  github: (q, n) => githubSearch(q, { limit: n }),
};

/**
 * Classify, call every routed STRUCTURED adapter concurrently with its budget, and
 * RRF-fuse the results. `searxng` is intentionally not handled here — the caller
 * owns the web layer and passes its ranked list in via `extraLists`.
 *
 * Never throws. A fully-down structured layer returns an empty fused list.
 */
export async function sourceFanout(query, { extraLists = [], fuse = true } = {}) {
  const plan = classifyQuery(query);
  const names = plan.sources.filter((s) => REGISTRY[s]);

  const settled = await Promise.all(
    names.map(async (name) => {
      try {
        const r = await REGISTRY[name](query, plan.budgets[name], plan);
        if (!r.ok) log(`sources: ${name} failed: ${r.error}`);
        else if (r.skipped) log(`sources: ${name} skipped (no credential)`);
        return r;
      } catch (e) {
        log(`sources: ${name} threw: ${e.message}`);
        return { ok: false, source: name, error: e.message, results: [] };
      }
    }),
  );

  const per = {};
  const lists = [];
  for (const r of settled) {
    per[r.source] = r.results.length;
    if (r.results.length) lists.push(r.results);
  }
  for (const l of extraLists) if (l && l.length) lists.push(l);

  return {
    ok: true,
    plan,
    perSource: per,
    results: fuse ? rrfFuse(lists) : lists.flat(),
  };
}
