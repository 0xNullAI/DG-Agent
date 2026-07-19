import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatProviderConfigError, isPiAiProviderKey } from './create-browser-agent-client.js';

// Regression: providers-catalog's ProviderDefinition.piProviderKey is a
// loosely-typed plain `string` (by design — providers-catalog doesn't
// depend on providers-pi-http for a literal union). isPiAiProviderKey is the
// one place that gap gets closed against providers-pi-http's actual known
// loader keys, so a catalog/registry drift (typo, rename, a catalog entry
// added without a matching loader) is caught here with a friendly message
// instead of constructing successfully and failing later, deep inside a
// chat turn's runTurn().
describe('isPiAiProviderKey', () => {
  it('accepts every real pi-ai provider key', () => {
    for (const key of [
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
    ]) {
      expect(isPiAiProviderKey(key)).toBe(true);
    }
  });

  it('rejects an unknown/mistyped provider key', () => {
    expect(isPiAiProviderKey('anthropicc')).toBe(false);
    expect(isPiAiProviderKey('')).toBe(false);
    expect(isPiAiProviderKey('openai')).toBe(false); // a real id, but openai-compat, not pi-ai
  });
});

// Regression: formatProviderConfigError's /baseUrl/i check was written for
// the openai-compat configSchema (which has a baseUrl field) and never
// matched pi-ai's configSchema (which has no baseUrl field at all), so a
// pi-ai config validation error fell through to the generic branch and
// showed the raw, English/JSON-shaped Zod error text directly in the
// otherwise-Chinese settings UI.
describe('formatProviderConfigError', () => {
  it('formats an openai-compat baseUrl error in Chinese', () => {
    const error = new Error('Invalid input: baseUrl must be a valid URL');
    const message = formatProviderConfigError(error, 'custom', 'openai-compat');
    expect(message).toContain('接口地址不是有效的 URL');
  });

  it('formats a pi-ai providerKey validation error in Chinese, not raw Zod JSON', () => {
    const schema = z.object({ providerKey: z.enum(['anthropic', 'google']) });
    const parsed = schema.safeParse({ providerKey: 'not-a-real-key' });
    expect(parsed.success).toBe(false);

    const message = formatProviderConfigError(
      parsed.success ? undefined : parsed.error,
      'anthropic',
      'pi-ai',
    );

    expect(message).not.toMatch(/invalid_value|ZodError|\[\s*{/i);
    expect(message).toContain('不受支持');
  });

  it('never applies the openai-compat baseUrl phrasing to a pi-ai dialect error', () => {
    // Same message text, different dialect — must not accidentally match
    // via the (dialect-unaware) regex alone.
    const error = new Error('Invalid input: baseUrl must be a valid URL');
    const message = formatProviderConfigError(error, 'anthropic', 'pi-ai');
    expect(message).not.toContain('接口地址不是有效的 URL');
  });
});
