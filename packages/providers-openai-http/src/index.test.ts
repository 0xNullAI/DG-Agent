import { createEmptyDeviceState } from '@dg-agent/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionTestError,
  ListModelsError,
  OpenAiHttpLlmClient,
  testConnection,
} from './index.js';

const EMPTY_SESSION = {
  id: 'test',
  createdAt: 0,
  updatedAt: 0,
  messages: [],
  deviceState: createEmptyDeviceState(),
};

const EMPTY_CONTEXT = {
  sessionId: 'test',
  sourceType: 'web' as const,
  traceId: 'trace-test',
  deviceState: createEmptyDeviceState(),
};

const MOCK_CHAT_RESPONSE = {
  choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: null } }],
};

function makeTurnInput() {
  return {
    session: EMPTY_SESSION,
    message: 'hello',
    context: EMPTY_CONTEXT,
    conversation: [{ kind: 'message' as const, role: 'user' as const, content: 'hello' }],
    instructions: '',
    tools: [],
  };
}

function captureRequestBody(): { body: Record<string, unknown> | null } {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured.body = JSON.parse(init.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => MOCK_CHAT_RESPONSE,
        body: null,
      };
    }),
  );
  return captured;
}

function captureRequestInit(): {
  headers: Record<string, string> | null;
} {
  const captured: { headers: Record<string, string> | null } = { headers: null };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured.headers = init.headers as Record<string, string>;
      return {
        ok: true,
        json: async () => MOCK_CHAT_RESPONSE,
        body: null,
      };
    }),
  );
  return captured;
}

describe('OpenAiHttpLlmClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('DeepSeek V4 thinking 禁用', () => {
    it('deepseek-v4-flash 请求体包含 thinking: disabled', async () => {
      const captured = captureRequestBody();
      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
      });

      await client.runTurn(makeTurnInput());

      expect(captured.body?.thinking).toEqual({ type: 'disabled' });
    });

    it('deepseek-v4-pro 请求体包含 thinking: disabled', async () => {
      const captured = captureRequestBody();
      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
      });

      await client.runTurn(makeTurnInput());

      expect(captured.body?.thinking).toEqual({ type: 'disabled' });
    });

    it('非 DeepSeek 模型请求体不含 thinking 字段', async () => {
      const captured = captureRequestBody();
      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      });

      await client.runTurn(makeTurnInput());

      expect(captured.body?.thinking).toBeUndefined();
    });

    it('baseUrl 含 deepseek 时也注入 thinking: disabled', async () => {
      const captured = captureRequestBody();
      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'custom-model',
      });

      await client.runTurn(makeTurnInput());

      expect(captured.body?.thinking).toEqual({ type: 'disabled' });
    });
  });

  describe('DeepSeek reasoning_content 回传', () => {
    it('工具调用后的 assistant 消息携带 reasoning_content', async () => {
      const captured = captureRequestBody();
      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
      });

      await client.runTurn({
        session: EMPTY_SESSION,
        message: 'hello',
        context: EMPTY_CONTEXT,
        conversation: [
          { kind: 'message', role: 'user', content: 'hello' },
          {
            kind: 'message',
            role: 'assistant',
            content: '',
            reasoningContent: '<think>thinking...</think>',
            toolCalls: [{ id: 'call_1', name: 'set_strength', args: { channel: 'A', value: 10 } }],
          },
          { kind: 'function_call_output', callId: 'call_1', output: 'ok' },
        ],
        instructions: '',
        tools: [],
      });

      const messages = captured.body?.messages as Array<Record<string, unknown>>;
      const assistantMsg = messages?.find(
        (m) => m.role === 'assistant' && Array.isArray(m.tool_calls),
      );
      expect(assistantMsg?.reasoning_content).toBe('<think>thinking...</think>');
    });
  });

  describe('extraHeaders', () => {
    it('merges extraHeaders() into the outbound request alongside the base headers', async () => {
      const captured = captureRequestInit();
      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-4o-mini',
        extraHeaders: () => ({
          'X-DG-Timestamp': '12345',
          'X-DG-Signature': 'deadbeef',
        }),
      });

      await client.runTurn(makeTurnInput());

      expect(captured.headers?.['Content-Type']).toBe('application/json');
      expect(captured.headers?.['Authorization']).toBe('Bearer sk-test');
      expect(captured.headers?.['X-DG-Timestamp']).toBe('12345');
      expect(captured.headers?.['X-DG-Signature']).toBe('deadbeef');
    });

    it('awaits an async extraHeaders before issuing the request', async () => {
      const captured = captureRequestInit();
      let called = false;
      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-4o-mini',
        extraHeaders: async () => {
          called = true;
          return { 'X-DG-Signature': 'abc' };
        },
      });

      await client.runTurn(makeTurnInput());

      expect(called).toBe(true);
      expect(captured.headers?.['X-DG-Signature']).toBe('abc');
    });
  });

  // Mirrors packages/providers-pi-http/src/index.test.ts's contract suite —
  // same four cases (successful text reply, tool-call round-trip, aborted
  // request, error response) exercised against the pi-ai-backed client, so
  // both LlmClient implementations are held to the same observable
  // behavior even though their wire formats differ.
  describe('contract: successful text reply / tool-call / abort / error', () => {
    it('resolves a successful text reply', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'Hello world' } }],
          }),
          body: null,
        }),
      );

      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
      });

      const result = await client.runTurn(makeTurnInput());

      expect(result.assistantMessage).toBe('Hello world');
      expect(result.toolCalls).toEqual([]);
    });

    it('round-trips a tool call', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'adjust_strength',
                        arguments: '{"channel":"A","value":10}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          body: null,
        }),
      );

      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
      });

      const result = await client.runTurn(makeTurnInput());

      expect(result.toolCalls).toEqual([
        { id: 'call_1', name: 'adjust_strength', args: { channel: 'A', value: 10 } },
      ]);
    });

    it('rejects when the request is aborted', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          if (init.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          return { ok: true, json: async () => MOCK_CHAT_RESPONSE, body: null };
        }),
      );

      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
      });

      const controller = new AbortController();
      controller.abort();

      await expect(
        client.runTurn({ ...makeTurnInput(), abortSignal: controller.signal }),
      ).rejects.toBeInstanceOf(Error);
    });

    it('rejects with a status-classifiable error on an HTTP error response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => '{"error":{"message":"invalid api key"}}',
        }),
      );

      const client = new OpenAiHttpLlmClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
      });

      // Already matches normalizeAssistantErrorMessage's
      // `模型服务 HTTP 错误 (\d{3})` pattern directly — this is the reference
      // shape providers-pi-http's classifyPiAiError reshapes pi-ai's own error
      // strings into (`Provider HTTP error NNN: ...`).
      await expect(client.runTurn(makeTurnInput())).rejects.toThrow(/模型服务 HTTP 错误 401/);
    });
  });
});

// Doubao/Ark and similar providers don't implement `/models` reliably even
// though `/chat/completions` works fine — testConnection falls back to a
// real minimal chat completion in that case rather than reporting failure.
describe('testConnection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves from /models alone without probing chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await testConnection({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/models');
  });

  it('falls back to a chat completion probe when /models fails and a model is given', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/models')) {
        return { ok: false, status: 404, text: async () => 'not found' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await testConnection({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'ark-test',
      model: 'doubao-seed-2-0-mini-250415',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/chat/completions');
  });

  it('rejects with a combined error when both /models and the chat probe fail', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/models')) {
        return { ok: false, status: 404, text: async () => 'no models route' };
      }
      return { ok: false, status: 401, text: async () => 'invalid api key' };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      testConnection({
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'bad-key',
        model: 'doubao-seed-2-0-mini-250415',
      }),
    ).rejects.toBeInstanceOf(ConnectionTestError);
  });

  it('rejects with the original /models error when no model is available to probe with', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'no models route' }),
    );

    await expect(
      testConnection({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'ark-test' }),
    ).rejects.toBeInstanceOf(ListModelsError);
  });
});
