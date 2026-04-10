/**
 * ai-service.ts — Unified AI interface using OpenAI Responses API.
 * All providers use the /responses endpoint. No chat completions compatibility.
 */

import type { ConversationItem, ToolDef, ChatCallbacks } from '../types';
import { loadSettings } from './providers';

const MAX_TOOL_ITERATIONS = 20;
const FREE_PROXY_URL = 'https://dg-agent-proxy.0xnullai.workers.dev';
const FREE_PROXY_URL_CN = 'https://dg-agent-proxy-eloracuikl.cn-hangzhou.fcapp.run';

// ---------------------------------------------------------------------------
// Responses API — tool format
// ---------------------------------------------------------------------------

function toResponsesTools(tools: ToolDef[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

// ---------------------------------------------------------------------------
// Core: single Responses API call (streaming or non-streaming)
// Returns parsed output items from the response.
// ---------------------------------------------------------------------------

interface ApiCallResult {
  outputItems: any[];
  streamedText: string;
}

async function callResponsesAPI(
  input: ConversationItem[],
  systemPrompt: string,
  tools: ToolDef[],
  config: Record<string, string>,
  onStreamText?: (chunk: string) => void,
): Promise<ApiCallResult> {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = config.model || 'gpt-5.3';
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('API key is required');

  const body: Record<string, any> = {
    model,
    input,
    store: false,
    temperature: 0.7,
  };
  if (systemPrompt) body.instructions = systemPrompt;
  const rTools = toResponsesTools(tools);
  if (rTools) body.tools = rTools;

  if (onStreamText) {
    body.stream = true;
  }

  const res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  // --- Non-streaming ---
  if (!onStreamText) {
    const data = await res.json();
    const text = data.output_text || '';
    return { outputItems: data.output || [], streamedText: text };
  }

  // --- Streaming: parse SSE ---
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  let completedOutput: any[] | null = null;

  // Fallback tracking (in case response.completed is missing)
  const functionCalls: Record<number, { call_id: string; name: string; arguments: string }> = {};
  let hasFunctionCalls = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      switch (event.type) {
        // Text deltas → stream to UI
        case 'response.output_text.delta':
          streamedText += event.delta;
          onStreamText(event.delta);
          break;

        // Function call tracking
        case 'response.output_item.added':
          if (event.item?.type === 'function_call') {
            hasFunctionCalls = true;
            functionCalls[event.output_index] = {
              call_id: event.item.call_id || '',
              name: event.item.name || '',
              arguments: '',
            };
          }
          break;

        case 'response.function_call_arguments.delta':
          if (functionCalls[event.output_index]) {
            functionCalls[event.output_index].arguments += event.delta;
          }
          break;

        case 'response.function_call_arguments.done':
          if (functionCalls[event.output_index]) {
            functionCalls[event.output_index].arguments = event.arguments;
            if (event.call_id) functionCalls[event.output_index].call_id = event.call_id;
            if (event.name) functionCalls[event.output_index].name = event.name;
          }
          break;

        // Canonical completed output
        case 'response.completed':
          completedOutput = event.response?.output || null;
          break;
      }
    }
  }

  // Prefer canonical output; fall back to reconstructed items
  if (completedOutput) {
    return { outputItems: completedOutput, streamedText };
  }

  // Reconstruct output items from accumulated deltas
  const reconstructed: any[] = [];
  if (hasFunctionCalls) {
    for (const fc of Object.values(functionCalls)) {
      reconstructed.push({
        type: 'function_call',
        call_id: fc.call_id,
        name: fc.name,
        arguments: fc.arguments,
        status: 'completed',
      });
    }
  }
  if (streamedText) {
    reconstructed.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: streamedText }],
    });
  }
  return { outputItems: reconstructed, streamedText };
}

// ---------------------------------------------------------------------------
// Chat with tool loop
// ---------------------------------------------------------------------------

async function chatResponses(
  existingItems: ConversationItem[],
  systemPrompt: string,
  tools: ToolDef[],
  callbacks: ChatCallbacks,
  config: Record<string, string>,
): Promise<ConversationItem[]> {
  const newItems: ConversationItem[] = [];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const input = [...existingItems, ...newItems];

    const { outputItems, streamedText } = await callResponsesAPI(
      input, systemPrompt, tools, config, callbacks.onStreamText,
    );

    const fnCalls = outputItems.filter((o: any) => o.type === 'function_call');

    if (fnCalls.length > 0) {
      // Store any text that accompanied the function calls
      if (streamedText) {
        newItems.push({ role: 'assistant', content: streamedText });
      }

      for (const fc of fnCalls) {
        newItems.push({
          type: 'function_call',
          call_id: fc.call_id,
          name: fc.name,
          arguments: fc.arguments,
        });
      }

      for (const fc of fnCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(fc.arguments);
        } catch {
          args = {};
        }
        let result: string;
        try {
          result = await callbacks.onToolCall(fc.name, args);
        } catch (e: unknown) {
          result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
        newItems.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      continue;
    }

    // No function calls — use output_text directly
    newItems.push({ role: 'assistant', content: streamedText });
    return newItems;
  }

  newItems.push({ role: 'assistant', content: '[Max tool-calling iterations reached]' });
  return newItems;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function chat(
  items: ConversationItem[],
  systemPrompt: string,
  tools: ToolDef[],
  callbacks: ChatCallbacks,
): Promise<ConversationItem[]> {
  const settings = loadSettings();
  const providerId = settings.provider || 'free';
  const config = { ...(settings.configs?.[providerId] || {}) };

  if (providerId === 'free') {
    const region = config.region || 'intl';
    config.baseUrl = region === 'cn' ? FREE_PROXY_URL_CN : FREE_PROXY_URL;
    config.apiKey = 'free';
    config.model = 'qwen3.6-plus';
  } else if (providerId === 'qwen' && !config.baseUrl) {
    config.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    config.model = config.model || 'qwen3.6-plus';
  } else if (providerId === 'openai' && !config.baseUrl) {
    config.baseUrl = 'https://api.openai.com/v1';
  }
  // 'custom' uses whatever the user configured

  try {
    return await chatResponses(items, systemPrompt, tools, callbacks, config);
  } catch (err: unknown) {
    console.error(`[ai-service] ${providerId} error:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return [{ role: 'assistant', content: `Error (${providerId}): ${message}` }];
  }
}
