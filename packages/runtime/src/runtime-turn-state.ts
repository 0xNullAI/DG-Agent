import type { LlmConversationItem } from '@dg-agent/contracts';
import type { ModelContextStrategy, SessionSnapshot } from '@dg-agent/core';
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
  return [
    ...selectModelContextMessages(session.messages, modelContextStrategy).map<LlmConversationItem>(
      (message) => ({
        kind: 'message',
        role: message.role,
        content: message.content,
      }),
    ),
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
  return turnState.workingItems.flatMap((item) =>
    item.kind === 'function_call'
      ? [
          {
            name: item.name,
            argsJson: item.argumentsJson,
          },
        ]
      : [],
  );
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

  if (content === '✋ 已手动中止') return true;
  if (content.startsWith('出错了：')) return true;

  return [
    '网络连接失败，请检查网络、代理或服务状态后重试',
    '还没有配置 API Key，请先在设置里填写',
    'API Key 无效或已过期，请检查设置',
    '当前接口访问被拒绝，请检查账号权限、地区限制或代理',
    '请求过于频繁，已被限流，请稍后再试',
    '请求被服务端拒绝，请检查模型、参数或接口兼容性',
    'AI 服务暂时不可用，请稍后重试',
    '当前模型服务还没有配置完成，请先在设置里选择服务提供方并补全凭证',
  ].includes(content);
}
