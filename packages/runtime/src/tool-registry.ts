import type { WaveformLibraryPort } from '@dg-agent/contracts';
import type { DeviceCommand, ToolCall, ToolDefinition, ToolExecutionPlan } from '@dg-agent/core';
import { z } from 'zod';

export interface ToolHandler {
  name: string;
  displayName?: string;
  definition: ToolDefinition | (() => Promise<ToolDefinition> | ToolDefinition);
  summarizeCommand?: (command: DeviceCommand) => string;
  toExecutionPlan(args: Record<string, unknown>): Promise<ToolExecutionPlan> | ToolExecutionPlan;
}

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.handlers.set(handler.name, handler);
  }

  async resolve(toolCall: ToolCall): Promise<ToolExecutionPlan> {
    const handler = this.handlers.get(toolCall.name);
    if (!handler) {
      throw new Error(`Unknown tool: ${toolCall.name}`);
    }

    return handler.toExecutionPlan(toolCall.args);
  }

  async listDefinitions(): Promise<ToolDefinition[]> {
    return Promise.all(
      [...this.handlers.values()].map(async (handler) => {
        const definition = typeof handler.definition === 'function' ? await handler.definition() : handler.definition;
        return handler.displayName && !definition.displayName
          ? { ...definition, displayName: handler.displayName }
          : definition;
      }),
    );
  }

  getDisplayName(name: string): string | undefined {
    return this.handlers.get(name)?.displayName;
  }

  summarizeCommand(name: string, command: DeviceCommand): string | undefined {
    return this.handlers.get(name)?.summarizeCommand?.(command);
  }
}

const channelSchema = z.enum(['A', 'B']);
const channelParameter = {
  type: 'string',
  enum: ['A', 'B'],
  description: '通道 A 或 B。',
} as const;
const MAX_START_STRENGTH_HINT = 10;
const MAX_ADJUST_STEP_HINT = 10;
const MAX_BURST_DURATION_HINT_MS = 5_000;
const DEFAULT_START_WAVEFORM_ID = 'pulse_mid';

export function createDefaultToolRegistry(): ToolRegistry {
  return createDefaultToolRegistryWithDeps({});
}

export interface DefaultToolRegistryDeps {
  waveformLibrary?: WaveformLibraryPort;
}

export function createDefaultToolRegistryWithDeps(deps: DefaultToolRegistryDeps): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'start',
    displayName: '启动通道',
    summarizeCommand(command) {
      if (command.type !== 'start') return '启动通道';
      return `启动 ${command.channel} 通道，强度 ${command.strength}，波形 ${command.waveform.id}`;
    },
    async definition() {
      const waveformDescription = await buildWaveformDescriptionText(deps.waveformLibrary);
      return {
        name: 'start',
        description: [
          '【启动工具】启动一个通道，同时设置初始强度和波形。',
          '只在该通道当前处于停止状态、需要从零开始时使用。',
          `软启动规则：启动强度应控制在 0-${MAX_START_STRENGTH_HINT}；更高值会被策略层压低。`,
          '如果通道已经在运行，只想继续加一点请用 adjust_strength；只想切换波形请用 change_wave；想结束请用 stop。',
          '完成一次 start 后，通常应该先描述结果并询问用户感受，不要在同一轮里马上连续追加多次强度。',
          waveformDescription ? `可用波形：${waveformDescription}` : '',
        ]
          .filter(Boolean)
          .join(' '),
        parameters: {
          type: 'object',
          properties: {
            channel: channelParameter,
            strength: {
              type: 'integer',
              minimum: 0,
              maximum: MAX_START_STRENGTH_HINT,
              description: '启动时的初始强度。建议从 5-8 起步，再根据反馈小步推进。',
            },
            waveformId: await buildWaveformIdParameter(deps.waveformLibrary),
            loop: {
              type: 'boolean',
              description: '是否循环播放波形，默认 true。',
            },
          },
          required: ['channel', 'strength', 'waveformId'],
        },
      };
    },
    async toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema,
          strength: z.coerce.number().int().min(0).max(200),
          waveformId: z.string().min(1).optional(),
          waveform: z.string().min(1).optional(),
          loop: z.boolean().optional().default(true),
        })
        .parse(args);

      const waveform = await resolveWaveform(
        deps.waveformLibrary,
        parsed.waveformId ?? parsed.waveform ?? DEFAULT_START_WAVEFORM_ID,
      );

      return {
        type: 'device',
        command: {
          type: 'start',
          channel: parsed.channel,
          strength: parsed.strength,
          waveform,
          loop: parsed.loop,
        },
      };
    },
  });

  registry.register({
    name: 'stop',
    displayName: '停止通道',
    summarizeCommand(command) {
      if (command.type !== 'stop') return '停止通道';
      return command.channel ? `停止 ${command.channel} 通道` : '停止全部通道';
    },
    definition: {
      name: 'stop',
      description: [
        '【停止工具】停止一个通道，或在不传 channel 时停止全部通道。',
        '想结束输出、暂停刺激、或者用户表达“停一下 / 够了 / 关掉”时，应优先使用这个工具。',
        '不要用 start(strength=0) 或其它变通方式代替 stop。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          channel: {
            ...channelParameter,
            description: '要停止的通道；不传则停止全部通道。',
          },
        },
      },
    },
    toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema.optional(),
        })
        .parse(args);

      return {
        type: 'device',
        command: {
          type: 'stop',
          channel: parsed.channel,
        },
      };
    },
  });

  registry.register({
    name: 'adjust_strength',
    displayName: '调节强度',
    summarizeCommand(command) {
      if (command.type !== 'adjustStrength') return '调节强度';
      return `调整 ${command.channel} 通道强度 ${command.delta > 0 ? '+' : ''}${command.delta}`;
    },
    definition: {
      name: 'adjust_strength',
      description: [
        '【强度调整工具】在不改变当前波形的前提下，相对调整一个通道的强度。',
        '这是通道运行过程中唯一的强度微调入口，适合小步推进、轻微回落、边缘控制。',
        '优先使用 +2、+3、-2、-3 这类细微变化；不要在同一轮里连续多次大幅加码。',
        '如果同时还要切换波形，请配合 change_wave，而不是重复 start。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          channel: channelParameter,
          delta: {
            type: 'integer',
            minimum: -MAX_ADJUST_STEP_HINT,
            maximum: MAX_ADJUST_STEP_HINT,
            description: `本次变化量。正数增加，负数降低；建议保持在 ±${MAX_ADJUST_STEP_HINT} 以内。`,
          },
        },
        required: ['channel', 'delta'],
      },
    },
    toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema,
          delta: z.coerce.number().int().min(-200).max(200),
        })
        .parse(args);

      return {
        type: 'device',
        command: {
          type: 'adjustStrength',
          channel: parsed.channel,
          delta: parsed.delta,
        },
      };
    },
  });

  registry.register({
    name: 'change_wave',
    displayName: '切换波形',
    summarizeCommand(command) {
      if (command.type !== 'changeWave') return '切换波形';
      return `切换 ${command.channel} 通道波形为 ${command.waveform.id}`;
    },
    async definition() {
      const waveformDescription = await buildWaveformDescriptionText(deps.waveformLibrary);
      return {
        name: 'change_wave',
        description: [
          '【切换波形工具】在不改变当前强度的前提下，更换一个通道的波形。',
          '适合已经启动后换节奏、换触感；如果通道还没启动，应改用 start。',
          '只改波形，不改强度；如果用户是要“再强一点”，优先用 adjust_strength。',
          waveformDescription ? `可用波形：${waveformDescription}` : '',
        ]
          .filter(Boolean)
          .join(' '),
        parameters: {
          type: 'object',
          properties: {
            channel: channelParameter,
            waveformId: await buildWaveformIdParameter(deps.waveformLibrary),
            loop: {
              type: 'boolean',
              description: '是否循环播放波形，默认 true。',
            },
          },
          required: ['channel', 'waveformId'],
        },
      };
    },
    async toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema,
          waveformId: z.string().min(1).optional(),
          waveform: z.string().min(1).optional(),
          loop: z.boolean().optional().default(true),
        })
        .parse(args);

      const waveformId = parsed.waveformId ?? parsed.waveform;
      if (!waveformId) {
        throw new Error('change_wave 缺少 waveformId 参数。');
      }

      const waveform = await resolveWaveform(deps.waveformLibrary, waveformId);

      return {
        type: 'device',
        command: {
          type: 'changeWave',
          channel: parsed.channel,
          waveform,
          loop: parsed.loop,
        },
      };
    },
  });

  registry.register({
    name: 'burst',
    displayName: '脉冲增强',
    summarizeCommand(command) {
      if (command.type !== 'burst') return '脉冲增强';
      return `对 ${command.channel} 通道执行脉冲，强度 ${command.strength}，持续 ${command.durationMs}ms`;
    },
    definition: {
      name: 'burst',
      description: [
        '【短时脉冲工具】把一个正在运行的通道短暂拉到目标强度，持续一小段时间后自动回落。',
        '只适合制造短促峰值，不能拿来绕过 start 的软启动限制。',
        '这个工具要求通道已经在运行；如果当前还是停止状态，应先用 start。',
        `durationMs 建议控制在 100-${MAX_BURST_DURATION_HINT_MS}ms。做完 burst 后通常应该先停下来观察反馈。`,
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          channel: channelParameter,
          strength: {
            type: 'integer',
            minimum: 0,
            maximum: 200,
            description: '脉冲期间的目标强度。仍然受设备上限和用户上限约束。',
          },
          durationMs: {
            type: 'integer',
            minimum: 100,
            maximum: MAX_BURST_DURATION_HINT_MS,
            description: `脉冲持续时间（毫秒）。建议保持在 100-${MAX_BURST_DURATION_HINT_MS}ms 内。`,
          },
        },
        required: ['channel', 'strength', 'durationMs'],
      },
    },
    toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema,
          strength: z.coerce.number().int().min(0).max(200),
          durationMs: z.coerce.number().int().min(100).max(20_000).optional(),
          duration_ms: z.coerce.number().int().min(100).max(20_000).optional(),
        })
        .parse(args);

      const durationMs = parsed.durationMs ?? parsed.duration_ms;
      if (durationMs == null) {
        throw new Error('burst 缺少 durationMs 参数。');
      }

      return {
        type: 'device',
        command: {
          type: 'burst',
          channel: parsed.channel,
          strength: parsed.strength,
          durationMs,
        },
      };
    },
  });

  registry.register({
    name: 'emergency_stop',
    displayName: '紧急停止',
    summarizeCommand(command) {
      return command.type === 'emergencyStop' ? '紧急停止' : '紧急停止';
    },
    definition: {
      name: 'emergency_stop',
      description: '立即停止全部输出。仅在需要紧急终止时使用。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    toExecutionPlan() {
      return {
        type: 'device',
        command: { type: 'emergencyStop' },
      };
    },
  });

  registry.register({
    name: 'timer',
    displayName: '设置定时器',
    definition: {
      name: 'timer',
      description: [
        '【定时器工具】设置一个延迟提醒，在指定秒数后由系统重新触发一轮内部跟进。',
        '适合安排“过一会儿再问感受”或“稍后提醒”的流程。',
        '定时到期后收到的是内部提醒，不是用户新消息；到期回合只应简短跟进，不要自动继续操作设备。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          seconds: {
            type: 'integer',
            minimum: 1,
            maximum: 3600,
            description: '倒计时秒数，范围 1-3600。',
          },
          label: {
            type: 'string',
            description: '给这次提醒起一个简短标签，方便到期时识别用途。',
          },
        },
        required: ['seconds', 'label'],
      },
    },
    toExecutionPlan(args) {
      const parsed = z
        .object({
          seconds: z.coerce.number().int().min(1).max(3600),
          label: z.string().min(1),
        })
        .parse(args);

      return {
        type: 'timer',
        command: {
          type: 'timer',
          seconds: parsed.seconds,
          label: parsed.label,
        },
      };
    },
  });

  return registry;
}

async function buildWaveformIdParameter(waveformLibrary: WaveformLibraryPort | undefined): Promise<Record<string, unknown>> {
  if (!waveformLibrary) {
    return {
      type: 'string',
      description: '波形 ID。',
    };
  }

  const waveforms = await waveformLibrary.list();
  const waveformIds = waveforms.map((waveform) => waveform.id);
  const waveformDescription = buildWaveformSummaryText(waveforms);

  return {
    type: 'string',
    enum: waveformIds,
    description: `波形 ID。${waveformDescription}`,
  };
}

async function buildWaveformDescriptionText(waveformLibrary: WaveformLibraryPort | undefined): Promise<string> {
  if (!waveformLibrary) {
    return '';
  }

  return buildWaveformSummaryText(await waveformLibrary.list());
}

function buildWaveformSummaryText(
  waveforms: Array<{
    id: string;
    name: string;
    description?: string;
  }>,
): string {
  if (waveforms.length === 0) {
    return '当前波形库为空。';
  }

  return waveforms
    .map((waveform) => `${waveform.id}（${waveform.name}${waveform.description ? `：${waveform.description}` : ''}）`)
    .join('；');
}

async function resolveWaveform(
  waveformLibrary: WaveformLibraryPort | undefined,
  waveformId: string,
) {
  if (!waveformLibrary) {
    throw new Error(`波形库不可用，无法解析 "${waveformId}"。`);
  }

  const waveform = await waveformLibrary.getById(waveformId);
  if (!waveform) {
    throw new Error(`未知波形：${waveformId}`);
  }

  return waveform;
}
