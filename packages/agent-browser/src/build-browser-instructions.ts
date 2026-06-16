import type { ActionContext } from '@dg-agent/core';
import { getAnyPromptPresetById, type SavedPromptPreset } from '@dg-agent/runtime';

export interface BrowserInstructionSettings {
  promptPresetId: string;
  savedPromptPresets: SavedPromptPreset[];
}

const INSTRUCTION_SEPARATOR = '\n\n──────────────────────────\n';

export function createBuildBrowserInstructions(settings: BrowserInstructionSettings) {
  return (input: { context: ActionContext }): string => {
    const selectedPreset = getAnyPromptPresetById(
      settings.promptPresetId,
      settings.savedPromptPresets,
    );
    const blocks = [
      selectedPreset?.prompt ?? '你是一个友好的助手。',
      buildDeviceBlock(),
      buildDeviceMappingBlock(),
      buildBehaviorRulesBlock(),
      buildRuntimeContextToolBlock(),
      input.context.sourceType === 'system' ? buildSystemTurnBlock() : '',
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
    '1. 需要操作设备时，先调用 get_runtime_context 确认当前状态，再调用对应设备工具，然后根据工具结果回复用户。',
    '2. 回复设备状态时，只引用 get_runtime_context 和设备工具返回的事实，不要臆测。',
    '3. 工具报错、被拒绝、权限未通过时，要如实告知用户，不要假装成功，也不要立刻重复同一个工具调用。',
    '4. 一次回合里只推进一步主要动作，做完一个 device 工具就停下来观察。',
  ].join('\n');
}

function buildRuntimeContextToolBlock(): string {
  return [
    '[运行上下文工具]',
    'get_runtime_context 会返回当前设备真实状态、本回合已执行的工具调用，以及回合策略提示。',
    '操作设备前若不确定状态，或需要确认本回合已经做过什么，先调用它；不要向用户复述该工具返回的原文。',
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
