# DG-Agent Cloudflare Workers

Replaces the old `aliyun-fc/` proxy (delete it once `llm-proxy` is deployed and
verified).

| Worker                       | Hosted by 0xNullAi?         | Purpose                 | Upstream                               | Domain             |
| ---------------------------- | --------------------------- | ----------------------- | -------------------------------------- | ------------------ |
| `llm-proxy` (`dg-llm-proxy`) | **Yes** — free tier         | LLM text relay          | `aihub.071129.xyz` (OpenAI-compatible) | `llm.0xnullai.com` |
| `speech-proxy`               | **No** — self-host template | DashScope ASR/TTS relay | `wss://dashscope.aliyuncs.com`         | (your own)         |

## llm-proxy — hosted free LLM tier

The browser's "免费体验" provider points at `https://llm.0xnullai.com`
(`packages/providers-catalog/src/index.ts`).

```bash
cd workers/llm-proxy
wrangler deploy
wrangler secret put PROXY_API_KEY          # aihub.071129.xyz key
# Dashboard: bind llm.0xnullai.com (Settings > Domains & Routes > Add custom domain)
```

Rate limit is per-IP, 10/min, in-memory (best-effort per isolate). For strict
global limits add a KV namespace or the Workers Rate Limiting binding.

## speech-proxy — self-host template (not hosted)

DashScope no longer has a free tier, so there is **no shared speech relay**. The
default voice mode is the browser's native Web Speech (free, zero config) — keep
recommending that. Users who register their own DashScope account and want
DashScope voice fill in the app's voice "API 密钥" + "代理地址", pointing the
proxy URL at their own deployment of this template. The user's key flows in via
`?api_key=` (no server secret required), so they can deploy it as-is:

```bash
cd workers/speech-proxy
wrangler deploy
# Then set the app's voice 代理地址 to your worker URL.
```

Keys live as request params / Worker secrets, never in the repo.
