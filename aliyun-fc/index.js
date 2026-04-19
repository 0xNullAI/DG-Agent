/**
 * Aliyun Function Compute (FC 3.0) — DG-Agent Free Tier Proxy
 *
 * Rate-limited proxy to Qwen Bailian Responses API.
 *
 * Deploy (FC 3.0 Console):
 *   1. Create function -> Web Function -> Runtime: Node.js 20
 *   2. Region: cn-hangzhou (same as DashScope for lowest latency)
 *   3. Upload this folder as zip, or paste inline
 *   4. Environment variables:
 *        PROXY_API_KEY   = sk-xxx   (ai.071129.xyz API key, for chat completions)
 *        BAILIAN_API_KEY = sk-xxx   (Qwen Bailian API key, for ASR / TTS WebSocket)
 *   5. HTTP Trigger: authentication = anonymous
 *   6. Listen port: 9000 (FC web function default)
 */

const http = require('http');

const PROXY_API = 'https://ai.071129.xyz/v1/chat/completions';
const MAX_REQUESTS_PER_MINUTE = 10;
const ALLOWED_ORIGINS = [
  'https://0xnullai.github.io',
];
const PORT = parseInt(process.env.FC_SERVER_PORT || '9000', 10);

// In-memory rate limit map: ip -> { minute, count }
const rateLimitMap = new Map();
let lastCleanup = 0;
function cleanupRateLimitMap() {
  const now = Math.floor(Date.now() / 60000);
  if (now - lastCleanup < 5) return;
  lastCleanup = now;
  for (const [key, val] of rateLimitMap) {
    if (val.minute < now - 1) rateLimitMap.delete(key);
  }
}

function pickAllowedOrigin(reqOrigin) {
  return ALLOWED_ORIGINS.find((o) => reqOrigin.startsWith(o)) || ALLOWED_ORIGINS[0];
}

function setCors(res, reqOrigin) {
  res.setHeader('Access-Control-Allow-Origin', pickAllowedOrigin(reqOrigin));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin'] || '';

  if (req.method === 'OPTIONS') {
    setCors(res, origin);
    res.statusCode = 204;
    res.end();
    return;
  }

  setCors(res, origin);

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '仅支持 POST 请求' });
    return;
  }

  if (!ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) {
    sendJson(res, 403, { error: '来源不被允许' });
    return;
  }

  const ip = getClientIp(req);
  const now = Math.floor(Date.now() / 60000);
  cleanupRateLimitMap();
  const entry = rateLimitMap.get(ip);
  const count = entry && entry.minute === now ? entry.count : 0;
  if (count >= MAX_REQUESTS_PER_MINUTE) {
    sendJson(res, 429, {
      error: `请求过于频繁，每分钟最多 ${MAX_REQUESTS_PER_MINUTE} 条，请稍后再试。`,
    });
    return;
  }
  rateLimitMap.set(ip, { minute: now, count: count + 1 });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: '请求体格式错误' });
    return;
  }

  body.model = body.model || 'LongCat-Flash-Chat';
  body.max_tokens = Math.min(body.max_tokens || 2048, 2048);
  delete body.max_output_tokens;
  delete body.api_key;
  delete body.apiKey;

  const apiKey = process.env.PROXY_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: '服务端未配置 PROXY_API_KEY' });
    return;
  }

  try {
    const upstream = await fetch(PROXY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (body.stream) {
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } finally {
        res.end();
      }
      return;
    }

    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(text);
  } catch (e) {
    sendJson(res, 502, { error: '代理请求失败: ' + (e && e.message ? e.message : String(e)) });
  }
});

server.listen(PORT, () => {
  console.log(`[dg-agent-fc] listening on ${PORT}`);
});
