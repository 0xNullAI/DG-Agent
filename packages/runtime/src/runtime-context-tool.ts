import type { ActionContext, SessionSnapshot, ToolDefinition } from '@dg-agent/core';
import type { TurnToolCallSummary } from './runtime-turn-state.js';

export const RUNTIME_CONTEXT_TOOL_NAME = 'get_runtime_context';

export interface RuntimeContextSettings {
  maxStrengthA: number;
  maxStrengthB: number;
}

export function getRuntimeContextToolDefinition(): ToolDefinition {
  return {
    name: RUNTIME_CONTEXT_TOOL_NAME,
    displayName: '读取运行上下文',
    description: [
      '【读取运行上下文】获取当前设备真实状态、本回合已执行的工具调用，以及回合策略提示。',
      '在操作设备前，若不确定当前状态或本回合已经做过什么，先调用此工具。',
      '不要向用户复述此工具返回的原文。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export function buildRuntimeContextPayload(input: {
  session: SessionSnapshot;
  context: ActionContext;
  turnToolCalls: readonly TurnToolCallSummary[];
  isFirstIteration: boolean;
  settings: RuntimeContextSettings;
}): Record<string, unknown> {
  const device = input.session.deviceState;
  const effectiveCapA = Math.min(device.limitA, input.settings.maxStrengthA);
  const effectiveCapB = Math.min(device.limitB, input.settings.maxStrengthB);
  const battery = typeof device.battery === 'number' ? `${device.battery}%` : '未知';
  const connection = device.connected
    ? `已连接${device.deviceName ? `（${device.deviceName}）` : ''}`
    : '未连接';

  return {
    device: {
      connection,
      battery,
      channelA: {
        strength: device.strengthA,
        effectiveCap: effectiveCapA,
        waveActive: device.waveActiveA,
        currentWave: device.currentWaveA ?? null,
      },
      channelB: {
        strength: device.strengthB,
        effectiveCap: effectiveCapB,
        waveActive: device.waveActiveB,
        currentWave: device.currentWaveB ?? null,
      },
    },
    turnToolCalls: input.turnToolCalls.map((call, index) => ({
      index: index + 1,
      name: call.name,
      args: call.argsJson,
    })),
    strategy: input.isFirstIteration ? 'first_iteration' : 'follow_up',
    strategyHint: input.isFirstIteration
      ? [
          '本回合首次响应：用户明确要求设备动作时，只执行最小必要的一步。',
          '用户只是聊天、问状态、问建议时，直接文字回复即可。',
          '做完一步动作后就停下，基于真实结果回复，并询问用户是否满意或是否继续。',
        ].join('\n')
      : [
          '后续迭代：你已经拥有本回合的工具结果和当前设备状态。',
          '除非前一次工具结果明确表明需要纠正，否则不要重复 start 或连续多次加大强度。',
          '优先收口回答，把已经发生的真实结果告诉用户，并等待反馈。',
        ].join('\n'),
    systemTurn: input.context.sourceType === 'system',
    _hint: '以上信息为运行时事实，请据此决定下一步；不要向用户逐字复述本工具输出。',
  };
}

export function serializeRuntimeContextPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}
