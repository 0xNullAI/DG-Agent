import { DEFAULT_BRIDGE_SETTINGS } from '@dg-agent/bridge-core';
import {
  createDefaultProviderSettings,
  normalizeProviderSettings,
  type ProviderId,
} from '@dg-agent/providers-catalog';
import {
  createDefaultToolCallConfig,
  DEFAULT_MAX_ADJUST_STEP,
  DEFAULT_MAX_BURST_DURATION_MS,
  DEFAULT_MAX_COLD_START_STRENGTH,
} from '@dg-agent/runtime';
import type {
  BrowserAppEnvLike,
  BrowserAppSettings,
  BrowserVoiceSettings,
} from './browser-settings-types.js';

export const DEFAULT_VOICE_SETTINGS: BrowserVoiceSettings = {
  mode: 'browser',
  speaker: 'longxiaochun_v2',
  apiKey: '',
  proxyUrl: '',
  autoStopEnabled: true,
};

export function normalizeVoiceSettings(
  input: Partial<BrowserVoiceSettings> = {},
): BrowserVoiceSettings {
  return {
    mode: input.mode === 'dashscope-proxy' ? 'dashscope-proxy' : 'browser',
    speaker: input.speaker?.trim() || DEFAULT_VOICE_SETTINGS.speaker,
    apiKey: input.apiKey?.trim() ?? '',
    proxyUrl: input.proxyUrl?.trim() ?? '',
    autoStopEnabled: input.autoStopEnabled ?? true,
  };
}

export function defaultBrowserAppSettings(env: BrowserAppEnvLike = {}): BrowserAppSettings {
  const toolCallConfig = createDefaultToolCallConfig();
  const provider = normalizeProviderSettings({
    ...createDefaultProviderSettings(),
    providerId: (env.VITE_PROVIDER_ID ?? 'free') as ProviderId,
    apiKey: env.VITE_OPENAI_API_KEY ?? '',
    baseUrl: env.VITE_OPENAI_BASE_URL ?? '',
    model: env.VITE_OPENAI_MODEL ?? '',
    endpoint: 'chat/completions',
    useStrict: true,
  });

  return {
    version: 1,
    themeMode: 'auto',
    showSafetyNoticeOnStartup: true,
    deviceMode: 'web-bluetooth',
    llmMode: 'provider-http',
    modelContextStrategy: 'last-user-turn',
    permissionMode: 'confirm',
    backgroundBehavior: 'stop',
    maxStrengthA: 50,
    maxStrengthB: 50,
    maxColdStartStrength: DEFAULT_MAX_COLD_START_STRENGTH,
    maxToolIterations: toolCallConfig.maxToolIterations,
    maxToolCallsPerTurn: toolCallConfig.maxToolCallsPerTurn,
    maxAdjustStrengthCallsPerTurn: toolCallConfig.maxAdjustStrengthCallsPerTurn,
    maxAdjustStrengthStep: DEFAULT_MAX_ADJUST_STEP,
    maxBurstCallsPerTurn: toolCallConfig.maxBurstCallsPerTurn,
    maxBurstDurationMs: DEFAULT_MAX_BURST_DURATION_MS,
    burstRequiresActiveChannel: toolCallConfig.burstRequiresActiveChannel,
    safetyStopOnLeave: true,
    rememberApiKey: false,
    voiceInputEnabled: false,
    ttsEnabled: false,
    voiceLanguage: 'zh-CN',
    bridge: DEFAULT_BRIDGE_SETTINGS,
    promptPresetId: 'gentle',
    customPrompt: '',
    savedPromptPresets: [],
    provider,
    providerConfigs: {
      [provider.providerId]: provider,
    },
    voice: DEFAULT_VOICE_SETTINGS,
  };
}
