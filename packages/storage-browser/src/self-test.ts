import assert from 'node:assert/strict';
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
}

function testMemoryOnlyKeys(): void {
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
  assert.equal(saved.provider.apiKey, 'sk-live');
  assert.equal(saved.voice.apiKey, 'voice-secret');
  assert.equal(Object.hasOwn(persistedSettings.provider as object, 'apiKey'), false);
  assert.equal(Object.hasOwn(persistedSettings.voice as object, 'apiKey'), false);
  assert.equal(localStorageRef.getItem(API_KEYS_LOCAL), null);
  assert.equal(sessionStorageRef.getItem(API_KEYS_SESSION), null);
  assert.equal(sessionStorageRef.getItem(VOICE_API_KEY_SESSION), null);

  sessionStorageRef.setItem(API_KEYS_SESSION, JSON.stringify({ openai: 'stale-session-key' }));
  sessionStorageRef.setItem(VOICE_API_KEY_SESSION, 'stale-voice-key');

  const reloadedStore = new BrowserAppSettingsStore({ localStorageRef, sessionStorageRef });
  const reloaded = reloadedStore.load();
  assert.equal(reloaded.provider.apiKey, '');
  assert.equal(reloaded.voice.apiKey, '');
}

function testModelContextStrategyPersistence(): void {
  const localStorageRef = new MemoryStorage();
  const sessionStorageRef = new MemoryStorage();
  const store = new BrowserAppSettingsStore({ localStorageRef, sessionStorageRef });

  assert.equal(store.load().modelContextStrategy, 'last-user-turn');

  const saved = store.save({
    ...store.load(),
    modelContextStrategy: 'full-history',
  });

  const persistedSettings = JSON.parse(localStorageRef.getItem(SETTINGS_KEY) ?? '{}') as {
    modelContextStrategy?: string;
  };
  assert.equal(saved.modelContextStrategy, 'full-history');
  assert.equal(persistedSettings.modelContextStrategy, 'full-history');
}

function testLegacyBridgeAccessTokenFallback(): void {
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
  assert.equal(store.load().bridge.qq.accessToken, '');
}

function testAllowAllOverride(): void {
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
  assert.equal(saved.permissionMode, 'allow-all');
  assert.equal(persistedSettings.permissionMode, 'confirm');
  assert.equal(store.load().permissionMode, 'allow-all');
  assert.equal(store.clearSessionPermissionModeOverride().permissionMode, 'confirm');
}

function testLegacyApiKeyFallback(): void {
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
  assert.equal(loaded.provider.providerId, 'openai');
  assert.equal(loaded.provider.apiKey, 'legacy-openai-key');
  assert.equal(loaded.providerConfigs.openai?.apiKey, 'legacy-openai-key');
}

function testRememberedKeys(): void {
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

  assert.match(localStorageRef.getItem(API_KEYS_LOCAL) ?? '', /qwen-key/);
  assert.equal(localStorageRef.getItem(VOICE_API_KEY_LOCAL), 'voice-key');
  assert.equal(sessionStorageRef.getItem(API_KEYS_SESSION), null);
  assert.equal(sessionStorageRef.getItem(VOICE_API_KEY_SESSION), null);
}

testMemoryOnlyKeys();
testModelContextStrategyPersistence();
testLegacyBridgeAccessTokenFallback();
testAllowAllOverride();
testLegacyApiKeyFallback();
testRememberedKeys();
console.log('storage-browser self-test passed');
