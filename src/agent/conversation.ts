/**
 * agent/conversation.ts — Conversation state and message orchestration.
 * Uses ConversationItem[] as native state, mapping directly to Responses API input.
 */

import type { ConversationItem, ConversationRecord } from '../types';
import { getItemText } from '../types';
import * as history from './history';
import { buildSystemPrompt } from './prompts';
import { chat } from './ai-service';
import { tools, executeTool } from './tools';
import * as bt from './bluetooth';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const conversationItems: ConversationItem[] = [];
let currentConversation: ConversationRecord | null = null;
let isProcessing = false;
let activePresetId = 'gentle';

const MAX_ITEMS = 200;

// ---------------------------------------------------------------------------
// Callbacks — UI layer registers these
// ---------------------------------------------------------------------------

export interface ConversationCallbacks {
  onUserMessage: (text: string) => void;
  onAssistantStream: (text: string, msgId?: string) => string;
  onAssistantFinalize: (msgId: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>, result: string) => void;
  onTypingStart: () => void;
  onTypingEnd: () => void;
  onError: (message: string) => void;
  onHistoryChange: () => void;
}

let callbacks: ConversationCallbacks | null = null;

export function registerCallbacks(cb: ConversationCallbacks): void {
  callbacks = cb;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getHistory(): readonly ConversationItem[] {
  return conversationItems;
}

export function getCurrentConversation(): ConversationRecord | null {
  return currentConversation;
}

export function getActivePresetId(): string {
  return activePresetId;
}

export function setActivePresetId(id: string): void {
  activePresetId = id;
}

export function getIsProcessing(): boolean {
  return isProcessing;
}

export function loadConversation(conv: ConversationRecord): void {
  conversationItems.length = 0;
  currentConversation = conv;
  activePresetId = conv.presetId || 'gentle';

  for (const item of conv.items) {
    conversationItems.push(item);
  }
}

export function startNewConversation(): void {
  conversationItems.length = 0;
  currentConversation = null;
}

/**
 * Send a user message: orchestrates AI call, tool execution, streaming.
 */
export async function sendMessage(text: string, customPrompt: string): Promise<void> {
  if (isProcessing || !callbacks) return;
  isProcessing = true;

  // Remove all tool items from previous turns to save tokens
  for (let i = conversationItems.length - 1; i >= 0; i--) {
    const item = conversationItems[i] as any;
    if (item.type === 'function_call' || item.type === 'function_call_output') {
      conversationItems.splice(i, 1);
    }
  }

  callbacks.onUserMessage(text);
  conversationItems.push({ role: 'user', content: text });

  if (!currentConversation) {
    currentConversation = history.createConversation(activePresetId);
  }

  callbacks.onTypingStart();
  let currentMsgId: string | null = null;
  let streamedText = '';

  try {
    const systemPrompt = buildSystemPrompt(activePresetId, customPrompt);

    // Non-destructive augmentation: append device status + tool-call reminder
    // to the last user message in a *copy* of the items array. The stored
    // conversationItems remain unchanged so history/UI show the raw user text.
    const itemsForLLM = augmentLastUserItem(conversationItems);

    // Debug: print the final user message (with injected context) sent to LLM
    const lastUser = [...itemsForLLM].reverse().find((it: any) => it.role === 'user') as any;
    if (lastUser) {
      console.log('[User → LLM]\n' + lastUser.content);
    }

    const newItems = await chat(
      itemsForLLM,
      systemPrompt,
      tools,
      {
        onToolCall: async (toolName: string, toolArgs: Record<string, unknown>) => {
          callbacks!.onTypingEnd();
          if (streamedText && currentMsgId) {
            callbacks!.onAssistantFinalize(currentMsgId);
            streamedText = '';
            currentMsgId = null;
          }
          console.log(`[Tool → ${toolName}]`, JSON.stringify(toolArgs));
          let result: string;
          try {
            result = await executeTool(toolName, toolArgs);
          } catch (err: any) {
            result = JSON.stringify({ error: err.message });
          }
          console.log(`[Tool ← ${toolName}]`, result);
          callbacks!.onToolCall(toolName, toolArgs, result);
          callbacks!.onTypingStart();
          return result;
        },
        onStreamText: (chunk: string) => {
          callbacks!.onTypingEnd();
          streamedText += chunk;
          currentMsgId = callbacks!.onAssistantStream(streamedText, currentMsgId || undefined);
        },
      },
    );

    callbacks.onTypingEnd();

    // Append all new items to conversation state
    conversationItems.push(...newItems);

    console.log('[Current context]', JSON.parse(JSON.stringify(conversationItems)));

    // Extract final assistant text for UI finalization
    const lastAssistant = [...newItems].reverse().find((item) => {
      const display = getItemText(item);
      return display?.role === 'assistant';
    });
    const finalText = streamedText || (lastAssistant ? getItemText(lastAssistant)?.text : '') || '';

    if (finalText) {
      if (!currentMsgId) {
        currentMsgId = callbacks.onAssistantStream(finalText, undefined);
      }
      callbacks.onAssistantFinalize(currentMsgId);
    }
  } catch (err: any) {
    callbacks.onTypingEnd();
    callbacks.onError(err.message || String(err));
  } finally {
    isProcessing = false;

    if (currentConversation) {
      currentConversation.items = [...conversationItems];
      currentConversation.title = history.generateTitle(conversationItems);
      currentConversation.updatedAt = Date.now();
      history.saveConversation(currentConversation);
      callbacks?.onHistoryChange();
    }

    pruneItems();
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Build a per-turn snapshot of the conversation where the *last* user message
 * is appended with current device status and a reminder that the model must
 * call at least one tool. The original `conversationItems` is not mutated, so
 * persisted history and prior turns stay free of injected context.
 */
function augmentLastUserItem(items: readonly ConversationItem[]): ConversationItem[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i >= 0; i--) {
    const item = copy[i] as any;
    if (item.role === 'user' && typeof item.content === 'string') {
      copy[i] = { ...item, content: item.content + buildUserContextSuffix() };
      break;
    }
  }
  return copy;
}

function buildUserContextSuffix(): string {
  const s = bt.getStatus();
  const conn = s.connected ? `已连接${s.deviceName ? `（${s.deviceName}）` : ''}` : '未连接';
  const battery = s.battery != null ? `${s.battery}%` : '未知';
  return (
    `\n\n[系统附加上下文 — 用户不可见]\n` +
    `当前郊狼设备状态：\n` +
    `  • 连接：${conn}\n` +
    `  • 电量：${battery}\n` +
    `  • A 通道：强度 ${s.strengthA}/${s.limitA}，波形${s.waveActiveA ? '活跃' : '停止'}\n` +
    `  • B 通道：强度 ${s.strengthB}/${s.limitB}，波形${s.waveActiveB ? '活跃' : '停止'}\n` +
    `\n【强制要求 — 违反视为严重错误】\n` +
    `本轮回复你【必须】调用至少一个工具，绝无例外！不调用工具就直接回复文字是被严格禁止的行为。\n` +
    `- 涉及设备操作 → 调用对应的操作工具（play / stop / add_strength / design_wave / set_strength_limit）\n` +
    `- 用户询问状态 → 调用 get_status\n` +
    `- 普通聊天、问候、闲聊、情感交流等任何场景 → 也必须调用 get_status，然后再根据结果回复用户\n` +
    `再次强调：本轮不允许"零工具调用"的纯文字回复。先调工具，再说话。`
  );
}

function pruneItems(): void {
  if (conversationItems.length <= MAX_ITEMS) return;
  // Find a safe cut point that doesn't split function_call / function_call_output pairs
  let cut = conversationItems.length - MAX_ITEMS;
  while (cut < conversationItems.length) {
    const item = conversationItems[cut] as any;
    if (item.type === 'function_call' || item.type === 'function_call_output') {
      cut++;
    } else {
      break;
    }
  }
  if (cut > 0) conversationItems.splice(0, cut);
}
