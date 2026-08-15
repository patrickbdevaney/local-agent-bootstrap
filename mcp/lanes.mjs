// Multi-provider inference lanes.
//
// Ported from the design in hermes-max/mcp-research/pool.py. The correction that
// matters: free-tier limits are per-ACCOUNT, not per-credential. Stacking
// credentials on one account does not multiply throughput. Real concurrency is the
// SUM of per-PROVIDER lanes — each lane is one rate-limited account; credentials
// within a lane only spread that account's allowance and survive a single bad one.
//
// Degradation ladder, all three preserved:
//   no providers   -> local lane only (the llama-server this stack already runs)
//   one provider   -> a single rate-limited lane
//   many providers -> wide parallel, total in-flight = sum of lane concurrencies
//
// Env only; nothing is committed.
//   GROQ_API_KEY_1..N      (or GROQ_API_KEYS=a,b,c)
//   CEREBRAS_API_KEY_1..N  (or CEREBRAS_API_KEYS=a,b,c)
//   LOCAL_BASE_URL         defaults to the local llama-server
//   POOL_{GROQ,CEREBRAS,LOCAL}_CONCURRENCY, {GROQ,CEREBRAS,LOCAL}_MODEL

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collect `PREFIX_1..N` in numeric order, plus a comma-separated `PREFIX_S` form. */
function collectKeys(env, prefix, csvName) {
  const numbered = Object.keys(env)
    .filter((k) => new RegExp(`^${prefix}_\\d+$`).test(k))
    .sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()))
    .map((k) => env[k]);
  const csv = (env[csvName] || "").split(",");
  return [...numbered, ...csv].map((v) => (v || "").trim()).filter(Boolean);
}

class Lane {
  constructor({ name, baseURL, model, keys, concurrency }) {
    this.name = name;
    this.baseURL = baseURL.replace(/\/$/, "");
    this.model = model;
    // A lane with no credentials still works (a local endpoint needs none).
    this.keys = keys.length > 0 ? keys : [null];
    this.concurrency = Math.max(1, concurrency);
    this.rr = 0;
    this.cooldown = new Map(); // key -> epoch ms to skip until
  }

  keyCount() {
    return this.keys[0] === null ? 0 : this.keys.length;
  }
}

export function buildLanes(env = process.env, opts = {}) {
  const num = (k, d) => Number(env[k] || d);
  const out = [];

  const groq = collectKeys(env, "GROQ_API_KEY", "GROQ_API_KEYS");
  if (groq.length > 0) {
    out.push(
      new Lane({
        name: "groq",
        baseURL: env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
        model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
        keys: groq,
        concurrency: num("POOL_GROQ_CONCURRENCY", 4),
      }),
    );
  }

  const cerebras = collectKeys(env, "CEREBRAS_API_KEY", "CEREBRAS_API_KEYS");
  if (cerebras.length > 0) {
    out.push(
      new Lane({
        name: "cerebras",
        baseURL: env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
        model: env.CEREBRAS_MODEL || "llama-3.3-70b",
        keys: cerebras,
        concurrency: num("POOL_CEREBRAS_CONCURRENCY", 2),
      }),
    );
  }

  // The local lane is the llama-server this stack already runs. It is LAST by
  // design and defaults to concurrency 1: that server is started with one slot,
  // so anything sent here queues behind the agent's own generation. It exists so
  // the pipeline still works with no cloud provider at all, not to add throughput.
  const localBase = (env.LOCAL_BASE_URL || opts.localBaseURL || "").replace(/\/$/, "");
  if (localBase && env.POOL_DISABLE_LOCAL !== "1") {
    out.push(
      new Lane({
        name: "local",
        baseURL: localBase,
        model: env.LOCAL_MODEL || opts.localModel || "qwen3.5-4b",
        keys: [],
        concurrency: num("POOL_LOCAL_CONCURRENCY", 1),
      }),
    );
  }

  return out;
}

export class Pool {
  constructor({ lanes, timeoutMs = 60000, log = () => {} }) {
    this.lanes = lanes;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  available() {
    return this.lanes.length > 0;
  }

  cloudLanes() {
    return this.lanes.filter((l) => l.name !== "local");
  }

  cloudAvailable() {
    return this.cloudLanes().length > 0;
  }

  select(cloudOnly) {
    return cloudOnly ? this.cloudLanes() : this.lanes;
  }

  stats() {
    return {
      lanes: this.lanes.map((l) => ({
        name: l.name,
        model: l.model,
        credentials: l.keyCount(),
        concurrency: l.concurrency,
      })),
      totalConcurrency: this.lanes.reduce((a, l) => a + l.concurrency, 0),
      mode:
        this.lanes.length === 0
          ? "none"
          : this.lanes.length === 1
            ? "single-lane"
            : "multi-provider",
    };
  }

  /**
   * One completion on one lane: round-robin its credentials, skip any that are
   * cooling off, back off on throttling. Returns null when the lane cannot serve
   * the request, so the caller can try the next lane.
   */
  async #one(lane, messages, { temperature, maxTokens }) {
    for (let attempt = 0; attempt < lane.keys.length; attempt++) {
      const key = lane.keys[lane.rr % lane.keys.length];
      lane.rr++;
      if ((lane.cooldown.get(key) || 0) > Date.now()) continue;

      const headers = { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${key}`;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${lane.baseURL}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: lane.model,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
          signal: ac.signal,
        });

        if (res.status === 429 || res.status === 503) {
          const ra = Number(res.headers.get("retry-after"));
          const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000 + 500, 300000) : 60000;
          lane.cooldown.set(key, Date.now() + ms);
          this.log(`pool[${lane.name}]: throttled, cooling ${Math.round(ms / 1000)}s`);
          continue;
        }
        if (!res.ok) {
          this.log(`pool[${lane.name}]: HTTP ${res.status}`);
          continue;
        }

        // Proactively rest a nearly-exhausted credential before it starts 429ing.
        const rem = Number(res.headers.get("x-ratelimit-remaining-requests"));
        if (Number.isFinite(rem) && rem <= 1) lane.cooldown.set(key, Date.now() + 5000);

        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text && text.trim()) return text.trim();
        this.log(`pool[${lane.name}]: empty completion`);
      } catch (e) {
        this.log(`pool[${lane.name}]: ${e.name === "AbortError" ? "timeout" : e.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  /** A single completion, routed across lanes in priority order. */
  async completeOne(messages, { temperature = 0.2, maxTokens = 1200, cloudOnly = false } = {}) {
    for (const lane of this.select(cloudOnly)) {
      const out = await this.#one(lane, messages, { temperature, maxTokens });
      if (out) return out;
    }
    return null;
  }

  /**
   * Ordered, bounded, concurrent fan-out. Total in-flight is the SUM of lane
   * concurrencies — one worker per unit of each lane's allowance, all pulling from
   * a shared index. Slots that fail return null; the array stays aligned with the
   * input so callers can map results back to their prompts.
   */
  async map(messageSets, { temperature = 0.2, maxTokens = 1200, cloudOnly = false } = {}) {
    const results = new Array(messageSets.length).fill(null);
    const lanes = this.select(cloudOnly);
    if (lanes.length === 0 || messageSets.length === 0) return results;

    let next = 0;
    const workers = [];
    for (const lane of lanes) {
      for (let i = 0; i < lane.concurrency; i++) {
        workers.push(
          (async () => {
            for (;;) {
              const idx = next++;
              if (idx >= messageSets.length) return;
              results[idx] = await this.#one(lane, messageSets[idx], { temperature, maxTokens });
              // A lane that just failed everything shouldn't spin the queue empty.
              if (results[idx] === null) await sleep(50);
            }
          })(),
        );
      }
    }
    await Promise.all(workers);
    return results;
  }
}
