import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriUpdateChecker, isNewerVersion, type UpdateStorage } from './update-checker.js';

function memoryStorage(): UpdateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

function fetchReturning(tagName: string | undefined, htmlUrl = 'https://example.com/release') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ tag_name: tagName, html_url: htmlUrl }),
  });
}

describe('isNewerVersion', () => {
  it('detects a newer patch version', () => {
    expect(isNewerVersion('5.4.2', '5.4.1')).toBe(true);
  });

  it('detects a newer minor/major version', () => {
    expect(isNewerVersion('6.0.0', '5.4.9')).toBe(true);
    expect(isNewerVersion('5.5.0', '5.4.9')).toBe(true);
  });

  it('is false for an equal or older version', () => {
    expect(isNewerVersion('5.4.1', '5.4.1')).toBe(false);
    expect(isNewerVersion('5.4.0', '5.4.1')).toBe(false);
  });

  it('handles differing segment counts', () => {
    expect(isNewerVersion('5.4', '5.4.0')).toBe(false);
    expect(isNewerVersion('5.4.1', '5.4')).toBe(true);
  });
});

describe('TauriUpdateChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports hasUpdate when the release tag is newer than the running version', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('v5.4.2'),
    });

    await checker['checkOnce']();

    const status = checker.getStatus();
    expect(status.hasUpdate).toBe(true);
    expect(status.latestVersion).toBe('5.4.2');
    expect(status.releaseUrl).toBe('https://example.com/release');
  });

  it('does not report hasUpdate when already on the latest version', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.2',
      fetchImpl: fetchReturning('v5.4.2'),
    });

    await checker['checkOnce']();

    expect(checker.getStatus().hasUpdate).toBe(false);
  });

  it('dismiss() persists per-version and survives a fresh checker instance', async () => {
    const storage = memoryStorage();
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage,
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('v5.4.2'),
    });

    await checker['checkOnce']();
    checker.dismiss();
    expect(checker.getStatus().hasUpdate).toBe(false);

    const reopened = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage,
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('v5.4.2'),
    });
    await reopened['checkOnce']();
    expect(reopened.getStatus().hasUpdate).toBe(false);
    expect(reopened.getStatus().dismissed).toBe(true);
  });

  it('a dismissed version does not suppress a subsequent, newer release', async () => {
    const storage = memoryStorage();
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage,
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('v5.4.2'),
    });
    await checker['checkOnce']();
    checker.dismiss();

    checker['options'].fetchImpl = fetchReturning('v5.4.3');
    await checker['checkOnce']();

    expect(checker.getStatus().hasUpdate).toBe(true);
    expect(checker.getStatus().latestVersion).toBe('5.4.3');
  });

  it('ignores a malformed response instead of throwing', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning(undefined),
    });

    await expect(checker['checkOnce']()).resolves.toBeUndefined();
    expect(checker.getStatus().hasUpdate).toBe(false);
  });

  it('ignores a network error instead of throwing', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(checker['checkOnce']()).resolves.toBeUndefined();
    expect(checker.getStatus().hasUpdate).toBe(false);
  });

  it('start() schedules an initial check and subsequent polls', async () => {
    const fetchImpl = fetchReturning('v5.4.2');
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl,
      firstCheckDelayMs: 1_000,
      pollIntervalMs: 10_000,
    });

    checker.start();
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    checker.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('subscribe() delivers the current status immediately and on change', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/DG-Agent',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('v5.4.2'),
    });

    const statuses: boolean[] = [];
    checker.subscribe((status) => statuses.push(status.hasUpdate));

    await checker['checkOnce']();

    expect(statuses).toEqual([false, true]);
  });
});
