import { z } from 'zod';

export type ProviderId = 'free' | 'qwen' | 'deepseek' | 'doubao' | 'openai' | 'custom';
export type ProviderEndpoint = 'responses' | 'chat/completions';

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
}

const PROVIDER_IDS = [
  'free',
  'qwen',
  'deepseek',
  'doubao',
  'openai',
  'custom',
] as const satisfies ProviderId[];
const BASE_PROVIDER_SETTINGS = {
  apiKey: '',
  model: '',
  baseUrl: '',
  endpoint: 'responses' as const,
  useStrict: true,
};

const providerSettingsSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  apiKey: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  endpoint: z.enum(['responses', 'chat/completions']),
  useStrict: z.boolean(),
});

export const FREE_TRIAL_PROXY_URL = 'https://dg-agent-proxy-eloracuikl.cn-hangzhou.fcapp.run';

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'free',
    name: '免费体验',
    hint: '无需配置 API-Key，当前由 MapLeaf API 提供支持。',
    browserSupported: true,
    fields: [],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    browserSupported: true,
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
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'deepseek-v4-flash' },
    ],
  },
  {
    id: 'doubao',
    name: '豆包',
    hint: '默认使用火山引擎 / Ark 接口配置',
    browserSupported: true,
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

export function normalizeProviderSettings(input: ProviderSettings): ProviderSettings {
  const normalized = { ...input };

  switch (normalized.providerId) {
    case 'qwen':
      normalized.baseUrl =
        normalized.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      normalized.model = normalized.model || 'qwen3.5-plus';
      normalized.endpoint = 'chat/completions';
      normalized.useStrict = true;
      break;
    case 'deepseek':
      normalized.baseUrl = normalized.baseUrl || 'https://api.deepseek.com';
      normalized.model = normalized.model || 'deepseek-v4-flash';
      normalized.endpoint = 'chat/completions';
      normalized.useStrict = true;
      break;
    case 'doubao':
      normalized.baseUrl = normalized.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3';
      normalized.model = normalized.model || 'doubao-seed-2-0-mini-250415';
      normalized.endpoint = 'responses';
      normalized.useStrict = true;
      break;
    case 'openai':
      normalized.baseUrl = normalized.baseUrl || 'https://api.openai.com/v1';
      normalized.model = normalized.model || 'gpt-4o-mini';
      normalized.endpoint = 'chat/completions';
      normalized.useStrict = true;
      break;
    case 'custom':
      normalized.baseUrl = normalized.baseUrl || 'https://api.example.com/v1';
      normalized.model = normalized.model || 'model-name';
      normalized.endpoint = normalized.endpoint || 'responses';
      break;
    case 'free':
      normalized.baseUrl = FREE_TRIAL_PROXY_URL + '/v1';
      normalized.model = 'deepseek-v4-flash';
      normalized.endpoint = 'chat/completions';
      normalized.useStrict = false;
      break;
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

  if (normalized.providerId === 'free') {
    return {
      ...normalized,
      apiKey: 'free',
      model: 'deepseek-v4-flash',
      baseUrl: FREE_TRIAL_PROXY_URL + '/v1',
      endpoint: 'chat/completions',
      useStrict: false,
      browserSupported: true,
    };
  }

  return {
    ...normalized,
    browserSupported: isProviderUsableInBrowser(normalized),
  };
}

export function isProviderUsableInBrowser(settings: ProviderSettings): boolean {
  const definition = getProviderDefinition(settings.providerId);
  return Boolean(definition?.browserSupported);
}
