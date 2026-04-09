/**
 * agent/providers.ts — Provider definitions and settings persistence.
 * Pure data layer, no DOM dependency.
 */

import type { ProviderDef, AppSettings } from '../types';

const SETTINGS_STORAGE_KEY = 'dg-agent-settings';

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'free',
    name: '免费体验',
    hint: '无需 API Key，每分钟限 10 条',
    fields: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'deepseek-chat' },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'qwen-plus' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-4o-mini' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://api.openai.com/v1' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'AIza...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gemini-2.5-flash' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://generativelanguage.googleapis.com' },
    ],
  },
];

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppSettings;
  } catch (_) { /* */ }
  return { provider: 'free', configs: {}, presetId: 'gentle', customPrompt: '' };
}

export function saveSettings(settings: AppSettings): void {
  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* */ }
}
