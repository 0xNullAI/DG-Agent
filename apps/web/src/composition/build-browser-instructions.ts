import type { ActionContext, SessionSnapshot } from '@dg-agent/core';
import { getAnyPromptPresetById, type SavedPromptPreset } from '@dg-agent/prompts-basic';
import type { TurnToolCallSummary } from '@dg-agent/runtime';

export interface BrowserInstructionSettings {
  promptPresetId: string;
  savedPromptPresets: SavedPromptPreset[];
  maxStrengthA: number;
  maxStrengthB: number;
  maxAdjustStrengthCallsPerTurn: number;
  maxAdjustStrengthStep: number;
}

const INSTRUCTION_SEPARATOR = '\n\n──────────────────────────\n';

export function createBuildBrowserInstructions(settings: BrowserInstructionSettings) {
  return (input: {
    session: SessionSnapshot;
    context: ActionContext;
    isFirstIteration: boolean;
    turnToolCalls: readonly TurnToolCallSummary[];
  }): string => {
    const selectedPreset = getAnyPromptPresetById(
      settings.promptPresetId,
      settings.savedPromptPresets,
    );
    const blocks = [
      selectedPreset?.prompt ?? '你是一个友好的助手。',
      buildDeviceBlock(),
      buildDeviceStatusBlock(input.session, settings),
      buildTurnToolUsageBlock(input.turnToolCalls),
      buildBehaviorRulesBlock(settings),
      input.context.sourceType === 'system' ? buildSystemTurnBlock() : '',
      input.isFirstIteration ? buildFirstIterationStrategyBlock() : '',
      !input.isFirstIteration ? buildFollowUpIterationBlock() : '',
    ];

    return blocks.filter(Boolean).join(INSTRUCTION_SEPARATOR);
  };
}

function buildDeviceBlock(): string {
  return [
    '[设备]',
    '你控制的是一台已连接的 DG-Lab 郊狼（Coyote）设备，支持 A / B 双通道独立控制。',
    '任何真实设备操作都必须通过工具完成；只靠文字描述不会改变设备状态。',
  ].join('\n');
}

function buildBehaviorRulesBlock(
  settings: Pick<
    BrowserInstructionSettings,
    'maxAdjustStrengthCallsPerTurn' | 'maxAdjustStrengthStep'
  >,
): string {
  return [
    '[行为规则]',
    '1. 需要操作设备时，先调用对应工具，再根据工具结果回复用户。',
    '2. 回复设备状态时，只引用 [当前设备状态] 和本回合工具返回的事实，不要臆测。',
    `3. adjust_strength 本回合最多调用 ${settings.maxAdjustStrengthCallsPerTurn} 次；单步变化尽量小，优先 +2、+3、-2、-3 这类细微调整。`,
    '4. 一次回合里只推进一步主要动作。完成一次 start / adjust_strength / change_wave / burst 后，优先停下来告诉用户实际结果并询问感受，不要自己连续叠加强度。',
    '5. 工具报错、被拒绝、权限未通过时，要如实告知用户，不要假装成功，也不要立刻重复同一个工具调用。',
    '6. timer 只是安排未来提醒，不代表用户已经反馈；到期后的系统回合只能简短跟进，不能自动继续操作设备。',
  ].join('\n');
}

function buildSystemTurnBlock(): string {
  return [
    '[系统触发说明]',
    '这一轮来自内部提醒，不是用户的新消息，也不代表用户已经同意继续。',
    '本轮禁止调用任何工具，禁止改动设备状态，禁止再次设置 timer。',
    '你只能做简短跟进，例如询问现在感觉如何、是否继续，或者说明你在等待反馈。',
  ].join('\n');
}

function buildFirstIterationStrategyBlock(): string {
  return [
    '[本回合策略 - 仅本回合首次响应生效]',
    '1. 如果用户明确要求某个设备动作，只执行最小必要的一步，不要自己连做 start + 多次 adjust_strength。',
    '2. 如果用户只是聊天、问状态、问建议，直接文字回复即可；当前设备状态已经在上方提供，不要为了“确认一下”额外调用工具。',
    '3. 做完一步动作后就停下，基于真实结果回复，并询问用户是否满意或是否继续。',
  ].join('\n');
}

function buildFollowUpIterationBlock(): string {
  return [
    '[后续迭代提醒]',
    '你已经拥有本回合的工具结果和当前设备状态。',
    '除非前一次工具结果明确表明需要纠正，否则不要重新开始计划，也不要重复 start 或连续多次加大强度。',
    '优先收口回答，把已经发生的真实结果告诉用户，并等待反馈。',
  ].join('\n');
}

function buildDeviceStatusBlock(
  session: SessionSnapshot,
  settings: Pick<BrowserInstructionSettings, 'maxStrengthA' | 'maxStrengthB'>,
): string {
  const device = session.deviceState;
  const effectiveCapA = Math.min(device.limitA, settings.maxStrengthA);
  const effectiveCapB = Math.min(device.limitB, settings.maxStrengthB);
  const battery = typeof device.battery === 'number' ? `${device.battery}%` : '未知';
  const connection = device.connected
    ? `已连接${device.deviceName ? `（${device.deviceName}）` : ''}`
    : '未连接';

  return [
    '[当前设备状态]',
    `连接：${connection}`,
    `电量：${battery}`,
    `A 通道：强度 ${device.strengthA} / 上限 ${effectiveCapA}，波形${device.waveActiveA ? '运行中' : '已停止'}，当前波形 ${device.currentWaveA ?? '-'}`,
    `B 通道：强度 ${device.strengthB} / 上限 ${effectiveCapB}，波形${device.waveActiveB ? '运行中' : '已停止'}，当前波形 ${device.currentWaveB ?? '-'}`,
  ].join('\n');
}

function buildTurnToolUsageBlock(calls: readonly TurnToolCallSummary[]): string {
  if (calls.length === 0) {
    return [
      '[本回合已调用工具]',
      '(无)',
      '这表示你本回合还没有真正执行过任何设备动作；不要提前声称“已经帮你调整好了”。',
    ].join('\n');
  }

  const lines = calls.map((call, index) => `${index + 1}. ${call.name}(${call.argsJson})`);
  return [
    '[本回合已调用工具]',
    ...lines,
    '生成回复前请对照这份清单：你声称已经完成的动作，必须能在上面找到对应调用。',
    '如果上面已经做过一次主要动作，下一步通常是解释结果并询问反馈，而不是继续叠加动作。',
  ].join('\n');
}
