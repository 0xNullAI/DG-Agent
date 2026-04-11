/**
 * transport.ts — Pure HTTP/SSE wrapper around the OpenAI Responses API.
 *
 * This module knows nothing about prompts, tools, policies, or the agent
 * loop. It accepts a fully-built `instructions` string + a clean `input`
 * array and returns the parsed output items. Provider-specific routing
 * (free / qwen / openai / custom) lives here as well so the runner stays
 * provider-agnostic.
 */

import type { ConversationItem, ToolDef } from '../types';
import { loadSettings } from './providers';

const FREE_PROXY_URL = 'https://dg-agent-proxy-eloracuikl.cn-hangzhou.fcapp.run';

// ---------------------------------------------------------------------------
// Provider config resolution
// ---------------------------------------------------------------------------

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
  /** Which OpenAI-compatible endpoint shape to speak on the wire. */
  endpoint: 'responses' | 'chat/completions';
  /** Whether to emit strict-mode tool schemas. True for all providers except
   *  a custom one whose user explicitly turned strict off. */
  useStrict: boolean;
}

export function resolveProviderConfig(): TransportConfig {
  const settings = loadSettings();
  const providerId = settings.provider || 'free';
  const raw = { ...(settings.configs?.[providerId] || {}) };

  let baseUrl = raw.baseUrl || '';
  let apiKey = raw.apiKey || '';
  let model = raw.model || '';

  if (providerId === 'free') {
    baseUrl = FREE_PROXY_URL;
    apiKey = 'free';
    model = 'qwen3.5-plus';
  } else if (providerId === 'qwen') {
    baseUrl = baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    model = model || 'qwen3.5-plus';
  } else if (providerId === 'openai') {
    baseUrl = baseUrl || 'https://api.openai.com/v1';
    model = model || 'gpt-5.3';
  } else if (providerId === 'doubao') {
    baseUrl = 'https://ark.cn-beijing.volces.com/api/v3';
    model = model || 'doubao-seed-2-0-mini-260215';
  }

  // Strict mode is on by default everywhere. Only the custom provider lets
  // the user opt out, because custom backends may be OpenAI-compatible shims
  // that reject `strict`, `additionalProperties:false`, or nullable unions.
  const useStrict = providerId === 'custom' ? raw.useStrict !== 'false' : true;
  const endpoint =
    providerId === 'custom' && raw.endpoint === 'chat/completions'
      ? 'chat/completions'
      : 'responses';

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    // Last-resort fallback so a custom provider with no model still produces
    // a valid request body. Any real provider block above already filled
    // this in; this only matters for misconfigured 'custom' setups.
    model: model || 'gpt-5.3',
    providerId,
    endpoint,
    useStrict,
  };
}

// ---------------------------------------------------------------------------
// Tool schema mapping
// ---------------------------------------------------------------------------

/**
 * JSON Schema keywords that strict-mode Responses-API providers (OpenAI, Ark)
 * refuse. They're descriptive hints to the human author and get stripped
 * before the schema leaves this module. Handlers in tools.ts already enforce
 * the real numeric bounds (see `clamp`), so removing them from the wire
 * schema does not weaken runtime safety — it only removes a soft hint for
 * the model, which we compensate for by putting the range back into each
 * field's description text.
 */
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

/**
 * Produce a strict-mode-compatible copy of a JSON Schema fragment.
 *
 * The transform is recursive and idempotent:
 *   - every `type:"object"` gets `additionalProperties: false`
 *   - every property not already in `required` is added to `required` and
 *     its type is unioned with `"null"` (so the model can explicitly pass
 *     null for what was an optional field)
 *   - unsupported keywords (see STRIP_KEYS) are dropped
 *
 * Never mutates the input — returns fresh objects/arrays. This lets
 * tools.ts keep a human-readable "loose" schema as the source of truth
 * and we only synthesize the strict form at HTTP-body build time.
 */
function strictify(node: any): any {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) {
    if (STRIP_KEYS.has(k)) continue;
    out[k] = strictify(v);
  }

  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const propKeys = Object.keys(out.properties);
    const originalRequired = new Set<string>(Array.isArray(out.required) ? out.required : []);
    // Every property must be listed in `required` under strict mode; fields
    // that were optional get their type widened to allow null so the model
    // has a way to say "not provided".
    out.required = propKeys;
    out.additionalProperties = false;
    for (const key of propKeys) {
      if (!originalRequired.has(key)) {
        out.properties[key] = widenWithNull(out.properties[key]);
      }
    }
  }
  return out;
}

/** Union a schema fragment's `type` with "null". Leaves untyped fragments alone. */
function widenWithNull(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const t = schema.type;
  if (t == null) return schema;
  if (Array.isArray(t)) {
    return t.includes('null') ? schema : { ...schema, type: [...t, 'null'] };
  }
  if (t === 'null') return schema;
  return { ...schema, type: [t, 'null'] };
}

function toResponsesTools(tools: ToolDef[], useStrict: boolean): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    const parameters = useStrict ? strictify(t.parameters) : t.parameters;
    const base: Record<string, any> = {
      type: 'function',
      name: t.name,
      description: t.description,
      parameters,
    };
    if (useStrict) base.strict = true;
    return base;
  });
}

function toChatCompletionsTools(tools: ToolDef[], useStrict: boolean): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    const parameters = useStrict ? strictify(t.parameters) : t.parameters;
    const fn: Record<string, any> = {
      name: t.name,
      description: t.description,
      parameters,
    };
    if (useStrict) fn.strict = true;
    return {
      type: 'function',
      function: fn,
    };
  });
}

function toChatCompletionsMessages(
  input: ConversationItem[],
  instructions: string,
): any[] {
  const messages: any[] = [{ role: 'system', content: instructions }];

  for (const item of input) {
    const it = item as any;

    if (it.role === 'user' || it.role === 'assistant') {
      messages.push({
        role: it.role,
        content: it.content,
      });
      continue;
    }

    if (it.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: it.call_id,
          type: 'function',
          function: {
            name: it.name,
            arguments: it.arguments || '',
          },
        }],
      });
      continue;
    }

    if (it.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: it.call_id,
        content: it.output,
      });
    }
  }

  return messages;
}

function extractChatMessageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  let out = '';
  for (const part of content) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (part?.type === 'text' && typeof part.text === 'string') {
      out += part.text;
      continue;
    }
    if (typeof part?.text === 'string') {
      out += part.text;
    }
  }
  return out;
}

function chatToolCallsToOutputItems(message: any): any[] {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return toolCalls.map((tc: any) => ({
    type: 'function_call',
    call_id: tc.id || '',
    name: tc.function?.name || '',
    arguments: tc.function?.arguments || '',
    status: 'completed',
  }));
}

// ---------------------------------------------------------------------------
// One Responses API call
// ---------------------------------------------------------------------------

export interface ResponsesCallResult {
  /** Parsed output items in canonical Responses API format. */
  outputItems: any[];
  /** Concatenated streamed text (empty if no text deltas were emitted). */
  streamedText: string;
}

export async function callResponses(
  input: ConversationItem[],
  instructions: string,
  tools: ToolDef[],
  config: TransportConfig,
  onTextDelta?: (accumulated: string) => void,
  signal?: AbortSignal,
): Promise<ResponsesCallResult> {
  if (config.endpoint === 'chat/completions') {
    return callChatCompletions(input, instructions, tools, config, onTextDelta, signal);
  }
  return callResponsesApi(input, instructions, tools, config, onTextDelta, signal);
}

async function callResponsesApi(
  input: ConversationItem[],
  instructions: string,
  tools: ToolDef[],
  config: TransportConfig,
  onTextDelta?: (accumulated: string) => void,
  signal?: AbortSignal,
): Promise<ResponsesCallResult> {
  if (!config.apiKey) throw new Error('API key is required');
  // fetch() rejects header values containing non ISO-8859-1 code points with a
  // confusing low-level error. Catch the common case (user pasted a key with
  // CJK chars, full-width spaces, smart quotes, or zero-width chars) here and
  // surface a message that points at the real cause.
  if (!/^[\x20-\x7E]+$/.test(config.apiKey)) {
    throw new Error(
      'API key 含有非法字符（可能混入了中文、全角空格或不可见字符）。请在设置中重新粘贴一次纯英文/数字的 key。',
    );
  }

  const body: Record<string, any> = {
    model: config.model,
    input,
    store: false,
    temperature: 0.3,
    instructions,
  };
  const rTools = toResponsesTools(tools, config.useStrict);
  if (rTools) {
    body.tools = rTools;
    // Explicitly surface the defaults the Volcengine Function Calling docs
    // recommend specifying. Values match the API defaults so behavior is
    // unchanged — this is purely for reproducibility / audit.
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }
  if (onTextDelta) body.stream = true;

  console.log('[LLM →]', structuredClone(body));

  const res = await fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  if (!onTextDelta) {
    const data = await res.json();
    console.log('[LLM ←]', structuredClone(data));
    return {
      outputItems: data.output || [],
      streamedText: data.output_text || '',
    };
  }

  const result = await parseSSEStream(res, onTextDelta);
  console.log('[LLM ←]', structuredClone(result));
  return result;
}

async function callChatCompletions(
  input: ConversationItem[],
  instructions: string,
  tools: ToolDef[],
  config: TransportConfig,
  onTextDelta?: (accumulated: string) => void,
  signal?: AbortSignal,
): Promise<ResponsesCallResult> {
  if (!config.apiKey) throw new Error('API key is required');
  // Keep the same validation and error wording as the Responses path so the
  // settings UX stays consistent no matter which endpoint the custom provider uses.
  if (!/^[\x20-\x7E]+$/.test(config.apiKey)) {
    throw new Error(
      'API key 含有非法字符（可能混入了中文、全角空格或不可见字符）。请在设置中重新粘贴一次纯英文/数字的 key。',
    );
  }

  const body: Record<string, any> = {
    model: config.model,
    messages: toChatCompletionsMessages(input, instructions),
    temperature: 0.3,
  };
  const cTools = toChatCompletionsTools(tools, config.useStrict);
  if (cTools) {
    body.tools = cTools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }
  if (onTextDelta) body.stream = true;

  console.log('[LLM →]', structuredClone(body));

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  if (!onTextDelta) {
    const data = await res.json();
    console.log('[LLM ←]', structuredClone(data));
    const message = data.choices?.[0]?.message || {};
    return {
      outputItems: chatToolCallsToOutputItems(message),
      streamedText: extractChatMessageText(message),
    };
  }

  const result = await parseChatCompletionsStream(res, onTextDelta);
  console.log('[LLM ←]', structuredClone(result));
  return result;
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

async function parseSSEStream(
  res: Response,
  onTextDelta: (accumulated: string) => void,
): Promise<ResponsesCallResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  let completedOutput: any[] | null = null;

  // Fallback reconstruction (used only if response.completed never arrives)
  const fnCallSlots: Record<number, { call_id: string; name: string; arguments: string }> = {};
  let sawFnCall = false;

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
          streamedText += event.delta;
          onTextDelta(streamedText);
          break;

        case 'response.output_item.added':
          if (event.item?.type === 'function_call') {
            sawFnCall = true;
            fnCallSlots[event.output_index] = {
              call_id: event.item.call_id || '',
              name: event.item.name || '',
              arguments: '',
            };
          }
          break;

        case 'response.function_call_arguments.delta':
          if (fnCallSlots[event.output_index]) {
            fnCallSlots[event.output_index].arguments += event.delta;
          }
          break;

        case 'response.function_call_arguments.done':
          if (fnCallSlots[event.output_index]) {
            fnCallSlots[event.output_index].arguments = event.arguments;
            if (event.call_id) fnCallSlots[event.output_index].call_id = event.call_id;
            if (event.name) fnCallSlots[event.output_index].name = event.name;
          }
          break;

        case 'response.completed':
          completedOutput = event.response?.output || null;
          break;
      }
    }
  }

  if (completedOutput) {
    return { outputItems: completedOutput, streamedText };
  }

  // Reconstruct from accumulated deltas
  const reconstructed: any[] = [];
  if (sawFnCall) {
    for (const fc of Object.values(fnCallSlots)) {
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

async function parseChatCompletionsStream(
  res: Response,
  onTextDelta: (accumulated: string) => void,
): Promise<ResponsesCallResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';

  const fnCallSlots: Record<number, { call_id: string; name: string; arguments: string }> = {};
  let sawFnCall = false;

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
            typeof part === 'string'
              ? part
              : typeof part?.text === 'string'
                ? part.text
                : '';
          if (!text) continue;
          streamedText += text;
          onTextDelta(streamedText);
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        sawFnCall = true;
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!fnCallSlots[idx]) {
            fnCallSlots[idx] = { call_id: '', name: '', arguments: '' };
          }
          if (tc.id) fnCallSlots[idx].call_id = tc.id;
          if (tc.function?.name) fnCallSlots[idx].name += tc.function.name;
          if (tc.function?.arguments) fnCallSlots[idx].arguments += tc.function.arguments;
        }
      }
    }
  }

  const outputItems: any[] = [];
  if (sawFnCall) {
    for (const fc of Object.values(fnCallSlots)) {
      outputItems.push({
        type: 'function_call',
        call_id: fc.call_id,
        name: fc.name,
        arguments: fc.arguments,
        status: 'completed',
      });
    }
  }

  return { outputItems, streamedText };
}
