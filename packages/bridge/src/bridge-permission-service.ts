import type { PermissionRequest } from '@dg-agent/core';
import type { PermissionDecision } from '@dg-agent/core';
import { getBridgePlatform, requestPermissionRemote } from './bridge-utils.js';
import type { BridgePermissionServiceOptions } from './bridge-types.js';

export class BridgePermissionService {
  private readonly confirmTimeoutMs: number;
  private readonly grants = new Map<string, number>();
  private readonly options: BridgePermissionServiceOptions;

  constructor(options: BridgePermissionServiceOptions) {
    this.options = options;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 30_000;
  }

  async request(input: PermissionRequest): Promise<PermissionDecision> {
    const platform = getBridgePlatform(input.context.sourceType);
    const userId = input.context.sourceUserId;

    if (!platform || !userId) {
      return this.options.fallback.request(input);
    }

    const platformSettings = this.options.settings[platform];
    if (platformSettings.permissionMode === 'allow-all') {
      return { type: 'approve-once' };
    }

    const grantKey = `${platform}:${userId}:${input.toolName}`;
    const now = Date.now();
    const grantUntil = this.grants.get(grantKey);
    if (typeof grantUntil === 'number') {
      if (grantUntil === Number.POSITIVE_INFINITY || now < grantUntil) {
        return {
          type: 'approve-scoped',
          expiresAt: Number.isFinite(grantUntil) ? grantUntil : undefined,
        };
      }
      this.grants.delete(grantKey);
    }

    const adapter = this.options.registry.get(platform);
    if (!adapter) {
      return { type: 'deny', reason: `${platform} 桥接适配器当前不可用` };
    }

    const decision = await requestPermissionRemote(
      adapter,
      userId,
      input.toolName,
      input.toolDisplayName,
      input.summary,
      input.args,
      this.confirmTimeoutMs,
    );

    if (decision.type === 'approve-scoped') {
      this.grants.set(grantKey, decision.expiresAt ?? Number.POSITIVE_INFINITY);
    }

    return decision;
  }

  clearGrants(): void {
    this.grants.clear();
    const fallback = this.options.fallback as { clearGrants?: () => void };
    fallback.clearGrants?.();
  }
}
