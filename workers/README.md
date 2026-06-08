# DG-Agent Cloudflare Workers

Two free-tier relays, migrated off Aliyun Function Compute onto Cloudflare
Workers. They replace the old `aliyun-fc/` proxy (which can be deleted once
these are deployed and smoke-tested).

| Worker                             | Path                 | Replaces                  | Upstream                                             | Custom domain         |
| ---------------------------------- | -------------------- | ------------------------- | ---------------------------------------------------- | --------------------- |
| `llm-proxy` (`dg-llm-proxy`)       | `/` POST             | `aliyun-fc/index.js`      | `aihub.071129.xyz` (OpenAI-compatible)               | `llm.0xnullai.com`    |
| `speech-proxy` (`dg-speech-proxy`) | `/ws/asr`, `/ws/tts` | the DashScope FC WS proxy | `wss://dashscope.aliyuncs.com` (still Aliyun engine) | `speech.0xnullai.com` |

The web client already points at these domains:

- `packages/providers-catalog/src/index.ts` → `FREE_TRIAL_PROXY_URL = https://llm.0xnullai.com`
- `packages/audio-browser/src/dashscope-proxy.ts` → `FREE_PROXY_URL = https://speech.0xnullai.com`

## Deploy

```bash
cd workers/llm-proxy
wrangler deploy
wrangler secret put PROXY_API_KEY          # aihub.071129.xyz key

cd ../speech-proxy
wrangler deploy
wrangler secret put DASHSCOPE_API_KEY       # DashScope (百炼) key
```

Then in the dashboard bind the custom domains (Workers & Pages > each worker >
Settings > Domains & Routes > Add custom domain): `llm.0xnullai.com` and
`speech.0xnullai.com`. DNS records are created automatically for a custom domain
in the same zone.

## Notes

- **LLM rate limit** is per-IP, 10/min, in-memory (best-effort per isolate),
  matching the old FC. For strict global limits add a KV namespace or the
  Workers Rate Limiting binding.
- **Speech** still uses DashScope as the engine — only the relay hop is
  de-Aliyun'd. Smoke-test ASR + TTS after deploy; if DashScope rejects the
  upgrade, adjust `DASHSCOPE_WS_URL` / auth header in `speech-proxy`.
- Keys live as Worker **secrets**, never in the repo.
