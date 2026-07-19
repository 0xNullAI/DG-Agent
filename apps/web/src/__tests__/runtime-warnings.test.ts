import { describe, expect, it } from 'vitest';
import { createProviderSettings, normalizeProviderSettings } from '@dg-agent/providers-catalog';
import { defaultBrowserAppSettings } from '@dg-agent/storage-browser';
import { buildWarnings } from '../utils/runtime-warnings.js';

const MODES = {
  deviceMode: 'web-bluetooth' as const,
  llmMode: 'provider-http' as const,
  bluetoothAvailability: { supported: true },
  permissionMode: 'confirm' as const,
  providerId: 'anthropic' as const,
};

const SPEECH = {
  recognitionSupported: true,
  synthesisSupported: true,
  recognitionMode: 'browser' as const,
  synthesisMode: 'browser' as const,
  nativeRecognitionSupported: true,
  nativeSynthesisSupported: true,
  proxyRecognitionSupported: false,
  proxySynthesisSupported: false,
};

const BASE_URL_WARNING = '当前模型接口地址无效，请在设置里检查接口地址';

describe('buildWarnings', () => {
  // Regression: normalizeProviderSettings always clears baseUrl to '' for
  // dialect: 'pi-ai' providers (no baseUrl concept for native/pi-ai-routed
  // providers) — buildWarnings must not run the OpenAI-compat "is this a
  // valid URL" check against that intentionally-empty value, or every one
  // of the 17 pi-ai-dialect providers shows a permanent false-positive
  // warning as soon as an API key is entered.
  it('does not warn about an invalid baseUrl for pi-ai-dialect providers', () => {
    const settings = {
      ...defaultBrowserAppSettings(),
      llmMode: 'provider-http' as const,
      provider: normalizeProviderSettings({
        ...createProviderSettings('anthropic'),
        apiKey: 'sk-ant-test',
      }),
    };

    const warnings = buildWarnings(settings, MODES, SPEECH);

    expect(warnings).not.toContain(BASE_URL_WARNING);
  });

  it('still warns about an invalid baseUrl for openai-compat providers', () => {
    const settings = {
      ...defaultBrowserAppSettings(),
      llmMode: 'provider-http' as const,
      provider: {
        ...normalizeProviderSettings({ ...createProviderSettings('custom'), apiKey: 'sk-test' }),
        baseUrl: 'not-a-url',
      },
    };

    const warnings = buildWarnings(settings, MODES, SPEECH);

    expect(warnings).toContain(BASE_URL_WARNING);
  });
});
