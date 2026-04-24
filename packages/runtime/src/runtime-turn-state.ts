import type { LlmConversationItem } from '@dg-agent/contracts';
import type { ModelContextStrategy, SessionSnapshot, ToolCall } from '@dg-agent/core';
import { REPLY_ABORTED_NOTE, TOOL_LOOP_EXHAUSTED_MESSAGE } from './runtime-errors.js';
import type { ToolCallConfig } from './tool-call-config.js';

export interface TurnState {
  workingItems: LlmConversationItem[];
  totalToolCalls: number;
  adjustStrengthCalls: number;
  burstCallsByChannel: { A: number; B: number };
  narrations: string[];
}

export interface TurnToolCallSummary {
  name: string;
  argsJson: string;
}

export function createTurnState(): TurnState {
  return {
    workingItems: [],
    totalToolCalls: 0,
    adjustStrengthCalls: 0,
    burstCallsByChannel: { A: 0, B: 0 },
    narrations: [],
  };
}

export function buildConversationItems(
  session: SessionSnapshot,
  turnState: TurnState,
  currentInput?: LlmConversationItem | null,
  modelContextStrategy: ModelContextStrategy = 'last-user-turn',
): LlmConversationItem[] {
  const persistedMessages = selectModelContextMessages(
    session.messages,
    modelContextStrategy,
  ).filter((message) => shouldIncludePersistedMessage(message, turnState));

  return [
    ...persistedMessages.map<LlmConversationItem>((message) => ({
      kind: 'message',
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      toolCalls: message.toolCalls,
    })),
    ...(currentInput ? [currentInput] : []),
    ...turnState.workingItems,
  ];
}

export function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

export function collectTurnToolCalls(turnState: TurnState): TurnToolCallSummary[] {
  return turnState.workingItems.flatMap((item) => {
    if (item.kind === 'function_call') {
      return [
        {
          name: item.name,
          argsJson: item.argumentsJson,
        },
      ];
    }

    if (item.kind === 'message' && item.role === 'assistant' && item.toolCalls?.length) {
      return item.toolCalls.map((toolCall) => ({
        name: toolCall.name,
        argsJson: safeStringify(toolCall.args),
      }));
    }

    return [];
  });
}

export function consumeTurnQuota(
  toolName: string,
  turnState: TurnState,
  config: ToolCallConfig,
  toolArgs?: Record<string, unknown>,
): string | null {
  if (turnState.totalToolCalls >= config.maxToolCallsPerTurn) {
    return `本轮工具调用次数上限为 ${config.maxToolCallsPerTurn}，请直接回复用户，不要继续调用工具`;
  }

  if (
    toolName === 'adjust_strength' &&
    turnState.adjustStrengthCalls >= config.maxAdjustStrengthCallsPerTurn
  ) {
    return `本轮 adjust_strength 最多只能调用 ${config.maxAdjustStrengthCallsPerTurn} 次`;
  }

  if (toolName === 'burst') {
    const channel = normalizeBurstChannel(toolArgs);
    if (turnState.burstCallsByChannel[channel] >= config.maxBurstCallsPerTurn) {
      return `本轮 burst 通道 ${channel} 最多只能调用 ${config.maxBurstCallsPerTurn} 次`;
    }
  }

  turnState.totalToolCalls += 1;
  if (toolName === 'adjust_strength') {
    turnState.adjustStrengthCalls += 1;
  }
  if (toolName === 'burst') {
    const channel = normalizeBurstChannel(toolArgs);
    turnState.burstCallsByChannel[channel] += 1;
  }

  return null;
}

function selectModelContextMessages(
  messages: SessionSnapshot['messages'],
  strategy: ModelContextStrategy,
): SessionSnapshot['messages'] {
  const filteredMessages = messages.filter((message) => !shouldSkipModelContextMessage(message));
  if (filteredMessages.length <= 1 || strategy === 'full-history') {
    return filteredMessages;
  }

  const userMessageIndices = filteredMessages.flatMap((message, index) =>
    message.role === 'user' ? [index] : [],
  );
  if (userMessageIndices.length === 0) {
    return filteredMessages;
  }

  if (strategy === 'last-five-user-turns') {
    return filteredMessages.slice(
      userMessageIndices[Math.max(userMessageIndices.length - 5, 0)] ?? 0,
    );
  }

  if (userMessageIndices.length === 1) {
    return filteredMessages.slice(userMessageIndices[0] ?? 0);
  }

  return filteredMessages.slice(userMessageIndices[userMessageIndices.length - 2] ?? 0);
}

function normalizeBurstChannel(args?: Record<string, unknown>): 'A' | 'B' {
  const raw = args?.channel;
  if (typeof raw === 'string' && (raw === 'B' || raw.toUpperCase() === 'B')) return 'B';
  return 'A';
}

function shouldSkipModelContextMessage(message: SessionSnapshot['messages'][number]): boolean {
  if (message.role === 'user') return false;

  const content = message.content.trim();
  if (!content) return true;

  if (message.role === 'system') {
    return true;
  }

  if (content === REPLY_ABORTED_NOTE) return true;
  if (content === TOOL_LOOP_EXHAUSTED_MESSAGE) return true;
  if (content.startsWith('出错了：')) return true;

  return [
    '网络连接失败，请检查网络、代理或服务状态后重试',
    '还没有配置 API Key，请先在设置里填写',
    'API Key 无效或已过期，请检查设置',
    '当前接口访问被拒绝，请检查账户权限、地区限制或代理',
    '请求过于频繁，已被限流，请稍后再试',
    '请求被服务端拒绝，请检查模型、参数或接口兼容性',
    'AI 服务暂时不可用，请稍后重试',
    '当前模型服务还没有配置完成，请先在设置里选择服务提供方并补全凭证',
  ].includes(content);
}

function shouldIncludePersistedMessage(
  message: SessionSnapshot['messages'][number],
  turnState: TurnState,
): boolean {
  if (message.role !== 'assistant' || !message.toolCalls?.length) {
    return true;
  }

  return !turnState.workingItems.some(
    (item) =>
      item.kind === 'message' &&
      item.role === 'assistant' &&
      item.content.trim() === message.content.trim() &&
      (item.reasoningContent?.trim() ?? '') === (message.reasoningContent?.trim() ?? '') &&
      sameToolCallSequence(item.toolCalls, message.toolCalls),
  );
}

function sameToolCallSequence(left?: ToolCall[], right?: ToolCall[]): boolean {
  const leftCalls = Array.isArray(left) ? left : [];
  const rightCalls = Array.isArray(right) ? right : [];

  if (leftCalls.length !== rightCalls.length) {
    return false;
  }

  return leftCalls.every((toolCall, index) => {
    const other = rightCalls[index];
    return (
      other &&
      toolCall.id === other.id &&
      toolCall.name === other.name &&
      safeStringify(toolCall.args) === safeStringify(other.args)
    );
  });
}
