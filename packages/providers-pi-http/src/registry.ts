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

/**
 * The authoritative set of provider keys this package actually knows how to
 * load — `LOADERS`'s keys, exported so `index.ts`'s `configSchema` can
 * validate a `providerKey` against it at `PiAiLlmClient` construction time
 * instead of trusting `providers-catalog`'s loosely-typed (plain `string`)
 * `piProviderKey` field. Without that check, a catalog/registry drift (typo,
 * rename, a catalog entry added without a matching loader) would construct
 * successfully and only fail later, deep inside `runTurn()`, as a confusing
 * raw error that bypasses `create-browser-agent-client.ts`'s friendly
 * Chinese config-error formatting entirely.
 */
export const PI_AI_PROVIDER_KEYS = Object.keys(LOADERS) as PiAiProviderKey[];

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

// `Model.maxTokens` is not just informational — pi-ai's `anthropic-messages`
// dialect sends it directly as the outbound `max_tokens` request field
// whenever the caller doesn't pass `options.maxTokens` explicitly (verified
// against the installed package: `anthropic-messages.js`'s `buildParams` does
// `max_tokens: options?.maxTokens ?? model.maxTokens`, unconditionally — the
// Anthropic Messages API has no "let the server pick" default to fall back
// to). For a model id unrecognized by pi-ai's catalog, borrowing this number
// from an arbitrary *other* model of the same provider (e.g. the first entry
// in whatever order the catalog object happens to iterate) would silently
// hand a real request a cap that has nothing to do with the actual model —
// too low truncates real output, too high can get the request rejected by a
// smaller model. A fixed, deliberately conservative constant, documented as
// a guess, is safer than an unexamined borrowed one. `contextWindow` gets
// the same treatment for the same reason (it clamps `maxTokens` down further
// via pi-ai's `clampMaxTokensToContext`).
const FALLBACK_MAX_TOKENS = 4096;
const FALLBACK_CONTEXT_WINDOW = 32000;

/**
 * Resolves a configured model id against the provider's static catalog.
 * Falls back to a conservative synthetic `Model` for ids the catalog doesn't
 * know yet — new model releases routinely ship before pi-ai's generated
 * catalog is regenerated, and this app lets users type an arbitrary model id
 * rather than only pick from a dropdown. `api` is still inferred from the
 * provider's known models (the *most common* one, not just the first) since
 * pi-ai needs a concrete dialect to dispatch to; every provider here except
 * `fireworks`/`xai` only ever has one `api` value anyway, so this is exact
 * for all but those two mixed-dialect providers.
 */
export function resolvePiAiModel(provider: Provider<Api>, modelId: string): Model<Api> {
  // providers-catalog's normalizeProviderSettings already trims
  // ProviderSettings.model, so PiAiLlmClient's config.model arrives trimmed
  // in the real app; trimming again here is a cheap, harmless guard for any
  // caller that constructs a model id outside that path (tests, future
  // consumers) so this lookup can't diverge from a UI-side comparison that
  // also trims.
  const trimmedModelId = modelId.trim();
  const models = provider.getModels();
  const known = models.find((model) => model.id === trimmedModelId);
  if (known) return known;

  return {
    id: trimmedModelId,
    name: trimmedModelId,
    api: mostCommonApi(models),
    provider: provider.id,
    baseUrl: provider.baseUrl ?? '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
  };
}

function mostCommonApi(models: readonly Model<Api>[]): Api {
  if (models.length === 0) return 'openai-completions';

  const counts = new Map<Api, number>();
  for (const model of models) {
    counts.set(model.api, (counts.get(model.api) ?? 0) + 1);
  }

  let bestApi: Api = models[0]!.api;
  let bestCount = 0;
  for (const [api, count] of counts) {
    if (count > bestCount) {
      bestApi = api;
      bestCount = count;
    }
  }
  return bestApi;
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
