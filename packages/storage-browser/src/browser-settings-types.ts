import type { BridgeSettings } from '@dg-agent/bridge-core';
import type { BrowserPermissionMode } from '@dg-agent/permissions-browser';
import type { SavedPromptPreset } from '@dg-agent/prompts-basic';
import type { ProviderId, ProviderSettings } from '@dg-agent/providers-catalog';
import type { ThemeMode } from '@dg-agent/theme-browser';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ProviderConfigMap = Partial<Record<ProviderId, ProviderSettings>>;
export type BrowserVoiceMode = 'browser' | 'dashscope-proxy';

export interface BrowserVoiceSettings {
  mode: BrowserVoiceMode;
  speaker: string;
  apiKey: string;
  proxyUrl: string;
  autoStopEnabled: boolean;
}

export interface BrowserAppSettings {
  version: 1;
  themeMode: ThemeMode;
  showSafetyNoticeOnStartup: boolean;
  deviceMode: 'fake' | 'web-bluetooth';
  llmMode: 'fake' | 'provider-http';
  permissionMode: BrowserPermissionMode;
  permissionModeExpiresAt?: number;
  backgroundBehavior: 'stop' | 'keep';
  maxStrengthA: number;
  maxStrengthB: number;
  safetyStopOnLeave: boolean;
  rememberApiKey: boolean;
  voiceInputEnabled: boolean;
  ttsEnabled: boolean;
  voiceLanguage: string;
  bridge: BridgeSettings;
  promptPresetId: string;
  customPrompt: string;
  savedPromptPresets: SavedPromptPreset[];
  provider: ProviderSettings;
  providerConfigs: ProviderConfigMap;
  voice: BrowserVoiceSettings;
}

export interface BrowserAppEnvLike {
  VITE_DEVICE_MODE?: 'fake' | 'web-bluetooth';
  VITE_LLM_MODE?: 'fake' | 'provider-http';
  VITE_PROVIDER_ID?: ProviderId;
  VITE_OPENAI_API_KEY?: string;
  VITE_OPENAI_BASE_URL?: string;
  VITE_OPENAI_MODEL?: string;
}
