import type { SessionSnapshot } from '@dg-agent/core';

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
  return (
    normalizedMessage.includes('User cancelled the requestDevice() chooser') ||
    // Tauri Android's connect flow (apps/tauri-android/src/connect-any-device-tauri.ts)
    // cancels via @dg-kit/transport-tauri-blec's requestDgLabDeviceTauri(),
    // which throws this Chinese message instead of the Web Bluetooth one
    // above — same "user backed out, not a real error" outcome, so it needs
    // the same friendly treatment.
    normalizedMessage.includes('用户取消了设备选择')
  );
}

export function parseCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
