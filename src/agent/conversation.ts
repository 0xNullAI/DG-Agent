/**
 * conversation.ts — Top-level session orchestration.
 *
 * Owns three things, nothing else:
 *   1. ConversationStore — a clean stream of `user` / `assistant` text items.
 *      Tool calls and outputs never enter this store; they live only inside
 *      the runner's per-turn working state.
 *   2. ChatSink — a per-`sendMessage` adapter that turns runner events into
 *      concrete UI callback calls and manages bubble lifecycle (stream /
 *      finalize / discard / inline).
 *   3. sendMessage — the single public mutation entry point. Wires up the
 *      permission gate (per-tool grant cache + settings-level mode), the
 *      abort controller, and the error-classification path, then hands the
 *      whole thing to `runTurn` and pushes the returned items into the store.
 */

import type { AgentSink, ConversationItem, ConversationRecord } from '../types';
import * as history from './history';
import { buildInstructions } from './prompts';
import { getTools, executeTool, cancelAllTimers, initTimer, type ScheduledTimer } from './tools';
import * as bt from './bluetooth';
import { runTurn } from './runner';
import { resolveProviderConfig } from './transport';
import {
  requiresPermission,
  hasGrant,
  recordChoice,
  getEffectiveMode,
  clearAlwaysMode,
  clearGrants,
  type PermissionChoice,
} from './permissions';

export function initConversation(callbacks: ConversationCallbacks): void {
  initConversationCallbacks(callbacks);
  initConversationTools();
}

export function resetConversation(): void {
  abortCurrent();
  resetConversationTools();
  store.items = [];
  store.current = null;
}

export function fullStopConversation(): void {
  resetConversationTools();
}

// ---------------------------------------------------------------------------
// UI callback contract
// ---------------------------------------------------------------------------

export interface ConversationCallbacks {
  onUserMessage: (text: string) => void;
  onAssistantStream: (text: string, msgId?: string) => string;
  onAssistantFinalize: (msgId: string) => void;
  onAssistantDiscard: (msgId: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>, result: string) => void;
  onSystemMessage: (text: string) => void;
  onTypingStart: () => void;
  onTypingEnd: () => void;
  onError: (message: string) => void;
  onBusyChange: (isBusy: boolean) => void;
  onHistoryChange: () => void;
  onFetchCustomPrompt?: () => string;
  /**
   * Prompt the user to allow or deny a mutating tool call. The UI should
   * show a modal with the four standard scopes (once / timed / always /
   * deny). If omitted, the conversation layer defaults to allow — useful
   * for tests and backwards compat.
   */
  onRequestPermission?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<PermissionChoice>;
}

let callbacks: ConversationCallbacks | null = null;

function initConversationCallbacks(cb: ConversationCallbacks): void {
  callbacks = cb;
}

// ---------------------------------------------------------------------------
// ConversationStore — pure user/assistant text stream
// ---------------------------------------------------------------------------

const MAX_ITEMS = 200;

const store = {
  items: [] as ConversationItem[],
  current: null as ConversationRecord | null,
  isProcessing: false,
  activePresetId: 'gentle',
};

/** Abort controller for the currently in-flight sendMessage, if any. */
let currentAbort: AbortController | null = null;

/**
 * Cancel the in-flight turn. Safe to call even if nothing is running.
 * The sendMessage promise will resolve (not reject) — the cancellation
 * is reported as a short assistant note in the conversation.
 */
export function abortCurrent(): void {
  if (currentAbort) currentAbort.abort();
}

// -----------------------------------------------------------
// Conversation tools — timers for now, but could be more in the future
// -----------------------------------------------------------

export function initConversationTools(): void {
  initTimer((timer) => {
    if (!store.current || !callbacks) return;
    callbacks.onSystemMessage(`⏰ 定时器「${timer.label}」已到期。`);
    pendingTimers.push(timer);
    void drainPendingTimers();
  });
}

export function resetConversationTools(): void {
  cancelAllTimers();
  pendingTimers.length = 0;
}

const pendingTimers: ScheduledTimer[] = [];

async function drainPendingTimers(): Promise<void> {
  if (store.isProcessing || !store.current || !callbacks) return;

  const timer = pendingTimers.shift();
  if (!timer) return;

  const trigger: ConversationItem = {
    role: 'user',
    content:
      `[系统事件：定时器到期]\n` +
      `label: ${timer.label}\n` +
      `seconds: ${timer.seconds}\n` +
      '这是你之前设置的内部提醒。请根据当前设备状态和对话上下文继续后续流程；若需要操作设备，先调用工具，再正常回复用户。',
  };

  await runConversationTurn(
    tailWithPrevExchange([...store.items, trigger]),
    undefined,
    false /* don't store the timer-triggered system message in the conversation history */,
  );
}

// ---------------------------------------------------------------------------
// Error classification — turn raw transport errors into human messages
// ---------------------------------------------------------------------------

function classifyError(err: any): string {
  const raw = err?.message || String(err ?? 'unknown');
  if (/API key is required/i.test(raw)) {
    return '还没有配置 API Key，请在右上角 ⚙️ 设置中填写。';
  }
  const m = raw.match(/API error (\d{3})/);
  if (m) {
    const code = Number(m[1]);
    if (code === 401) return 'API Key 无效或已过期，请在设置中检查。';
    if (code === 403) return 'API 访问被拒绝（权限不足或地区限制），请检查账号或代理。';
    if (code === 429) return '请求过于频繁，已被限流，请稍后再试。';
    if (code >= 500) return 'AI 服务暂时不可用，请稍后重试。';
    if (code === 400) return '请求被服务端拒绝（参数或模型不支持），请检查设置。';
  }
  if (/Failed to fetch|NetworkError|TypeError: network|net::/i.test(raw)) {
    return '网络连接失败，请检查网络或代理后重试。';
  }
  return `出错了：${raw}`;
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

/** Strip non-text items (legacy data: function_call / function_call_output). */
function sanitize(items: readonly ConversationItem[]): ConversationItem[] {
  return items.filter((it: any) => it.role === 'user' || it.role === 'assistant');
}

/**
 * Pick the tail of the conversation to send to the LLM: the previous user
 * turn's full exchange (its user message plus every assistant item it
 * produced, including any "narrate then act" bubbles) followed by the
 * just-pushed current user message. On the very first turn there is no
 * prior exchange and we return just the current user message.
 */
function tailWithPrevExchange(items: readonly ConversationItem[]): ConversationItem[] {
  const lastIdx = items.length - 1;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if ((items[i] as any).role === 'user') {
      return items.slice(i);
    }
  }
  return items.slice(lastIdx);
}

function pruneItems(): void {
  if (store.items.length <= MAX_ITEMS) return;
  store.items.splice(0, store.items.length - MAX_ITEMS);
}

// ---------------------------------------------------------------------------
// Read-only accessors
// ---------------------------------------------------------------------------

export function getCurrentConversation(): ConversationRecord | null {
  return store.current;
}

export function getActivePresetId(): string {
  return store.activePresetId;
}

export function setActivePresetId(id: string): void {
  store.activePresetId = id;
}

export function loadConversation(conv: ConversationRecord): void {
  resetConversation();
  store.items = sanitize(conv.items);
  store.current = conv;
  store.activePresetId = conv.presetId || 'gentle';
}

export function startNewConversation(): void {
  resetConversation();
  // A fresh conversation should not inherit broad trust granted earlier:
  //   - the session-wide 'always' mode is revoked
  //   - every per-tool grant accumulated via the dialog is wiped
  // The 5-minute 'timed' settings mode keeps its own expiry and is left
  // untouched here.
  clearAlwaysMode();
  clearGrants();
}

// ---------------------------------------------------------------------------
// ChatSink — per-sendMessage UI adapter
// ---------------------------------------------------------------------------

class ChatSink implements AgentSink {
  private cb: ConversationCallbacks;
  private msgId: string | null = null;

  constructor(cb: ConversationCallbacks) {
    this.cb = cb;
  }

  /** Drop any in-flight bubble without finalizing (used on error). */
  discardPendingBubble(): void {
    if (this.msgId) {
      this.cb.onAssistantDiscard(this.msgId);
      this.msgId = null;
    }
  }

  // ---- AgentSink interface ----

  onTextDelta(accumulated: string): void {
    this.cb.onTypingEnd();
    this.msgId = this.cb.onAssistantStream(accumulated, this.msgId || undefined);
  }

  onTextComplete(): void {
    if (this.msgId) {
      this.cb.onAssistantFinalize(this.msgId);
      this.msgId = null;
    }
  }

  onTextDiscard(): void {
    this.discardPendingBubble();
    this.cb.onTypingStart();
  }

  onTextInline(text: string): void {
    if (!text) return;
    this.discardPendingBubble();
    const id = this.cb.onAssistantStream(text, undefined);
    this.cb.onAssistantFinalize(id);
  }

  onToolCall(name: string, args: Record<string, unknown>, result: string): void {
    // If there was streamed text before the tool call ("narrate then act"),
    // lock that bubble in before showing the tool notification.
    this.onTextComplete();
    this.cb.onToolCall(name, args, result);
    this.cb.onTypingStart();
  }
}

async function runConversationTurn(
  conversationItems: readonly ConversationItem[],
  customPrompt?: string,
  persistTurn: boolean = true,
): Promise<void> {
  if (store.isProcessing || !callbacks) return;
  store.isProcessing = true;

  const cb = callbacks;
  const sink = new ChatSink(cb);
  const abort = new AbortController();
  currentAbort = abort;

  cb.onBusyChange(true);
  cb.onTypingStart();

  // Permission gate:
  //   1. Only mutating tools are gated at all
  //   2. The user's chosen mode ('ask' | 'timed' | 'always') overrides everything
  //      — 'timed' and 'always' skip the dialog entirely
  //   3. In 'ask' mode we consult the per-tool grant cache first, only hit the
  //      UI on a miss, then record the user's choice
  const requestPermission = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<'allow' | 'deny'> => {
    if (!requiresPermission(name)) return 'allow';

    const mode = getEffectiveMode();
    if (mode === 'always' || mode === 'timed') return 'allow';

    // mode === 'ask'
    if (hasGrant(name)) return 'allow';
    if (!cb.onRequestPermission) return 'allow';
    const choice = await cb.onRequestPermission(name, args);
    return recordChoice(name, choice);
  };

  try {
    const finalItems = await runTurn({
      conversationItems,
      buildInstructions: (deviceStatus, isFirstIteration, turnToolCalls) =>
        buildInstructions({
          presetId: store.activePresetId,
          customPrompt: customPrompt == null ? cb.onFetchCustomPrompt?.() || '' : customPrompt,
          deviceStatus,
          isFirstIteration,
          turnToolCalls,
        }),
      getDeviceStatus: bt.getStatus,
      tools: getTools(),
      executor: executeTool,
      transportConfig: resolveProviderConfig(),
      sink,
      signal: abort.signal,
      requestPermission,
    });
    if (persistTurn) {
      store.items.push(...finalItems);
    }
  } catch (err: any) {
    // Drop any in-flight streamed bubble regardless of the failure mode.
    sink.discardPendingBubble();

    if (isAbortError(err) || abort.signal.aborted) {
      // User pressed stop. Render a short note, persist it so reloads show
      // a complete pair, but do NOT emit cb.onError (not a real error).
      const note = '⏹ 已手动中止';
      sink.onTextInline(note);
      if (persistTurn) {
        store.items.push({ role: 'assistant', content: note });
      }
    } else {
      console.error('[conversation] runTurn failed:', err);
      const friendly = classifyError(err);
      cb.onError(friendly);
      // Persist as assistant item so reloads show a complete user/assistant
      // pair instead of an orphan user message at the tail.
      if (persistTurn) {
        store.items.push({ role: 'assistant', content: friendly });
      }
    }
  } finally {
    currentAbort = null;
    cb.onTypingEnd();

    if (persistTurn && store.current) {
      store.current.items = [...store.items];
      store.current.title = history.generateTitle(store.items);
      store.current.updatedAt = Date.now();
      history.saveConversation(store.current);
      cb.onHistoryChange();
    }

    pruneItems();
    store.isProcessing = false;

    if (pendingTimers.length > 0 && store.current) {
      queueMicrotask(() => {
        void drainPendingTimers();
      });
      return;
    }

    cb.onBusyChange(false);
  }
}

// ---------------------------------------------------------------------------
// sendMessage — the only mutation entry point
// ---------------------------------------------------------------------------

export async function sendMessage(text: string): Promise<void> {
  if (store.isProcessing || !callbacks) return;
  callbacks.onUserMessage(text);
  store.items.push({ role: 'user', content: text });

  if (!store.current) {
    store.current = history.createConversation(store.activePresetId);
  }

  // Keep only the previous exchange (prior user + its reply) plus the
  // current user message. store.items still holds the full history for
  // UI / localStorage; we only trim what goes up to the LLM.
  await runConversationTurn(
    tailWithPrevExchange(store.items),
    callbacks.onFetchCustomPrompt?.() || '',
  );
}
