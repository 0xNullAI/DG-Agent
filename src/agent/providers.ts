/**
 * agent/providers.ts — Provider definitions and settings persistence.
 * Pure data layer, no DOM dependency.
 */

import type { ProviderDef, AppSettings } from '../types';

const SETTINGS_STORAGE_KEY = 'dg-agent-settings';

export const DEFAULT_MAX_STRENGTH = 50;
export const MAX_STRENGTH_CEILING = 200;

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'free',
    name: '免费体验',
    hint: '无需 API Key，每分钟限 10 条。使用阿里云线路。',
    fields: [],
  },
  {
    id: 'qwen',
    name: '通义千问',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'qwen3.5-plus' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hint: 'DeepSeek 官方 Chat Completions API。默认使用 deepseek-reasoner 模型。',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'deepseek-reasoner' },
    ],
  },
  {
    id: 'doubao',
    name: '豆包',
    hint: '火山方舟 Responses API。model 填 Endpoint ID（如 ep-xxx）或模型 ID（如 doubao-seed-2-0-mini-260215）。',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'ARK API Key' },
      {
        key: 'model',
        label: '模型 / Endpoint ID',
        type: 'text',
        placeholder: 'doubao-seed-2-0-mini-260215',
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-5.3' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://api.openai.com/v1' },
    ],
  },
  {
    id: 'custom',
    name: '自定义',
    hint: '自定义模型、API Key 和接口地址',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'model-name' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://api.example.com/v1' },
      {
        key: 'endpoint',
        label: 'API 接口类型',
        type: 'select',
        default: 'responses',
        options: [
          { value: 'responses', label: 'Responses API (推荐)' },
          { value: 'chat/completions', label: 'Chat Completions (传统/兼容模式)' },
        ],
      },
      {
        key: 'useStrict',
        label: 'strict 模式',
        type: 'select',
        default: 'true',
        options: [
          { value: 'true', label: '开启（OpenAI 兼容后端推荐）' },
          { value: 'false', label: '关闭（后端不兼容时选此）' },
        ],
      },
    ],
  },
];

function normalizeMax(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(MAX_STRENGTH_CEILING, Math.round(n)));
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppSettings;
      // Migration: legacy single-value cap → per-channel caps.
      const legacy =
        typeof parsed.maxStrength === 'number' && Number.isFinite(parsed.maxStrength)
          ? parsed.maxStrength
          : null;
      if (typeof parsed.maxStrengthA !== 'number' || !Number.isFinite(parsed.maxStrengthA)) {
        parsed.maxStrengthA = legacy ?? DEFAULT_MAX_STRENGTH;
      }
      if (typeof parsed.maxStrengthB !== 'number' || !Number.isFinite(parsed.maxStrengthB)) {
        parsed.maxStrengthB = legacy ?? DEFAULT_MAX_STRENGTH;
      }
      delete parsed.maxStrength;

      // Default + self-heal the permission mode. Only 'ask' and 'timed'
      // are valid persisted values: 'always' is session-scoped and lives in
      // memory only, so any stale 'always' from an earlier build or a
      // previous session must be downgraded to 'ask' on load.
      if (parsed.permissionMode !== 'ask' && parsed.permissionMode !== 'timed') {
        parsed.permissionMode = 'ask';
        delete parsed.permissionModeExpiresAt;
      }
      // Expired timed windows auto-revert so users don't come back to an
      // already-unlocked session hours later.
      if (
        parsed.permissionMode === 'timed' &&
        (typeof parsed.permissionModeExpiresAt !== 'number' ||
          Date.now() >= parsed.permissionModeExpiresAt)
      ) {
        parsed.permissionMode = 'ask';
        delete parsed.permissionModeExpiresAt;
      }
      return parsed;
    }
  } catch (_) {
    /* */
  }
  return {
    provider: 'free',
    configs: {},
    presetId: 'gentle',
    customPrompt: '',
    backgroundBehavior: 'stop',
    maxStrengthA: DEFAULT_MAX_STRENGTH,
    maxStrengthB: DEFAULT_MAX_STRENGTH,
    permissionMode: 'ask',
  };
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (_) {
    /* */
  }
}

/** Read the user-configured max strength cap for one channel (0-200). */
export function getMaxStrength(channel: 'A' | 'B'): number {
  const s = loadSettings();
  return normalizeMax(channel === 'A' ? s.maxStrengthA : s.maxStrengthB, DEFAULT_MAX_STRENGTH);
}
