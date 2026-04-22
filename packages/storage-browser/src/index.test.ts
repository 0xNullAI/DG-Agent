import { describe, expect, it } from 'vitest';
import { createProviderSettings } from '@dg-agent/providers-catalog';
import { BrowserAppSettingsStore } from './index.js';

const SETTINGS_KEY = 'dg-agent.browser-settings';
const API_KEYS_LOCAL = 'dg-agent.provider-api-keys.local';
const API_KEYS_SESSION = 'dg-agent.provider-api-keys.session';
const VOICE_API_KEY_LOCAL = 'dg-agent.voice-api-key.local';
const VOICE_API_KEY_SESSION = 'dg-agent.voice-api-key.session';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  dump(): Record<string, string> {
    return Object.fromEntries(this.values.entries());
  }
}

describe('BrowserAppSettingsStore', () => {
  it('defaults to last-user-turn context and persists model context strategy changes', () => {
    const localStorageRef = new MemoryStorage();
    const sessionStorageRef = new MemoryStorage();
    const store = new BrowserAppSettingsStore({ localStorageRef, sessionStorageRef });

    expect(store.load().modelContextStrategy).toBe('last-user-turn');

    const saved = store.save({
      ...store.load(),
      modelContextStrategy: 'full-history',
    });

    const persistedSettings = JSON.parse(localStorageRef.getItem(SETTINGS_KEY) ?? '{}') as {
      modelContextStrategy?: string;
    };
    expect(saved.modelContextStrategy).toBe('full-history');
    expect(persistedSettings.modelContextStrategy).toBe('full-history');
  });

  it('fills missing qq accessToken from defaults for legacy persisted settings', () => {
    const localStorageRef = new MemoryStorage();
    const sessionStorageRef = new MemoryStorage();
    localStorageRef.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        bridge: {
          enabled: true,
          qq: {
            enabled: true,
            wsUrl: 'ws://127.0.0.1:3001',
            allowUsers: [],
            allowGroups: [],
            permissionMode: 'confirm',
          },
          telegram: {
            enabled: false,
            botToken: '',
            proxyUrl: '',
            allowUsers: [],
            permissionMode: 'confirm',
          },
        },
      }),
    );

    const store = new BrowserAppSettingsStore({ localStorageRef, sessionStorageRef });
    expect(store.load().bridge.qq.accessToken).toBe('');
  });

  it('keeps API keys only in memory when remember is disabled', () => {
    const localStorageRef = new MemoryStorage();
    const sessionStorageRef = new MemoryStorage();
    const store = new BrowserAppSettingsStore({ localStorageRef, sessionStorageRef });
    const openai = {
      ...createProviderSettings('openai'),
      apiKey: ' sk-live ',
      baseUrl: 'https://api.openai.com/v1/',
    };

    const saved = store.save({
      ...store.load(),
      rememberApiKey: false,
      provider: openai,
      providerConfigs: {
        openai,
      },
      voice: {
        ...store.load().voice,
        apiKey: ' voice-secret ',
      },
    });

    const persistedSettings = JSON.parse(localStorageRef.getItem(SETTINGS_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(saved.provider.apiKey).toBe('sk-live');
    expect(saved.voice.apiKey).toBe('voice-secret');
    expect(persistedSettings.provider).not.toHaveProperty('apiKey');
    expect(persistedSettings.voice).not.toHaveProperty('apiKey');
    expect(localStorageRef.getItem(API_KEYS_LOCAL)).toBeNull();
    expect(sessionStorageRef.getItem(API_KEYS_SESSION)).toBeNull();
    expect(sessionStorageRef.getItem(VOICE_API_KEY_SESSION)).toBeNull();

    sessionStorageRef.setItem(API_KEYS_SESSION, JSON.stringify({ openai: 'stale-session-key' }));
    sessionStorageRef.setItem(VOICE_API_KEY_SESSION, 'stale-voice-key');

    const reloadedStore = new BrowserAppSettingsStore({ localStorageRef, sessionStorageRef });
    const reloaded = reloadedStore.load();
    expect(reloaded.provider.apiKey).toBe('');
    expect(reloaded.voice.apiKey).toBe('');
  });

  it('keeps allow-all only as a session override', () => {
    const localStorageRef = new MemoryStorage();
    const sessionStorageRef = new MemoryStorage();
    const store = new BrowserAppSettingsStore({ localStorageRef, sessionStorageRef });

    const saved = store.save({
      ...store.load(),
      permissionMode: 'allow-all',
    });

    const persistedSettings = JSON.parse(localStorageRef.getItem(SETTINGS_KEY) ?? '{}') as {
      permissionMode?: string;
    };
    expect(saved.permissionMode).toBe('allow-all');
    expect(persistedSettings.permissionMode).toBe('confirm');
    expect(store.load().permissionMode).toBe('allow-all');
    expect(store.clearSessionPermissionModeOverride().permissionMode).toBe('confirm');
  });

  it('falls back to legacy raw API key values', () => {
    const localStorageRef = new MemoryStorage();
    const sessionStorageRef = new MemoryStorage();
    localStorageRef.setItem(API_KEYS_LOCAL, 'legacy-openai-key');

    const store = new BrowserAppSettingsStore({
      localStorageRef,
      sessionStorageRef,
      env: {
        VITE_PROVIDER_ID: 'openai',
      },
    });

    const loaded = store.load();

    expect(loaded.provider.providerId).toBe('openai');
    expect(loaded.provider.apiKey).toBe('legacy-openai-key');
    expect(loaded.providerConfigs.openai?.apiKey).toBe('legacy-openai-key');
  });

  it('moves remembered keys into local storage', () => {
    const localStorageRef = new MemoryStorage();
    const sessionStorageRef = new MemoryStorage();
    const store = new BrowserAppSettingsStore({ localStorageRef, sessionStorageRef });
    const qwen = {
      ...createProviderSettings('qwen'),
      apiKey: ' qwen-key ',
    };

    store.save({
      ...store.load(),
      rememberApiKey: true,
      provider: qwen,
      providerConfigs: {
        qwen,
      },
      voice: {
        ...store.load().voice,
        apiKey: ' voice-key ',
      },
    });

    expect(localStorageRef.getItem(API_KEYS_LOCAL)).toContain('qwen-key');
    expect(localStorageRef.getItem(VOICE_API_KEY_LOCAL)).toBe('voice-key');
    expect(sessionStorageRef.getItem(API_KEYS_SESSION)).toBeNull();
    expect(sessionStorageRef.getItem(VOICE_API_KEY_SESSION)).toBeNull();
  });
});
