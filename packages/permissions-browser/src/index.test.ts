import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPermissionService, TIMED_PERMISSION_WINDOW_MS } from './index.js';
import type { PermissionRequest } from '@dg-agent/contracts';

function makeRequest(toolName = 'adjust_strength'): PermissionRequest {
  return {
    context: { sessionId: 's1', sourceType: 'web', traceId: 't1' },
    toolName,
    toolDisplayName: toolName,
    summary: 'test',
    args: {},
  };
}

describe('BrowserPermissionService', () => {
  describe('allow-all mode', () => {
    it('returns approve-once without calling requestFn', async () => {
      const requestFn = vi.fn();
      const svc = new BrowserPermissionService({ mode: 'allow-all', requestFn });
      const result = await svc.request(makeRequest());
      expect(result.type).toBe('approve-once');
      expect(requestFn).not.toHaveBeenCalled();
    });
  });

  describe('timed mode', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('calls requestFn on first request and caches grant for window duration', async () => {
      const requestFn = vi.fn().mockResolvedValue(true);
      const svc = new BrowserPermissionService({ mode: 'timed', requestFn });

      const first = await svc.request(makeRequest());
      expect(requestFn).toHaveBeenCalledTimes(1);
      expect(first.type).toBe('approve-scoped');

      const second = await svc.request(makeRequest());
      expect(requestFn).toHaveBeenCalledTimes(1); // not called again
      expect(second.type).toBe('approve-scoped');
    });

    it('re-prompts after timed window expires', async () => {
      const requestFn = vi.fn().mockResolvedValue(true);
      const svc = new BrowserPermissionService({ mode: 'timed', requestFn });

      await svc.request(makeRequest());
      expect(requestFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(TIMED_PERMISSION_WINDOW_MS + 1);

      await svc.request(makeRequest());
      expect(requestFn).toHaveBeenCalledTimes(2);
    });

    it('uses pre-seeded timedGrantExpiresAt without prompting', async () => {
      const requestFn = vi.fn();
      const svc = new BrowserPermissionService({
        mode: 'timed',
        timedGrantExpiresAt: Date.now() + 60_000,
        requestFn,
      });
      const result = await svc.request(makeRequest());
      expect(requestFn).not.toHaveBeenCalled();
      expect(result.type).toBe('approve-scoped');
    });
  });

  describe('confirm mode — per-tool grant cache', () => {
    it('caches approve-scoped indefinitely when no expiresAt', async () => {
      const requestFn = vi.fn().mockResolvedValue({ type: 'approve-scoped' });
      const svc = new BrowserPermissionService({ mode: 'confirm', requestFn });

      await svc.request(makeRequest('adjust_strength'));
      expect(requestFn).toHaveBeenCalledTimes(1);

      await svc.request(makeRequest('adjust_strength'));
      expect(requestFn).toHaveBeenCalledTimes(1); // cached
    });

    it('different tools each get their own cache entry', async () => {
      const requestFn = vi.fn().mockResolvedValue({ type: 'approve-scoped' });
      const svc = new BrowserPermissionService({ mode: 'confirm', requestFn });

      await svc.request(makeRequest('adjust_strength'));
      await svc.request(makeRequest('burst'));
      expect(requestFn).toHaveBeenCalledTimes(2);

      await svc.request(makeRequest('adjust_strength'));
      await svc.request(makeRequest('burst'));
      expect(requestFn).toHaveBeenCalledTimes(2); // both cached
    });

    it('evicts expired finite grant and re-prompts', async () => {
      vi.useFakeTimers();
      const expiresAt = Date.now() + 1000;
      const requestFn = vi.fn().mockResolvedValue({ type: 'approve-scoped', expiresAt });
      const svc = new BrowserPermissionService({ mode: 'confirm', requestFn });

      await svc.request(makeRequest());
      expect(requestFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2000);
      requestFn.mockResolvedValue({ type: 'approve-once' });
      await svc.request(makeRequest());
      expect(requestFn).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('deny returns Chinese guidance message and does not cache', async () => {
      const requestFn = vi.fn().mockResolvedValue(false);
      const svc = new BrowserPermissionService({ mode: 'confirm', requestFn });

      const result = await svc.request(makeRequest());
      expect(result.type).toBe('deny');
      if (result.type === 'deny') {
        expect(result.reason).toContain('用户拒绝了本次工具调用');
        expect(result.reason).toContain('不要立即用相同参数重试');
      }

      // After deny, next request should prompt again (not cached)
      requestFn.mockResolvedValue(true);
      await svc.request(makeRequest());
      expect(requestFn).toHaveBeenCalledTimes(2);
    });

    it('clearGrants removes all cached grants', async () => {
      const requestFn = vi.fn().mockResolvedValue({ type: 'approve-scoped' });
      const svc = new BrowserPermissionService({ mode: 'confirm', requestFn });

      await svc.request(makeRequest('adjust_strength'));
      await svc.request(makeRequest('burst'));
      expect(requestFn).toHaveBeenCalledTimes(2);

      svc.clearGrants();

      await svc.request(makeRequest('adjust_strength'));
      await svc.request(makeRequest('burst'));
      expect(requestFn).toHaveBeenCalledTimes(4);
    });
  });
});
