import type { LlmClient, LlmTurnInput, LlmTurnResult } from '@dg-agent/core';
import { z } from 'zod';
import { classifyPiAiError } from './errors.js';
import {
  PI_AI_PROVIDER_KEYS,
  listPiAiModels,
  loadPiAiProvider,
  resolvePiAiModel,
} from './registry.js';
import { buildContext, extractReasoning, extractText, extractToolCalls } from './serialization.js';
import type { PiAiModelInfo, PiAiProviderKey } from './types.js';

export type { PiAiModelInfo, PiAiProviderKey } from './types.js';
export { PI_AI_PROVIDER_KEYS } from './registry.js';

// `providerKey` is validated against registry.ts's actual known loader keys
// (not just "is a non-empty string") so a catalog/registry drift throws a
// clear ZodError right here at construction time — see PI_AI_PROVIDER_KEYS'
// doc comment in registry.ts for why that matters.
const configSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
  providerKey: z.enum(PI_AI_PROVIDER_KEYS as [PiAiProviderKey, ...PiAiProviderKey[]]),
  temperature: z.number().min(0).max(2).default(0.3),
});

export interface PiAiLlmClientConfig {
  apiKey: string;
  model: string;
  providerKey: PiAiProviderKey;
  temperature?: number;
}

/**
 * `LlmClient` implementation on top of `@earendil-works/pi-ai`'s unified
 * streaming API. Covers every provider in registry.ts — native Anthropic /
 * Google plus the OpenAI-/Anthropic-compatible-but-not-`api.openai.com`
 * providers (OpenRouter, Groq, Moonshot, Z.AI/GLM, MiniMax, xAI, Cerebras,
 * Together, Hugging Face, Mistral, Fireworks, Xiaomi) — through one code
 * path, because pi-ai's `Provider.stream()` already dispatches to the right
 * dialect (anthropic-messages / google-generative-ai / openai-completions /
 * mistral-conversations / ...) per model; this class never needs to know
 * which one a given provider uses.
 *
 * Mirrors `OpenAiHttpLlmClient` in providers-openai-http: same
 * config-validation-up-front shape, same "accumulated text" streaming
 * callback contract, same reliance on the runtime layer
 * (`normalizeAssistantErrorMessage`) for user-facing Chinese error copy —
 * see errors.ts for how pi-ai's error shape is translated into that layer's
 * vocabulary.
 *
 * No provider SDK (`@anthropic-ai/sdk`, `@google/genai`, `openai`, ...) is
 * ever imported at this module's top level; `runTurn` dynamically loads only
 * the one provider factory the configured `providerKey` needs, via
 * registry.ts.
 */
export class PiAiLlmClient implements LlmClient {
  private readonly config: z.infer<typeof configSchema>;

  constructor(inputConfig: PiAiLlmClientConfig) {
    this.config = configSchema.parse(inputConfig);
  }

  async runTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    validateApiKey(this.config.apiKey);

    const provider = await loadPiAiProvider(this.config.providerKey);
    const model = resolvePiAiModel(provider, this.config.model);
    const context = buildContext(input, {
      api: model.api,
      provider: model.provider,
      model: model.id,
    });

    let capturedPayload: unknown;
    const eventStream = provider.stream(model, context, {
      apiKey: this.config.apiKey,
      temperature: this.config.temperature,
      signal: input.abortSignal,
      onPayload: (payload) => {
        capturedPayload = payload;
        input.onRawRequest?.(payload);
        return undefined;
      },
    });

    // Mirrors OpenAiHttpLlmClient's `streaming = typeof input.onTextDelta ===
    // 'function'` branch: only do incremental delta work when a caller
    // actually wants progressive updates. pi-ai's transport always speaks
    // SSE under the hood regardless (its `Provider.stream()` has no
    // non-streaming request mode to opt into — verified against the
    // installed package's dialect modules), so this doesn't change what
    // goes over the wire the way the sibling client's `stream: false` does;
    // it does avoid pointless per-event accumulation/callback overhead when
    // nobody is listening, which is the behavior this app's `LlmClient`
    // callers actually observe.
    //
    // When we do iterate: drain the stream fully before reading `.result()`
    // — pi-ai resolves `.result()` from the same synchronous `push()` call
    // that delivers the terminal `done`/`error` event to this loop, so by
    // the time the loop exits the result promise is already settled, no
    // race between the two. `.result()` resolves independently of whether
    // anything ever iterates the stream (pi-ai's internal event queue isn't
    // backpressured by consumption), so skipping the loop entirely below is
    // safe too.
    if (input.onTextDelta) {
      let accumulated = '';
      for await (const event of eventStream) {
        if (event.type === 'text_delta') {
          accumulated += event.delta;
          input.onTextDelta(accumulated);
        }
      }
    }

    const message = await eventStream.result();

    if (message.stopReason === 'aborted' || message.stopReason === 'error') {
      // The outer runtime (agent-runtime.ts) classifies an abort by checking
      // `abortController.signal.aborted` first, falling back to the thrown
      // error's `name` — since `input.abortSignal` is the same signal object
      // it inspects, a thrown Error here (any name) is enough for the
      // aborted case to be recognized correctly.
      throw classifyPiAiError(message.errorMessage);
    }

    return {
      assistantMessage: extractText(message),
      reasoningContent: extractReasoning(message),
      toolCalls: (() => {
        const calls = extractToolCalls(message);
        return calls.length > 0 ? calls : undefined;
      })(),
      rawResponse: { request: capturedPayload, response: message },
    };
  }
}

function validateApiKey(apiKey: string): void {
  if (!/^[\x20-\x7E]+$/.test(apiKey)) {
    throw new Error(
      'API key 含有非法字符（可能混入了中文、全角空格或不可见字符）。请在设置中重新粘贴一次纯英文/数字的 key。',
    );
  }
}

/**
 * Model catalog metadata for the settings UI's model picker (context window,
 * max output tokens, whether the model does extended thinking). Backed by
 * each provider's generated pi-ai catalog, loaded lazily and independently
 * of `PiAiLlmClient` itself so a settings screen that never opens the model
 * picker doesn't pay for any provider SDK.
 */
export async function listModelsForProvider(
  providerKey: PiAiProviderKey,
): Promise<PiAiModelInfo[]> {
  return listPiAiModels(providerKey);
}
