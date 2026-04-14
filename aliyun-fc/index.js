/**
 * Aliyun Function Compute (FC 3.0) — DG-Agent Free Tier Proxy
 *
 * Rate-limited proxy to Qwen Bailian Responses API + DashScope Voice WebSocket.
 *
 * Deploy (FC 3.0 Console):
 *   1. Create function -> Web Function -> Runtime: Node.js 20
 *   2. Region: cn-hangzhou (same as DashScope for lowest latency)
 *   3. Upload this folder as zip, or paste inline
 *   4. Environment variables:
 *        BAILIAN_API_KEY = sk-xxx   (your Qwen Bailian API key)
 *   5. HTTP Trigger: authentication = anonymous
 *   6. Listen port: 9000 (FC web function default)
 */

const http = require('http');
const WS = require('ws');

const BAILIAN_API = 'https://dashscope.aliyuncs.com/compatible-mode/v1/responses';
const BAILIAN_ASR_API = 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions';
const DASHSCOPE_ASR_WS = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';
const DASHSCOPE_TTS_WS = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';
const MAX_REQUESTS_PER_MINUTE = 10;
const MAX_ASR_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_ORIGINS = ['https://0xnullai.github.io'];
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

function checkRateLimit(ip) {
  const now = Math.floor(Date.now() / 60000);
  cleanupRateLimitMap();
  const entry = rateLimitMap.get(ip);
  const count = entry && entry.minute === now ? entry.count : 0;
  if (count >= MAX_REQUESTS_PER_MINUTE) return false;
  rateLimitMap.set(ip, { minute: now, count: count + 1 });
  return true;
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

async function readBodyRaw(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// WebSocket proxy — bidirectional relay to DashScope voice WebSocket
// ---------------------------------------------------------------------------

const wss = new WS.Server({ noServer: true });

function handleWsUpgrade(req, socket, head) {
  const origin = req.headers['origin'] || '';
  if (!ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let upstreamUrl;
  if (url.pathname === '/ws/asr') {
    upstreamUrl = DASHSCOPE_ASR_WS;
  } else if (url.pathname === '/ws/tts') {
    upstreamUrl = DASHSCOPE_TTS_WS;
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const apiKey = process.env.BAILIAN_API_KEY;
  if (!apiKey) {
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstream = new WS(upstreamUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    upstream.on('open', () => {
      clientWs.on('message', (data, isBinary) => {
        if (upstream.readyState === WS.OPEN) {
          upstream.send(data, { binary: isBinary });
        }
      });
      upstream.on('message', (data, isBinary) => {
        if (clientWs.readyState === WS.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });
    });

    upstream.on('error', (err) => {
      console.error('[ws-proxy] upstream error:', err.message);
      if (clientWs.readyState === WS.OPEN) clientWs.close(1011, 'upstream error');
    });
    clientWs.on('error', (err) => {
      console.error('[ws-proxy] client error:', err.message);
      if (upstream.readyState === WS.OPEN) upstream.close();
    });
    clientWs.on('close', () => {
      if (upstream.readyState === WS.OPEN) upstream.close();
    });
    upstream.on('close', () => {
      if (clientWs.readyState === WS.OPEN) clientWs.close();
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

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
  if (!checkRateLimit(ip)) {
    sendJson(res, 429, {
      error: `请求过于频繁，每分钟最多 ${MAX_REQUESTS_PER_MINUTE} 条，请稍后再试。`,
    });
    return;
  }

  // --- ASR proxy route ---
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/audio/transcriptions') {
    const apiKey = process.env.BAILIAN_API_KEY;
    if (!apiKey) {
      sendJson(res, 500, { error: '服务端未配置 BAILIAN_API_KEY' });
      return;
    }

    let rawBody;
    try {
      rawBody = await readBodyRaw(req, MAX_ASR_BODY_BYTES);
    } catch (e) {
      sendJson(res, 413, { error: e.message || '请求体过大' });
      return;
    }

    try {
      const upstream = await fetch(BAILIAN_ASR_API, {
        method: 'POST',
        headers: {
          'Content-Type': req.headers['content-type'] || 'multipart/form-data',
          Authorization: `Bearer ${apiKey}`,
        },
        body: rawBody,
      });

      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(text);
    } catch (e) {
      sendJson(res, 502, {
        error: '语音识别代理请求失败: ' + (e && e.message ? e.message : String(e)),
      });
    }
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: '请求体格式错误' });
    return;
  }

  body.model = body.model || 'qwen3.6-plus';
  body.max_output_tokens = Math.min(body.max_output_tokens || 2048, 2048);
  delete body.api_key;
  delete body.apiKey;

  const apiKey = process.env.BAILIAN_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: '服务端未配置 BAILIAN_API_KEY' });
    return;
  }

  try {
    const upstream = await fetch(BAILIAN_API, {
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

// Handle WebSocket upgrade requests
server.on('upgrade', handleWsUpgrade);

server.listen(PORT, () => {
  console.log(`[dg-agent-fc] listening on ${PORT}`);
});
