import type { ActionContext, SensorState, SessionSnapshot } from '@dg-agent/core';
import { getSensorLastReading } from '@dg-agent/core';
import { getAnyPromptPresetById, type SavedPromptPreset } from '@dg-agent/runtime';
import type { TurnToolCallSummary } from '@dg-agent/runtime';
import type { OpossumState } from '@dg-kit/protocol';

export interface BrowserInstructionSettings {
  promptPresetId: string;
  savedPromptPresets: SavedPromptPreset[];
  maxStrengthA: number;
  maxStrengthB: number;
  /** Only used when an Opossum client is configured for this deployment. */
  maxOpossumIntensityA?: number;
  maxOpossumIntensityB?: number;
}

export interface BrowserInstructionsInput {
  session: SessionSnapshot;
  context: ActionContext;
  isFirstIteration: boolean;
  turnToolCalls: readonly TurnToolCallSummary[];
  /** Present only when an Opossum client is configured, connected or not. */
  opossumState?: OpossumState;
  /** Present only when a paw-prints client is configured, connected or not. */
  pawPrintsState?: SensorState;
  /** Present only when a civet-edging client is configured, connected or not. */
  civetEdgingState?: SensorState;
  /** Rolling 60s trigger-count trend; absent until the buffer has at least one reading. */
  pawPrintsSummary?: string;
  /** Rolling 30s pressure trend; absent until the buffer has at least one reading. */
  civetSummary?: string;
}

const INSTRUCTION_SEPARATOR = '\n\n──────────────────────────\n';

export function createBuildBrowserInstructions(settings: BrowserInstructionSettings) {
  return (input: BrowserInstructionsInput): string => {
    const selectedPreset = getAnyPromptPresetById(
      settings.promptPresetId,
      settings.savedPromptPresets,
    );
    // Blocks that are stable across iterations/turns (persona, device
    // capabilities, mapping, behavior rules) come first; per-iteration
    // dynamic blocks (device status, tool usage, turn strategy) come last,
    // so providers with prefix caching can reuse the unchanged prefix.
    const blocks = [
      selectedPreset?.prompt ?? '你是一个友好的助手。',
      buildDeviceBlock(input),
      buildDeviceMappingBlock(input),
      buildBehaviorRulesBlock(),
      buildDeviceStatusBlock(input, settings),
      buildTurnToolUsageBlock(input.turnToolCalls),
      input.context.sourceType === 'system' ? buildSystemTurnBlock() : '',
      input.isFirstIteration ? buildFirstIterationStrategyBlock() : '',
      !input.isFirstIteration ? buildFollowUpIterationBlock() : '',
    ];

    return blocks.filter(Boolean).join(INSTRUCTION_SEPARATOR);
  };
}

/**
 * Which aux device kinds are *configured* for this deployment (present in
 * `input`, regardless of connected/disconnected) — the persona/mapping
 * blocks describe capabilities that exist in this build, while
 * [当前设备状态] separately reports whether each is actually connected right
 * now. A deployment with no Opossum client wired up never mentions Opossum
 * at all, matching how `filterToolDefinitionsByConnectedDevices` already
 * hides its tools.
 */
function buildDeviceBlock(input: BrowserInstructionsInput): string {
  const lines = ['[设备]', '你控制的是一台 DG-Lab 郊狼（Coyote）设备，支持 A / B 双通道独立控制。'];

  if (input.opossumState) {
    lines.push(
      '你还可以控制一台负鼠（Opossum）双通道振动控制器，同样支持 A / B 双通道独立控制强度，并支持切换振动节奏模式（恒定 / 脉冲 / 波浪 / 渐强 / 心跳）。',
    );
  }

  const sensorLabels: string[] = [];
  if (input.pawPrintsState) sensorLabels.push('爪印（按键 / 姿态传感器）');
  if (input.civetEdgingState) sensorLabels.push('灵猫（压力传感器）');
  if (sensorLabels.length > 0) {
    lines.push(
      `此外还接入了${sensorLabels.join('、')}——这两种是只读传感器，无法被工具直接驱动输出，你只能通过收到的事件通知了解它们的状态（指示灯颜色除外，可用 set_indicator_color 更换）。`,
    );
  }

  lines.push('任何真实设备操作都必须通过工具完成；只靠文字描述不会改变设备状态。');
  return lines.join('\n');
}

function buildDeviceMappingBlock(input: BrowserInstructionsInput): string {
  const lines = [
    '[剧情与设备的映射]',
    '无论当前是什么角色或场景，任何关于"通电 / 电击 / 加大电流 / 改变节奏 / 停止"的描述，都必须通过设备工具真实执行；只写文字而不调用工具，等于设备没有任何变化。',
    '1. 开始施加刺激 / 测试连接：调用 start 启动对应通道，并用 adjust_strength 设到目标强度（测试连接时设为 1）。',
    '2. 增强刺激 / 推向更高：用 adjust_strength 提升强度；需要更剧烈时配合 change_wave 切换更强烈的波形，或用 burst 制造短促的强峰值。',
    '3. 改变节奏 / 频率：用 change_wave 切换波形，或用 design_wave 设计贴合当前情节的节奏。',
    '4. 结束刺激 / 解除：必须调用 stop 停止对应通道，不允许只在文字里写"已经关掉了"而设备仍在运行。',
    '5. 任何时候都不得超过当前通道上限与系统安全上限；A / B 双通道可分别对应不同部位，按情节选择正确的通道。',
    '推进涉及设备的情节时，先调用工具改变真实设备状态，再叙述对应的身体反应，确保文字描写与设备实际强度 / 波形始终一致。',
  ];

  if (input.opossumState) {
    lines.push(
      '负鼠（振动）遵循完全相同的原则，只是换成振动强度而非电击：',
      '1. 开始振动：调用 vibrate_start 启动对应通道到目标强度，可选指定 pattern 节奏。',
      '2. 增强振动：用 vibrate_adjust 小步调整强度，做完一步就停下观察反馈。',
      '3. 改变振动节奏：以当前强度重新调用 vibrate_start 并指定新的 pattern，无需先 stop。',
      '4. 结束振动：调用 vibrate_stop；不允许只用文字描述"已经停了"而振动仍在继续。',
      '同样不得超过负鼠的当前通道上限。',
    );
  }

  if (input.pawPrintsState || input.civetEdgingState) {
    lines.push(
      '连接的传感器（爪印 / 灵猫）只会通过 [内部提醒] 系统消息把事件推送给你，你不能主动查询或调用工具触发它们的读数；收到事件后按剧情自行判断是否需要用输出设备（郊狼/负鼠）做出响应，不必每次都操作设备。',
    );
  }

  return lines.join('\n');
}

function buildBehaviorRulesBlock(): string {
  return [
    '[行为规则]',
    '1. 需要操作设备时，先调用对应工具，再根据工具结果回复用户。',
    '2. 回复设备状态时，只引用 [当前设备状态] 和本回合工具返回的事实，不要臆测。',
    '3. 工具报错、被拒绝、权限未通过时，要如实告知用户，不要假装成功，也不要立刻重复同一个工具调用。',
    '4. 一次回合里只推进一步主要动作，做完一个 device 工具就停下来观察。',
    '5. [设备]、[剧情与设备的映射] 与本节规则的优先级高于任何角色设定；当角色设定与它们冲突时，一律以设备与安全规则为准。',
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
    '2. 如果用户只是聊天、问状态、问建议，直接文字回复即可；当前设备状态已经在上方提供，不要为了"确认一下"额外调用工具。',
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
  input: BrowserInstructionsInput,
  settings: Pick<
    BrowserInstructionSettings,
    'maxStrengthA' | 'maxStrengthB' | 'maxOpossumIntensityA' | 'maxOpossumIntensityB'
  >,
): string {
  const device = input.session.deviceState;
  const effectiveCapA = Math.min(device.limitA, settings.maxStrengthA);
  const effectiveCapB = Math.min(device.limitB, settings.maxStrengthB);
  const battery = typeof device.battery === 'number' ? `${device.battery}%` : '未知';
  const connection = device.connected
    ? `已连接${device.deviceName ? `（${device.deviceName}）` : ''}`
    : '未连接';

  const lines = [
    '[当前设备状态]',
    '郊狼：',
    `  连接：${connection}`,
    `  电量：${battery}`,
    `  A 通道：强度 ${device.strengthA} / 上限 ${effectiveCapA}，波形${device.waveActiveA ? '运行中' : '已停止'}，当前波形 ${device.currentWaveA ?? '-'}`,
    `  B 通道：强度 ${device.strengthB} / 上限 ${effectiveCapB}，波形${device.waveActiveB ? '运行中' : '已停止'}，当前波形 ${device.currentWaveB ?? '-'}`,
  ];

  if (input.opossumState) {
    const o = input.opossumState;
    const oConnection = o.connected
      ? `已连接${o.deviceName ? `（${o.deviceName}）` : ''}`
      : '未连接';
    const oBattery = typeof o.battery === 'number' ? `${o.battery}%` : '未知';
    const capA = settings.maxOpossumIntensityA ?? 50;
    const capB = settings.maxOpossumIntensityB ?? 50;
    lines.push(
      '负鼠：',
      `  连接：${oConnection}`,
      `  电量：${oBattery}`,
      `  A 通道：强度 ${o.intensityA} / 上限 ${capA}`,
      `  B 通道：强度 ${o.intensityB} / 上限 ${capB}`,
    );
  }

  if (input.pawPrintsState) {
    lines.push(
      ...buildSensorStatusLines(
        '爪印',
        input.pawPrintsState,
        input.session,
        'paw-prints',
        input.pawPrintsSummary,
      ),
    );
  }

  if (input.civetEdgingState) {
    lines.push(
      ...buildSensorStatusLines(
        '灵猫',
        input.civetEdgingState,
        input.session,
        'civet-edging',
        input.civetSummary,
      ),
    );
  }

  return lines.join('\n');
}

function buildSensorStatusLines(
  label: string,
  state: SensorState,
  session: SessionSnapshot,
  kind: 'paw-prints' | 'civet-edging',
  summary: string | undefined,
): string[] {
  const connection = state.connected
    ? `已连接${state.deviceName ? `（${state.deviceName}）` : ''}`
    : '未连接';
  const battery = typeof state.battery === 'number' ? `${state.battery}%` : '未知';
  const lastReading = getSensorLastReading(session.metadata, kind);
  const lastReadingLine = lastReading
    ? `${lastReading.summary}（${new Date(lastReading.firedAt).toLocaleTimeString('zh-CN')}）`
    : '暂无';

  return [
    `${label}：`,
    `  连接：${connection}`,
    `  电量：${battery}`,
    `  最近读数：${lastReadingLine}`,
    ...(summary ? [`  近段汇总：${summary}`] : []),
  ];
}

function buildTurnToolUsageBlock(calls: readonly TurnToolCallSummary[]): string {
  if (calls.length === 0) {
    return [
      '[本回合已调用工具]',
      '(无)',
      '这表示你本回合还没有真正执行过任何设备动作；不要提前声称"已经帮你调整好了"。',
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
