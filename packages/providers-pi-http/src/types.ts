/**
 * pi-ai built-in provider ids this package wires up. Each maps to one of
 * pi-ai's `providers/*.ts` factories (`createProvider(...)`), which already
 * knows its own baseUrl and which dialect(s) (`anthropic-messages`,
 * `google-generative-ai`, `openai-completions`, ...) its models use — so this
 * package never has to hard-code per-dialect request/response handling
 * itself, only pick *which* factory to load. See registry.ts.
 *
 * Selection notes (see the PR description for the full rationale):
 * - `anthropic` / `google`: native, first-party, no proxy needed (G1 spike).
 * - Everything else is OpenAI-compatible-or-Anthropic-compatible-but-not-
 *   `api.openai.com`, so it isn't subject to OpenAI's own CORS block. Each
 *   was checked with a live `OPTIONS` preflight against its real host with
 *   `Origin: https://agent.0xnullai.com` before being added here; providers
 *   that came back without an `Access-Control-Allow-Origin` header (e.g.
 *   NVIDIA NIM) were left out rather than assumed to work.
 * - Enterprise/cloud-account providers (AWS Bedrock, Azure, Google Vertex,
 *   Cloudflare AI Gateway/Workers AI, Vercel AI Gateway, GitHub Copilot) are
 *   deliberately excluded — they need more than an API key (account IDs,
 *   OAuth device flows, cloud IAM) and don't fit this app's "paste a key in
 *   settings" UX.
 */
export type PiAiProviderKey =
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'groq'
  | 'moonshotai'
  | 'moonshotai-cn'
  | 'zai'
  | 'zai-coding-cn'
  | 'minimax'
  | 'minimax-cn'
  | 'xai'
  | 'cerebras'
  | 'together'
  | 'huggingface'
  | 'mistral'
  | 'fireworks'
  | 'xiaomi';

/**
 * Trimmed-down view of a pi-ai catalog entry, safe to surface in the model
 * picker UI without pulling the full `Model<Api>` shape (cost tiers, thinking
 * level maps, etc.) into `apps/web`.
 */
export interface PiAiModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}
