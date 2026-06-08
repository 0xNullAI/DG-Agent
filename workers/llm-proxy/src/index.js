/**
 * dg-llm-proxy — Cloudflare Worker
 *
 * Free-tier LLM relay for DG-Agent. Port of the former Aliyun FC proxy
 * (aliyun-fc/index.js) onto Cloudflare Workers — same behaviour, new host.
 *
 * Rate-limited open relay to an OpenAI-compatible upstream gateway. The
 * upstream key is injected server-side (PROXY_API_KEY secret) and never
 * exposed to the browser. Abuse is bounded by the per-IP rate limit below.
 *
 * Deploy:
 *   wrangler deploy
 *   wrangler secret put PROXY_API_KEY      # aihub.071129.xyz key
 *   # PROXY_MODEL is set via [vars] in wrangler.toml (optional override)
 *   # Bind custom domain llm.0xnullai.com in the dashboard
 *     (Workers > dg-llm-proxy > Settings > Domains & Routes).
 */

const UPSTREAM = 'https://aihub.071129.xyz/v1/chat/completions';
const MAX_REQUESTS_PER_MINUTE = 10;

// Best-effort per-isolate rate limit (mirrors the original FC in-memory map).
// Cloudflare may run several isolates, so this is approximate. For strict
// global limiting switch to a KV namespace or the Workers Rate Limiting binding.
const rateLimitMap = new Map();
let lastCleanup = 0;

function cleanup(nowMin) {
  if (nowMin - lastCleanup < 5) return;
  lastCleanup = nowMin;
  for (const [key, val] of rateLimitMap) {
    if (val.minute < nowMin - 1) rateLimitMap.delete(key);
  }
}

function checkRateLimit(ip, nowMin) {
  cleanup(nowMin);
  const entry = rateLimitMap.get(ip);
  const count = entry && entry.minute === nowMin ? entry.count : 0;
  if (count >= MAX_REQUESTS_PER_MINUTE) return false;
  rateLimitMap.set(ip, { minute: nowMin, count: count + 1 });
  return true;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return json(405, { error: '仅支持 POST 请求' });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const nowMin = Math.floor(Date.now() / 60000);
    if (!checkRateLimit(ip, nowMin)) {
      return json(429, {
        error: `请求过于频繁，每分钟最多 ${MAX_REQUESTS_PER_MINUTE} 条，请稍后再试。`,
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: '请求体格式错误' });
    }

    // Force the upstream model server-side so the frontend stays agnostic.
    body.model = env.PROXY_MODEL || 'openrouter/free';
    body.max_tokens = Math.min(body.max_tokens || 2048, 2048);
    delete body.max_output_tokens;
    delete body.api_key;
    delete body.apiKey;

    if (!env.PROXY_API_KEY) {
      return json(500, { error: '服务端未配置 PROXY_API_KEY' });
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.PROXY_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return json(502, { error: '代理请求失败: ' + (e && e.message ? e.message : String(e)) });
    }

    if (body.stream) {
      // Pass the SSE stream straight through.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
