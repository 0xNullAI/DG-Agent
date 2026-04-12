/**
 * tools.ts — Tool definitions and executor for Coyote device control.
 * Each tool co-locates its schema and handler. Common boilerplate is unified.
 */

import type { ToolDef, UserWaveform, WaveFrame } from '../types';
import * as bt from './bluetooth';
import { getMaxStrength } from './providers';
import { MAX_START_STRENGTH, MAX_BURST_DURATION_MS } from './policies';
import * as waveforms from './waveforms';

// ---------------------------------------------------------------------------
// Waveform creation constraints
// ---------------------------------------------------------------------------

const MAX_WAVEFORM_FRAMES = 50;   // 50 frames = 5 seconds max
const MIN_WAVEFORM_FRAMES = 3;    // At least 3 frames for meaningful patterns
const MIN_FREQUENCY = 10;
const MAX_FREQUENCY = 1000;
const MIN_INTENSITY = 0;
const MAX_INTENSITY = 100;

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
  const ch = channel.toUpperCase() === 'A' ? 'A' : 'B';
  const deviceLimit = ch === 'A' ? limits.limitA : limits.limitB;
  const effectiveLimit = Math.min(deviceLimit, getMaxStrength(ch));
  const v = num(value, 0);
  const clamped = Math.min(Math.max(0, v), effectiveLimit);
  return { value: clamped, limited: clamped !== v };
}

/** Coerce arbitrary input (string, number, null) to a finite integer. */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

// ---------------------------------------------------------------------------
// Burst auto-restore tracking
// ---------------------------------------------------------------------------
// `burst` temporarily raises a channel's strength and schedules a setTimeout
// to drop it back down. The safety contract is that the elevated strength
// MUST NOT persist past duration_ms, regardless of what happens in between.
// The timer is only cancelled when the channel has already been zeroed —
// i.e. by `stop` or by emergency stop via fullStop(). All other mutating
// tools (adjust_strength, change_wave, start) let the timer fire; the
// handler's min(current, prev) floor keeps the outcome safe.
const burstRestores = new Map<'A' | 'B', ReturnType<typeof setTimeout>>();

function normChannel(ch: string): 'A' | 'B' {
  return ch.toUpperCase() === 'A' ? 'A' : 'B';
}

/** Cancel the pending burst-restore on a channel (no-op if none pending). */
function cancelBurstRestore(channel: 'A' | 'B' | 'all'): void {
  if (channel === 'all') {
    for (const [, timer] of burstRestores) clearTimeout(timer);
    burstRestores.clear();
    return;
  }
  const timer = burstRestores.get(channel);
  if (timer !== undefined) {
    clearTimeout(timer);
    burstRestores.delete(channel);
  }
}

/**
 * Cancel every pending burst-restore timer. Exposed for the emergency-stop
 * paths that bypass the tool layer (visibilitychange, beforeunload) so a
 * pending restore cannot revive the device after the user or lifecycle
 * handler has already zeroed it.
 */
export function cancelAllBurstRestores(): void {
  cancelBurstRestore('all');
}

// ---------------------------------------------------------------------------
// Tool registry — definition + handler in one place
// ---------------------------------------------------------------------------

function resolveWaveform(id: string): UserWaveform {
  const w = waveforms.getById(id);
  if (w) return w;
  const available = waveforms.getAll().map((x) => x.id).join(', ');
  throw new Error(`未知波形 id "${id}"。可用波形: ${available || '(空)'}`);
}

/**
 * Build the tool schemas exposed to the LLM. The waveform enum and its
 * description block are refreshed from the library on every call, so edits
 * made between turns become visible to the model immediately. Handlers are
 * static (see HANDLERS below) — they resolve waveforms at execution time,
 * not at schema-build time.
 */
function buildToolDefs(): ToolDef[] {
  const list = waveforms.getAll();
  const waveEnum = list.map((w) => w.id);
  const waveDesc = list.length === 0
    ? '（波形库为空）'
    : list.map((w) => `  • ${w.id} — ${w.description || w.name}`).join('\n');

  return [
    {
      name: 'start',
      description:
        '【启动工具】启动一个通道：同时设置「强度」和「波形」。**只在通道当前是停止状态、需要从零开始播放时使用**。与 stop 配对。\n\n' +
        `**软启动硬规则**：start 的 strength 上限为 ${MAX_START_STRENGTH}，超过会被自动夹紧。这是为了防止从零突然给用户高强度刺激——冷启动必须温柔，想要更高强度请先 start 再用 adjust_strength 一步步爬升。\n\n` +
        '使用场景：\n' +
        '• 第一次开始刺激：start(channel=A, strength=8, waveform=breath)\n' +
        '• stop 之后重新启动：start(channel=A, strength=5, waveform=tide)\n\n' +
        '不要用 start 的场景：\n' +
        '• 通道已经在播放，只想换波形 → 用 change_wave\n' +
        '• 通道已经在播放，只想调强度 → 用 adjust_strength\n' +
        '• 想要"停止" → 用 stop，不要传 strength=0',
      parameters: {
        type: 'object',
        properties: {
          channel: CH,
          strength: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_START_STRENGTH,
            description: `启动时的强度，0-${MAX_START_STRENGTH}。这是软启动硬上限——超过 ${MAX_START_STRENGTH} 会被自动夹紧。建议从 5-8 起步，之后用 adjust_strength 一步步爬升。`,
          },
          waveform: {
            type: 'string',
            enum: waveEnum,
            description: '波形 id，从用户波形库中选择：\n' + waveDesc,
          },
          loop: { type: 'boolean', default: true, description: '是否循环播放波形，默认 true' },
        },
        required: ['channel', 'strength', 'waveform'],
      },
    },
    {
      name: 'stop',
      description:
        '【关闭工具】完整关闭通道：同时把强度归零并停止波形输出。想要结束刺激时必须用这个工具——不要用 start(strength=0) 或其它变通方式来"关"设备。\n\n' +
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
    {
      name: 'adjust_strength',
      description:
        '【强度调整工具】在不改变当前波形的前提下，相对调整一个通道的强度。这是通道运行中**唯一**的强度调整入口——边缘控制、渐进攀升、轻微回落都用它。\n\n' +
        '使用场景：\n' +
        '• 缓慢攀升：adjust_strength(channel=A, delta=3)\n' +
        '• 轻微回落：adjust_strength(channel=A, delta=-5)\n' +
        '• 已经 start 启动后，想在当前波形上做 +2/+3 的细腻变化\n\n' +
        '注意：如果同时还要换波形，请配合 change_wave 使用。',
      parameters: {
        type: 'object',
        properties: {
          channel: CH,
          delta: { type: 'integer', description: '变化量，正数增加，负数减少。典型值 ±1 到 ±10。' },
        },
        required: ['channel', 'delta'],
      },
    },
    {
      name: 'change_wave',
      description:
        '【换波形工具】在不改变强度的前提下，把一个通道的当前波形换成另一个。这是通道运行中**唯一**的波形切换入口——只动波形，不动强度。\n\n' +
        '使用场景：\n' +
        '• 用户说"换成潮汐"、"试试 tide"等更换波形的意图\n' +
        '• 已经 start 启动后，想从 breath 切到 pulse_mid 推进节奏\n\n' +
        '注意：如果通道目前是停止状态（strength=0 或刚 stop 过），切了波形也不会有输出，应该改用 start。',
      parameters: {
        type: 'object',
        properties: {
          channel: CH,
          waveform: {
            type: 'string',
            enum: waveEnum,
            description: '要切换到的波形 id，从用户波形库中选择：\n' + waveDesc,
          },
          loop: { type: 'boolean', default: true, description: '是否循环播放波形，默认 true' },
        },
        required: ['channel', 'waveform'],
      },
    },
    {
      name: 'burst',
      description:
        '【短时突增工具】把一个**正在运行**的通道的强度瞬间拉高，持续一小段时间后自动回落到不高于调用前的水平。专门用于制造短暂的刺激峰值——惩罚、突袭、节奏爆点等。\n\n' +
        '示例：burst(channel=A, strength=40, duration_ms=2000) — A 通道强度瞬间拉到 40，2 秒后自动回落。\n\n' +
        '硬性约束：\n' +
        '  1. 通道必须已在运行，停止状态下会报错。\n' +
        `  2. duration_ms 范围 100-${MAX_BURST_DURATION_MS}，超过会被夹紧。\n` +
        '  3. 强度仍受设备/用户绝对上限约束。\n' +
        '  4. 不替换波形，只改变强度。\n' +
        '  5. 到时间一定会把强度降到不高于调用前的水平，期间任何其它工具调用都不会取消这个回落。尽可能将其作为最后一个工具调用。',
      parameters: {
        type: 'object',
        properties: {
          channel: CH,
          strength: {
            type: 'integer',
            minimum: 0,
            maximum: 200,
            description: '突增期间的目标强度绝对值，0-200。仍受设备/用户硬上限约束。',
          },
          duration_ms: {
            type: 'integer',
            minimum: 100,
            maximum: MAX_BURST_DURATION_MS,
            description: `突增持续时间（毫秒），100-${MAX_BURST_DURATION_MS}。时间到后强度一定回到不高于调用前的水平。`,
          },
        },
        required: ['channel', 'strength', 'duration_ms'],
      },
    },
    {
      name: 'create_waveform',
      description:
        '【创建波形工具】根据需求生成自定义波形并添加到波形库中。创建后可立即用于 start 或 change_wave。\n\n' +
        '**何时使用**：\n' +
        '• 用户要求创建特定节奏的波形（"做一个每3秒一次脉冲的波形"、"设计一个渐强模式"）\n' +
        '• 现有波形无法满足需求，需要定制化设计\n' +
        '• 用户描述想要的刺激模式（"像心跳一样"、"波浪式递增"）\n\n' +
        '**帧结构说明**：\n' +
        '• frames 是一个数组，每帧 = [frequency, intensity]\n' +
        '• frequency: 10-1000 (Hz)，越高越密集。常用值 10-30\n' +
        '• intensity: 0-100 (%)，刺激强度百分比\n' +
        '• 帧速率为 10 fps（每帧 = 100ms），总时长 = 帧数 × 100ms\n\n' +
        '**设计建议**：\n' +
        '• 帧数限制 3-50 帧（0.3-5秒）\n' +
        '• 简单节奏用少量帧，如心跳：[[10,100],[10,0],[10,100],[10,0]]\n' +
        '• 复杂节奏可用更多帧，如渐强：[[10,0],[10,20],[10,40],[10,60],[10,80],[10,100]]',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '波形名称，中文或英文，如 "心跳"、"渐强脉冲"。用于后续 start/change_wave 时引用。',
          },
          description: {
            type: 'string',
            description: '波形描述，说明其特点和使用场景，如 "模拟心跳节奏，适合快节奏刺激"。',
          },
          frames: {
            type: 'array',
            description: `帧数组，每帧 [frequency, intensity]。频率 ${MIN_FREQUENCY}-${MAX_FREQUENCY}Hz，强度 ${MIN_INTENSITY}-${MAX_INTENSITY}。帧数 ${MIN_WAVEFORM_FRAMES}-${MAX_WAVEFORM_FRAMES} 帧。`,
            items: {
              type: 'array',
              items: { type: 'number' },
              minItems: 2,
              maxItems: 2,
            },
            minItems: MIN_WAVEFORM_FRAMES,
            maxItems: MAX_WAVEFORM_FRAMES,
          },
        },
        required: ['name', 'frames'],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Static handler map — handlers don't depend on waveform library state, they
// resolve a waveform by id at execution time via resolveWaveform(). Keeping
// this map static (rather than rebuilding per call) avoids churn on every
// tool invocation.
// ---------------------------------------------------------------------------

type Handler = (args: any) => any;

const HANDLERS: Record<string, Handler> = {
  start({ channel, strength, waveform, loop }) {
    const requested = num(strength);
    const startCapped = Math.min(requested, MAX_START_STRENGTH);
    const safe = clamp(startCapped, channel);
    const wf = resolveWaveform(String(waveform));
    bt.setStrength(channel, safe.value);
    bt.sendWave(channel, wf.frames, loop !== false);
    return {
      channel,
      strength: { requested, actual: safe.value, limited: safe.value !== requested },
      waveform: { id: wf.id, name: wf.name },
      loop: loop !== false,
    };
  },

  stop({ channel }) {
    if (channel) {
      cancelBurstRestore(normChannel(channel));
      bt.setStrength(channel, 0);
      bt.stopWave(channel);
      return { channel, stopped: true };
    }
    cancelBurstRestore('all');
    bt.setStrength('A', 0);
    bt.setStrength('B', 0);
    bt.stopWave(null);
    return { channel: 'all', stopped: true };
  },

  adjust_strength({ channel, delta }) {
    const deltaN = num(delta);
    const status = bt.getStatus();
    const current = channel.toUpperCase() === 'A' ? status.strengthA : status.strengthB;
    const safe = clamp(current + deltaN, channel);
    const actualDelta = safe.value - current;
    if (actualDelta !== 0) bt.addStrength(channel, actualDelta);
    return { channel, requestedDelta: deltaN, actualDelta, result: safe.value, limited: safe.limited };
  },

  change_wave({ channel, waveform, loop }) {
    const wf = resolveWaveform(String(waveform));
    bt.sendWave(channel, wf.frames, loop !== false);
    return { channel, waveform: { id: wf.id, name: wf.name }, loop: loop !== false };
  },

  burst({ channel, strength, duration_ms }) {
    const ch = normChannel(channel);
    const status = bt.getStatus();
    const current = ch === 'A' ? status.strengthA : status.strengthB;
    const waveActive = ch === 'A' ? status.waveActiveA : status.waveActiveB;

    // Cold-launching at high strength is exactly what MAX_START_STRENGTH
    // is meant to prevent; burst would be a trivial bypass otherwise.
    if (current <= 0 || !waveActive) {
      throw new Error(
        `通道 ${ch} 当前未在运行 (strength=${current}, waveActive=${waveActive})，burst 只能在已启动的通道上使用。请先用 start 启动通道，再调用 burst。`,
      );
    }

    const requestedStrength = num(strength);
    const requestedDuration = num(duration_ms);
    const clampedDuration = Math.min(Math.max(100, requestedDuration), MAX_BURST_DURATION_MS);
    const safeTarget = clamp(requestedStrength, ch);

    // Normally prevented by the per-turn cap, but kept as a safety net so
    // `prev` is well-defined when there's a prior pending restore.
    cancelBurstRestore(ch);

    const prev = current;
    bt.setStrength(ch, safeTarget.value);

    const timer = setTimeout(() => {
      // Safety floor: at restore time the strength MUST NOT remain above
      // prev. min(currentStrength, prev) guarantees:
      //   - elevated strength always comes down (the safety contract)
      //   - a strength that has already been lowered is not re-raised
      //   - stop() leaves the channel at 0 (min(0, prev) = 0)
      const nowStatus = bt.getStatus();
      const nowCurrent = ch === 'A' ? nowStatus.strengthA : nowStatus.strengthB;
      const safePrev = clamp(prev, ch).value;
      const target = Math.min(nowCurrent, safePrev);
      if (target !== nowCurrent) bt.setStrength(ch, target);
      burstRestores.delete(ch);
    }, clampedDuration);

    burstRestores.set(ch, timer);

    return {
      channel: ch,
      burst: {
        from: prev,
        to: { requested: requestedStrength, actual: safeTarget.value, limited: safeTarget.limited },
      },
      duration_ms: {
        requested: requestedDuration,
        actual: clampedDuration,
        limited: clampedDuration !== requestedDuration,
      },
      willRestoreAt: Date.now() + clampedDuration,
      _note: `${clampedDuration}ms 后强度必定回落到不高于 ${prev} 的水平——这是安全硬保证，不会因为其它工具调用而取消。`,
    };
  },

  create_waveform({ name, description, frames }) {
    if (!Array.isArray(frames) || frames.length < MIN_WAVEFORM_FRAMES) {
      throw new Error(`frames 必须至少包含 ${MIN_WAVEFORM_FRAMES} 帧`);
    }
    if (frames.length > MAX_WAVEFORM_FRAMES) {
      throw new Error(`frames 最多 ${MAX_WAVEFORM_FRAMES} 帧，当前 ${frames.length} 帧`);
    }

    const validatedFrames: WaveFrame[] = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (!Array.isArray(frame) || frame.length !== 2) {
        throw new Error(`第 ${i + 1} 帧格式错误，应为 [frequency, intensity]`);
      }
      const [freq, intensity] = frame;
      const freqNum = Number(freq);
      const intensityNum = Number(intensity);

      if (!Number.isFinite(freqNum) || freqNum < MIN_FREQUENCY || freqNum > MAX_FREQUENCY) {
        throw new Error(`第 ${i + 1} 帧 frequency 超出范围 ${MIN_FREQUENCY}-${MAX_FREQUENCY}Hz`);
      }
      if (!Number.isFinite(intensityNum) || intensityNum < MIN_INTENSITY || intensityNum > MAX_INTENSITY) {
        throw new Error(`第 ${i + 1} 帧 intensity 超出范围 ${MIN_INTENSITY}-${MAX_INTENSITY}%`);
      }

      validatedFrames.push([freqNum, intensityNum]);
    }

    const waveform = waveforms.addWaveform({
      name: String(name || '自定义波形').trim() || '自定义波形',
      description: String(description || '').trim(),
      frames: validatedFrames,
    });

    return {
      success: true,
      id: waveform.id,
      name: waveform.name,
      description: waveform.description,
      frameCount: validatedFrames.length,
      duration_ms: validatedFrames.length * 100,
      usage: `创建成功！可使用 start(channel=A, waveform=${waveform.id}) 或 change_wave(channel=A, waveform=${waveform.id}) 立即播放此波形`,
      _note: `波形已添加到库中，可在设置页面的"波形"标签页查看和管理`,
    };
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function getTools(): ToolDef[] {
  return buildToolDefs();
}

export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) return JSON.stringify({ error: `Unknown tool: ${name}` });

  // Centralised disconnect guard: every tool in the registry is now
  // mutating, so we can fail fast unconditionally if the device isn't
  // connected. The friendly error tells the model to ask the user to
  // reconnect rather than retrying with the same args.
  if (!bt.getStatus().connected) {
    return JSON.stringify({
      error: '设备未连接，无法执行该操作。请告知用户先在 App 内连接郊狼设备，再继续。',
      deviceState: snap(),
    });
  }

  try {
    const result = handler(args);
    return JSON.stringify({
      success: true,
      ...result,
      deviceState: snap(),
      _hint: '以上 deviceState 是设备当前真实状态，请根据此状态回复用户。',
    });
  } catch (err: unknown) {
    console.error(`[tools] ${name}:`, err);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
