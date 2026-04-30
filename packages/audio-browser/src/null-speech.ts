import type {
  BrowserSpeechCapabilities,
  SpeechRecognitionController,
  SpeechSynthesisSession,
  SpeechSynthesizer,
} from './types.js';

export const NULL_SPEECH_CAPABILITIES: BrowserSpeechCapabilities = {
  recognitionSupported: false,
  synthesisSupported: false,
  recognitionMode: 'browser',
  synthesisMode: 'browser',
  nativeRecognitionSupported: false,
  nativeSynthesisSupported: false,
  proxyRecognitionSupported: false,
  proxySynthesisSupported: false,
};

export function createNullSpeechRecognitionController(): SpeechRecognitionController {
  return {
    async transcribeOnce(): Promise<string> {
      throw new Error('当前环境不支持语音识别');
    },
    stop(): void {
      // no-op
    },
    abort(): void {
      // no-op
    },
  };
}

export function createNullSpeechSynthesizer(): SpeechSynthesizer {
  const nullSession: SpeechSynthesisSession = {
    pushAccumulatedText(): void {
      // no-op
    },
    async finish(): Promise<void> {
      // no-op
    },
    abort(): void {
      // no-op
    },
  };
  return {
    async speak(): Promise<void> {
      // no-op (silent)
    },
    createStreamingSession(): SpeechSynthesisSession {
      return nullSession;
    },
    stop(): void {
      // no-op
    },
  };
}
