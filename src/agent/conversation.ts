/**
 * agent/conversation.ts — Conversation state and message orchestration.
 * Pure logic layer: communicates with UI through callbacks only, never touches DOM.
 */

import type { ChatMessage, ConversationRecord } from '../types';
import * as history from './history';
import { buildSystemPrompt } from './prompts';
import { chat } from './ai-service';
import { tools, executeTool } from './tools';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const conversationHistory: ChatMessage[] = [];
let currentConversation: ConversationRecord | null = null;
let isProcessing = false;
let activePresetId = 'gentle';

const MAX_HISTORY_MESSAGES = 80;

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

export function getHistory(): readonly ChatMessage[] {
  return conversationHistory;
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
  conversationHistory.length = 0;
  currentConversation = conv;
  activePresetId = conv.presetId || 'gentle';

  for (const msg of conv.messages) {
    conversationHistory.push({ role: msg.role as ChatMessage['role'], content: msg.content });
  }
}

export function startNewConversation(): void {
  conversationHistory.length = 0;
  currentConversation = null;
}

/**
 * Send a user message: orchestrates AI call, tool execution, streaming.
 * All UI updates go through registered callbacks.
 */
export async function sendMessage(text: string, customPrompt: string): Promise<void> {
  if (isProcessing || !callbacks) return;
  isProcessing = true;

  callbacks.onUserMessage(text);
  conversationHistory.push({ role: 'user', content: text });

  if (!currentConversation) {
    currentConversation = history.createConversation(activePresetId);
  }

  callbacks.onTypingStart();
  let currentMsgId: string | null = null;

  try {
    const systemPrompt = buildSystemPrompt(activePresetId, customPrompt);
    let streamedText = '';

    const response = await chat(
      conversationHistory,
      systemPrompt,
      tools,
      async (toolName: string, toolArgs: Record<string, unknown>) => {
        callbacks!.onTypingEnd();
        let result: string;
        try {
          result = await executeTool(toolName, toolArgs);
        } catch (err: any) {
          result = JSON.stringify({ error: err.message });
        }
        callbacks!.onToolCall(toolName, toolArgs, result);
        return result;
      },
      (textChunk: string) => {
        callbacks!.onTypingEnd();
        streamedText += textChunk;
        currentMsgId = callbacks!.onAssistantStream(streamedText, currentMsgId || undefined);
      },
    );

    callbacks.onTypingEnd();
    const finalContent = streamedText || response?.content || '';
    if (finalContent) {
      currentMsgId = callbacks.onAssistantStream(finalContent, currentMsgId || undefined);
      callbacks.onAssistantFinalize(currentMsgId);
      conversationHistory.push({ role: 'assistant', content: finalContent });
    }
  } catch (err: any) {
    callbacks.onTypingEnd();
    callbacks.onError(err.message || String(err));
  } finally {
    isProcessing = false;

    if (currentConversation) {
      currentConversation.messages = conversationHistory.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
      currentConversation.title = history.generateTitle(currentConversation.messages);
      currentConversation.updatedAt = Date.now();
      history.saveConversation(currentConversation);
      callbacks?.onHistoryChange();
    }

    pruneHistory();
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function pruneHistory(): void {
  if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_MESSAGES);
  }
}
