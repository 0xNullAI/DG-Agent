export const REPLY_ABORTED_ERROR_MESSAGE = 'Assistant reply aborted.';
export const REPLY_ABORTED_NOTE = '✋ 已手动中止。';
export const TOOL_LOOP_EXHAUSTED_MESSAGE = '我这边有点绕进去了，可以换个说法再问一次吗？';

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;

  if (typeof DOMException !== 'undefined') {
    throw new DOMException(REPLY_ABORTED_ERROR_MESSAGE, 'AbortError');
  }

  const error = new Error(REPLY_ABORTED_ERROR_MESSAGE);
  error.name = 'AbortError';
  throw error;
}

export function normalizeAssistantErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');

  if (/API key is required/i.test(raw)) {
    return '还没有配置 API Key，请先在设置里填写。';
  }

  const statusMatch = raw.match(/\b(?:API error|HTTP error|Provider HTTP error)\s+(\d{3})\b/i);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 400) return '请求被服务端拒绝，请检查模型、参数或接口兼容性。';
    if (status === 401) return 'API Key 无效或已过期，请检查设置。';
    if (status === 403) return '当前接口访问被拒绝，请检查账号权限、地区限制或代理。';
    if (status === 429) return '请求过于频繁，已被限流，请稍后再试。';
    if (status >= 500) return 'AI 服务暂时不可用，请稍后重试。';
  }

  if (/Failed to fetch|NetworkError|TypeError: network|net::|WebSocket/i.test(raw)) {
    return '网络连接失败，请检查网络、代理或服务状态后重试。';
  }

  return `出错了：${raw}`;
}
