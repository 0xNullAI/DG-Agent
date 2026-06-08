/**
 * dg-speech-proxy — Cloudflare Worker (SELF-HOST TEMPLATE, not hosted by 0xNullAi)
 *
 * DashScope dropped its free tier, so there is NO shared relay. This worker is
 * a template for users who register their own DashScope account and want
 * browser DASR/TTS (the browser can't set the WS auth header itself). The
 * recommended free option is the built-in "browser native" voice mode.
 *
 * The browser connects to wss://<your-proxy>/ws/asr and /ws/tts with the user's
 * key as ?api_key=...; this worker opens an outbound WebSocket to DashScope's
 * realtime inference endpoint with that key and relays all frames (text JSON
 * control + binary PCM audio) transparently. /ws/asr and /ws/tts share the same
 * upstream — the task type lives in the client's run-task message.
 *
 * Self-host:
 *   wrangler deploy
 *   # No secret needed — the key flows in from the client's ?api_key=.
 *   # (Optionally bake one in: wrangler secret put DASHSCOPE_API_KEY)
 *   # Point the app's voice "代理地址" at your worker's URL.
 *
 * VERIFY: the upstream URL / auth header are the standard DashScope realtime WS
 * contract; smoke-test ASR + TTS and adjust DASHSCOPE_WS_URL if needed.
 */

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    // DashScope has no free tier — there is no shared key. The caller brings
    // their own key, passed as ?api_key= by the client; a self-hoster may also
    // bake one in via the DASHSCOPE_API_KEY secret. No key => no service.
    const apiKey = new URL(request.url).searchParams.get('api_key') || env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      return new Response('missing DashScope api_key (pass ?api_key= or set DASHSCOPE_API_KEY)', {
        status: 401,
      });
    }

    const upstreamUrl = env.DASHSCOPE_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `bearer ${apiKey}`,
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
