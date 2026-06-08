/**
 * dg-speech-proxy — Cloudflare Worker
 *
 * Free-tier speech (ASR + TTS) relay for DG-Agent. Replaces the former Aliyun
 * FC WebSocket proxy. The browser connects to:
 *     wss://speech.0xnullai.com/ws/asr
 *     wss://speech.0xnullai.com/ws/tts
 * and this worker opens an outbound WebSocket to Aliyun DashScope's realtime
 * inference endpoint, injecting the DashScope key server-side, then relays all
 * frames (text JSON control + binary PCM audio) transparently in both
 * directions. The ASR/TTS task type lives in the client's run-task message, so
 * both /ws/asr and /ws/tts use the same upstream endpoint.
 *
 * NOTE: the speech engine is still DashScope (Aliyun) — only the relay hop
 * moves to Cloudflare. To fully drop Aliyun, swap the upstream here.
 *
 * Deploy:
 *   wrangler deploy
 *   wrangler secret put DASHSCOPE_API_KEY   # DashScope (百炼) API key
 *   # Bind custom domain speech.0xnullai.com in the dashboard.
 *
 * VERIFY AFTER DEPLOY: the upstream URL / auth header below are the standard
 * DashScope realtime WS contract; smoke-test ASR + TTS once live and adjust
 * DASHSCOPE_WS_URL / headers if DashScope rejects the upgrade.
 */

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    if (!env.DASHSCOPE_API_KEY) {
      return new Response('server missing DASHSCOPE_API_KEY', { status: 500 });
    }

    const upstreamUrl = env.DASHSCOPE_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `bearer ${env.DASHSCOPE_API_KEY}`,
        },
      });
    } catch (e) {
      return new Response('upstream connect failed: ' + (e && e.message ? e.message : String(e)), {
        status: 502,
      });
    }

    const upstreamWs = upstreamResp.webSocket;
    if (!upstreamWs) {
      return new Response('upstream did not upgrade to websocket', { status: 502 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    upstreamWs.accept();

    // Cloudflare only allows close codes 1000 or 3000-4999 on outbound closes;
    // clamp anything else to avoid throwing during teardown.
    const safeCode = (code) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);

    // browser -> DashScope
    server.addEventListener('message', (event) => {
      try {
        upstreamWs.send(event.data);
      } catch {
        /* upstream gone; ignore */
      }
    });
    server.addEventListener('close', (event) => {
      try {
        upstreamWs.close(safeCode(event.code), event.reason);
      } catch {
        /* already closed */
      }
    });
    server.addEventListener('error', () => {
      try {
        upstreamWs.close();
      } catch {
        /* already closed */
      }
    });

    // DashScope -> browser
    upstreamWs.addEventListener('message', (event) => {
      try {
        server.send(event.data);
      } catch {
        /* client gone; ignore */
      }
    });
    upstreamWs.addEventListener('close', (event) => {
      try {
        server.close(safeCode(event.code), event.reason);
      } catch {
        /* already closed */
      }
    });
    upstreamWs.addEventListener('error', () => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  },
};
