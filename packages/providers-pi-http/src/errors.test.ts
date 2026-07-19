import { describe, expect, it } from 'vitest';
import { classifyPiAiError } from './errors.js';

describe('classifyPiAiError', () => {
  it('reshapes a leading-status message (Anthropic SDK shape) into Provider HTTP error NNN', () => {
    const error = classifyPiAiError('401 {"type":"error","error":{"message":"invalid x-api-key"}}');
    expect(error.message).toMatch(/^Provider HTTP error 401:/);
  });

  it('reshapes a coded-status message (Google SDK shape) into Provider HTTP error NNN', () => {
    const error = classifyPiAiError(
      '{"error":{"code":403,"message":"permission denied","status":"PERMISSION_DENIED"}}',
    );
    expect(error.message).toMatch(/^Provider HTTP error 403:/);
  });

  it('reshapes a "got status: NNN." message (Google streaming shape) into Provider HTTP error NNN', () => {
    const error = classifyPiAiError('got status: 429. {"error":{"code":429}}');
    expect(error.message).toMatch(/^Provider HTTP error 429:/);
  });

  it('reshapes "No API key for provider" into the message normalizeAssistantErrorMessage recognizes', () => {
    const error = classifyPiAiError('No API key for provider: anthropic');
    expect(error.message).toBe('API key is required');
  });

  // Regression: @anthropic-ai/sdk and openai (Stainless-generated, same
  // lineage) both wrap a real fetch-level failure in APIConnectionError /
  // APIConnectionTimeoutError with the *original* error only in `.cause` —
  // pi-ai only ever reads `error.message`, which falls back to one of these
  // two fixed literals. Neither carries a status nor matches
  // runtime-errors.ts's own network regex on its own, so without this they
  // silently fell through to a generic `出错了：Connection error.` instead
  // of this app's usual "网络连接失败" copy.
  it('reshapes the Anthropic/OpenAI SDK connection-error fallback into a NetworkError-classifiable message', () => {
    expect(classifyPiAiError('Connection error.').message).toMatch(/^NetworkError:/);
    expect(classifyPiAiError('Request timed out.').message).toMatch(/^NetworkError:/);
  });

  it('falls back to a generic error for an unrecognized message', () => {
    const error = classifyPiAiError('something unexpected happened');
    expect(error.message).toBe('something unexpected happened');
  });

  it('falls back to a Chinese placeholder when no message is available at all', () => {
    const error = classifyPiAiError(undefined);
    expect(error.message).toBe('未知错误');
  });
});
