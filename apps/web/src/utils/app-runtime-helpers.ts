import { SPEECH_ABORTED_ERROR_MESSAGE, SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE } from '@dg-agent/audio-browser';

const REPLY_ABORTED_ERROR_MESSAGE = 'Assistant reply aborted.';

export function isSpeechAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === SPEECH_ABORTED_ERROR_MESSAGE;
}

export function isSpeechSynthesisAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE;
}

export function isReplyAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === REPLY_ABORTED_ERROR_MESSAGE;
}

export function createSessionId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
