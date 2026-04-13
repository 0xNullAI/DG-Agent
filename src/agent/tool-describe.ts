/**
 * tool-describe.ts — Human-readable descriptions of AI tool calls.
 *
 * Shared by the UI permission dialog and the social-platform bridge so
 * both surfaces render the same copy for each tool invocation.
 */

import * as waveforms from './waveforms';

// ---------------------------------------------------------------------------
// Helpers (unexported)
// ---------------------------------------------------------------------------

function chLabel(ch: unknown): string {
  const c = typeof ch === 'string' ? ch.toUpperCase() : '';
  return c === 'A' || c === 'B' ? `${c} 通道` : '';
}

function waveLabel(id: unknown): string {
  if (typeof id !== 'string') return '';
  const w = waveforms.getById(id);
  return w ? w.name : id;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Render a (toolName, args) pair as a single human-readable sentence.
 * Falls back to a generic "调用 <name>" line for unknown tools.
 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const ch = chLabel(args.channel);

  switch (name) {
    case 'start': {
      const strength = args.strength;
      return `启动 ${ch || '通道'}：播放「${waveLabel(args.waveform)}」波形，强度 ${strength}`;
    }

    case 'stop': {
      if (ch) return `停止 ${ch}：强度归零并关闭波形输出`;
      return '停止所有通道：A 与 B 同时归零并关闭波形';
    }

    case 'adjust_strength': {
      const delta = Number(args.delta);
      if (!Number.isFinite(delta) || delta === 0) {
        return `${ch || '通道'} 强度微调`;
      }
      const sign = delta > 0 ? '+' : '';
      const verb = delta > 0 ? '增加' : '降低';
      return `${ch || '通道'} 强度${verb} ${sign}${delta}（在当前波形上微调）`;
    }

    case 'change_wave':
      return `${ch || '通道'} 切换波形为「${waveLabel(args.waveform)}」（强度不变）`;

    case 'burst': {
      const strength = args.strength;
      const duration = Number(args.duration_ms);
      const secs = Number.isFinite(duration) ? (duration / 1000).toFixed(1) : '?';
      return `${ch || '通道'} 短时突增：强度瞬间拉到 ${strength}，持续 ${secs} 秒后自动回落`;
    }

    default:
      return `调用工具「${name}」`;
  }
}
