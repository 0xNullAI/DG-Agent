import type { WaveformLibrary } from '@dg-agent/core';
import type { DeviceCommand, ToolCall, ToolDefinition, ToolExecutionPlan } from '@dg-agent/core';
import { compileWaveformDesign, type DesignSegment } from '@dg-agent/waveforms';
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
      throw new Error(`未知工具：${toolCall.name}`);
    }

    return handler.toExecutionPlan(toolCall.args);
  }

  async listDefinitions(): Promise<ToolDefinition[]> {
    return Promise.all(
      [...this.handlers.values()].map(async (handler) => {
        const definition =
          typeof handler.definition === 'function'
            ? await handler.definition()
            : handler.definition;
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
  description: '通道 A 或 B',
} as const;
const MAX_START_STRENGTH_HINT = 10;
const MAX_ADJUST_STEP_HINT = 10;
const MAX_BURST_DURATION_HINT_MS = 5_000;
const DEFAULT_START_WAVEFORM_ID = 'pulse_mid';

export interface DefaultToolRegistryDeps {
  waveformLibrary?: WaveformLibrary;
  toolDefinitionHints?: ToolDefinitionHints;
}

export interface ToolDefinitionHints {
  maxColdStartStrength?: number;
  maxAdjustStrengthStep?: number;
  maxAdjustStrengthCallsPerTurn?: number;
  maxBurstDurationMs?: number;
  maxBurstCallsPerTurn?: number;
}

export function createDefaultToolRegistryWithDeps(deps: DefaultToolRegistryDeps): ToolRegistry {
  const registry = new ToolRegistry();
  const maxColdStartStrengthHint = normalizeToolDefinitionHint(
    deps.toolDefinitionHints?.maxColdStartStrength,
    MAX_START_STRENGTH_HINT,
    0,
  );
  const maxAdjustStrengthStepHint = normalizeToolDefinitionHint(
    deps.toolDefinitionHints?.maxAdjustStrengthStep,
    MAX_ADJUST_STEP_HINT,
    1,
  );
  const maxAdjustCallsHint = normalizeToolDefinitionHint(
    deps.toolDefinitionHints?.maxAdjustStrengthCallsPerTurn,
    2,
    1,
  );
  const maxBurstDurationMsHint = normalizeToolDefinitionHint(
    deps.toolDefinitionHints?.maxBurstDurationMs,
    MAX_BURST_DURATION_HINT_MS,
    100,
  );
  const maxBurstCallsHint = normalizeToolDefinitionHint(
    deps.toolDefinitionHints?.maxBurstCallsPerTurn,
    1,
    1,
  );

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
          '【启动通道】启动一个通道，同时设置初始强度和波形。',
          '触发：通道当前停止，需要从零开始时使用。',
          '不用：通道已运行 → 想加点强度用 adjust_strength，想换波形用 change_wave，想结束用 stop。',
          `约束：单次启动强度上限 ${maxColdStartStrengthHint}（受安全设置约束），完成后先描述结果并询问感受，不要在同一回合连续追加多次强度。`,
          waveformDescription ? `可用波形：${waveformDescription}。` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        parameters: {
          type: 'object',
          properties: {
            channel: channelParameter,
            strength: {
              type: 'integer',
              minimum: 0,
              maximum: maxColdStartStrengthHint,
              description: `启动时的初始强度，范围 [0, ${maxColdStartStrengthHint}]。`,
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
          loop: z.preprocess((v) => {
            if (typeof v === 'string') return v.toLowerCase() !== 'false' && v !== '0' && v !== '';
            return v;
          }, z.boolean().optional().default(true)),
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
        '【停止通道】停止一个通道，省略 channel 则停止全部通道。',
        '触发：用户表达"停一下/够了/关掉"，或需要结束输出时。',
        '不用：start(strength=0) 或其他变通方式不能代替 stop。',
        '约束：无次数上限。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          channel: {
            ...channelParameter,
            description: '要停止的通道，省略则停止全部。',
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
        '【调节强度】在不改变波形的前提下相对调整一个通道的强度。',
        '触发：通道运行中，需要小步推进、轻微回落、边缘控制时使用。',
        '不用：想换波形 → change_wave；通道未启动 → start。',
        `约束：本回合最多调用 ${maxAdjustCallsHint} 次，单步幅度 ±${maxAdjustStrengthStepHint}，优先选小幅度（约 1/3 上限）做平稳推进，每次调整后停下来观察反馈。`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          channel: channelParameter,
          delta: {
            type: 'integer',
            minimum: -maxAdjustStrengthStepHint,
            maximum: maxAdjustStrengthStepHint,
            description: `本次变化量（正增负减），范围 [-${maxAdjustStrengthStepHint}, ${maxAdjustStrengthStepHint}]。`,
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
          '【切换波形】在不改变强度的前提下更换一个通道的波形。',
          '触发：已启动后想换节奏、换触感时使用。',
          '不用：想加强 → adjust_strength；通道未启动 → start。',
          '约束：仅切波形不动强度，切换后停下来描述新感觉。',
          waveformDescription ? `可用波形：${waveformDescription}。` : '',
        ]
          .filter(Boolean)
          .join('\n'),
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
          loop: z.preprocess((v) => {
            if (typeof v === 'string') return v.toLowerCase() !== 'false' && v !== '0' && v !== '';
            return v;
          }, z.boolean().optional().default(true)),
        })
        .parse(args);

      const waveformId = parsed.waveformId ?? parsed.waveform;
      if (!waveformId) {
        throw new Error('change_wave 缺少 waveformId 参数');
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
        '【短时脉冲】把一个正在运行的通道短暂拉到目标强度，持续一段时间后自动回落。',
        '触发：制造短促峰值、强烈点射感时使用。',
        '不用：通道未启动 → 先 start；想长期提升强度 → adjust_strength。',
        `约束：本回合最多调用 ${maxBurstCallsHint} 次，单次时长 100-${maxBurstDurationMsHint}ms，完成后先停下来观察反馈。`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          channel: channelParameter,
          strength: {
            type: 'integer',
            minimum: 0,
            maximum: 200,
            description: '脉冲期间的目标强度（受设备上限和用户上限约束）。',
          },
          durationMs: {
            type: 'integer',
            minimum: 100,
            maximum: maxBurstDurationMsHint,
            description: `脉冲持续时间（毫秒），范围 [100, ${maxBurstDurationMsHint}]。`,
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
        throw new Error('burst 缺少 durationMs 参数');
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
    name: 'timer',
    displayName: '设置定时器',
    definition: {
      name: 'timer',
      description: [
        '【设置定时器】指定秒数后由系统触发一次内部跟进。',
        '触发：需要"过一会儿再问"、"稍后提醒"的流程时使用。',
        '不用：想立即跟进直接发文字回复，不需要定时器。',
        '约束：到期回合是内部触发不是用户消息，到期回合只能简短跟进，禁止自动操作设备。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          seconds: {
            type: 'integer',
            minimum: 1,
            maximum: 3600,
            description: '倒计时秒数，范围 [1, 3600]。',
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

  registry.register({
    name: 'design_wave',
    displayName: '设计波形',
    summarizeCommand(command) {
      if (command.type === 'start') {
        return `设计并启动波形 ${command.waveform.id} 到 ${command.channel} 通道`;
      }
      return '设计波形';
    },
    definition: {
      name: 'design_wave',
      description: [
        '【设计波形】组合一组段落生成新的自定义波形，保存到波形库后可立即播放或留待后用。',
        '触发：用户描述的体感无法用现有波形组合表达时使用（如 "先慢慢渐入再变成连续敲击"）。',
        '不用：内置或已导入的波形够用 → 直接 start / change_wave；只想加减强度 → adjust_strength。',
        '约束：单回合最多调用 1 次；总时长 100-30000ms（建议 1-10s）；保存的波形会出现在用户的自定义波形列表里。',
        '段落原语：ramp（强度线性变化）、hold（恒定强度）、pulse（高低交替节拍）、silence（静默间隔）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '给波形起一个简短中文名（如"渐入潮汐"、"短促电击"）。',
          },
          description: {
            type: 'string',
            description: '一句体感说明（用户和后续的 AI 都靠这段决定是否选用此波形）。',
          },
          segments: {
            type: 'array',
            minItems: 1,
            description: '段落列表，按顺序拼接成完整波形。',
            items: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['ramp'] },
                    from: { type: 'integer', minimum: 0, maximum: 100 },
                    to: { type: 'integer', minimum: 0, maximum: 100 },
                    durationMs: { type: 'integer', minimum: 100, maximum: 30_000 },
                    frequencyMs: { type: 'integer', minimum: 10, maximum: 1000 },
                  },
                  required: ['type', 'from', 'to', 'durationMs'],
                },
                {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['hold'] },
                    intensity: { type: 'integer', minimum: 0, maximum: 100 },
                    durationMs: { type: 'integer', minimum: 100, maximum: 30_000 },
                    frequencyMs: { type: 'integer', minimum: 10, maximum: 1000 },
                  },
                  required: ['type', 'intensity', 'durationMs'],
                },
                {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['pulse'] },
                    intensity: { type: 'integer', minimum: 0, maximum: 100 },
                    onMs: { type: 'integer', minimum: 50, maximum: 1000 },
                    offMs: { type: 'integer', minimum: 50, maximum: 1000 },
                    count: { type: 'integer', minimum: 1, maximum: 50 },
                    frequencyMs: { type: 'integer', minimum: 10, maximum: 1000 },
                  },
                  required: ['type', 'intensity', 'onMs', 'offMs', 'count'],
                },
                {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['silence'] },
                    durationMs: { type: 'integer', minimum: 100, maximum: 5000 },
                  },
                  required: ['type', 'durationMs'],
                },
              ],
            },
          },
          playOnChannel: {
            type: 'string',
            enum: ['A', 'B'],
            description: '可选：保存后立刻在该通道启动播放（需同时填 playOnStrength）。',
          },
          playOnStrength: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
            description: '可选：立即播放时的初始强度（受冷启动上限约束）。',
          },
        },
        required: ['name', 'description', 'segments'],
      },
    },
    async toExecutionPlan(args) {
      const segmentSchema = z.discriminatedUnion('type', [
        z.object({
          type: z.literal('ramp'),
          from: z.coerce.number().int().min(0).max(100),
          to: z.coerce.number().int().min(0).max(100),
          durationMs: z.coerce.number().int().min(100).max(30_000),
          frequencyMs: z.coerce.number().int().min(10).max(1000).optional(),
        }),
        z.object({
          type: z.literal('hold'),
          intensity: z.coerce.number().int().min(0).max(100),
          durationMs: z.coerce.number().int().min(100).max(30_000),
          frequencyMs: z.coerce.number().int().min(10).max(1000).optional(),
        }),
        z.object({
          type: z.literal('pulse'),
          intensity: z.coerce.number().int().min(0).max(100),
          onMs: z.coerce.number().int().min(50).max(1000),
          offMs: z.coerce.number().int().min(50).max(1000),
          count: z.coerce.number().int().min(1).max(50),
          frequencyMs: z.coerce.number().int().min(10).max(1000).optional(),
        }),
        z.object({
          type: z.literal('silence'),
          durationMs: z.coerce.number().int().min(100).max(5000),
        }),
      ]);
      const parsed = z
        .object({
          name: z.string().min(1).max(40),
          description: z.string().min(1).max(120),
          segments: z.array(segmentSchema).min(1),
          playOnChannel: z.enum(['A', 'B']).optional(),
          playOnStrength: z.coerce.number().int().min(0).max(100).optional(),
        })
        .parse(args);

      if (!deps.waveformLibrary?.save) {
        throw new Error('当前环境的波形库不支持保存');
      }

      const compiled = compileWaveformDesign(parsed.segments as DesignSegment[]);
      const idSeed =
        parsed.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'designed';
      const waveform = {
        id: `ai-${idSeed}-${Date.now().toString(36)}`,
        name: parsed.name,
        description: parsed.description,
        frames: compiled.frames,
      };

      await deps.waveformLibrary.save(waveform);

      const summary = {
        ok: true,
        waveformId: waveform.id,
        name: waveform.name,
        description: waveform.description,
        totalDurationMs: compiled.totalDurationMs,
        frameCount: compiled.frames.length,
      };

      if (parsed.playOnChannel && typeof parsed.playOnStrength === 'number') {
        return {
          type: 'device',
          command: {
            type: 'start',
            channel: parsed.playOnChannel,
            strength: parsed.playOnStrength,
            waveform,
            loop: true,
          },
        };
      }

      return {
        type: 'inline',
        output: JSON.stringify({
          ...summary,
          _hint: '波形已保存。可在下一回合用 start / change_wave 引用此 waveformId 播放。',
        }),
      };
    },
  });

  return registry;
}

async function buildWaveformIdParameter(
  waveformLibrary: WaveformLibrary | undefined,
): Promise<Record<string, unknown>> {
  if (!waveformLibrary) {
    return {
      type: 'string',
      description: '波形 ID',
    };
  }

  const waveforms = await waveformLibrary.list();
  const waveformIds = waveforms.map((waveform) => waveform.id);
  const waveformDescription = buildWaveformSummaryText(waveforms);

  return {
    type: 'string',
    enum: waveformIds,
    description: `波形 ID - ${waveformDescription}`,
  };
}

async function buildWaveformDescriptionText(
  waveformLibrary: WaveformLibrary | undefined,
): Promise<string> {
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
    return '当前波形库为空';
  }

  return waveforms
    .map(
      (waveform) =>
        `${waveform.id}（${waveform.name}${waveform.description ? `：${waveform.description}` : ''}）`,
    )
    .join('；');
}

async function resolveWaveform(waveformLibrary: WaveformLibrary | undefined, waveformId: string) {
  if (!waveformLibrary) {
    throw new Error(`波形库不可用，无法解析 "${waveformId}"`);
  }

  const waveform = await waveformLibrary.getById(waveformId);
  if (!waveform) {
    throw new Error(`未知波形：${waveformId}`);
  }

  return waveform;
}

function normalizeToolDefinitionHint(
  value: number | undefined,
  fallback: number,
  min: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.round(parsed));
}
