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
    `AI requests permission to operate the device.\n` +
    `Tool: ${toolName}\n` +
    `Summary: ${summary}\n\n` +
    `Args:\n${safeFormatArgs(args)}\n\n` +
    `Reply 1 to allow once, 2 to allow for 5 minutes, 3 to allow for this session, 4 to deny.`;

  try {
    await adapter.sendMessage(userId, prompt);
  } catch {
    return { type: 'deny', reason: 'Failed to send remote permission request.' };
  }

  const reply = await adapter.waitForReply(userId, timeoutMs);
  if (reply === null) {
    try {
      await adapter.sendMessage(userId, 'Permission request timed out, so the action was denied automatically.');
    } catch {
      // Ignore follow-up send failures.
    }
    return { type: 'deny', reason: 'Remote permission request timed out.' };
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
      return { type: 'deny', reason: 'Remote user denied the request.' };
    default:
      try {
        await adapter.sendMessage(userId, `Invalid choice "${trimmed}". Reply with 1, 2, 3, or 4 next time.`);
      } catch {
        // Ignore follow-up send failures.
      }
      return { type: 'deny', reason: 'Remote user denied the request.' };
  }
}

function safeFormatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
