import type { PermissionService, PermissionRequest } from '@dg-agent/core';
import type { PermissionDecision } from '@dg-agent/core';

export type BrowserPermissionMode = 'confirm' | 'timed' | 'allow-all';

export const TIMED_PERMISSION_WINDOW_MS = 5 * 60 * 1000;

export interface BrowserPermissionServiceOptions {
  mode: BrowserPermissionMode;
  timedGrantExpiresAt?: number;
  confirmFn?: (message: string) => boolean;
  requestFn?: (
    input: PermissionRequest,
  ) => Promise<PermissionDecision | boolean> | PermissionDecision | boolean;
}

export class BrowserPermissionService implements PermissionService {
  private readonly confirmFn: (message: string) => boolean;
  private readonly requestFn?: (
    input: PermissionRequest,
  ) => Promise<PermissionDecision | boolean> | PermissionDecision | boolean;
  private timedGrantExpiresAt = 0;
  private readonly grants = new Map<string, number>();

  constructor(private readonly options: BrowserPermissionServiceOptions) {
    this.confirmFn =
      options.confirmFn ??
      ((message) => {
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
          return false;
        }
        return window.confirm(message);
      });
    this.requestFn = options.requestFn;
    this.timedGrantExpiresAt = options.timedGrantExpiresAt ?? 0;
  }

  async request(input: PermissionRequest): Promise<PermissionDecision> {
    if (this.options.mode === 'allow-all') {
      return { type: 'approve-once' };
    }

    const grantKey = `${input.context.sessionId}:${input.toolName}`;
    const grantUntil = this.grants.get(grantKey);
    if (typeof grantUntil === 'number') {
      if (grantUntil === Number.POSITIVE_INFINITY || Date.now() < grantUntil) {
        return {
          type: 'approve-scoped',
          expiresAt: Number.isFinite(grantUntil) ? grantUntil : undefined,
        };
      }
      this.grants.delete(grantKey);
    }

    if (this.options.mode === 'timed' && Date.now() < this.timedGrantExpiresAt) {
      return { type: 'approve-scoped', expiresAt: this.timedGrantExpiresAt };
    }

    const result = this.requestFn
      ? await this.requestFn(input)
      : this.confirmFn(formatPermissionMessage(input));
    const decision = normalizeDecision(result);
    if (decision.type === 'deny') {
      return {
        type: 'deny',
        reason:
          '用户拒绝了本次工具调用。请不要立即用相同参数重试，也不要在回复里声称已经执行。改为询问用户是否愿意改用别的方式，或直接给出文字建议。',
      };
    }

    if (this.options.mode === 'timed') {
      this.timedGrantExpiresAt = Date.now() + TIMED_PERMISSION_WINDOW_MS;
      return { type: 'approve-scoped', expiresAt: this.timedGrantExpiresAt };
    }

    if (decision.type === 'approve-scoped') {
      this.grants.set(grantKey, decision.expiresAt ?? Number.POSITIVE_INFINITY);
      return decision;
    }

    return { type: 'approve-once' };
  }

  clearGrants(): void {
    this.grants.clear();
  }
}

function formatPermissionMessage(input: PermissionRequest): string {
  return [
    'AI 请求执行设备操作',
    `工具：${input.toolDisplayName ?? input.toolName}`,
    `说明：${input.summary}`,
    '',
    '参数：',
    safeFormatJson(input.args),
    '',
    '是否允许本次操作？',
  ].join('\n');
}

function safeFormatJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeDecision(value: PermissionDecision | boolean): PermissionDecision {
  if (typeof value === 'boolean') {
    return value ? { type: 'approve-once' } : { type: 'deny' };
  }
  return value;
}
