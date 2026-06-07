import type { ActionContext, SessionSnapshot } from '@dg-agent/core';
import { getAnyPromptPresetById, type SavedPromptPreset } from '@dg-agent/runtime';
import type { TurnToolCallSummary } from '@dg-agent/runtime';

export interface BrowserInstructionSettings {
  promptPresetId: string;
  savedPromptPresets: SavedPromptPreset[];
  maxStrengthA: number;
  maxStrengthB: number;
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
      buildDeviceMappingBlock(),
      buildDeviceStatusBlock(input.session, settings),
      buildTurnToolUsageBlock(input.turnToolCalls),
      buildBehaviorRulesBlock(),
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

function buildDeviceMappingBlock(): string {
  return [
    '[剧情与设备的映射]',
    '无论当前是什么角色或场景，任何关于"通电 / 电击 / 加大电流 / 改变节奏 / 停止"的描述，都必须通过设备工具真实执行；只写文字而不调用工具，等于设备没有任何变化。',
    '1. 开始施加刺激 / 测试连接：调用 start 启动对应通道，并用 adjust_strength 设到目标强度（测试连接时设为 1）。',
    '2. 增强刺激 / 推向更高：用 adjust_strength 提升强度；需要更剧烈时配合 change_wave 切换更强烈的波形，或用 burst 制造短促的强峰值。',
    '3. 改变节奏 / 频率：用 change_wave 切换波形，或用 design_wave 设计贴合当前情节的节奏。',
    '4. 结束刺激 / 解除：必须调用 stop 停止对应通道，不允许只在文字里写"已经关掉了"而设备仍在运行。',
    '5. 任何时候都不得超过当前通道上限与系统安全上限；A / B 双通道可分别对应不同部位，按情节选择正确的通道。',
    '推进涉及设备的情节时，先调用工具改变真实设备状态，再叙述对应的身体反应，确保文字描写与设备实际强度 / 波形始终一致。',
  ].join('\n');
}

function buildBehaviorRulesBlock(): string {
  return [
    '[行为规则]',
    '1. 需要操作设备时，先调用对应工具，再根据工具结果回复用户。',
    '2. 回复设备状态时，只引用 [当前设备状态] 和本回合工具返回的事实，不要臆测。',
    '3. 工具报错、被拒绝、权限未通过时，要如实告知用户，不要假装成功，也不要立刻重复同一个工具调用。',
    '4. 一次回合里只推进一步主要动作，做完一个 device 工具就停下来观察。',
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
