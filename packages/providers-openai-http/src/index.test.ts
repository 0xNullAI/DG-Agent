import { createEmptyDeviceState } from '@dg-agent/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiHttpLlmClient } from './index.js';

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
});
