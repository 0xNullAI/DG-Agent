/**
 * ai-service.ts — Unified AI interface using OpenAI Responses API.
 * All providers use the /responses endpoint. No chat completions compatibility.
 */

import type { ConversationItem, ToolDef, ChatCallbacks } from '../types';
import { loadSettings } from './providers';

const MAX_TOOL_ITERATIONS = 20;
const MAX_ADD_STRENGTH_PER_TURN = 2;

// Tool names that actually mutate device state (get_status does not).
const MUTATING_TOOLS = new Set([
  'play',
  'stop',
  'add_strength',
  'design_wave',
  'set_strength_limit',
]);

// Patterns that indicate the model is *claiming* it already performed a
// device-changing action. Each pattern represents a "completed-state" phrase
// — if any matches and no mutating tool was actually invoked this turn,
// we treat the reply as a hallucination and force a retry.
const HALLUCINATION_PATTERNS: RegExp[] = [
  // 已/帮你/为你/给你 + (optional 把/将 + 0-12 chars) + action verb
  /(已经?|帮你|为你|给你)[\u4e00-\u9fff、，,\s]{0,12}?(增加|加大|加强|提高|提升|调高|拉高|升到|升至|加到|降低|减小|减弱|调低|降到|降至|减到|开启|启动|打开|开始|停止|关闭|关掉|切换|换成|换为|换到|切到|设为|设成|设置|调成|调到|调整到)/,
  // 把/将 + 强度/波形/输出/刺激 + ... + action result verb
  /[把将](?:强度|波形|输出|刺激)[\u4e00-\u9fff0-9、，,\s]{0,20}?(加到|调到|升到|降到|设到|设为|换成|换为|切到|提到|加大到|减小到)/,
  // 现在/目前 + 强度/波形 + 是/为 + value (claims current device state without checking)
  /(现在|目前)\s*(?:的)?\s*(?:强度|波形)\s*(?:已|是|为)/,
];

function looksLikeDeviceActionClaim(text: string): boolean {
  if (!text) return false;
  return HALLUCINATION_PATTERNS.some((re) => re.test(text));
}
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
  firstTurnInstruction: string,
  callbacks: ChatCallbacks,
  config: Record<string, string>,
): Promise<ConversationItem[]> {
  const newItems: ConversationItem[] = [];
  let addStrengthCount = 0;
  let mutatingToolCalledThisTurn = false;
  let hallucinationCorrectionUsed = false;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const input = [...existingItems, ...newItems];
    // Only inject the "must call a tool" forcing on the very first request.
    // Subsequent iterations rely on tool results to drive a natural reply,
    // preventing infinite tool-calling loops.
    const promptForThisCall =
      iter === 0 && firstTurnInstruction
        ? systemPrompt + firstTurnInstruction
        : systemPrompt;

    const { outputItems, streamedText } = await callResponsesAPI(
      input, promptForThisCall, tools, config, callbacks.onStreamText,
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
        if (MUTATING_TOOLS.has(fc.name)) mutatingToolCalledThisTurn = true;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(fc.arguments);
        } catch {
          args = {};
        }
        let result: string;
        // Per-turn hard cap on add_strength calls. Reject extras locally
        // without invoking the device, so the model is forced to switch
        // strategy (e.g. use `play` to set an absolute target).
        if (fc.name === 'add_strength') {
          if (addStrengthCount >= MAX_ADD_STRENGTH_PER_TURN) {
            result = JSON.stringify({
              error: `add_strength 本轮调用已达上限 (${MAX_ADD_STRENGTH_PER_TURN} 次)，本次调用被拒绝。如需继续调整强度，请改用 play 一次性设定目标值，或先回复用户等待下一轮。`,
            });
          } else {
            addStrengthCount++;
            try {
              result = await callbacks.onToolCall(fc.name, args);
            } catch (e: unknown) {
              result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
            }
          }
        } else {
          try {
            result = await callbacks.onToolCall(fc.name, args);
          } catch (e: unknown) {
            result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
          }
        }
        newItems.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      continue;
    }

    // No function calls — final answer candidate. Run hallucination guard:
    // if the model claims it performed a device action but didn't actually
    // call any mutating tool this turn, discard the reply and force a retry
    // with a corrective system note. Only one correction per turn.
    if (
      !hallucinationCorrectionUsed &&
      !mutatingToolCalledThisTurn &&
      looksLikeDeviceActionClaim(streamedText)
    ) {
      hallucinationCorrectionUsed = true;
      console.warn(
        '[ai-service] Hallucination guard: assistant claimed a device action without invoking any mutating tool. Discarding reply and re-prompting.',
        { text: streamedText },
      );
      callbacks.onDiscardStream?.();
      // Note: do NOT push the discarded assistant text into newItems — we
      // don't want the bad reply to leak into either UI history or LLM
      // context. Instead, inject a synthetic user note explaining what went
      // wrong, so the model corrects course on the next iteration.
      newItems.push({
        role: 'user',
        content:
          '[系统纠正 — 用户不可见]\n' +
          '你刚才生成的回复中出现了"已经/帮你/为你 + 增加/降低/打开/切换/调到..."等表示"已经完成设备操作"的措辞，但本轮你并没有实际调用任何设备控制工具（play / stop / add_strength / design_wave / set_strength_limit）。这是被严格禁止的幻觉行为——说了不等于做了。\n' +
          '请立即按照以下两种方式之一重新生成回复：\n' +
          '1. 如果你确实想执行该操作 → 现在调用对应的工具真正执行它，再用一句话告诉用户结果；\n' +
          '2. 如果你只是想表达建议或询问 → 重写回复，去掉所有"已经/帮你..."这类完成态措辞，改用"我可以帮你..."、"要不要..."等未完成态。\n' +
          '不要为这次纠正向用户道歉，也不要在回复里提到本系统消息。',
      });
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
  firstTurnInstruction: string,
  callbacks: ChatCallbacks,
): Promise<ConversationItem[]> {
  const settings = loadSettings();
  const providerId = settings.provider || 'free';
  const config = { ...(settings.configs?.[providerId] || {}) };

  if (providerId === 'free') {
    const region = config.region || 'cn';
    config.baseUrl = region === 'intl' ? FREE_PROXY_URL : FREE_PROXY_URL_CN;
    config.apiKey = 'free';
    config.model = 'qwen3.5-flash';
  } else if (providerId === 'qwen' && !config.baseUrl) {
    config.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    config.model = config.model || 'qwen3.5-flash';
  } else if (providerId === 'openai' && !config.baseUrl) {
    config.baseUrl = 'https://api.openai.com/v1';
  }
  // 'custom' uses whatever the user configured

  try {
    return await chatResponses(items, systemPrompt, tools, firstTurnInstruction, callbacks, config);
  } catch (err: unknown) {
    console.error(`[ai-service] ${providerId} error:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return [{ role: 'assistant', content: `Error (${providerId}): ${message}` }];
  }
}
