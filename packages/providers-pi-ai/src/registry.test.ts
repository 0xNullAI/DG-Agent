import { describe, expect, it, vi } from 'vitest';

// Regression for the cache-poisoning bug: a rejected provider load must not
// be cached forever, or every subsequent call for that provider replays the
// same rejection for the rest of the page session (e.g. after a transient
// chunk-load failure) with no way to recover short of a reload.
describe('loadPiAiProvider caching', () => {
  it('does not cache a rejected load — a later call retries', async () => {
    vi.resetModules();
    let calls = 0;

    vi.doMock('@earendil-works/pi-ai/providers/anthropic', () => ({
      anthropicProvider: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('chunk load failed');
        }
        return { id: 'anthropic', getModels: () => [], baseUrl: 'https://api.anthropic.com' };
      },
    }));

    const { loadPiAiProvider } = await import('./registry.js');

    await expect(loadPiAiProvider('anthropic')).rejects.toThrow('chunk load failed');

    const provider = await loadPiAiProvider('anthropic');
    expect(provider.id).toBe('anthropic');
    expect(calls).toBe(2);

    vi.doUnmock('@earendil-works/pi-ai/providers/anthropic');
  });
});
