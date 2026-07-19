import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import type { PiAiModelInfo, PiAiProviderKey } from './types.js';

/**
 * One dynamic `import()` per provider — each is its own Vite code-split
 * boundary, so selecting `zai` never fetches `@anthropic-ai/sdk`, selecting
 * `anthropic` never fetches `openai` or `@google/genai`, and so on. This
 * mirrors pi-ai's own `.lazy.ts` split, just at the provider-factory level
 * (`providers/*.ts`) instead of the raw dialect-module level, since
 * `providers/*.ts` itself only imports the matching `api/*.lazy.ts` wrapper
 * — the heavy SDK stays behind a *second*, inner dynamic import that only
 * fires on the first actual `.stream()` call (verified against the
 * installed package: e.g. `providers/anthropic.js` imports
 * `api/anthropic-messages.lazy.js`, not `@anthropic-ai/sdk` itself).
 */
const LOADERS: Record<PiAiProviderKey, () => Promise<Provider<Api>>> = {
  anthropic: () =>
    import('@earendil-works/pi-ai/providers/anthropic').then((m) => m.anthropicProvider()),
  google: () => import('@earendil-works/pi-ai/providers/google').then((m) => m.googleProvider()),
  openrouter: () =>
    import('@earendil-works/pi-ai/providers/openrouter').then((m) => m.openrouterProvider()),
  groq: () => import('@earendil-works/pi-ai/providers/groq').then((m) => m.groqProvider()),
  moonshotai: () =>
    import('@earendil-works/pi-ai/providers/moonshotai').then((m) => m.moonshotaiProvider()),
  'moonshotai-cn': () =>
    import('@earendil-works/pi-ai/providers/moonshotai-cn').then((m) => m.moonshotaiCnProvider()),
  zai: () => import('@earendil-works/pi-ai/providers/zai').then((m) => m.zaiProvider()),
  'zai-coding-cn': () =>
    import('@earendil-works/pi-ai/providers/zai-coding-cn').then((m) => m.zaiCodingCnProvider()),
  minimax: () => import('@earendil-works/pi-ai/providers/minimax').then((m) => m.minimaxProvider()),
  'minimax-cn': () =>
    import('@earendil-works/pi-ai/providers/minimax-cn').then((m) => m.minimaxCnProvider()),
  xai: () => import('@earendil-works/pi-ai/providers/xai').then((m) => m.xaiProvider()),
  cerebras: () =>
    import('@earendil-works/pi-ai/providers/cerebras').then((m) => m.cerebrasProvider()),
  together: () =>
    import('@earendil-works/pi-ai/providers/together').then((m) => m.togetherProvider()),
  huggingface: () =>
    import('@earendil-works/pi-ai/providers/huggingface').then((m) => m.huggingfaceProvider()),
  mistral: () => import('@earendil-works/pi-ai/providers/mistral').then((m) => m.mistralProvider()),
  fireworks: () =>
    import('@earendil-works/pi-ai/providers/fireworks').then((m) => m.fireworksProvider()),
  xiaomi: () => import('@earendil-works/pi-ai/providers/xiaomi').then((m) => m.xiaomiProvider()),
};

const cache = new Map<PiAiProviderKey, Promise<Provider<Api>>>();

/**
 * A rejected load (e.g. a transient chunk-load failure, or a stale deployed
 * page referencing an asset hash a newer deploy has since removed) must not
 * poison the cache — every subsequent call for that provider would otherwise
 * replay the same rejection for the rest of the page session with no way to
 * recover short of a reload. Only a *settled-successful* load is cached;
 * evict on rejection so the next call retries a fresh `import()`.
 */
export function loadPiAiProvider(key: PiAiProviderKey): Promise<Provider<Api>> {
  let inflight = cache.get(key);
  if (!inflight) {
    inflight = LOADERS[key]().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, inflight);
  }
  return inflight;
}

/**
 * Resolves a configured model id against the provider's static catalog.
 * Falls back to a conservative synthetic `Model` (borrowing `api` /
 * `contextWindow` / `maxTokens` from an existing catalog entry as a template
 * when one exists) for ids the catalog doesn't know yet — new model releases
 * routinely ship before pi-ai's generated catalog is regenerated, and this
 * app lets users type an arbitrary model id rather than only pick from a
 * dropdown.
 */
export function resolvePiAiModel(provider: Provider<Api>, modelId: string): Model<Api> {
  const known = provider.getModels().find((model) => model.id === modelId);
  if (known) return known;

  const template = provider.getModels()[0];
  return {
    id: modelId,
    name: modelId,
    api: template?.api ?? 'openai-completions',
    provider: provider.id,
    baseUrl: provider.baseUrl ?? '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: template?.contextWindow ?? 128000,
    maxTokens: template?.maxTokens ?? 8192,
  };
}

export async function listPiAiModels(key: PiAiProviderKey): Promise<PiAiModelInfo[]> {
  const provider = await loadPiAiProvider(key);
  return provider.getModels().map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
  }));
}
