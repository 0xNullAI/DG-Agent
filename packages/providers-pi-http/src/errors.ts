/**
 * pi-ai never throws for provider/API errors: `AssistantMessageEventStream`
 * always resolves (via `.result()`) to a final `AssistantMessage`, with
 * `stopReason: "error" | "aborted"` and a string `errorMessage` on failure.
 * `packages/runtime/src/runtime-errors.ts`'s `normalizeAssistantErrorMessage`
 * is the single place that turns a thrown `Error.message` into the
 * user-facing Chinese string (网络连接失败 / API Key 无效或已过期 / …) for
 * *every* LlmClient — `OpenAiHttpLlmClient` included. Rather than duplicate
 * that Chinese copy here, this module reshapes pi-ai's `errorMessage` string
 * into the same English-ish shapes `normalizeAssistantErrorMessage` already
 * recognizes (`Provider HTTP error NNN: …`, `API key is required`) so both
 * clients funnel through one classifier and stay consistent by construction.
 */

const LEADING_STATUS = /^(\d{3})\b/;
// @google/genai's ApiError folds the HTTP status into the JSON error body as
// `code` (see api-error.ts upstream); the streaming path additionally prints
// `got status: NNN.` ahead of the JSON. Anthropic's SDK already prefixes the
// message with the bare status (`LEADING_STATUS` above), so this is Google's
// fallback shape only.
const CODED_STATUS = /"code"\s*:\s*(\d{3})\b/;
const GOT_STATUS = /got status:\s*(\d{3})\b/i;
// Both `@anthropic-ai/sdk` and `openai` (Stainless-generated, same lineage —
// the latter backs most of the openai-completions-family providers here)
// wrap a genuine fetch-level failure (offline, DNS, CORS, proxy) in
// `APIConnectionError`/`APIConnectionTimeoutError` with the *original*
// error only in `.cause`; the message pi-ai actually reads
// (`error.message`) falls back to a fixed, unhelpful literal — verified
// against both installed packages' `core/error.mjs`. Neither string carries
// an HTTP status or matches runtime-errors.ts's own network regex
// (`/Failed to fetch|NetworkError|.../i`), so without this they'd fall
// through to a generic `出错了：Connection error.` instead of this app's
// usual "网络连接失败" copy.
const SDK_CONNECTION_ERROR = /^(connection error\.?|request timed out\.?)$/i;

export function classifyPiAiError(errorMessage: string | undefined): Error {
  const raw = errorMessage?.trim() || '未知错误';

  if (/No API key for provider/i.test(raw)) {
    return new Error('API key is required');
  }

  if (SDK_CONNECTION_ERROR.test(raw)) {
    return new Error(`NetworkError: ${raw}`);
  }

  const status = extractHttpStatus(raw);
  if (status !== undefined) {
    return new Error(`Provider HTTP error ${status}: ${raw}`);
  }

  return new Error(raw);
}

function extractHttpStatus(raw: string): number | undefined {
  const leading = raw.match(LEADING_STATUS);
  if (leading?.[1]) return Number(leading[1]);

  const coded = raw.match(CODED_STATUS) ?? raw.match(GOT_STATUS);
  if (coded?.[1]) return Number(coded[1]);

  return undefined;
}
