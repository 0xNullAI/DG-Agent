import assert from 'node:assert/strict';
import {
  FREE_TRIAL_PROXY_URL,
  createProviderSettings,
  normalizeProviderSettings,
  providerRequiresUserApiKey,
  resolveProviderRuntimeSettings,
} from './index.js';

function run(): void {
  const normalized = normalizeProviderSettings({
    ...createProviderSettings('openai'),
    baseUrl: 'https://api.openai.com/v1///',
    model: '',
  });

  assert.equal(normalized.baseUrl, 'https://api.openai.com/v1');
  assert.equal(normalized.model, 'gpt-4o-mini');
  assert.equal(normalized.endpoint, 'chat/completions');
  assert.equal(normalized.useStrict, true);

  const runtime = resolveProviderRuntimeSettings(createProviderSettings('free'));
  assert.equal(runtime.apiKey, 'free');
  assert.equal(runtime.model, 'qwen3.5-plus');
  assert.equal(runtime.baseUrl, FREE_TRIAL_PROXY_URL);
  assert.equal(runtime.browserSupported, true);

  assert.equal(providerRequiresUserApiKey('free'), false);
  assert.equal(providerRequiresUserApiKey('openai'), true);
  console.log('providers-catalog self-test passed');
}

run();
