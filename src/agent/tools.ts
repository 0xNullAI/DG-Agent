/**
 * tools.ts — Tool definitions and executor for Coyote device control.
 * Each tool co-locates its schema and handler. Common boilerplate is unified.
 */

import type { ToolDef, WaveStep } from '../types';
import * as bt from './bluetooth';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const CH = { type: 'string', enum: ['A', 'B'], description: '通道 A 或 B' } as const;

function snap() {
  const s = bt.getStatus();
  return { strengthA: s.strengthA, strengthB: s.strengthB, waveActiveA: s.waveActiveA, waveActiveB: s.waveActiveB };
}

function clamp(value: number, channel: string): { value: number; limited: boolean } {
  const limits = bt.getStrengthLimits();
  const limit = channel.toUpperCase() === 'A' ? limits.limitA : limits.limitB;
  const clamped = Math.min(Math.max(0, value), limit);
  return { value: clamped, limited: clamped !== value };
}

// ---------------------------------------------------------------------------
// Tool registry — definition + handler in one place
// ---------------------------------------------------------------------------

interface ToolEntry {
  def: ToolDef;
  handler: (args: any) => any;
}

const registry: ToolEntry[] = [
  {
    def: {
      name: 'play',
      description:
        '【核心操作工具】一次性同时设置一个通道的「强度」和「波形」。这是开始或调整任何刺激时的首选工具——强度和波形必须同时提供，绝不允许单独设强度而不配波形。\n\n' +
        '使用场景：\n' +
        '• 开始新的刺激：play(channel=A, strength=15, preset=breath)\n' +
        '• 切换波形并调整强度：play(channel=A, strength=25, preset=tide)\n' +
        '• 使用自定义频率和强度百分比：play(channel=B, strength=20, frequency=50, intensity=80)\n\n' +
        '波形参数二选一：\n' +
        '  (1) 只提供 preset（推荐）：使用预设波形\n' +
        '  (2) 同时提供 frequency 和 intensity：自定义单一频率/强度的简单波形\n\n' +
        '注意：strength 是设备输出的绝对强度(0-200)，受安全上限限制；intensity 只是波形内部的能量百分比(0-100)，不同概念。想要"停止"请调用 stop，而不是传 strength=0。',
      parameters: {
        type: 'object',
        properties: {
          channel: CH,
          strength: {
            type: 'integer',
            minimum: 0,
            maximum: 200,
            description: '通道输出的绝对强度，0-200。新手从 5-15 开始；会被安全上限自动限制。',
          },
          preset: {
            type: 'string',
            enum: ['breath', 'tide', 'pulse_low', 'pulse_mid', 'pulse_high', 'tap'],
            description:
              '预设波形名（与 frequency/intensity 互斥）：\n' +
              '  • breath — 呼吸节奏，渐强渐弱，最温柔\n' +
              '  • tide   — 潮汐感，波浪般起伏，适合铺垫\n' +
              '  • pulse_low  — 低脉冲，轻柔的规律节奏\n' +
              '  • pulse_mid  — 中脉冲，中等刺激\n' +
              '  • pulse_high — 高脉冲，强烈的规律节奏\n' +
              '  • tap    — 轻拍，带节奏停顿，有"点触"感',
          },
          frequency: {
            type: 'integer',
            minimum: 10,
            maximum: 1000,
            description: '自定义频率(ms)，必须与 intensity 同时提供，且不能与 preset 同用。',
          },
          intensity: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
            description: '自定义波形内部能量百分比(0-100)，必须与 frequency 同时提供。注意：这不是 strength！',
          },
          duration_frames: {
            type: 'integer',
            default: 10,
            description: '帧数（每帧 100ms）。仅在自定义 frequency+intensity 模式下生效，preset 模式忽略。',
          },
          loop: { type: 'boolean', default: true, description: '是否循环播放波形，默认 true' },
        },
        required: ['channel', 'strength'],
      },
    },
    handler({ channel, strength, preset, frequency, intensity, duration_frames, loop }) {
      if (preset && (frequency != null || intensity != null))
        return { error: 'preset 和 frequency/intensity 互斥，请只选一种' };
      if (!preset && (frequency == null || intensity == null))
        return { error: '必须提供 preset，或同时提供 frequency 和 intensity' };

      const safe = clamp(strength, channel);
      bt.setStrength(channel, safe.value);
      bt.sendWave(channel, preset || null, frequency ?? null, intensity ?? null, duration_frames || 10, loop !== false);

      return {
        channel,
        strength: { requested: strength, actual: safe.value, limited: safe.limited },
        wave: preset ? { preset } : { frequency, intensity },
        loop: loop !== false,
      };
    },
  },
  {
    def: {
      name: 'stop',
      description:
        '【关闭工具】完整关闭通道：同时把强度归零并停止波形输出。想要结束刺激时必须用这个工具——不要用 play(strength=0) 或其它变通方式来"关"设备。\n\n' +
        '使用场景：\n' +
        '• 停止 A 通道：stop(channel=A)\n' +
        '• 紧急全停（A 和 B 都关）：stop() 不传参数\n' +
        '• 用户说"停一下"、"够了"、"停止"、"关掉"等任何结束意图时',
      parameters: {
        type: 'object',
        properties: {
          channel: { ...CH, description: '要关闭的通道；不填则 A 和 B 同时关闭' },
        },
      },
    },
    handler({ channel }) {
      if (channel) {
        bt.setStrength(channel, 0);
        bt.stopWave(channel);
        return { channel, stopped: true };
      }
      bt.setStrength('A', 0);
      bt.setStrength('B', 0);
      bt.stopWave(null);
      return { channel: 'all', stopped: true };
    },
  },
  {
    def: {
      name: 'add_strength',
      description:
        '【微调工具】在不改变当前波形的前提下，相对调整一个通道的强度。用于边缘控制、渐进攀升等需要细腻调整的场景。\n\n' +
        '使用场景：\n' +
        '• 缓慢攀升：add_strength(channel=A, delta=3)\n' +
        '• 轻微回落：add_strength(channel=A, delta=-5)\n' +
        '• 已经用 play 设好波形，只想在此基础上做 +2/+3 的微调\n\n' +
        '注意：如果需要同时换波形，请用 play 而不是这个工具。',
      parameters: {
        type: 'object',
        properties: {
          channel: CH,
          delta: { type: 'integer', description: '变化量，正数增加，负数减少。典型值 ±1 到 ±10。' },
        },
        required: ['channel', 'delta'],
      },
    },
    handler({ channel, delta }) {
      const current = channel.toUpperCase() === 'A' ? bt.getStatus().strengthA : bt.getStatus().strengthB;
      const safe = clamp(current + delta, channel);
      const actualDelta = safe.value - current;
      if (actualDelta !== 0) bt.addStrength(channel, actualDelta);
      return { channel, requestedDelta: delta, actualDelta, result: safe.value, limited: safe.limited };
    },
  },
  {
    def: {
      name: 'design_wave',
      description:
        '【高级波形工具】一次性设置强度并播放一段自定义的多步波形。当预设波形不够用、需要构造独特的节奏曲线时使用。\n\n' +
        '使用场景：\n' +
        '• 制造渐强：steps=[{freq:20,intensity:20,repeat:3},{freq:20,intensity:50,repeat:3},{freq:20,intensity:90,repeat:3}]\n' +
        '• 制造断续节奏：steps=[{freq:10,intensity:100,repeat:1},{freq:10,intensity:0,repeat:2}]\n' +
        '• 模拟心跳、呼吸等有机节律\n\n' +
        '每一步(step)代表一段连续相同的帧，帧时长 100ms。repeat 决定这一步持续几帧。与 play 一样必须同时提供 strength。',
      parameters: {
        type: 'object',
        properties: {
          channel: CH,
          strength: {
            type: 'integer',
            minimum: 0,
            maximum: 200,
            description: '通道输出的绝对强度，0-200。',
          },
          steps: {
            type: 'array',
            description: '波形步骤数组，每一步是 {freq, intensity, repeat?}',
            items: {
              type: 'object',
              properties: {
                freq: { type: 'integer', minimum: 10, maximum: 1000, description: '这一步的频率(ms)' },
                intensity: { type: 'integer', minimum: 0, maximum: 100, description: '这一步的波形能量百分比 0-100' },
                repeat: { type: 'integer', minimum: 1, default: 1, description: '这一步重复几帧（每帧 100ms）' },
              },
              required: ['freq', 'intensity'],
            },
          },
          loop: { type: 'boolean', default: true, description: '是否循环播放整段波形' },
        },
        required: ['channel', 'strength', 'steps'],
      },
    },
    handler({ channel, strength, steps, loop }: { channel: string; strength: number; steps: WaveStep[]; loop?: boolean }) {
      const safe = clamp(strength, channel);
      bt.setStrength(channel, safe.value);
      bt.designWave(channel, steps, loop !== false);
      return {
        channel,
        strength: { requested: strength, actual: safe.value, limited: safe.limited },
        stepsCount: steps.length,
        loop: loop !== false,
      };
    },
  },
  {
    def: {
      name: 'set_strength_limit',
      description:
        '【安全设置】设置 A/B 两个通道的强度上限。这是一道安全闸——所有 play/add_strength/design_wave 都会被限制在这个上限之内。\n\n' +
        '使用场景：\n' +
        '• 用户明确说"强度不要超过 X"时\n' +
        '• 初次连接或更换场景时，根据用户习惯预设一个安全范围\n\n' +
        '注意：这个工具只设置上限，不会直接影响当前输出强度。',
      parameters: {
        type: 'object',
        properties: {
          limit_a: { type: 'integer', minimum: 0, maximum: 200, description: 'A 通道强度上限 0-200' },
          limit_b: { type: 'integer', minimum: 0, maximum: 200, description: 'B 通道强度上限 0-200' },
        },
        required: ['limit_a', 'limit_b'],
      },
    },
    handler({ limit_a, limit_b }) {
      bt.setStrengthLimit(limit_a, limit_b);
      return { limit_a, limit_b };
    },
  },
  {
    def: {
      name: 'get_status',
      description:
        '【状态查询】获取设备当前真实状态：连接状态、电量、A/B 强度、A/B 波形是否活跃。\n\n' +
        '必须调用的场景：\n' +
        '• 每次要对设备进行任何操作前（open/调整/关闭），都应该先 get_status 确认当前状态\n' +
        '• 用户询问"现在几档"、"强度多少"、"还在响吗"等状态问题时\n\n' +
        '注意：调用 get_status 后，请直接根据返回结果回复用户，不要接着再调用其他工具（除非用户的请求本来就是"查状态然后再操作"）。',
      parameters: { type: 'object', properties: {} },
    },
    handler() {
      return { ...bt.getStatus(), _hint: '状态已获取，请直接根据此结果回复用户，不要再次调用任何工具。' };
    },
  },
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const tools: ToolDef[] = registry.map((t) => t.def);

const handlerMap = new Map(registry.map((t) => [t.def.name, t.handler]));

export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  const handler = handlerMap.get(name);
  if (!handler) return JSON.stringify({ error: `Unknown tool: ${name}` });

  try {
    const result = handler(args);
    const isGetStatus = name === 'get_status';
    return JSON.stringify({
      success: true,
      ...result,
      ...(!isGetStatus && { deviceState: snap(), _hint: '以上 deviceState 是设备当前真实状态，请根据此状态回复用户。' }),
    });
  } catch (err: unknown) {
    console.error(`[tools] ${name}:`, err);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
