import type { BridgePlatform, MessageOrigin, PlatformAdapter } from './bridge-types.js';

export function getBridgePlatform(sourceType: string): BridgePlatform | null {
  return sourceType === 'qq' || sourceType === 'telegram' ? sourceType : null;
}

export function createBridgeSessionId(origin: MessageOrigin): string {
  return `bridge:${origin.platform}:${origin.userId}`;
}

export async function requestPermissionRemote(
  adapter: PlatformAdapter,
  userId: string,
  toolName: string,
  toolDisplayName: string | undefined,
  summary: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<
  | { type: 'approve-once' }
  | { type: 'approve-scoped'; expiresAt?: number }
  | { type: 'deny'; reason?: string }
> {
  const timedExpiry = Date.now() + 5 * 60_000;
  const prompt =
    `AI 请求权限以操作设备。\n` +
    `工具：${toolDisplayName ?? toolName}\n` +
    `说明：${summary}\n\n` +
    `参数：\n${safeFormatArgs(args)}\n\n` +
    `回复 1 允许本次，2 允许 5 分钟，3 允许本会话，4 拒绝。`;

  try {
    await adapter.sendMessage(userId, prompt);
  } catch {
    return { type: 'deny', reason: '发送远程权限请求失败。' };
  }

  const reply = await adapter.waitForReply(userId, timeoutMs);
  if (reply === null) {
    try {
      await adapter.sendMessage(userId, '权限请求已超时，系统已自动拒绝这次操作。');
    } catch {
      // Ignore follow-up send failures.
    }
    return { type: 'deny', reason: '远程权限请求已超时。' };
  }

  const trimmed = reply.trim();
  switch (trimmed) {
    case '1':
      return { type: 'approve-once' };
    case '2':
      return { type: 'approve-scoped', expiresAt: timedExpiry };
    case '3':
      return { type: 'approve-scoped' };
    case '4':
      return { type: 'deny', reason: '远程用户拒绝了这次请求。' };
    default:
      try {
        await adapter.sendMessage(userId, `无效选项“${trimmed}”。下次请回复 1、2、3 或 4。`);
      } catch {
        // Ignore follow-up send failures.
      }
      return { type: 'deny', reason: '远程用户拒绝了这次请求。' };
  }
}

function safeFormatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
