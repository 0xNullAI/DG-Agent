import type { RuntimeEvent, RuntimeTraceEntry } from '@dg-agent/core';

export interface TraceFeedItem {
  id: string;
  text: string;
  createdAt: number;
}

export function buildTraceFeed(entries: RuntimeTraceEntry[]): TraceFeedItem[] {
  return entries
    .flatMap((entry) => {
      const text = formatTraceEntry(entry);
      if (!text) return [];
      return [
        {
          id: entry.id,
          text,
          createdAt: entry.createdAt,
        },
      ];
    })
    .sort((left, right) => left.createdAt - right.createdAt);
}

let liveTraceCounter = 0;

export function buildLiveTraceFeedItemFromEvent(event: RuntimeEvent): TraceFeedItem | null {
  const id = `live-${++liveTraceCounter}`;
  const createdAt = Date.now();

  switch (event.type) {
    case 'device-command-executed': {
      const cmd = event.command;
      let text: string;
      if (cmd.type === 'start') {
        text = `已执行：启动 ${cmd.channel}，强度 ${cmd.strength}，波形 ${cmd.waveform.id}`;
      } else if (cmd.type === 'stop') {
        text = cmd.channel ? `已执行：停止 ${cmd.channel}` : '已执行：停止全部通道';
      } else if (cmd.type === 'adjustStrength') {
        text = `已执行：调整 ${cmd.channel} 强度 ${cmd.delta > 0 ? '+' : ''}${cmd.delta}`;
      } else if (cmd.type === 'changeWave') {
        text = `已执行：切换 ${cmd.channel} 波形为 ${cmd.waveform.id}`;
      } else if (cmd.type === 'burst') {
        text = `已执行：${cmd.channel} 通道脉冲到 ${cmd.strength}，持续 ${cmd.durationMs}ms`;
      } else if (cmd.type === 'emergencyStop') {
        text = '已执行：紧急停止';
      } else {
        return null;
      }
      return { id, text, createdAt };
    }
    case 'tool-call-denied':
      return {
        id,
        text: `未执行：${event.toolCall.displayName ?? event.toolCall.name}。原因：${event.reason}`,
        createdAt,
      };
    case 'tool-call-failed':
      return {
        id,
        text: `执行失败：${event.toolCall.displayName ?? event.toolCall.name}。原因：${event.error}`,
        createdAt,
      };
    case 'timer-scheduled':
      return {
        id,
        text: `已设定定时：${event.label}（${Math.round((event.dueAt - Date.now()) / 1000)}s 后）`,
        createdAt,
      };
    default:
      return null;
  }
}

function formatTraceEntry(entry: RuntimeTraceEntry): string | null {
  switch (entry.kind) {
    case 'tool-result':
      return formatExecutedTrace(entry);
    case 'tool-denied':
      return `未执行：${entry.toolDisplayName ?? entry.toolName ?? '工具'}。原因：${entry.detail ?? '未知原因。'}`;
    case 'tool-failed':
      return `执行失败：${entry.toolDisplayName ?? entry.toolName ?? '工具'}。原因：${entry.detail ?? '未知错误。'}`;
    case 'timer-scheduled':
      return entry.label && typeof entry.seconds === 'number'
        ? `已设定定时：${entry.label}（${entry.seconds} 秒后）`
        : null;
    default:
      return null;
  }
}

function formatExecutedTrace(entry: RuntimeTraceEntry): string | null {
  if (!entry.toolName) return null;
  switch (entry.toolName) {
    case 'start': {
      const channel = typeof entry.args?.channel === 'string' ? entry.args.channel : '通道';
      const strength =
        typeof entry.args?.strength === 'number' ? entry.args.strength : entry.args?.strength;
      const waveformId =
        typeof entry.args?.waveformId === 'string'
          ? entry.args.waveformId
          : typeof entry.args?.waveform === 'string'
            ? entry.args.waveform
            : '默认';
      return `已执行：启动 ${channel}，强度 ${strength ?? 0}，波形 ${waveformId}`;
    }
    case 'stop': {
      const channel = typeof entry.args?.channel === 'string' ? entry.args.channel : '';
      return channel ? `已执行：停止 ${channel}` : '已执行：停止全部通道';
    }
    case 'adjust_strength': {
      const channel = typeof entry.args?.channel === 'string' ? entry.args.channel : '通道';
      const delta =
        typeof entry.args?.delta === 'number' ? entry.args.delta : Number(entry.args?.delta ?? 0);
      return `已执行：调整 ${channel} 强度 ${delta > 0 ? '+' : ''}${delta}`;
    }
    case 'change_wave': {
      const channel = typeof entry.args?.channel === 'string' ? entry.args.channel : '通道';
      const waveformId =
        typeof entry.args?.waveformId === 'string'
          ? entry.args.waveformId
          : typeof entry.args?.waveform === 'string'
            ? entry.args.waveform
            : '默认';
      return `已执行：切换 ${channel} 波形为 ${waveformId}`;
    }
    case 'burst': {
      const channel = typeof entry.args?.channel === 'string' ? entry.args.channel : '通道';
      const strength =
        typeof entry.args?.strength === 'number'
          ? entry.args.strength
          : Number(entry.args?.strength ?? 0);
      const durationMs =
        typeof entry.args?.durationMs === 'number'
          ? entry.args.durationMs
          : typeof entry.args?.duration_ms === 'number'
            ? entry.args.duration_ms
            : Number(entry.args?.durationMs ?? entry.args?.duration_ms ?? 0);
      return `已执行：${channel} 通道脉冲到 ${strength}，持续 ${durationMs}ms`;
    }
    case 'emergency_stop':
      return '已执行：紧急停止';
    default:
      return `已执行：${entry.toolDisplayName ?? entry.toolName}`;
  }
}
