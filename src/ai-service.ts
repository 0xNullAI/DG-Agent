/**
 * ai-service.ts — Unified AI provider interface with tool-calling support.
 * Browser-only (no backend); all API calls use fetch directly.
 */

import type { ChatMessage, ChatResponse, ToolDef, ToolCallHandler, StreamTextHandler, AppSettings } from './types';

const STORAGE_KEY = 'dg-agent-settings';
const MAX_TOOL_ITERATIONS = 5;

// ---------------------------------------------------------------------------
// Config helpers — reads from the same localStorage key as app.js
// ---------------------------------------------------------------------------

function loadSettings(): Partial<AppSettings> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function getActiveProvider(): string {
  return loadSettings().provider || 'gemini';
}

function getProviderConfig(providerId: string): Record<string, string> {
  const settings = loadSettings();
  return settings.configs?.[providerId] || {};
}

// ---------------------------------------------------------------------------
// Format conversion helpers
// ---------------------------------------------------------------------------

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: ToolDef['parameters'];
}

interface GeminiToolSet {
  functionDeclarations: GeminiFunctionDeclaration[];
}

/** Unified tool def -> Gemini functionDeclarations */
function toGeminiTools(tools: ToolDef[]): GeminiToolSet[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolDef['parameters'];
  };
}

/** Unified tool def -> OpenAI tools array */
function toOpenAITools(tools: ToolDef[]): OpenAIToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: ToolDef['parameters'];
}

/** Unified tool def -> Anthropic tools array */
function toAnthropicTools(tools: ToolDef[]): AnthropicToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

async function chatGemini(
  messages: ChatMessage[],
  systemPrompt: string,
  tools: ToolDef[],
  onToolCall: ToolCallHandler,
  onStreamText: StreamTextHandler | undefined,
  config: Record<string, string>,
): Promise<ChatResponse> {
  const model = config.model || 'gemini-2.5-flash';
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('Gemini API key is required. Gemini offers free API keys at https://aistudio.google.com/apikey');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Build Gemini contents from messages
  function buildContents(msgs: ChatMessage[]): Array<{ role: string; parts: any[] }> {
    const contents: Array<{ role: string; parts: any[] }> = [];
    for (const m of msgs) {
      if (m.role === 'user' || m.role === 'assistant') {
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (typeof m.content === 'string') {
          contents.push({ role, parts: [{ text: m.content }] });
        } else if (Array.isArray(m.parts)) {
          // raw parts (tool responses, etc.)
          contents.push({ role, parts: m.parts });
        }
      }
    }
    return contents;
  }

  // Iterative tool-calling loop
  let conversationMsgs: ChatMessage[] = [...messages];
  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const body: Record<string, any> = {
      contents: buildContents(conversationMsgs),
      generationConfig: { temperature: 0.7 },
    };
    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    const geminiTools = toGeminiTools(tools);
    if (geminiTools) body.tools = geminiTools;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const parts: any[] = data.candidates?.[0]?.content?.parts || [];

    // Check for function calls
    const functionCalls = parts.filter((p: any) => p.functionCall);
    if (functionCalls.length > 0 && onToolCall) {
      // Add model response with function calls to conversation
      conversationMsgs.push({ role: 'assistant', content: '', parts });

      // Execute each tool call and collect results
      const responseParts: any[] = [];
      for (const fc of functionCalls) {
        const { name, args } = fc.functionCall;
        let result: any;
        try {
          result = await onToolCall(name, args);
        } catch (e: unknown) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
        responseParts.push({
          functionResponse: {
            name,
            response: { content: typeof result === 'string' ? JSON.parse(result) : result },
          },
        });
      }
      conversationMsgs.push({ role: 'user', content: '', parts: responseParts });
      continue; // next iteration
    }

    // No tool calls — extract text
    const text = parts.map((p: any) => p.text || '').join('');
    if (onStreamText) onStreamText(text);
    return { role: 'assistant', content: text };
  }

  return { role: 'assistant', content: '[Max tool-calling iterations reached]' };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

async function chatOpenAI(
  messages: ChatMessage[],
  systemPrompt: string,
  tools: ToolDef[],
  onToolCall: ToolCallHandler,
  onStreamText: StreamTextHandler | undefined,
  config: Record<string, string>,
): Promise<ChatResponse> {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = config.model || 'gpt-4o-mini';
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('API key is required for OpenAI-compatible provider');

  function buildMessages(msgs: ChatMessage[]): any[] {
    const out: any[] = [];
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    for (const m of msgs) {
      out.push({ role: m.role, content: m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id, name: m.name } : {}) });
    }
    return out;
  }

  let conversationMsgs: ChatMessage[] = [...messages];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const body: Record<string, any> = {
      model,
      messages: buildMessages(conversationMsgs),
      temperature: 0.7,
    };
    const oaiTools = toOpenAITools(tools);
    if (oaiTools) body.tools = oaiTools;

    // Try streaming
    if (onStreamText) {
      body.stream = true;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${err}`);
      }

      // Parse SSE stream
      const reader: ReadableStreamDefaultReader<Uint8Array> = res.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {};
      let hasToolCalls = false;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullText += delta.content;
            onStreamText(delta.content);
          }
          if (delta.tool_calls) {
            hasToolCalls = true;
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
            }
          }
        }
      }

      if (hasToolCalls && onToolCall) {
        const toolCallsArr = Object.values(toolCalls);
        // Add assistant message with tool_calls
        conversationMsgs.push({
          role: 'assistant',
          content: fullText || '',
          tool_calls: toolCallsArr.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        // Execute tools and add results
        for (const tc of toolCallsArr) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.arguments);
          } catch {
            args = {};
          }
          let result: string;
          try {
            result = await onToolCall(tc.name, args);
          } catch (e: unknown) {
            result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
          }
          conversationMsgs.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.name,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
        continue; // next iteration
      }

      return { role: 'assistant', content: fullText };
    }

    // Non-streaming fallback
    body.stream = false;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (msg?.tool_calls && msg.tool_calls.length > 0 && onToolCall) {
      conversationMsgs.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        let result: string;
        try {
          result = await onToolCall(tc.name, args);
        } catch (e: unknown) {
          result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
        conversationMsgs.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      continue;
    }

    const text: string = msg?.content || '';
    return { role: 'assistant', content: text };
  }

  return { role: 'assistant', content: '[Max tool-calling iterations reached]' };
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

async function chatAnthropic(
  messages: ChatMessage[],
  systemPrompt: string,
  tools: ToolDef[],
  onToolCall: ToolCallHandler,
  onStreamText: StreamTextHandler | undefined,
  config: Record<string, string>,
): Promise<ChatResponse> {
  const model = config.model || 'claude-sonnet-4-20250514';
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('Anthropic API key is required');

  const url = 'https://api.anthropic.com/v1/messages';

  function buildMessages(msgs: ChatMessage[]): Array<{ role: string; content: string | unknown[] }> {
    const out: Array<{ role: string; content: string | unknown[] }> = [];
    for (const m of msgs) {
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: m.content });
      } else if (Array.isArray(m.content)) {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  let conversationMsgs: ChatMessage[] = [...messages];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const body: Record<string, any> = {
      model,
      max_tokens: 4096,
      messages: buildMessages(conversationMsgs),
    };
    if (systemPrompt) body.system = systemPrompt;
    const antTools = toAnthropicTools(tools);
    if (antTools) body.tools = antTools;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const contentBlocks: any[] = data.content || [];

    // Extract text blocks
    const textParts: string[] = contentBlocks.filter((b: any) => b.type === 'text').map((b: any) => b.text as string);
    const toolUseBlocks: any[] = contentBlocks.filter((b: any) => b.type === 'tool_use');

    if (toolUseBlocks.length > 0 && onToolCall) {
      // Add the full assistant response to conversation
      conversationMsgs.push({ role: 'assistant', content: contentBlocks });

      // Execute tools and build tool_result blocks
      const toolResultBlocks: any[] = [];
      for (const tu of toolUseBlocks) {
        let result: string;
        try {
          result = await onToolCall(tu.name, tu.input);
        } catch (e: unknown) {
          result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      conversationMsgs.push({ role: 'user', content: toolResultBlocks });
      continue;
    }

    const text = textParts.join('');
    if (onStreamText) onStreamText(text);
    return { role: 'assistant', content: text };
  }

  return { role: 'assistant', content: '[Max tool-calling iterations reached]' };
}

// ---------------------------------------------------------------------------
// Main chat entry point
// ---------------------------------------------------------------------------

/**
 * Send messages to the active AI provider with tool-calling support.
 */
export async function chat(
  messages: ChatMessage[],
  systemPrompt: string,
  tools: ToolDef[],
  onToolCall: ToolCallHandler,
  onStreamText?: StreamTextHandler,
): Promise<ChatResponse> {
  const providerId = getActiveProvider();
  const config = getProviderConfig(providerId);

  try {
    switch (providerId) {
      case 'gemini':
        return await chatGemini(messages, systemPrompt, tools, onToolCall, onStreamText, config);
      case 'openai':
        return await chatOpenAI(messages, systemPrompt, tools, onToolCall, onStreamText, config);
      case 'anthropic':
        return await chatAnthropic(messages, systemPrompt, tools, onToolCall, onStreamText, config);
      default:
        // Fallback: treat unknown providers as OpenAI-compatible
        return await chatOpenAI(messages, systemPrompt, tools, onToolCall, onStreamText, config);
    }
  } catch (err: unknown) {
    console.error(`[ai-service] ${providerId} error:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { role: 'assistant', content: `Error (${providerId}): ${message}` };
  }
}
