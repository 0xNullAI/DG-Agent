import {
  createProviderSettings,
  normalizeProviderSettings,
  type ProviderId,
} from '@dg-agent/providers-catalog';
import type {
  BrowserAppSettings,
  BrowserAppEnvLike,
  ProviderConfigMap,
  StorageLike,
} from './browser-settings-types.js';
import {
  API_KEYS_LOCAL,
  API_KEYS_SESSION,
  SETTINGS_KEY,
  TIMED_PERMISSION_WINDOW_MS,
  VOICE_API_KEY_LOCAL,
  VOICE_API_KEY_SESSION,
} from './browser-settings-constants.js';
import { defaultBrowserAppSettings, normalizeVoiceSettings } from './browser-settings-defaults.js';
import { settingsSchema, type PersistedBrowserAppSettings } from './browser-settings-schema.js';

export interface BrowserAppSettingsStoreOptions {
  localStorageRef?: StorageLike;
  sessionStorageRef?: StorageLike;
  env?: BrowserAppEnvLike;
}

export class BrowserAppSettingsStore {
  private readonly localStorageRef: StorageLike | undefined;
  private readonly sessionStorageRef: StorageLike | undefined;
  private readonly defaults: BrowserAppSettings;
  private sessionPermissionModeOverride: BrowserAppSettings['permissionMode'] | null = null;
  private runtimeApiKeys: Partial<Record<ProviderId, string>> = {};
  private runtimeVoiceApiKey = '';

  constructor(options: BrowserAppSettingsStoreOptions = {}) {
    this.localStorageRef =
      options.localStorageRef ??
      (typeof localStorage === 'undefined' ? undefined : (localStorage as unknown as StorageLike));
    this.sessionStorageRef =
      options.sessionStorageRef ??
      (typeof sessionStorage === 'undefined'
        ? undefined
        : (sessionStorage as unknown as StorageLike));
    this.defaults = defaultBrowserAppSettings(options.env);
  }

  load(): BrowserAppSettings {
    const persisted = this.normalizePersistedSettings(this.readPersistedSettings());
    const activeProviderId = persisted?.provider?.providerId ?? this.defaults.provider.providerId;
    const apiKeys = this.readApiKeys(activeProviderId);
    const voiceApiKey = this.readVoiceApiKey();
    const providerConfigs = this.buildProviderConfigs(persisted, apiKeys);
    const activeProvider = providerConfigs[activeProviderId] ?? this.defaults.provider;
    const effectivePermissionState = this.resolvePermissionState(persisted);

    return {
      ...this.defaults,
      ...persisted,
      permissionMode: effectivePermissionState.permissionMode,
      permissionModeExpiresAt: effectivePermissionState.permissionModeExpiresAt,
      bridge: {
        ...this.defaults.bridge,
        ...(persisted?.bridge ?? {}),
        qq: {
          ...this.defaults.bridge.qq,
          ...(persisted?.bridge?.qq ?? {}),
        },
        telegram: {
          ...this.defaults.bridge.telegram,
          ...(persisted?.bridge?.telegram ?? {}),
        },
      },
      provider: activeProvider,
      providerConfigs,
      voice: normalizeVoiceSettings({
        ...this.defaults.voice,
        ...(persisted?.voice ?? {}),
        apiKey: voiceApiKey,
      }),
    };
  }

  save(settings: BrowserAppSettings): BrowserAppSettings {
    const providerConfigs = {
      ...settings.providerConfigs,
      [settings.provider.providerId]: settings.provider,
    };
    const persistedPermissionMode =
      settings.permissionMode === 'allow-all' ? 'confirm' : settings.permissionMode;
    const persistedPermissionModeExpiresAt =
      settings.permissionMode === 'timed' ? Date.now() + TIMED_PERMISSION_WINDOW_MS : undefined;

    this.sessionPermissionModeOverride =
      settings.permissionMode === 'allow-all' ? 'allow-all' : null;

    const sanitized = {
      version: 1 as const,
      themeMode: settings.themeMode,
      showSafetyNoticeOnStartup: settings.showSafetyNoticeOnStartup,
      deviceMode: settings.deviceMode,
      llmMode: settings.llmMode,
      modelContextStrategy: settings.modelContextStrategy,
      permissionMode: persistedPermissionMode,
      permissionModeExpiresAt: persistedPermissionModeExpiresAt,
      backgroundBehavior: settings.backgroundBehavior,
      maxStrengthA: settings.maxStrengthA,
      maxStrengthB: settings.maxStrengthB,
      safetyStopOnLeave: settings.safetyStopOnLeave,
      rememberApiKey: settings.rememberApiKey,
      voiceInputEnabled: settings.voiceInputEnabled,
      ttsEnabled: settings.ttsEnabled,
      voiceLanguage: settings.voiceLanguage,
      bridge: settings.bridge,
      promptPresetId: settings.promptPresetId,
      customPrompt: settings.customPrompt,
      savedPromptPresets: settings.savedPromptPresets,
      provider: {
        providerId: settings.provider.providerId,
        baseUrl: settings.provider.baseUrl,
        model: settings.provider.model,
        endpoint: settings.provider.endpoint,
        useStrict: settings.provider.useStrict,
      },
      providerConfigs: Object.fromEntries(
        Object.entries(providerConfigs).map(([providerId, provider]) => [
          providerId,
          {
            providerId: provider.providerId,
            baseUrl: provider.baseUrl,
            model: provider.model,
            endpoint: provider.endpoint,
            useStrict: provider.useStrict,
          },
        ]),
      ),
      voice: {
        mode: settings.voice.mode,
        speaker: settings.voice.speaker,
        proxyUrl: settings.voice.proxyUrl,
        autoStopEnabled: settings.voice.autoStopEnabled,
      },
    };

    this.localStorageRef?.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
    this.persistApiKeys(providerConfigs, settings.rememberApiKey);
    this.persistVoiceApiKey(settings.voice.apiKey, settings.rememberApiKey);
    return this.load();
  }

  reset(): BrowserAppSettings {
    this.sessionPermissionModeOverride = null;
    this.runtimeApiKeys = {};
    this.runtimeVoiceApiKey = '';
    this.localStorageRef?.removeItem(SETTINGS_KEY);
    this.localStorageRef?.removeItem(API_KEYS_LOCAL);
    this.localStorageRef?.removeItem(VOICE_API_KEY_LOCAL);
    this.sessionStorageRef?.removeItem(API_KEYS_SESSION);
    this.sessionStorageRef?.removeItem(VOICE_API_KEY_SESSION);
    return this.defaults;
  }

  clearSessionPermissionModeOverride(): BrowserAppSettings {
    this.sessionPermissionModeOverride = null;
    return this.load();
  }

  private readPersistedSettings(): PersistedBrowserAppSettings | null {
    const raw = this.localStorageRef?.getItem(SETTINGS_KEY);
    if (!raw) return null;

    try {
      return settingsSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private normalizePersistedSettings(
    persisted: PersistedBrowserAppSettings | null,
  ): PersistedBrowserAppSettings | null {
    if (!persisted) return null;

    return {
      ...persisted,
      deviceMode: persisted.deviceMode === 'fake' ? 'web-bluetooth' : persisted.deviceMode,
      llmMode: persisted.llmMode === 'fake' ? 'provider-http' : persisted.llmMode,
    };
  }

  private buildProviderConfigs(
    persisted: PersistedBrowserAppSettings | null,
    apiKeys: Partial<Record<ProviderId, string>>,
  ): ProviderConfigMap {
    const providerConfigs: ProviderConfigMap = {
      ...this.defaults.providerConfigs,
    };

    const persistedConfigs = persisted?.providerConfigs ?? {};
    for (const config of Object.values(persistedConfigs)) {
      providerConfigs[config.providerId] = normalizeProviderSettings({
        ...createProviderSettings(config.providerId),
        ...config,
        apiKey: apiKeys[config.providerId] ?? '',
      });
    }

    if (persisted?.provider) {
      providerConfigs[persisted.provider.providerId] = normalizeProviderSettings({
        ...createProviderSettings(persisted.provider.providerId),
        ...persisted.provider,
        apiKey: apiKeys[persisted.provider.providerId] ?? '',
      });
    }

    for (const [providerId, apiKey] of Object.entries(apiKeys)) {
      if (!apiKey) continue;
      const typedProviderId = providerId as ProviderId;
      providerConfigs[typedProviderId] = normalizeProviderSettings({
        ...(providerConfigs[typedProviderId] ?? createProviderSettings(typedProviderId)),
        apiKey,
      });
    }

    return providerConfigs;
  }

  private readApiKeys(activeProviderId: ProviderId): Partial<Record<ProviderId, string>> {
    if (Object.keys(this.runtimeApiKeys).length > 0) return this.runtimeApiKeys;

    return this.parseApiKeyMap(this.localStorageRef?.getItem(API_KEYS_LOCAL), activeProviderId);
  }

  private persistApiKeys(providerConfigs: ProviderConfigMap, remember: boolean): void {
    const apiKeys = Object.fromEntries(
      Object.entries(providerConfigs)
        .map(([providerId, provider]) => [providerId, provider.apiKey.trim()])
        .filter(([, apiKey]) => Boolean(apiKey)),
    );

    if (remember) {
      this.runtimeApiKeys = {};
      if (Object.keys(apiKeys).length > 0) {
        this.localStorageRef?.setItem(API_KEYS_LOCAL, JSON.stringify(apiKeys));
      } else {
        this.localStorageRef?.removeItem(API_KEYS_LOCAL);
      }
      this.sessionStorageRef?.removeItem(API_KEYS_SESSION);
      return;
    }

    this.runtimeApiKeys = apiKeys;
    this.localStorageRef?.removeItem(API_KEYS_LOCAL);
    this.sessionStorageRef?.removeItem(API_KEYS_SESSION);
  }

  private readVoiceApiKey(): string {
    if (this.runtimeVoiceApiKey) return this.runtimeVoiceApiKey;

    return this.localStorageRef?.getItem(VOICE_API_KEY_LOCAL) ?? this.defaults.voice.apiKey;
  }

  private persistVoiceApiKey(apiKey: string, remember: boolean): void {
    const trimmedApiKey = apiKey.trim();

    if (remember) {
      this.runtimeVoiceApiKey = '';
      if (trimmedApiKey) {
        this.localStorageRef?.setItem(VOICE_API_KEY_LOCAL, trimmedApiKey);
      } else {
        this.localStorageRef?.removeItem(VOICE_API_KEY_LOCAL);
      }
      this.sessionStorageRef?.removeItem(VOICE_API_KEY_SESSION);
      return;
    }

    this.runtimeVoiceApiKey = trimmedApiKey;
    this.localStorageRef?.removeItem(VOICE_API_KEY_LOCAL);
    this.sessionStorageRef?.removeItem(VOICE_API_KEY_SESSION);
  }

  private parseApiKeyMap(
    raw: string | null | undefined,
    fallbackProviderId: ProviderId,
  ): Partial<Record<ProviderId, string>> {
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed).filter(
          (entry): entry is [ProviderId, string] => typeof entry[1] === 'string',
        );
        return Object.fromEntries(entries);
      }
    } catch {
      return raw ? { [fallbackProviderId]: raw } : {};
    }

    return {};
  }

  private resolvePermissionState(
    persisted: PersistedBrowserAppSettings | null,
  ): Pick<BrowserAppSettings, 'permissionMode' | 'permissionModeExpiresAt'> {
    if (this.sessionPermissionModeOverride === 'allow-all') {
      return {
        permissionMode: 'allow-all',
        permissionModeExpiresAt: undefined,
      };
    }

    const persistedMode = persisted?.permissionMode ?? this.defaults.permissionMode;
    const persistedExpiry = persisted?.permissionModeExpiresAt;

    if (persistedMode === 'allow-all') {
      return {
        permissionMode: 'confirm',
        permissionModeExpiresAt: undefined,
      };
    }

    if (persistedMode === 'timed') {
      if (typeof persistedExpiry === 'number' && Date.now() < persistedExpiry) {
        return {
          permissionMode: 'timed',
          permissionModeExpiresAt: persistedExpiry,
        };
      }

      return {
        permissionMode: 'confirm',
        permissionModeExpiresAt: undefined,
      };
    }

    return {
      permissionMode: 'confirm',
      permissionModeExpiresAt: undefined,
    };
  }
}
