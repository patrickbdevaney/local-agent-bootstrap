# 07 — OpenCode Configuration

---

## Install

```bash
npm install -g opencode-ai@latest
```

Validated version: **1.18.18**, on Node v22.18.0. Installs in ~1 minute (13 packages).

---

## Detect the schema, don't assume it

OpenCode's config format has changed across versions. Fetch the live schema rather than copying a blog post:

```bash
curl -s https://opencode.ai/config.json -o /tmp/oc-schema.json
python3 -c "
import json; d=json.load(open('/tmp/oc-schema.json'))
print('TOP:', list(d.keys()))
print('DEFS:', list(d['\$defs'].keys()))"
```

```
TOP:  ['$schema', '$ref', '$defs', 'allowComments', 'allowTrailingCommas']
DEFS: ['LogLevel', 'ServerConfig', 'ConfigV2.Reference.Git', 'ConfigV2.Reference.Local',
       'PermissionActionConfig', ..., 'AgentConfig', 'ProviderConfig',
       'McpLocalConfig', 'McpOAuthConfig', 'McpRemoteConfig', ..., 'Config']
```

The definitions are literally named **`ConfigV2.*`** — this is the V2 era. The root is a `$ref` into `$defs.Config`, which is why a naive `properties` read returns an empty list.

`ProviderConfig` shape:

```
{ api, name, env, id, npm, whitelist, blacklist,
  options: { apiKey, baseURL, enterpriseUrl, setCacheKey, timeout, headerTimeout, chunkTimeout },
  models: { <id>: { id, name, family, release_date, attachment, reasoning,
                    temperature, tool_call, interleaved, cost, limit, modalities, ... } } }
```

---

## The working config

`~/.config/opencode/opencode.json` (also vendored at [`config/opencode.json`](../config/opencode.json)):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local llama.cpp (RTX 4060)",
      "options": {
        "baseURL": "http://127.0.0.1:8090/v1",
        "apiKey": "local-no-auth",
        "timeout": 900000,
        "headerTimeout": 120000
      },
      "models": {
        "qwen3.5-4b": {
          "name": "Qwen3.5-4B UD-Q5_K_XL (MTP)",
          "family": "qwen3.5",
          "tool_call": true,
          "reasoning": false,
          "temperature": true,
          "limit": { "context": 131072, "output": 8192 },
          "modalities": { "input": ["text"], "output": ["text"] },
          "cost": { "input": 0, "output": 0 }
        }
      }
    }
  },
  "model": "local/qwen3.5-4b",
  "small_model": "local/qwen3.5-4b",
  "mcp": {
    "local-search": {
      "type": "local",
      "command": ["node", "/home/patrickd/local-agent-bootstrap/mcp/search-server.mjs"],
      "enabled": true,
      "timeout": 180000
    }
  }
}
```

### Field notes

| Field | Why |
|---|---|
| `npm: "@ai-sdk/openai-compatible"` | The Vercel AI SDK adapter for any OpenAI-shaped endpoint. This is what makes llama-server work as a provider. |
| `apiKey` | **Required even though llama-server ignores it.** The SDK refuses to construct a client without a value. Any string works. |
| `baseURL` | Must include `/v1`. Port 8090, not 8080. |
| `timeout: 900000` | 15 min. A local 4B on a long task is far slower than a cloud API; the default will cut you off mid-task. |
| `headerTimeout: 120000` | Time to first byte. Long prefills legitimately take a while before the first token. |
| `models.<id>` | **Must match `--alias`.** With `--alias qwen3.5-4b`, the key is `qwen3.5-4b`. Without an alias it would be the raw filename. |
| `tool_call: true` | Declares tool support. Without it the agent loop won't offer tools. |
| `reasoning: false` | **Must match the server.** See the interaction below. |
| `limit.context` | Match `-c`. OpenCode uses this to decide when to compact. |
| `limit.output` | 8192 — deliberately conservative, a second guard against runaway generation. |
| `cost` | Zeros keep local usage out of spend tracking. |
| `model` / `small_model` | Global default and the model used for summarization/title tasks. Both point local so nothing silently reaches for a cloud provider. |

### The `reasoning` / `interleaved` interaction

`interleaved` tells OpenCode which field carries streamed thinking (`reasoning`, `reasoning_content`, or `reasoning_text`).

- **Server has `--reasoning off`** → set `"reasoning": false` and **omit `interleaved`**.
- **Server has thinking on** → set `"reasoning": true` and `"interleaved": "reasoning_content"` (which is what llama-server emits).

Mismatching these is a good way to get an agent that appears to produce empty responses. This build runs with thinking **off** ([why](05-Server-Configuration.md#the-reasoning-flag--the-biggest-single-gotcha)), so `interleaved` is absent.

---

## MCP registration

```json
"mcp": {
  "local-search": {
    "type": "local",
    "command": ["node", "/absolute/path/to/mcp/search-server.mjs"],
    "enabled": true,
    "timeout": 180000
  }
}
```

- `type: "local"` — stdio subprocess. (`McpRemoteConfig` and `McpOAuthConfig` exist for HTTP/OAuth servers.)
- `command` is an **array**, and the path must be **absolute** — it is not resolved relative to the workspace.
- `timeout: 180000` — a `normal`-mode search fetches and extracts four pages; the default is too tight.
- Tools appear to the model namespaced: `local-search_web_search`, `local-search_web_fetch`.

---

## Verifying

```bash
$ opencode models
opencode/big-pickle
opencode/deepseek-v4-flash-free
...
local/qwen3.5-4b          ← yours
```

Then a real round trip:

```bash
$ opencode run --model local/qwen3.5-4b "Reply with exactly: READY"
READY
```

And the MCP path, letting the model choose the tool itself:

```bash
$ opencode run --model local/qwen3.5-4b \
    "Use the local-search web_search tool to find what llama.cpp's --cache-type-k does."

⚙ local-search_web_search {"query":"llama.cpp --cache-type-k flag","count":3,"summarize":true}
The --cache-type-k flag in llama.cpp controls the precision of the KV cache for key
tensors, with Q8_0 reducing cache memory by half with near-zero quality loss.
```

---

## Config location

`~/.config/opencode/opencode.json` is **global**, so `agent code` works from any directory. A per-project `opencode.json` in a workspace root overrides it — useful for pinning a different model per repo.

---

## Gotchas

1. **`opencode models` failing to list your provider** usually means malformed JSON or an unknown `npm` package name — not a connection problem. It doesn't contact the endpoint to list.
2. **Empty responses** almost always mean the `reasoning`/`interleaved` pair disagrees with the server's `--reasoning` setting.
3. **Model-id drift**: without `--alias`, the id is the GGUF filename and your config breaks the moment you change quants. Always alias.
4. **Don't `pkill -f opencode`** from a shell whose own command line contains that string — you will kill your own shell. Ask how that was discovered.

---

**Next:** [08 — The agent CLI](08-The-agent-CLI.md)
