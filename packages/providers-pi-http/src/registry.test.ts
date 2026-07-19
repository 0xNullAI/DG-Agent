import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { resolvePiAiModel } from './registry.js';

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

// Regression: an unrecognized model id used to borrow maxTokens/contextWindow
// from provider.getModels()[0] — an arbitrary, unrelated catalog entry — as
// the *actual* outbound max_tokens sent to the real API for the Anthropic
// dialect. A provider whose first catalog entry has a small maxTokens (e.g.
// an Opus-family model capped at 32000) would silently truncate output for
// an unrelated, larger-capacity model the user typed by id; a provider whose
// first entry is unusually large could get a request rejected outright by a
// smaller unrecognized model. The fallback must use a fixed, deliberate
// constant instead.
describe('resolvePiAiModel fallback for an unrecognized model id', () => {
  const models = [
    { id: 'known-small', api: 'anthropic-messages' as const, contextWindow: 9999, maxTokens: 111 },
    { id: 'known-big', api: 'anthropic-messages' as const, contextWindow: 8888, maxTokens: 222 },
  ] as unknown as Model<Api>[];
  const provider = {
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    getModels: () => models,
  } as unknown as Provider<Api>;

  it('returns a fixed, non-borrowed maxTokens/contextWindow for an unknown model id', () => {
    const resolved = resolvePiAiModel(provider, 'brand-new-model-not-in-catalog');

    expect(resolved.maxTokens).not.toBe(111);
    expect(resolved.maxTokens).not.toBe(222);
    expect(resolved.contextWindow).not.toBe(9999);
    expect(resolved.contextWindow).not.toBe(8888);
    // Same fixed values regardless of which model happens to iterate first.
    expect(resolved.maxTokens).toBeGreaterThan(0);
    expect(resolved.contextWindow).toBeGreaterThan(0);
  });

  it('still returns the exact catalog entry for a known model id', () => {
    const resolved = resolvePiAiModel(provider, 'known-small');
    expect(resolved.maxTokens).toBe(111);
    expect(resolved.contextWindow).toBe(9999);
  });
});
