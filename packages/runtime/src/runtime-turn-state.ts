import type { LlmConversationItem } from '@dg-agent/contracts';
import type { SessionSnapshot } from '@dg-agent/core';
import type { ToolCallConfig } from './tool-call-config.js';

export interface TurnState {
  workingItems: LlmConversationItem[];
  totalToolCalls: number;
  adjustStrengthCalls: number;
  burstCalls: number;
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
    burstCalls: 0,
    narrations: [],
  };
}

export function buildConversationItems(session: SessionSnapshot, turnState: TurnState): LlmConversationItem[] {
  return [
    ...selectModelContextMessages(session.messages).map<LlmConversationItem>((message) => ({
      kind: 'message',
      role: message.role,
      content: message.content,
    })),
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

export function consumeTurnQuota(toolName: string, turnState: TurnState, config: ToolCallConfig): string | null {
  if (turnState.totalToolCalls >= config.maxToolCallsPerTurn) {
    return `Tool calls for this turn are capped at ${config.maxToolCallsPerTurn}; reply to the user instead of issuing more tool calls.`;
  }

  if (toolName === 'adjust_strength' && turnState.adjustStrengthCalls >= config.maxAdjustStrengthCallsPerTurn) {
    return `adjust_strength is capped at ${config.maxAdjustStrengthCallsPerTurn} call(s) per turn.`;
  }

  if (toolName === 'burst' && turnState.burstCalls >= config.maxBurstCallsPerTurn) {
    return `burst is capped at ${config.maxBurstCallsPerTurn} call(s) per turn.`;
  }

  turnState.totalToolCalls += 1;
  if (toolName === 'adjust_strength') {
    turnState.adjustStrengthCalls += 1;
  }
  if (toolName === 'burst') {
    turnState.burstCalls += 1;
  }

  return null;
}

function selectModelContextMessages(messages: SessionSnapshot['messages']): SessionSnapshot['messages'] {
  if (messages.length <= 1) return messages;

  const currentUserIndex = messages.length - 1;
  for (let index = currentUserIndex - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') {
      return messages.slice(index).filter((message) => !shouldSkipModelContextMessage(message));
    }
  }

  return messages.slice(currentUserIndex).filter((message) => !shouldSkipModelContextMessage(message));
}

function shouldSkipModelContextMessage(message: SessionSnapshot['messages'][number]): boolean {
  if (message.role === 'user') return false;

  const content = message.content.trim();
  if (!content) return true;

  if (content === '✋ 已手动中止。') return true;
  if (content.startsWith('出错了：')) return true;

  return [
    '网络连接失败，请检查网络、代理或服务状态后重试。',
    '还没有配置 API Key，请先在设置里填写。',
    'API Key 无效或已过期，请检查设置。',
    '当前接口访问被拒绝，请检查账号权限、地区限制或代理。',
    '请求过于频繁，已被限流，请稍后再试。',
    '请求被服务端拒绝，请检查模型、参数或接口兼容性。',
    'AI 服务暂时不可用，请稍后重试。',
    '当前模型服务还没有配置完成，请先在设置里选择服务提供方并补全凭证。',
  ].includes(content);
}
