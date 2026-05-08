import type { LlmClient, LlmTurnInput, LlmTurnResult } from '@dg-agent/core';
import type { ToolCall } from '@dg-agent/core';
import type { ProviderEndpoint } from '@dg-agent/providers-catalog';
import { z } from 'zod';
import {
  toChatMessages,
  toResponsesInput,
  toChatTool,
  toResponsesTool,
  toConversationItems,
  toToolCall,
  parseArguments,
  normalizeContent,
  normalizeOptionalContent,
} from './serialization.js';

const configSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.3),
  endpoint: z.enum(['responses', 'chat/completions']).default('chat/completions'),
  useStrict: z.boolean().default(true),
});

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.union([z.string(), z.null()]).optional(),
            reasoning_content: z.union([z.string(), z.null()]).optional(),
            tool_calls: z
              .array(
                z.object({
                  id: z.string(),
                  type: z.literal('function'),
                  function: z.object({
                    name: z.string(),
                    arguments: z.string(),
                  }),
                }),
              )
              .optional(),
          })
          .passthrough(),
      }),
    )
    .min(1),
});

const responsesSchema = z.object({
  output: z.array(z.any()).optional().default([]),
  output_text: z.string().optional().default(''),
});

export interface OpenAiHttpLlmClientConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  endpoint?: ProviderEndpoint;
  useStrict?: boolean;
}

export class OpenAiHttpLlmClient implements LlmClient {
  private readonly config: z.infer<typeof configSchema>;

  constructor(inputConfig: OpenAiHttpLlmClientConfig) {
    this.config = configSchema.parse(inputConfig);
  }

  async runTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    validateApiKey(this.config.apiKey);
    if (this.config.endpoint === 'responses') {
      return this.runResponsesTurn(input);
    }
    return this.runChatCompletionsTurn(input);
  }

  private async runChatCompletionsTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const streaming = typeof input.onTextDelta === 'function';
    const requestBody = {
      model: this.config.model,
      temperature: this.config.temperature,
      thinking: isDeepSeekModel(this.config) ? { type: 'disabled' } : undefined,
      messages: toChatMessages(
        input.conversation ?? toConversationItems(input.session),
        input.instructions,
        { includeReasoningContent: shouldIncludeReasoningContent(this.config) },
      ),
      tools:
        input.tools.length > 0
          ? input.tools.map((tool) => toChatTool(tool, this.config.useStrict))
          : undefined,
      tool_choice: input.tools.length > 0 ? 'auto' : undefined,
      parallel_tool_calls: input.tools.length > 0 ? true : undefined,
      stream: streaming || undefined,
    };
    input.onRawRequest?.(requestBody);
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: input.abortSignal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`模型服务 HTTP 错误 ${response.status}: ${await response.text()}`);
    }

    if (streaming && input.onTextDelta) {
      const result = await parseChatCompletionsStream(response, input.onTextDelta);
      return {
        ...result,
        rawResponse: {
          streamed: true,
          assistantMessage: result.assistantMessage,
          reasoningContent: result.reasoningContent,
          toolCalls: result.toolCalls,
        },
      };
    }

    const rawJson: unknown = await response.json();
    const parsed = chatResponseSchema.parse(rawJson);
    const firstChoice = parsed.choices[0];
    if (!firstChoice) {
      throw new Error('Chat Completions 响应中没有可用结果');
    }

    const message = firstChoice.message;
    return {
      assistantMessage: normalizeContent(message.content),
      reasoningContent: normalizeOptionalContent(message.reasoning_content),
      toolCalls: (message.tool_calls ?? []).map(toToolCall),
      rawResponse: rawJson,
    };
  }

  private async runResponsesTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const streaming = typeof input.onTextDelta === 'function';
    const requestBody = {
      model: this.config.model,
      input: toResponsesInput(input.conversation ?? toConversationItems(input.session)),
      instructions: input.instructions,
      store: false,
      temperature: this.config.temperature,
      tools:
        input.tools.length > 0
          ? input.tools.map((tool) => toResponsesTool(tool, this.config.useStrict))
          : undefined,
      tool_choice: input.tools.length > 0 ? 'auto' : undefined,
      parallel_tool_calls: input.tools.length > 0 ? true : undefined,
      stream: streaming || undefined,
    };
    input.onRawRequest?.(requestBody);
    const response = await fetch(`${this.config.baseUrl}/responses`, {
      method: 'POST',
      signal: input.abortSignal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`模型服务 HTTP 错误 ${response.status}: ${await response.text()}`);
    }

    if (streaming && input.onTextDelta) {
      const result = await parseResponsesStream(response, input.onTextDelta);
      return {
        ...result,
        rawResponse: {
          streamed: true,
          assistantMessage: result.assistantMessage,
          toolCalls: result.toolCalls,
        },
      };
    }

    const rawJson: unknown = await response.json();
    const parsed = responsesSchema.parse(rawJson);
    const toolCalls: ToolCall[] = [];

    for (const item of parsed.output) {
      if (item?.type === 'function_call') {
        toolCalls.push({
          id: String(item.call_id ?? item.id ?? ''),
          name: String(item.name ?? ''),
          args: parseArguments(String(item.arguments ?? '{}')),
        });
      }
    }

    return {
      assistantMessage: parsed.output_text,
      toolCalls,
      rawResponse: rawJson,
    };
  }
}

async function parseResponsesStream(
  response: Response,
  onTextDelta: (accumulated: string) => void,
): Promise<LlmTurnResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('流式响应体不可用');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  const fnCallSlots: Record<number, { id: string; name: string; arguments: string }> = {};

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
        case 'response.output_text.delta':
          streamedText += event.delta ?? '';
          onTextDelta(streamedText);
          break;
        case 'response.output_item.added':
          if (event.item?.type === 'function_call') {
            fnCallSlots[event.output_index ?? 0] = {
              id: event.item.call_id ?? '',
              name: event.item.name ?? '',
              arguments: '',
            };
          }
          break;
        case 'response.function_call_arguments.delta': {
          const slot = fnCallSlots[event.output_index ?? 0];
          if (slot) {
            slot.arguments += event.delta ?? '';
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          const slot = fnCallSlots[event.output_index ?? 0];
          if (slot) {
            slot.arguments = event.arguments ?? slot.arguments;
            slot.id = event.call_id ?? slot.id;
            slot.name = event.name ?? slot.name;
          }
          break;
        }
      }
    }
  }

  return {
    assistantMessage: streamedText,
    toolCalls: Object.values(fnCallSlots).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: parseArguments(toolCall.arguments),
    })),
  };
}

async function parseChatCompletionsStream(
  response: Response,
  onTextDelta: (accumulated: string) => void,
): Promise<LlmTurnResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('流式响应体不可用');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  let streamedReasoning = '';
  const fnCallSlots: Record<number, { id: string; name: string; arguments: string }> = {};

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

      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (!delta) continue;

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        streamedReasoning += delta.reasoning_content;
      }

      if (typeof delta.content === 'string' && delta.content) {
        streamedText += delta.content;
        onTextDelta(streamedText);
      } else if (Array.isArray(delta.content)) {
        for (const part of delta.content) {
          const text =
            typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '';
          if (!text) continue;
          streamedText += text;
          onTextDelta(streamedText);
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          const index = typeof toolCall.index === 'number' ? toolCall.index : 0;
          if (!fnCallSlots[index]) {
            fnCallSlots[index] = {
              id: '',
              name: '',
              arguments: '',
            };
          }

          if (toolCall.id) fnCallSlots[index].id = toolCall.id;
          if (toolCall.function?.name) fnCallSlots[index].name += toolCall.function.name;
          if (toolCall.function?.arguments)
            fnCallSlots[index].arguments += toolCall.function.arguments;
        }
      }
    }
  }

  return {
    assistantMessage: streamedText,
    reasoningContent: streamedReasoning || undefined,
    toolCalls: Object.values(fnCallSlots).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: parseArguments(toolCall.arguments),
    })),
  };
}

function validateApiKey(apiKey: string): void {
  if (!/^[\x20-\x7E]+$/.test(apiKey)) {
    throw new Error(
      'API key 含有非法字符（可能混入了中文、全角空格或不可见字符）。请在设置中重新粘贴一次纯英文/数字的 key。',
    );
  }
}

function isDeepSeekModel(config: z.infer<typeof configSchema>): boolean {
  const normalizedModel = config.model.trim().toLowerCase();
  const normalizedBaseUrl = config.baseUrl.trim().toLowerCase();
  return normalizedModel.includes('deepseek') || normalizedBaseUrl.includes('deepseek');
}

function shouldIncludeReasoningContent(config: z.infer<typeof configSchema>): boolean {
  return isDeepSeekModel(config);
}

export interface ListModelsOptions {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}

export class ListModelsError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ListModelsError';
  }
}

const listModelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
});

/**
 * Fetch available model IDs from an OpenAI-compatible `/models` endpoint.
 * baseUrl is expected to already include the version prefix (e.g. `.../v1`),
 * so the request hits `${baseUrl}/models` directly.
 */
export async function listModels({
  baseUrl,
  apiKey,
  signal,
}: ListModelsOptions): Promise<string[]> {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  if (!trimmedBase) {
    throw new ListModelsError('未配置接口地址，无法拉取模型列表');
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(`${trimmedBase}/models`, {
      method: 'GET',
      headers,
      signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw error;
    }
    throw new ListModelsError('网络错误，无法连接模型服务', error);
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // ignore body read failure
    }
    throw new ListModelsError(
      `模型列表请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
    );
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch (error) {
    throw new ListModelsError('模型列表响应不是有效的 JSON', error);
  }

  const parsed = listModelsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new ListModelsError('模型列表响应格式不符合 OpenAI 规范', parsed.error);
  }

  const ids = Array.from(new Set(parsed.data.data.map((entry) => entry.id).filter(Boolean)));
  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}
