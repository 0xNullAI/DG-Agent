import {
  DashscopeProxySpeechRecognitionController,
  DashscopeProxySpeechSynthesizer,
  isDashscopeProxyRecognitionSupported,
  isDashscopeProxySynthesisSupported,
} from './dashscope-proxy.js';
import {
  SPEECH_ABORTED_ERROR_MESSAGE,
  SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE,
} from './types.js';
import type {
  BrowserSpeechCapabilities,
  BrowserSpeechRecognitionOptions,
  BrowserSpeechSynthesisOptions,
  SpeechCapabilityOptions,
  SpeechRecognitionController,
  SpeechRecognitionRequest,
  SpeechSynthesisSession,
  SpeechSynthesizer,
} from './types.js';
export {
  DEFAULT_PROXY_TTS_SPEAKER,
  PROXY_TTS_SPEAKERS,
  SPEECH_ABORTED_ERROR_MESSAGE,
  SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE,
  type BrowserSpeechCapabilities,
  type BrowserSpeechRecognitionOptions,
  type BrowserSpeechSynthesisOptions,
  type SpeechCapabilityOptions,
  type SpeechRecognitionController,
  type SpeechRecognitionRequest,
  type SpeechServiceMode,
  type SpeechSynthesisSession,
  type SpeechSynthesizer,
} from './types.js';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface BrowserSpeechWindowLike extends Window {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}

function getSpeechWindow(): BrowserSpeechWindowLike | undefined {
  return typeof window === 'undefined' ? undefined : (window as BrowserSpeechWindowLike);
}

function getNativeRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  const browserWindow = getSpeechWindow();
  return browserWindow?.SpeechRecognition ?? browserWindow?.webkitSpeechRecognition;
}

export function getBrowserSpeechCapabilities(options: SpeechCapabilityOptions = {}): BrowserSpeechCapabilities {
  const recognitionMode = options.recognitionMode ?? 'browser';
  const synthesisMode = options.synthesisMode ?? 'browser';
  const nativeRecognitionSupported = Boolean(getNativeRecognitionCtor());
  const nativeSynthesisSupported =
    typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  const proxyRecognitionSupported = isDashscopeProxyRecognitionSupported();
  const proxySynthesisSupported = isDashscopeProxySynthesisSupported();

  return {
    recognitionMode,
    synthesisMode,
    nativeRecognitionSupported,
    nativeSynthesisSupported,
    proxyRecognitionSupported,
    proxySynthesisSupported,
    recognitionSupported: recognitionMode === 'dashscope-proxy' ? proxyRecognitionSupported : nativeRecognitionSupported,
    synthesisSupported: synthesisMode === 'dashscope-proxy' ? proxySynthesisSupported : nativeSynthesisSupported,
  };
}

export class BrowserSpeechRecognitionController implements SpeechRecognitionController {
  private activeRecognition: SpeechRecognitionLike | null = null;

  constructor(private readonly options: BrowserSpeechRecognitionOptions = {}) {}

  async transcribeOnce(request: SpeechRecognitionRequest = {}): Promise<string> {
    const RecognitionCtor = getNativeRecognitionCtor();
    if (!RecognitionCtor) {
      throw new Error('Speech recognition is not supported in this browser.');
    }

    return await new Promise<string>((resolve, reject) => {
      const recognition = new RecognitionCtor();
      let transcript = '';
      let settled = false;
      this.activeRecognition = recognition;

      recognition.lang = this.options.lang ?? 'zh-CN';
      recognition.interimResults = true;
      recognition.continuous = Boolean(request.manualStop);

      recognition.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';
        for (let index = 0; index < event.results.length; index++) {
          const result = event.results[index];
          if (!result) continue;
          const text = result[0]?.transcript ?? '';
          if (result.isFinal) {
            finalTranscript += text;
          } else {
            interimTranscript += text;
          }
        }
        transcript = finalTranscript.trim();
        request.onPartialTranscript?.(`${finalTranscript}${interimTranscript}`.trim());
      };

      recognition.onerror = (event) => {
        if (settled) return;
        settled = true;
        this.activeRecognition = null;
        reject(new Error(event.error === 'aborted' ? SPEECH_ABORTED_ERROR_MESSAGE : event.error ?? 'Speech recognition failed.'));
      };

      recognition.onend = () => {
        if (settled) return;
        settled = true;
        this.activeRecognition = null;
        resolve(transcript.trim());
      };

      recognition.start();
    });
  }

  abort(): void {
    const recognition = this.activeRecognition;
    this.activeRecognition = null;
    recognition?.abort();
  }

  stop(): void {
    this.activeRecognition?.stop();
  }
}

export class BrowserSpeechSynthesizer implements SpeechSynthesizer {
  private readonly activeSessions = new Set<BrowserSpeechSynthesisSession>();

  constructor(private readonly options: BrowserSpeechSynthesisOptions = {}) {}

  speak(text: string): Promise<void> {
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
      return Promise.reject(new Error('Speech synthesis is not supported in this browser.'));
    }

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.options.lang ?? 'zh-CN';
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error('Speech synthesis failed.'));
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.cancel();
    }
    for (const session of [...this.activeSessions]) {
      session.abort();
    }
  }

  createStreamingSession(): SpeechSynthesisSession {
    const session = new BrowserSpeechSynthesisSession(this);
    this.activeSessions.add(session);
    return session;
  }

  unregisterSession(session: BrowserSpeechSynthesisSession): void {
    this.activeSessions.delete(session);
  }
}

class BrowserSpeechSynthesisSession implements SpeechSynthesisSession {
  private accumulatedText = '';
  private aborted = false;

  constructor(private readonly owner: BrowserSpeechSynthesizer) {}

  pushAccumulatedText(accumulatedText: string): void {
    if (this.aborted) return;
    this.accumulatedText = accumulatedText;
  }

  async finish(finalText?: string): Promise<void> {
    const text = (finalText ?? this.accumulatedText).trim();
    this.owner.unregisterSession(this);

    if (this.aborted) {
      throw new Error(SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE);
    }

    if (!text) return;
    await this.owner.speak(text);
  }

  abort(): void {
    this.aborted = true;
    this.owner.unregisterSession(this);
  }
}

export function createSpeechRecognitionController(
  options: BrowserSpeechRecognitionOptions = {},
): SpeechRecognitionController {
  if (options.mode === 'dashscope-proxy') {
    return new DashscopeProxySpeechRecognitionController(options);
  }

  return new BrowserSpeechRecognitionController(options);
}

export function createSpeechSynthesizer(options: BrowserSpeechSynthesisOptions = {}): SpeechSynthesizer {
  if (options.mode === 'dashscope-proxy') {
    return new DashscopeProxySpeechSynthesizer(options);
  }

  return new BrowserSpeechSynthesizer(options);
}
