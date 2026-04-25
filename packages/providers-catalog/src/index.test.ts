import { describe, expect, it } from 'vitest';
import {
  FREE_TRIAL_PROXY_URL,
  createProviderSettings,
  normalizeProviderSettings,
  providerRequiresUserApiKey,
  resolveProviderRuntimeSettings,
} from './index.js';

describe('providers-catalog', () => {
  it('fills provider defaults and trims trailing slashes', () => {
    const normalized = normalizeProviderSettings({
      ...createProviderSettings('openai'),
      baseUrl: 'https://api.openai.com/v1///',
      model: '',
    });

    expect(normalized.baseUrl).toBe('https://api.openai.com/v1');
    expect(normalized.model).toBe('gpt-4o-mini');
    expect(normalized.endpoint).toBe('chat/completions');
    expect(normalized.useStrict).toBe(true);
  });

  it('maps the free provider to the browser proxy runtime settings', () => {
    const runtime = resolveProviderRuntimeSettings(createProviderSettings('free'));

    expect(runtime.apiKey).toBe('free');
    expect(runtime.model).toBe('deepseek-v4-flash');
    expect(runtime.baseUrl).toBe(FREE_TRIAL_PROXY_URL + '/v1');
    expect(runtime.browserSupported).toBe(true);
  });

  it('uses deepseek-v4-flash as the default deepseek model', () => {
    const normalized = normalizeProviderSettings({
      ...createProviderSettings('deepseek'),
      apiKey: 'sk-test',
      model: '',
    });

    expect(normalized.model).toBe('deepseek-v4-flash');
    expect(normalized.baseUrl).toBe('https://api.deepseek.com');
    expect(normalized.endpoint).toBe('chat/completions');
  });

  it('detects whether a provider needs a user API key', () => {
    expect(providerRequiresUserApiKey('free')).toBe(false);
    expect(providerRequiresUserApiKey('openai')).toBe(true);
  });
});
