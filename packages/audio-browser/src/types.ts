export type SpeechServiceMode = 'browser' | 'dashscope-proxy';

export interface BrowserSpeechCapabilities {
  recognitionSupported: boolean;
  synthesisSupported: boolean;
  recognitionMode: SpeechServiceMode;
  synthesisMode: SpeechServiceMode;
  nativeRecognitionSupported: boolean;
  nativeSynthesisSupported: boolean;
  proxyRecognitionSupported: boolean;
  proxySynthesisSupported: boolean;
}

export interface SpeechRecognitionRequest {
  onPartialTranscript?: (text: string) => void;
}

export interface SpeechRecognitionController {
  transcribeOnce(request?: SpeechRecognitionRequest): Promise<string>;
  abort(): void;
}

export interface SpeechSynthesizer {
  speak(text: string): Promise<void>;
  createStreamingSession(): SpeechSynthesisSession;
  stop(): void;
}

export interface SpeechSynthesisSession {
  pushAccumulatedText(accumulatedText: string): void;
  finish(finalText?: string): Promise<void>;
  abort(): void;
}

export interface BrowserSpeechRecognitionOptions {
  lang?: string;
  mode?: SpeechServiceMode;
  proxyUrl?: string;
  apiKey?: string;
  autoStopEnabled?: boolean;
}

export interface BrowserSpeechSynthesisOptions {
  lang?: string;
  mode?: SpeechServiceMode;
  proxyUrl?: string;
  apiKey?: string;
  speaker?: string;
}

export interface SpeechCapabilityOptions {
  recognitionMode?: SpeechServiceMode;
  synthesisMode?: SpeechServiceMode;
}

export const SPEECH_ABORTED_ERROR_MESSAGE = 'Voice capture stopped.';
export const SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE = 'Speech playback stopped.';
export const DEFAULT_PROXY_TTS_SPEAKER = 'longxiaochun_v2';
export const PROXY_TTS_SPEAKERS: Array<{ id: string; label: string }> = [
  { id: DEFAULT_PROXY_TTS_SPEAKER, label: DEFAULT_PROXY_TTS_SPEAKER },
];
