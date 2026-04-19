/**
 * permission-bridge.ts — Remote permission confirmation via social platform messages.
 *
 * When the AI wants to call a mutating tool and the turn originated from a
 * social platform user, we can't pop a browser dialog. Instead we send a
 * descriptive message to the platform and wait for the user's numeric reply.
 */

import type { PlatformAdapter } from './adapter';
import { describeToolCall } from '../agent/tool-describe';
import type { PermissionChoice } from '../agent/permissions';

const PERMISSION_TIMEOUT_MS = 30_000;

const CHOICE_MAP: Record<string, PermissionChoice> = {
  '1': 'once',
  '2': 'timed',
  '3': 'always',
  '4': 'deny',
};

/**
 * Ask a remote user (via their platform adapter) to approve or deny a tool call.
 * Returns the user's choice, or 'deny' on timeout.
 */
export async function requestPermissionRemote(
  adapter: PlatformAdapter,
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<PermissionChoice> {
  const description = describeToolCall(toolName, args);

  const prompt =
    `AI 请求操作设备\n` +
    `工具: ${toolName}\n` +
    `说明: ${description}\n\n` +
    `回复数字选择：\n` +
    `1. 允许本次\n` +
    `2. 5分钟内都允许\n` +
    `3. 总是允许（本会话）\n` +
    `4. 拒绝`;

  try {
    await adapter.sendMessage(userId, prompt);
  } catch (err) {
    console.error('[PermissionBridge] Failed to send permission request:', err);
    return 'deny';
  }

  const reply = await adapter.waitForReply(userId, PERMISSION_TIMEOUT_MS);

  if (reply === null) {
    try {
      await adapter.sendMessage(userId, '权限确认超时，已自动拒绝。');
    } catch {
      /* ignore */
    }
    return 'deny';
  }

  const trimmed = reply.trim();
  const choice = CHOICE_MAP[trimmed];

  if (!choice) {
    try {
      await adapter.sendMessage(userId, `无效选择「${trimmed}」，已自动拒绝。请回复 1-4。`);
    } catch {
      /* ignore */
    }
    return 'deny';
  }

  return choice;
}
