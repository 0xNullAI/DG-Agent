import { z } from 'zod';

export type ProviderId =
  | 'free'
  | 'qwen'
  | 'deepseek'
  | 'doubao'
  | 'openai'
  | 'custom'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'groq'
  | 'moonshotai'
  | 'moonshotai-cn'
  | 'zai'
  | 'zai-coding-cn'
  | 'minimax'
  | 'minimax-cn'
  | 'xai'
  | 'cerebras'
  | 'together'
  | 'huggingface'
  | 'mistral'
  | 'fireworks'
  | 'xiaomi';
export type ProviderEndpoint = 'responses' | 'chat/completions';

/**
 * Which transport a provider goes through:
 * - `openai-compat`: the original hand-rolled OpenAI Chat-Completions /
 *   Responses HTTP client in `providers-openai-http` (`free`/`qwen`/
 *   `deepseek`/`doubao`/`openai`/`custom` — unchanged by this field's
 *   introduction, still routed exactly as before).
 * - `pi-ai`: `providers-pi-http`'s `PiAiLlmClient`, wrapping
 *   `@earendil-works/pi-ai`. `piProviderKey` then names which of pi-ai's
 *   built-in provider factories (`registry.ts` in that package) to load —
 *   pi-ai itself picks the right wire dialect (anthropic-messages /
 *   google-generative-ai / openai-completions / ...) per model, so this
 *   catalog never needs to know or care which one a given provider uses.
 */
export type ProviderDialect = 'openai-compat' | 'pi-ai';

export interface ProviderFieldDefinition {
  key: 'apiKey' | 'model' | 'baseUrl' | 'endpoint' | 'useStrict';
  label: string;
  type: 'password' | 'text' | 'url' | 'select';
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  hint?: string;
  browserSupported: boolean;
  fields: ProviderFieldDefinition[];
  dialect: ProviderDialect;
  /**
   * Loosely typed (not `PiAiProviderKey`) so this package doesn't have to
   * depend on `providers-pi-http` just for a string literal union — the
   * dependency runs the other way (agent-browser depends on both and wires
   * them together). Only meaningful when `dialect === 'pi-ai'`.
   */
  piProviderKey?: string;
}

export interface ProviderSettings {
  providerId: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
  endpoint: ProviderEndpoint;
  useStrict: boolean;
}

export interface ProviderRuntimeSettings extends ProviderSettings {
  browserSupported: boolean;
  dialect: ProviderDialect;
  piProviderKey?: string;
}

const PROVIDER_IDS = [
  'free',
  'qwen',
  'deepseek',
  'doubao',
  'openai',
  'custom',
  'anthropic',
  'google',
  'openrouter',
  'groq',
  'moonshotai',
  'moonshotai-cn',
  'zai',
  'zai-coding-cn',
  'minimax',
  'minimax-cn',
  'xai',
  'cerebras',
  'together',
  'huggingface',
  'mistral',
  'fireworks',
  'xiaomi',
] as const satisfies ProviderId[];
// These seed every freshly created provider config. For built-in providers
// `normalizeProviderSettings` overrides `endpoint`/`useStrict` below, so these
// values only survive for the user-editable `custom` provider — hence the
// Chat-Completions + non-strict defaults requested for custom backends.
const BASE_PROVIDER_SETTINGS = {
  apiKey: '',
  model: '',
  baseUrl: '',
  endpoint: 'chat/completions' as const,
  useStrict: false,
};

const providerSettingsSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  apiKey: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  endpoint: z.enum(['responses', 'chat/completions']),
  useStrict: z.boolean(),
});

export const FREE_TRIAL_PROXY_URL = 'https://llm.0xnullai.com';

/**
 * Display model for the free tier. The Cloudflare Worker proxy forces the real
 * upstream model server-side (via the PROXY_MODEL env var), so this value is only
 * used for the UI label and the request body the proxy then overrides.
 */
export const FREE_TRIAL_MODEL = 'openrouter/free';

/** apiKey + model only — no baseUrl/endpoint/useStrict fields, shared by every `dialect: 'pi-ai'` entry below. */
function piAiFields(
  apiKeyPlaceholder: string,
  modelPlaceholder: string,
): ProviderFieldDefinition[] {
  return [
    { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: apiKeyPlaceholder },
    { key: 'model', label: '模型', type: 'text', placeholder: modelPlaceholder },
  ];
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'free',
    name: '免费体验',
    hint: '无需配置 API-Key，当前由 MapLeaf API 提供支持。',
    browserSupported: true,
    fields: [],
    dialect: 'openai-compat',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    browserSupported: true,
    dialect: 'openai-compat',
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'qwen3.5-plus' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hint: '默认使用 Chat Completions 兼容模式',
    browserSupported: true,
    dialect: 'openai-compat',
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'deepseek-v4-pro' },
    ],
  },
  {
    id: 'doubao',
    name: '豆包',
    hint: '默认使用火山引擎 / Ark 接口配置',
    browserSupported: true,
    dialect: 'openai-compat',
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'ARK API 密钥' },
      {
        key: 'model',
        label: '模型 / Endpoint ID',
        type: 'text',
        placeholder: 'doubao-seed-2-0-mini-250415',
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    browserSupported: true,
    dialect: 'openai-compat',
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-4o-mini' },
      { key: 'baseUrl', label: '接口地址', type: 'url', placeholder: 'https://api.openai.com/v1' },
    ],
  },
  {
    id: 'custom',
    name: '自定义',
    hint: '适用于 OpenAI 兼容后端或私有网关',
    browserSupported: true,
    dialect: 'openai-compat',
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'model-name' },
      { key: 'baseUrl', label: '接口地址', type: 'url', placeholder: 'https://api.example.com/v1' },
      {
        key: 'endpoint',
        label: '接口类型',
        type: 'select',
        options: [
          { value: 'responses', label: 'Responses 接口' },
          { value: 'chat/completions', label: 'Chat Completions 接口' },
        ],
      },
      {
        key: 'useStrict',
        label: '严格 Schema',
        type: 'select',
        options: [
          { value: 'true', label: '开启' },
          { value: 'false', label: '关闭' },
        ],
      },
    ],
  },
  // —— pi-ai-routed providers (@dg-agent/providers-pi-http). Native Anthropic
  // / Google first, then the OpenAI-/Anthropic-compatible-but-not-
  // `api.openai.com` providers, each CORS-checked live against its real
  // host before being added (see providers-pi-http's types.ts for the notes).
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    hint: '通过 Anthropic 官方接口直连，浏览器可直接访问',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'anthropic',
    fields: piAiFields('sk-ant-...', 'claude-sonnet-4-5'),
  },
  {
    id: 'google',
    name: 'Gemini (Google)',
    hint: '通过 Google 官方接口直连，浏览器可直接访问',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'google',
    fields: piAiFields('AIza...', 'gemini-2.5-flash'),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    hint: '聚合多家模型的路由服务',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'openrouter',
    fields: piAiFields('sk-or-...', 'anthropic/claude-sonnet-4.5'),
  },
  {
    id: 'groq',
    name: 'Groq',
    hint: '低延迟开源模型推理服务',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'groq',
    fields: piAiFields('gsk_...', 'llama-3.3-70b-versatile'),
  },
  {
    id: 'moonshotai',
    name: 'Moonshot AI（Kimi，国际）',
    hint: '月之暗面 Kimi 国际接口',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'moonshotai',
    fields: piAiFields('sk-...', 'kimi-k2-0905-preview'),
  },
  {
    id: 'moonshotai-cn',
    name: 'Moonshot AI（Kimi，国内）',
    hint: '月之暗面 Kimi 中国大陆接口',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'moonshotai-cn',
    fields: piAiFields('sk-...', 'kimi-k2-0905-preview'),
  },
  {
    id: 'zai',
    name: 'Z.AI（GLM，国际）',
    hint: '智谱 GLM 国际接口',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'zai',
    fields: piAiFields('sk-...', 'glm-4.7'),
  },
  {
    id: 'zai-coding-cn',
    name: '智谱 GLM（国内）',
    hint: '智谱 AI 中国大陆接口',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'zai-coding-cn',
    fields: piAiFields('sk-...', 'glm-4.7'),
  },
  {
    id: 'minimax',
    name: 'MiniMax（国际）',
    hint: 'MiniMax 国际接口（Claude 兼容协议）',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'minimax',
    fields: piAiFields('sk-...', 'MiniMax-M2.7'),
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax（国内）',
    hint: 'MiniMax 中国大陆接口（Claude 兼容协议）',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'minimax-cn',
    fields: piAiFields('sk-...', 'MiniMax-M2.7'),
  },
  {
    id: 'xai',
    name: 'xAI（Grok）',
    hint: 'xAI 官方接口',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'xai',
    fields: piAiFields('xai-...', 'grok-4.3'),
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    hint: '高速开源模型推理服务',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'cerebras',
    fields: piAiFields('csk-...', 'gpt-oss-120b'),
  },
  {
    id: 'together',
    name: 'Together AI',
    hint: '开源模型托管服务',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'together',
    fields: piAiFields('sk-...', 'Qwen/Qwen3.6-Plus'),
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    hint: 'Hugging Face 推理路由',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'huggingface',
    fields: piAiFields('hf_...', 'Qwen/Qwen3-235B-A22B'),
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    hint: 'Mistral 官方接口',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'mistral',
    fields: piAiFields('sk-...', 'mistral-large-latest'),
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    hint: '开源模型托管服务',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'fireworks',
    fields: piAiFields('fw_...', 'accounts/fireworks/models/deepseek-v4-pro'),
  },
  {
    id: 'xiaomi',
    name: '小米 MiMo',
    hint: '小米 MiMo 官方接口',
    browserSupported: true,
    dialect: 'pi-ai',
    piProviderKey: 'xiaomi',
    fields: piAiFields('sk-...', 'mimo-v2.5-pro'),
  },
];

export function getProviderDefinition(id: ProviderId): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((provider) => provider.id === id);
}

export function createProviderSettings(providerId: ProviderId): ProviderSettings {
  return normalizeProviderSettings({
    ...BASE_PROVIDER_SETTINGS,
    providerId,
  });
}

export function createDefaultProviderSettings(): ProviderSettings {
  return createProviderSettings('free');
}

/** `providerId -> default model id`, applied by `normalizeProviderSettings` below for every built-in provider (skips `custom`, which stays fully user-editable). */
const DEFAULT_MODEL_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  qwen: 'qwen3.5-plus',
  deepseek: 'deepseek-v4-pro',
  doubao: 'doubao-seed-2-0-mini-250415',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-flash',
  openrouter: 'anthropic/claude-sonnet-4.5',
  groq: 'llama-3.3-70b-versatile',
  moonshotai: 'kimi-k2-0905-preview',
  'moonshotai-cn': 'kimi-k2-0905-preview',
  zai: 'glm-4.7',
  'zai-coding-cn': 'glm-4.7',
  minimax: 'MiniMax-M2.7',
  'minimax-cn': 'MiniMax-M2.7',
  xai: 'grok-4.3',
  cerebras: 'gpt-oss-120b',
  together: 'Qwen/Qwen3.6-Plus',
  huggingface: 'Qwen/Qwen3-235B-A22B',
  mistral: 'mistral-large-latest',
  fireworks: 'accounts/fireworks/models/deepseek-v4-pro',
  xiaomi: 'mimo-v2.5-pro',
};

/** `providerId -> default baseUrl`, applied only for `dialect: 'openai-compat'` providers with a fixed host (qwen/deepseek/doubao/openai — `free` and `custom` are handled separately above/below). */
const DEFAULT_BASE_URL_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  openai: 'https://api.openai.com/v1',
};

export function normalizeProviderSettings(input: ProviderSettings): ProviderSettings {
  const normalized = { ...input };
  const definition = getProviderDefinition(normalized.providerId);

  // Trim before the default-fallback checks below (a whitespace-only model
  // id must fall back to the provider default, not survive as-is) and
  // before this ever reaches PiAiLlmClient — otherwise a model id with
  // incidental leading/trailing whitespace (e.g. pasted from somewhere) can
  // show as "known" in the settings UI's catalog lookup (which trims for
  // display) while resolving to a *different*, untrimmed, synthetic model
  // at actual request time. Trimming once here, at the single place every
  // persisted/draft `ProviderSettings.model` value passes through, is the
  // one normalization every other reader can then rely on.
  normalized.model = normalized.model.trim();

  if (normalized.providerId === 'free') {
    normalized.baseUrl = FREE_TRIAL_PROXY_URL + '/v1';
    normalized.model = FREE_TRIAL_MODEL;
    normalized.endpoint = 'chat/completions';
    normalized.useStrict = false;
  } else if (normalized.providerId === 'custom') {
    // endpoint/useStrict stay user-editable: only fill the endpoint when it's
    // missing (seeded to chat/completions via BASE_PROVIDER_SETTINGS) and never
    // clobber the user's strict toggle.
    normalized.baseUrl = normalized.baseUrl || 'https://api.example.com/v1';
    normalized.model = normalized.model || 'model-name';
    normalized.endpoint = normalized.endpoint || 'chat/completions';
  } else if (definition?.dialect === 'pi-ai') {
    // No baseUrl/endpoint/useStrict concept for native/pi-ai-routed
    // providers — pi-ai's own provider registry owns the host, and there is
    // no OpenAI-compat "responses vs chat/completions" choice to make.
    normalized.baseUrl = '';
    normalized.model = normalized.model || DEFAULT_MODEL_BY_PROVIDER[normalized.providerId] || '';
    normalized.endpoint = 'chat/completions';
    normalized.useStrict = false;
  } else {
    // Remaining openai-compat built-ins: qwen / deepseek / doubao / openai.
    normalized.baseUrl =
      normalized.baseUrl || DEFAULT_BASE_URL_BY_PROVIDER[normalized.providerId] || '';
    normalized.model = normalized.model || DEFAULT_MODEL_BY_PROVIDER[normalized.providerId] || '';
    normalized.endpoint = 'chat/completions';
    normalized.useStrict = false;
  }

  normalized.baseUrl = normalized.baseUrl.replace(/\/+$/, '');
  return providerSettingsSchema.parse(normalized);
}

export function providerRequiresUserApiKey(settingsOrId: ProviderSettings | ProviderId): boolean {
  const providerId = typeof settingsOrId === 'string' ? settingsOrId : settingsOrId.providerId;
  const definition = getProviderDefinition(providerId);
  return Boolean(definition?.fields.some((field) => field.key === 'apiKey'));
}

export function resolveProviderRuntimeSettings(input: ProviderSettings): ProviderRuntimeSettings {
  const normalized = normalizeProviderSettings(input);
  const definition = getProviderDefinition(normalized.providerId);
  const dialect: ProviderDialect = definition?.dialect ?? 'openai-compat';

  if (normalized.providerId === 'free') {
    return {
      ...normalized,
      apiKey: 'free',
      model: FREE_TRIAL_MODEL,
      baseUrl: FREE_TRIAL_PROXY_URL + '/v1',
      endpoint: 'chat/completions',
      useStrict: false,
      browserSupported: true,
      dialect,
    };
  }

  return {
    ...normalized,
    browserSupported: isProviderUsableInBrowser(normalized),
    dialect,
    piProviderKey: definition?.piProviderKey,
  };
}

export function isProviderUsableInBrowser(settings: ProviderSettings): boolean {
  const definition = getProviderDefinition(settings.providerId);
  return Boolean(definition?.browserSupported);
}

/**
 * Per-request HMAC headers for the free-proxy. The signed payload is just
 * the current timestamp — that's enough for the proxy to verify the caller
 * holds the shared secret (and reject replays via the ±5 minute window)
 * without us having to canonicalize the request body.
 *
 * The secret is shipped in the Tauri Android build (via Vite env), so this
 * is deliberately a low bar: anyone who decompiles the APK can recover the
 * secret. Rotating the secret server-side invalidates the leaked one. The
 * web build doesn't ship the secret and is whitelisted by Origin instead.
 */
export function createFreeProxyHmacHeaders(secret: string): () => Promise<Record<string, string>> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('HMAC headers require WebCrypto subtle; not available in this runtime');
  }
  const encoder = new TextEncoder();
  // Import the key once and cache the import; signing is the only hot path.
  const keyPromise = subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return async () => {
    const timestamp = Date.now().toString();
    const key = await keyPromise;
    const sigBytes = await subtle.sign('HMAC', key, encoder.encode(timestamp));
    return {
      'X-DG-Timestamp': timestamp,
      'X-DG-Signature': bufferToHex(sigBytes),
    };
  };
}

function bufferToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}
