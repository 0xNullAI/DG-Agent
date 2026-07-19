import { createEmptyDeviceState } from '@dg-agent/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiAiLlmClient } from './index.js';

/**
 * Contract-test suite mirroring providers-openai-http/src/index.test.ts's
 * companion `contract.test.ts` (same four cases: successful text reply,
 * tool-call round-trip, aborted request, error response) so both LlmClient
 * implementations are held to the same observable behavior. pi-ai's dialects
 * talk to the real `@anthropic-ai/sdk` / `@google/genai` clients rather than
 * bare `fetch`, but both ultimately read `globalThis.fetch` for the actual
 * network call (verified against the installed packages — neither SDK
 * bypasses it in a browser-shaped runtime), so the same `vi.stubGlobal`
 * pattern the openai-http tests use still applies; the fixtures below just
 * speak each dialect's real wire format (SSE) instead of a single JSON body.
 *
 * Anthropic (`anthropic` provider, native `anthropic-messages` dialect) is
 * the primary target since its event/error shapes are documented in detail
 * in errors.ts/serialization.ts; Google gets one additional smoke test to
 * confirm multi-provider routing through the same registry.ts loader
 * actually reaches a different dialect end-to-end.
 */

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

function makeTurnInput(overrides: Record<string, unknown> = {}) {
  return {
    session: EMPTY_SESSION,
    message: 'hello',
    context: EMPTY_CONTEXT,
    conversation: [{ kind: 'message' as const, role: 'user' as const, content: 'hello' }],
    instructions: '',
    tools: [],
    ...overrides,
  };
}

function sseFrames(events: Array<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

function anthropicSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicErrorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ANTHROPIC_TEXT_REPLY_EVENTS = [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 0 } },
    },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

const ANTHROPIC_TOOL_CALL_EVENTS = [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { id: 'msg_2', usage: { input_tokens: 5, output_tokens: 0 } },
    },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'adjust_strength', input: {} },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"channel":"A","value":10}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 3 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

function stubFetchOnce(
  handler: (init: RequestInit | undefined) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return handler(init);
    }),
  );
}

describe('PiAiLlmClient (anthropic)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a successful text reply, streaming accumulated deltas', async () => {
    stubFetchOnce(() => anthropicSseResponse(ANTHROPIC_TEXT_REPLY_EVENTS));

    const client = new PiAiLlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      providerKey: 'anthropic',
    });

    const deltas: string[] = [];
    const result = await client.runTurn(
      makeTurnInput({ onTextDelta: (text: string) => deltas.push(text) }),
    );

    expect(result.assistantMessage).toBe('Hello world');
    expect(deltas).toEqual(['Hello', 'Hello world']);
    expect(result.toolCalls).toBeUndefined();
  });

  it('round-trips a tool call', async () => {
    stubFetchOnce(() => anthropicSseResponse(ANTHROPIC_TOOL_CALL_EVENTS));

    const client = new PiAiLlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      providerKey: 'anthropic',
    });

    const result = await client.runTurn(makeTurnInput());

    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'adjust_strength', args: { channel: 'A', value: 10 } },
    ]);
  });

  it('rejects when the request is aborted', async () => {
    stubFetchOnce(() => anthropicSseResponse(ANTHROPIC_TEXT_REPLY_EVENTS));

    const client = new PiAiLlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      providerKey: 'anthropic',
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.runTurn(makeTurnInput({ abortSignal: controller.signal })),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects with a status-classifiable error on an HTTP error response', async () => {
    stubFetchOnce(() =>
      anthropicErrorResponse(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    );

    const client = new PiAiLlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      providerKey: 'anthropic',
    });

    // classifyPiAiError reshapes this into `Provider HTTP error 401: ...` —
    // the same vocabulary packages/runtime/src/runtime-errors.ts's
    // normalizeAssistantErrorMessage already recognizes for every LlmClient.
    await expect(client.runTurn(makeTurnInput())).rejects.toThrow(/Provider HTTP error 401/);
  });
});

describe('PiAiLlmClient (google)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a successful text reply via the google-generative-ai dialect', async () => {
    // @google/genai's streaming transport reads plain SSE `data: {...}`
    // frames off the raw response body (verified against the installed
    // package), same shape as Anthropic's, just without named `event:`
    // lines or a terminal marker — the stream simply ends.
    const chunk = {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'Hi from Gemini' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    };
    stubFetchOnce(
      () =>
        new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const client = new PiAiLlmClient({
      apiKey: 'test-google-key',
      model: 'gemini-2.5-flash',
      providerKey: 'google',
    });

    const result = await client.runTurn(makeTurnInput());

    expect(result.assistantMessage).toBe('Hi from Gemini');
  });
});
