import type { DeviceCommand, RuntimeEvent, SessionSnapshot } from '@dg-agent/core';

export function getSessionTitle(session: SessionSnapshot): string {
  const firstUserMessage = session.messages
    .find((message) => message.role === 'user')
    ?.content?.trim();
  if (!firstUserMessage) return '新对话';
  return firstUserMessage.slice(0, 36);
}

export function getSessionPreview(session: SessionSnapshot): string {
  const lastMessage = session.messages.at(-1)?.content?.trim();
  if (!lastMessage) return '还没有消息';
  return lastMessage.slice(0, 60);
}

export function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

export function formatUiErrorMessage(error: unknown): string {
  const rawMessage =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? '发生未知错误');

  const normalizedMessage = rawMessage
    .trim()
    .replace(/^(DOMException|TypeError|Error|AbortError):\s*/i, '');

  if (!normalizedMessage) {
    return '发生未知错误';
  }

  if (isBluetoothChooserCancelledError(error)) {
    return '你已取消设备选择';
  }

  if (
    normalizedMessage.includes(
      "Failed to execute 'requestDevice' on 'Bluetooth': Must be handling a user gesture",
    )
  ) {
    return '请通过页面上的连接按钮手动选择设备';
  }

  return normalizedMessage;
}

export function isBluetoothChooserCancelledError(error: unknown): boolean {
  const rawMessage =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? '');
  const normalizedMessage = rawMessage
    .trim()
    .replace(/^(DOMException|TypeError|Error|AbortError):\s*/i, '');
  return normalizedMessage.includes('User cancelled the requestDevice() chooser');
}

export function getRecentToolActivities(
  events: RuntimeEvent[],
): Array<{ kind: 'proposed' | 'executed' | 'denied'; text: string }> {
  return events
    .filter(
      (event) =>
        event.type === 'tool-call-proposed' ||
        event.type === 'device-command-executed' ||
        event.type === 'tool-call-failed' ||
        event.type === 'tool-call-denied' ||
        event.type === 'timer-scheduled' ||
        event.type === 'timer-fired',
    )
    .slice(0, 6)
    .map((event) => {
      switch (event.type) {
        case 'tool-call-proposed':
          return {
            kind: 'proposed' as const,
            text: `请求工具：${event.toolCall.displayName ?? event.toolCall.name}`,
          };
        case 'tool-call-denied':
          return {
            kind: 'denied' as const,
            text: `工具被拒绝：${event.toolCall.displayName ?? event.toolCall.name} · ${event.reason}`,
          };
        case 'tool-call-failed':
          return {
            kind: 'denied' as const,
            text: `工具执行失败：${event.toolCall.displayName ?? event.toolCall.name} · ${event.error}`,
          };
        case 'device-command-executed':
          return {
            kind: 'executed' as const,
            text: `已执行：${formatCommandSummary(event.command)}`,
          };
        case 'timer-scheduled':
          return {
            kind: 'proposed' as const,
            text: `已设定定时：${event.label}`,
          };
        case 'timer-fired':
          return {
            kind: 'executed' as const,
            text: `定时已触发：${event.label}`,
          };
      }
    });
}

export function getChatNotices(
  events: RuntimeEvent[],
): Array<{ kind: 'tool' | 'system' | 'warning'; text: string }> {
  return events
    .filter(
      (event) =>
        event.type === 'device-command-executed' ||
        event.type === 'assistant-message-aborted' ||
        event.type === 'tool-call-failed' ||
        event.type === 'tool-call-denied' ||
        event.type === 'timer-scheduled' ||
        event.type === 'timer-fired' ||
        event.type === 'runtime-warning',
    )
    .slice(0, 8)
    .map((event) => {
      switch (event.type) {
        case 'device-command-executed':
          return {
            kind: 'tool' as const,
            text: `工具已执行：${formatCommandSummary(event.command)}`,
          };
        case 'assistant-message-aborted':
          return {
            kind: 'system' as const,
            text: '已停止当前回复',
          };
        case 'tool-call-denied':
          return {
            kind: 'warning' as const,
            text: `工具被拒绝：${event.toolCall.displayName ?? event.toolCall.name} · ${event.reason}`,
          };
        case 'tool-call-failed':
          return {
            kind: 'warning' as const,
            text: `工具执行失败：${event.toolCall.displayName ?? event.toolCall.name} · ${event.error}`,
          };
        case 'timer-scheduled':
          return {
            kind: 'system' as const,
            text: `已设定定时：${event.label}`,
          };
        case 'timer-fired':
          return {
            kind: 'system' as const,
            text: `定时已触发：${event.label}`,
          };
        case 'runtime-warning':
          return {
            kind: 'warning' as const,
            text: event.message,
          };
      }
    });
}

export function clampStrengthSetting(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(200, Math.round(parsed)));
}

export function parseCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatCommandSummary(command: DeviceCommand): string {
  switch (command.type) {
    case 'start':
      return `启动 ${command.channel} · 强度 ${command.strength}`;
    case 'stop':
      return command.channel ? `停止 ${command.channel}` : '停止全部';
    case 'adjustStrength':
      return `调整 ${command.channel} ${command.delta > 0 ? '+' : ''}${command.delta}`;
    case 'changeWave':
      return `切换波形 ${command.channel} → ${command.waveform.id}`;
    case 'burst':
      return `脉冲 ${command.channel} · ${command.strength} · ${command.durationMs}ms`;
    case 'emergencyStop':
      return '紧急停止';
  }
}
