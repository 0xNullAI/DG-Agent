/**
 * Cloudflare Worker — DG-Agent DeepSeek Proxy
 *
 * Rate-limited proxy to DeepSeek API.
 * API key stored as Worker secret, not exposed to frontend.
 *
 * Uses in-memory rate limiting (no KV dependency).
 * Note: each Worker isolate has its own counter map, so limits
 * are approximate across multiple edge locations — acceptable
 * for a lightweight abuse guard.
 *
 * Environment variables (set via wrangler secret):
 *   DEEPSEEK_API_KEY  — your DeepSeek API key
 *
 * Deploy:
 *   1. npm install -g wrangler
 *   2. cd worker
 *   3. wrangler login
 *   4. wrangler secret put DEEPSEEK_API_KEY
 *   5. wrangler deploy
 */

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';
const MAX_REQUESTS_PER_MINUTE = 10;
const ALLOWED_ORIGINS = [
  'https://0xnullai.github.io',
];

// In-memory rate limit map: ip -> { minute, count }
const rateLimitMap = new Map();

// Periodic cleanup to prevent memory leak (every 5 minutes)
let lastCleanup = 0;
function cleanupRateLimitMap() {
  const now = Math.floor(Date.now() / 60000);
  if (now - lastCleanup < 5) return;
  lastCleanup = now;
  for (const [key, val] of rateLimitMap) {
    if (val.minute < now - 1) rateLimitMap.delete(key);
  }
}

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

    // Rate limiting by IP (in-memory)
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Math.floor(Date.now() / 60000);

    cleanupRateLimitMap();

    const entry = rateLimitMap.get(ip);
    let count = 0;
    if (entry && entry.minute === now) {
      count = entry.count;
    }

    if (count >= MAX_REQUESTS_PER_MINUTE) {
      return corsResponse(request, jsonResponse({
        error: `请求过于频繁，每分钟最多 ${MAX_REQUESTS_PER_MINUTE} 条，请稍后再试。`
      }, 429));
    }

    rateLimitMap.set(ip, { minute: now, count: count + 1 });

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
