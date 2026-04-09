/**
 * tools.ts — Tool definitions and executor for Coyote device control.
 */

import type { ToolDef, WaveStep } from '../types';
import * as bt from './bluetooth';

export const tools: ToolDef[] = [
  {
    name: 'set_strength',
    description: '设置指定通道的绝对强度值',
    parameters: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['A', 'B'], description: '通道 A 或 B' },
        value: { type: 'integer', minimum: 0, maximum: 200, description: '强度值 0-200' },
      },
      required: ['channel', 'value'],
    },
  },
  {
    name: 'add_strength',
    description: '相对调整指定通道的强度',
    parameters: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['A', 'B'], description: '通道' },
        delta: { type: 'integer', description: '变化量，正数增加，负数减少。最终值会被限制在安全上限内' },
      },
      required: ['channel', 'delta'],
    },
  },
  {
    name: 'set_strength_limit',
    description: '设置两个通道的强度上限（会持久保存到设备）',
    parameters: {
      type: 'object' as const,
      properties: {
        limit_a: { type: 'integer', minimum: 0, maximum: 200 },
        limit_b: { type: 'integer', minimum: 0, maximum: 200 },
      },
      required: ['limit_a', 'limit_b'],
    },
  },
  {
    name: 'send_wave',
    description: '发送波形到指定通道。必须且只能选以下两种之一：(1) 只提供 preset 参数；(2) 同时提供 frequency + intensity 参数。不要同时提供 preset 和 frequency/intensity',
    parameters: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['A', 'B'] },
        preset: {
          type: 'string',
          enum: ['breath', 'tide', 'pulse_low', 'pulse_mid', 'pulse_high', 'tap'],
          description: '预设波形名',
        },
        frequency: { type: 'integer', minimum: 10, maximum: 1000, description: '自定义频率(ms)，与preset二选一' },
        intensity: { type: 'integer', minimum: 0, maximum: 100, description: '自定义强度百分比' },
        duration_frames: { type: 'integer', default: 10, description: '自定义波形帧数，每帧100ms' },
        loop: { type: 'boolean', default: true },
      },
      required: ['channel'],
    },
  },
  {
    name: 'design_wave',
    description:
      '设计自定义波形。steps为步骤数组，每步包含freq(频率ms,10-1000)、intensity(0-100)、repeat(重复次数,默认1)',
    parameters: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['A', 'B'] },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              freq: { type: 'integer' },
              intensity: { type: 'integer' },
              repeat: { type: 'integer', description: '该步骤的重复次数，默认1' },
            },
            required: ['freq', 'intensity'],
          },
        },
        loop: { type: 'boolean', default: true },
      },
      required: ['channel', 'steps'],
    },
  },
  {
    name: 'stop_wave',
    description: '停止波形输出',
    parameters: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['A', 'B'], description: '指定通道，不填则停止所有' },
      },
    },
  },
  {
    name: 'get_status',
    description: '获取设备当前状态（连接状态、强度、电量、波形状态等）',
    parameters: { type: 'object' as const, properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Helper: get device state snapshot for tool results
// ---------------------------------------------------------------------------
function deviceSnapshot() {
  const s = bt.getStatus();
  return { strengthA: s.strengthA, strengthB: s.strengthB, waveActiveA: s.waveActiveA, waveActiveB: s.waveActiveB };
}

/**
 * Execute a tool call by name. Returns a JSON string result.
 * @param name - tool name
 * @param args - tool arguments
 */
export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case 'set_strength': {
        const { channel, value } = args as { channel: string; value: number };
        const limits = bt.getStrengthLimits();
        const limit = channel.toUpperCase() === 'A' ? limits.limitA : limits.limitB;
        const safeValue = Math.min(Math.max(0, value), limit);
        bt.setStrength(channel, safeValue);
        return JSON.stringify({
          success: true, channel, requestedValue: value, actualValue: safeValue,
          limited: safeValue < value,
          deviceState: deviceSnapshot(),
          _hint: '以上 deviceState 是设备当前真实状态，请根据此状态回复用户。',
        });
      }

      case 'add_strength': {
        const { channel, delta } = args as { channel: string; delta: number };
        const status = bt.getStatus();
        const limits = bt.getStrengthLimits();
        const current = channel.toUpperCase() === 'A' ? status.strengthA : status.strengthB;
        const limit = channel.toUpperCase() === 'A' ? limits.limitA : limits.limitB;
        const desired = current + delta;
        const clamped = Math.min(Math.max(0, desired), limit);
        const safeDelta = clamped - current;
        if (safeDelta !== 0) {
          bt.addStrength(channel, safeDelta);
        }
        return JSON.stringify({
          success: true, channel, requestedDelta: delta, actualDelta: safeDelta, resultStrength: clamped,
          limited: safeDelta !== delta,
          deviceState: deviceSnapshot(),
          _hint: '以上 deviceState 是设备当前真实状态，请根据此状态回复用户。',
        });
      }

      case 'set_strength_limit': {
        const { limit_a, limit_b } = args as { limit_a: number; limit_b: number };
        bt.setStrengthLimit(limit_a, limit_b);
        const s = bt.getStatus();
        return JSON.stringify({
          success: true, limit_a, limit_b,
          deviceState: { strengthA: s.strengthA, strengthB: s.strengthB, limitA: s.limitA, limitB: s.limitB },
          _hint: '以上 deviceState 是设备当前真实状态，请根据此状态回复用户。',
        });
      }

      case 'send_wave': {
        const { channel, preset, frequency, intensity, duration_frames, loop } = args as {
          channel: string;
          preset?: string;
          frequency?: number;
          intensity?: number;
          duration_frames?: number;
          loop?: boolean;
        };
        if (preset && (frequency != null || intensity != null)) {
          return JSON.stringify({ error: 'preset 和 frequency/intensity 互斥，请只选一种方式' });
        }
        if (!preset && (frequency == null || intensity == null)) {
          return JSON.stringify({ error: '非预设模式需要同时提供 frequency 和 intensity' });
        }
        bt.sendWave(
          channel,
          preset || null,
          frequency || null,
          intensity || null,
          duration_frames || 10,
          loop !== false
        );
        return JSON.stringify({
          success: true, channel, preset, frequency, intensity, loop: loop !== false,
          deviceState: deviceSnapshot(),
          _hint: '以上 deviceState 是设备当前真实状态，请根据此状态回复用户。',
        });
      }

      case 'design_wave': {
        const { channel, steps, loop } = args as { channel: string; steps: WaveStep[]; loop?: boolean };
        bt.designWave(channel, steps, loop !== false);
        return JSON.stringify({
          success: true, channel, stepsCount: steps.length, loop: loop !== false,
          deviceState: deviceSnapshot(),
          _hint: '以上 deviceState 是设备当前真实状态，请根据此状态回复用户。',
        });
      }

      case 'stop_wave': {
        const { channel } = args as { channel?: string };
        bt.stopWave(channel || null);
        return JSON.stringify({
          success: true, channel: channel || 'all',
          deviceState: deviceSnapshot(),
          _hint: '以上 deviceState 是设备当前真实状态，请根据此状态回复用户。',
        });
      }

      case 'get_status': {
        const status = bt.getStatus();
        return JSON.stringify({
          success: true,
          ...status,
          _hint: '状态已获取，请直接根据此结果回复用户，不要再次调用任何工具。',
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: unknown) {
    console.error(`[tools] Error executing ${name}:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: message });
  }
}
