import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FREE_TRIAL_MODEL,
  FREE_TRIAL_PROXY_URL,
  createFreeProxyHmacHeaders,
  createProviderSettings,
  getProviderDefinition,
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
    expect(normalized.useStrict).toBe(false);
  });

  it('trims whitespace from a typed model id', () => {
    const withWhitespace = normalizeProviderSettings({
      ...createProviderSettings('anthropic'),
      model: '  claude-opus-4-5  ',
    });
    expect(withWhitespace.model).toBe('claude-opus-4-5');

    // A whitespace-only model id is not a "real" model id — must fall back
    // to the provider default like an empty string would.
    const whitespaceOnly = normalizeProviderSettings({
      ...createProviderSettings('anthropic'),
      model: '   ',
    });
    expect(whitespaceOnly.model).toBe('claude-sonnet-4-5');
  });

  it('maps the free provider to the browser proxy runtime settings', () => {
    const runtime = resolveProviderRuntimeSettings(createProviderSettings('free'));

    expect(runtime.apiKey).toBe('free');
    expect(runtime.model).toBe(FREE_TRIAL_MODEL);
    expect(runtime.baseUrl).toBe(FREE_TRIAL_PROXY_URL + '/v1');
    expect(runtime.endpoint).toBe('chat/completions');
    expect(runtime.browserSupported).toBe(true);
  });

  it('uses deepseek-v4-pro as the default deepseek model', () => {
    const normalized = normalizeProviderSettings({
      ...createProviderSettings('deepseek'),
      apiKey: 'sk-test',
      model: '',
    });

    expect(normalized.model).toBe('deepseek-v4-pro');
    expect(normalized.baseUrl).toBe('https://api.deepseek.com');
    expect(normalized.endpoint).toBe('chat/completions');
  });

  it('defaults the custom provider to the Chat endpoint with strict schema off', () => {
    const normalized = createProviderSettings('custom');

    expect(normalized.endpoint).toBe('chat/completions');
    expect(normalized.useStrict).toBe(false);
  });

  it('keeps the custom strict toggle user-editable across normalization', () => {
    const normalized = normalizeProviderSettings({
      ...createProviderSettings('custom'),
      useStrict: true,
      endpoint: 'responses',
    });

    expect(normalized.useStrict).toBe(true);
    expect(normalized.endpoint).toBe('responses');
  });

  it('detects whether a provider needs a user API key', () => {
    expect(providerRequiresUserApiKey('free')).toBe(false);
    expect(providerRequiresUserApiKey('openai')).toBe(true);
  });

  it('tags the original six providers as openai-compat, unchanged', () => {
    for (const id of ['free', 'qwen', 'deepseek', 'doubao', 'openai', 'custom'] as const) {
      expect(getProviderDefinition(id)?.dialect).toBe('openai-compat');
    }
  });

  it('tags anthropic/google and the newly added providers as pi-ai with a piProviderKey', () => {
    for (const id of [
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
    ] as const) {
      const definition = getProviderDefinition(id);
      expect(definition?.dialect).toBe('pi-ai');
      expect(definition?.piProviderKey).toBe(id);
    }
  });

  it('clears baseUrl/endpoint/useStrict for pi-ai-dialect providers and fills a default model', () => {
    const normalized = normalizeProviderSettings({
      ...createProviderSettings('anthropic'),
      baseUrl: 'https://should-be-ignored.example.com',
      model: '',
    });

    expect(normalized.baseUrl).toBe('');
    expect(normalized.model).toBe('claude-sonnet-4-5');
    expect(normalized.endpoint).toBe('chat/completions');
    expect(normalized.useStrict).toBe(false);
  });

  it('resolves runtime settings for a pi-ai provider with dialect + piProviderKey', () => {
    const runtime = resolveProviderRuntimeSettings({
      ...createProviderSettings('google'),
      apiKey: 'test-key',
    });

    expect(runtime.dialect).toBe('pi-ai');
    expect(runtime.piProviderKey).toBe('google');
    expect(runtime.browserSupported).toBe(true);
  });

  it('signs the timestamp with HMAC-SHA256 so the proxy can verify the caller', async () => {
    const secret = 'unit-test-shared-secret';
    const signFn = createFreeProxyHmacHeaders(secret);
    const headers = await signFn();

    expect(headers['X-DG-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-DG-Signature']).toMatch(/^[0-9a-f]{64}$/);

    const expected = createHmac('sha256', secret).update(headers['X-DG-Timestamp']).digest('hex');
    expect(headers['X-DG-Signature']).toBe(expected);

    const recent = Math.abs(Date.now() - Number(headers['X-DG-Timestamp']));
    expect(recent).toBeLessThan(5_000);
  });
});
