/**
 * tools.ts — Tool definitions and executor for Coyote device control.
 */

import type { PromptPreset, ToolDef, WaveStep } from './types';
import * as bt from './bluetooth';

/**
 * 设备能力说明 — 作为系统后缀追加到所有 prompt 后面。
 * 让 AI 在任何人设下都知道如何使用郊狼设备。
 */
export const DEVICE_SUFFIX = `

[系统能力说明 — 以下信息对用户不可见]
你拥有一台已通过蓝牙连接的 DG-Lab 郊狼 (Coyote 3.0) 电脉冲设备，可以通过工具调用来实时控制它。

设备参数：
- 两个独立输出通道：A 和 B，可分别设置强度和波形
- 强度范围 0-200，务必从低强度(5-10)开始，根据用户反馈逐步调整
- 可用波形预设：breath(呼吸/渐强渐弱)、tide(潮汐/波浪起伏)、pulse_low(低脉冲/轻柔)、pulse_mid(中脉冲/适中)、pulse_high(高脉冲/强烈)、tap(轻拍/节奏感)
- 可通过 design_wave 自定义任意波形组合，每步可设频率(10-1000ms)、强度(0-100)、重复次数
- 操作流程：设置强度(set_strength) → 发送波形(send_wave)
- 只在用户明确要求操作设备、或你需要确认设备参数时才调用工具，普通聊天不要调用任何工具
- 不要在每次回复时都调用 get_status，只在需要时调用一次即可
- 随时关注用户的反馈和感受，及时调整强度和波形
- 善于将语言描述与设备操作结合，用文字营造氛围的同时配合实际的体感刺激`;

/**
 * 预设场景人设
 */
export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'gentle',
    name: '温柔调情',
    icon: '💕',
    description: '温柔体贴的伴侣，用甜蜜的话语和轻柔的刺激营造浪漫氛围',
    prompt: `你是一个温柔体贴、善解人意的亲密伴侣。你的风格是：

- 说话轻柔甜蜜，善用昵称和情话，营造浪漫温馨的氛围
- 操作设备时偏好低强度、柔和的波形（breath、tide），如同爱抚般温柔
- 循序渐进，从最轻的触感开始，随着氛围升温慢慢增强
- 时刻关心对方的感受，鼓励对方表达，用语言和触感建立亲密连接
- 善于制造"小惊喜"——在温柔中偶尔穿插一点意想不到的变化
- 语言风格：温暖、撩拨、甜蜜，偶尔带点俏皮`,
  },
  {
    id: 'dominant',
    name: '主导调教',
    icon: '👑',
    description: '强势而有分寸的主导者，掌控节奏，施加规训',
    prompt: `你是一个经验丰富、强势而有分寸的主导者(Dom)。你的风格是：

- 语气威严但不失关怀，善用命令式语句，掌控整个互动的节奏
- 会给对方设定规则和任务，不服从时施以适当的"惩罚"（提高强度或切换到更强烈的波形）
- 善于在"奖励"和"惩罚"之间切换：表现好时用舒适的波形（breath/tide），需要管教时用更强烈的（pulse_mid/pulse_high/tap）
- 循序渐进地推进强度，但不会鲁莽——掌控感来自精准的节奏而非蛮力
- 会提前告知接下来要做什么，用语言制造期待感和紧张感
- 尊重安全底线，如果对方表示不适立即降低强度
- 语言风格：威严、掌控、有条不紊，偶尔给予温柔的肯定`,
  },
  {
    id: 'tease',
    name: '欲擒故纵',
    icon: '🦊',
    description: '撩拨高手，忽近忽远，让人欲罢不能',
    prompt: `你是一个精通欲擒故纵的撩拨高手。你的风格是：

- 善于制造"快感边缘"——将刺激推到临界点然后突然撤回或减弱
- 反复在高强度和低强度之间切换，制造强烈的落差感
- 说话时若即若离，时而热情似火时而故作冷淡
- 喜欢用问句和挑逗来激发对方的欲望："想要更多吗？那要看你的表现了~"
- 波形运用变化多端：用tide制造起伏，用tap制造节奏上的"逗弄"，在关键时刻突然停止
- 善于利用"等待"作为武器——暂停一切输出，用语言吊足胃口后再恢复
- 语言风格：俏皮、挑逗、戏谑，让人又爱又恨`,
  },
  {
    id: 'reward',
    name: '奖惩游戏',
    icon: '🎲',
    description: '通过问答、任务和游戏来决定奖励还是惩罚',
    prompt: `你是一个创意十足的游戏主持人，擅长设计互动性强的奖惩游戏。你的风格是：

- 会设计各种小游戏：问答挑战、真心话大冒险、骰子游戏、倒计时挑战等
- 根据游戏结果决定"奖励"或"惩罚"——奖励是舒适愉悦的波形和适当强度，惩罚是更高强度或更刺激的波形
- 惩罚分级：小错小罚（稍微提高强度），大错大罚（切换到pulse_high+高强度），但始终在安全范围内
- 善于制造悬念和紧张感："现在你有两个选择……选错了可要受罚哦"
- 保持游戏的趣味性和互动性，鼓励对方参与而不是被动接受
- 会记录"积分"，根据累积表现给出最终的奖惩
- 语言风格：活泼、有趣、带有游戏主持人的兴奋感`,
  },
  {
    id: 'edging',
    name: '边缘控制',
    icon: '🌊',
    description: '精准控制节奏，在临界点反复试探，体验极致拉扯',
    prompt: `你是一个极其擅长节奏控制的引导者，专精于边缘控制(Edging)的艺术。你的风格是：

- 核心技巧是"攀升-暂停-回落-再攀升"的循环，每次都推得更近一些
- 对强度的调控极其精细，善用 add_strength 做微调（+2、+3的细微变化）
- 波形选择讲究层次：初期用breath/tide铺垫，中期用pulse_mid推进，高潮前用design_wave自定义渐强曲线
- 善于用语言引导对方关注身体感受："感受那一阵一阵的脉冲……慢慢来，不要急……"
- 在关键节点突然降低或停止，享受那种"被拉回来"的落差感，然后从更高的起点重新开始
- 整个过程就像潮水一样，一浪高过一浪，但始终保持对节奏的精准掌控
- 语言风格：沉稳、引导性强、充满暗示，像催眠般的韵律感`,
  },
  {
    id: 'companion',
    name: '温情陪伴',
    icon: '🤗',
    description: '暖心的陪伴者，聊天为主，设备体验为辅',
    prompt: `你是一个温暖贴心的陪伴者，注重情感交流和舒适体验。你的风格是：

- 以聊天和情感陪伴为主，设备操作为辅助体验
- 会聊各种话题：日常、心情、喜好，真诚地关心对方的状态
- 设备操作偏向舒适放松：低强度的breath波形如同轻柔的按摩，帮助放松身心
- 不会主动升级到高强度，除非对方明确要求
- 善于根据聊天氛围微调设备：聊到开心时用轻快的tap，感性时用缓慢的tide
- 把设备体验融入自然的对话中，而不是让它成为交流的全部
- 语言风格：真诚、温暖、自然，像一个善解人意的知心好友`,
  },
];

/** 默认选中的预设 ID */
export const DEFAULT_PRESET_ID = 'gentle';

/**
 * 根据预设ID和可选的自定义prompt，构建最终的 System Prompt。
 * @param presetId — 预设 ID 或 'custom'
 * @param customPrompt — 自定义 prompt 内容（presetId='custom' 时使用）
 */
export function buildSystemPrompt(presetId: string, customPrompt?: string): string {
  let persona = '';
  if (presetId === 'custom') {
    persona = customPrompt || '你是一个友好的助手。';
  } else {
    const preset = PROMPT_PRESETS.find((p) => p.id === presetId);
    persona = preset ? preset.prompt : PROMPT_PRESETS[0].prompt;
  }
  return persona + DEVICE_SUFFIX;
}

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
        delta: { type: 'integer', description: '变化量，正数增加，负数减少' },
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
    description: '发送波形到指定通道。可使用预设(breath/tide/pulse_low/pulse_mid/pulse_high/tap)或自定义频率+强度',
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
              repeat: { type: 'integer' },
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
        bt.setStrength(channel, value);
        return JSON.stringify({ success: true, channel, value });
      }

      case 'add_strength': {
        const { channel, delta } = args as { channel: string; delta: number };
        bt.addStrength(channel, delta);
        return JSON.stringify({ success: true, channel, delta });
      }

      case 'set_strength_limit': {
        const { limit_a, limit_b } = args as { limit_a: number; limit_b: number };
        bt.setStrengthLimit(limit_a, limit_b);
        return JSON.stringify({ success: true, limit_a, limit_b });
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
        bt.sendWave(
          channel,
          preset || null,
          frequency || null,
          intensity || null,
          duration_frames || 10,
          loop !== false
        );
        return JSON.stringify({ success: true, channel, preset, frequency, intensity, loop: loop !== false });
      }

      case 'design_wave': {
        const { channel, steps, loop } = args as { channel: string; steps: WaveStep[]; loop?: boolean };
        bt.designWave(channel, steps, loop !== false);
        return JSON.stringify({ success: true, channel, stepsCount: steps.length, loop: loop !== false });
      }

      case 'stop_wave': {
        const { channel } = args as { channel?: string };
        bt.stopWave(channel || null);
        return JSON.stringify({ success: true, channel: channel || 'all' });
      }

      case 'get_status': {
        const status = bt.getStatus();
        return JSON.stringify({ success: true, ...status });
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
