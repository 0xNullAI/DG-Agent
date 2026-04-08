/**
 * Cloudflare Worker — DG-Agent DeepSeek Proxy
 *
 * Rate-limited proxy to DeepSeek API.
 * API key stored as Worker secret, not exposed to frontend.
 *
 * Environment variables (set via wrangler secret):
 *   DEEPSEEK_API_KEY  — your DeepSeek API key
 *
 * KV namespace binding:
 *   RATE_LIMIT        — for per-IP rate limiting
 *
 * Deploy:
 *   1. npm install -g wrangler
 *   2. cd worker
 *   3. wrangler login
 *   4. wrangler kv namespace create RATE_LIMIT
 *   5. Update wrangler.toml with the KV namespace ID
 *   6. wrangler secret put DEEPSEEK_API_KEY
 *   7. wrangler deploy
 */

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';
const MAX_REQUESTS_PER_MINUTE = 10;
const ALLOWED_ORIGINS = [
  'https://0xnullai.github.io',
];

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(request, new Response(null, { status: 204 }));
    }

    // Only POST
    if (request.method !== 'POST') {
      return corsResponse(request, jsonResponse({ error: '仅支持 POST 请求' }, 405));
    }

    // Check origin
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      return corsResponse(request, jsonResponse({ error: '来源不被允许' }, 403));
    }

    // Rate limiting by IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateKey = `rate:${ip}`;
    const now = Math.floor(Date.now() / 60000); // current minute

    try {
      const stored = await env.RATE_LIMIT.get(rateKey, 'json');
      let count = 0;
      if (stored && stored.minute === now) {
        count = stored.count;
      }

      if (count >= MAX_REQUESTS_PER_MINUTE) {
        return corsResponse(request, jsonResponse({
          error: `请求过于频繁，每分钟最多 ${MAX_REQUESTS_PER_MINUTE} 条，请稍后再试。`
        }, 429));
      }

      // Increment counter
      await env.RATE_LIMIT.put(rateKey, JSON.stringify({ minute: now, count: count + 1 }), {
        expirationTtl: 120, // auto-expire after 2 minutes
      });
    } catch (e) {
      // If KV fails, allow the request (fail open)
      console.error('Rate limit check failed:', e);
    }

    // Parse and sanitize request body
    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse(request, jsonResponse({ error: '请求体格式错误' }, 400));
    }

    // Force model and limits
    body.model = body.model || 'deepseek-chat';
    body.max_tokens = Math.min(body.max_tokens || 2048, 2048);
    // Remove any api key from body
    delete body.api_key;
    delete body.apiKey;

    // Forward to DeepSeek
    try {
      const dsResponse = await fetch(DEEPSEEK_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      // Stream passthrough
      if (body.stream) {
        return corsResponse(request, new Response(dsResponse.body, {
          status: dsResponse.status,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        }));
      }

      const data = await dsResponse.json();
      return corsResponse(request, jsonResponse(data, dsResponse.status));
    } catch (e) {
      return corsResponse(request, jsonResponse({ error: '代理请求失败: ' + e.message }, 502));
    }
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsResponse(request, response) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.find(o => origin.startsWith(o)) || ALLOWED_ORIGINS[0];

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
