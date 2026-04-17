import type { LlmConversationItem, LlmPort, LlmTurnInput, LlmTurnResult } from '@dg-agent/contracts';
import type { SessionSnapshot, ToolDefinition, ToolCall } from '@dg-agent/core';
import type { ProviderEndpoint } from '@dg-agent/providers-catalog';
import { z } from 'zod';

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

export interface OpenAiHttpLlmPortConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  endpoint?: ProviderEndpoint;
  useStrict?: boolean;
}

export class OpenAiHttpLlmPort implements LlmPort {
  private readonly config: z.infer<typeof configSchema>;

  constructor(inputConfig: OpenAiHttpLlmPortConfig) {
    this.config = configSchema.parse(inputConfig);
  }

  async runTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    if (this.config.endpoint === 'responses') {
      return this.runResponsesTurn(input);
    }
    return this.runChatCompletionsTurn(input);
  }

  private async runChatCompletionsTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const streaming = typeof input.onTextDelta === 'function';
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: input.abortSignal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature,
        messages: toChatMessages(input.conversation ?? toConversationItems(input.session), input.instructions),
        tools: input.tools.length > 0 ? input.tools.map((tool) => toChatTool(tool, this.config.useStrict)) : undefined,
        tool_choice: input.tools.length > 0 ? 'auto' : undefined,
        parallel_tool_calls: input.tools.length > 0 ? true : undefined,
        stream: streaming || undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`Provider HTTP error ${response.status}: ${await response.text()}`);
    }

    if (streaming && input.onTextDelta) {
      return parseChatCompletionsStream(response, input.onTextDelta);
    }

    const parsed = chatResponseSchema.parse(await response.json());
    const firstChoice = parsed.choices[0];
    if (!firstChoice) {
      throw new Error('Chat Completions response contained no choices.');
    }

    const message = firstChoice.message;
    return {
      assistantMessage: normalizeContent(message.content),
      toolCalls: (message.tool_calls ?? []).map(toToolCall),
    };
  }

  private async runResponsesTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const streaming = typeof input.onTextDelta === 'function';
    const response = await fetch(`${this.config.baseUrl}/responses`, {
      method: 'POST',
      signal: input.abortSignal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: toResponsesInput(input.conversation ?? toConversationItems(input.session)),
        instructions: input.instructions,
        store: false,
        temperature: this.config.temperature,
        tools:
          input.tools.length > 0 ? input.tools.map((tool) => toResponsesTool(tool, this.config.useStrict)) : undefined,
        tool_choice: input.tools.length > 0 ? 'auto' : undefined,
        parallel_tool_calls: input.tools.length > 0 ? true : undefined,
        stream: streaming || undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`Provider HTTP error ${response.status}: ${await response.text()}`);
    }

    if (streaming && input.onTextDelta) {
      return parseResponsesStream(response, input.onTextDelta);
    }

    const parsed = responsesSchema.parse(await response.json());
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
    };
  }
}

async function parseResponsesStream(
  response: Response,
  onTextDelta: (accumulated: string) => void,
): Promise<LlmTurnResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response body is unavailable.');
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
    throw new Error('Streaming response body is unavailable.');
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

      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (!delta) continue;

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
          if (toolCall.function?.arguments) fnCallSlots[index].arguments += toolCall.function.arguments;
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

function toChatMessages(conversation: LlmConversationItem[], instructions: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  if (instructions.trim()) {
    messages.push({
      role: 'system',
      content: instructions,
    });
  }

  for (const item of conversation) {
    if (item.kind === 'message') {
      messages.push({
        role: item.role,
        content: item.content,
      });
      continue;
    }

    if (item.kind === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.callId,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.argumentsJson,
            },
          },
        ],
      });
      continue;
    }

    messages.push({
      role: 'tool',
      tool_call_id: item.callId,
      content: item.output,
    });
  }

  return messages;
}

function toResponsesInput(conversation: LlmConversationItem[]): Array<Record<string, unknown>> {
  return conversation.map((item) => {
    if (item.kind === 'message') {
      return {
        role: item.role,
        content: item.content,
      };
    }

    if (item.kind === 'function_call') {
      return {
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.argumentsJson,
      };
    }

    return {
      type: 'function_call_output',
      call_id: item.callId,
      output: item.output,
    };
  });
}

function toResponsesTool(tool: ToolDefinition, useStrict: boolean): Record<string, unknown> {
  const parameters = useStrict ? strictify(tool.parameters) : tool.parameters;
  const base: Record<string, unknown> = {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters,
  };

  if (useStrict) {
    base.strict = true;
  }

  return base;
}

function toChatTool(tool: ToolDefinition, useStrict: boolean): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: useStrict ? strictify(tool.parameters) : tool.parameters,
    },
  };
}

function normalizeContent(content: string | null | undefined): string {
  return content ?? '';
}

function toToolCall(toolCall: {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    args: parseArguments(toolCall.function.arguments),
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  const source = raw || '{}';
  try {
    return JSON.parse(source) as Record<string, unknown>;
  } catch {
    // fall through to the light repair pass
  }

  try {
    return JSON.parse(repairJson(source)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function repairJson(raw: string): string {
  const stack: string[] = [];
  let output = '';
  let inString = false;
  let escaping = false;

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (!char) continue;

    if (inString) {
      if (escaping) {
        output += char;
        escaping = false;
        continue;
      }

      if (char === '\\') {
        output += char;
        escaping = true;
        continue;
      }

      if (char === '"') {
        output += char;
        inString = false;
        continue;
      }

      if (char === '\n') {
        output += '\\n';
        continue;
      }
      if (char === '\r') {
        output += '\\r';
        continue;
      }
      if (char === '\t') {
        output += '\\t';
        continue;
      }

      output += char;
      continue;
    }

    if (char === '"') {
      output += char;
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      output += char;
      continue;
    }

    if (char === '}' || char === ']') {
      let cursor = output.length - 1;
      while (cursor >= 0 && /\s/.test(output[cursor] ?? '')) {
        cursor -= 1;
      }
      if (cursor >= 0 && output[cursor] === ',') {
        output = output.slice(0, cursor) + output.slice(cursor + 1);
      }
      stack.pop();
      output += char;
      continue;
    }

    output += char;
  }

  if (inString) {
    output += '"';
  }

  while (stack.length > 0) {
    const open = stack.pop();
    output += open === '{' ? '}' : ']';
  }

  return output;
}

function toConversationItems(session: SessionSnapshot): LlmConversationItem[] {
  return session.messages.map((item) => ({
    kind: 'message',
    role: item.role,
    content: item.content,
  }));
}

const STRIP_KEYS = new Set([
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;

  const record = node as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (STRIP_KEYS.has(key)) continue;
    output[key] = strictify(value);
  }

  if (output.type === 'object' && output.properties && typeof output.properties === 'object') {
    const properties = output.properties as Record<string, unknown>;
    const propKeys = Object.keys(properties);
    const originalRequired = new Set<string>(Array.isArray(output.required) ? (output.required as string[]) : []);

    output.required = propKeys;
    output.additionalProperties = false;

    for (const key of propKeys) {
      if (!originalRequired.has(key)) {
        properties[key] = widenWithNull(properties[key]);
      }
    }
  }

  return output;
}

function widenWithNull(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const record = schema as Record<string, unknown>;
  const type = record.type;
  if (type == null) return schema;
  if (Array.isArray(type)) {
    return type.includes('null') ? schema : { ...record, type: [...type, 'null'] };
  }
  if (type === 'null') return schema;
  return { ...record, type: [type, 'null'] };
}
