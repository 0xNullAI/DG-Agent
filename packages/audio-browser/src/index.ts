import {
  DashscopeProxySpeechRecognitionController,
  DashscopeProxySpeechSynthesizer,
  isDashscopeProxyRecognitionSupported,
  isDashscopeProxySynthesisSupported,
} from './dashscope-proxy.js';
import { SPEECH_ABORTED_ERROR_MESSAGE, SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE } from './types.js';
import type {
  BrowserSpeechCapabilities,
  BrowserSpeechRecognitionOptions,
  BrowserSpeechSynthesisOptions,
  BrowserSpeechSynthesisVoiceOption,
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
  type BrowserSpeechSynthesisVoiceOption,
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

interface SpeechSynthesisVoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
  default: boolean;
  localService: boolean;
}

function getSpeechWindow(): BrowserSpeechWindowLike | undefined {
  return typeof window === 'undefined' ? undefined : (window as BrowserSpeechWindowLike);
}

function getNativeRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  const browserWindow = getSpeechWindow();
  return browserWindow?.SpeechRecognition ?? browserWindow?.webkitSpeechRecognition;
}

function getNativeSynthesisVoices(): SpeechSynthesisVoiceLike[] {
  if (typeof speechSynthesis === 'undefined') return [];
  return speechSynthesis.getVoices() as SpeechSynthesisVoiceLike[];
}

function toBrowserVoiceOption(voice: SpeechSynthesisVoiceLike): BrowserSpeechSynthesisVoiceOption {
  return {
    voiceURI: voice.voiceURI,
    name: voice.name,
    lang: voice.lang,
    default: voice.default,
    localService: voice.localService,
  };
}

function compareBrowserVoiceOptions(
  left: BrowserSpeechSynthesisVoiceOption,
  right: BrowserSpeechSynthesisVoiceOption,
): number {
  if (left.default !== right.default) return left.default ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function matchesSpeechLanguage(voiceLang: string, targetLang?: string): boolean {
  const normalizedVoiceLang = voiceLang.trim().toLowerCase();
  const normalizedTargetLang = targetLang?.trim().toLowerCase();
  if (!normalizedTargetLang) return true;
  if (normalizedVoiceLang === normalizedTargetLang) return true;

  const voiceBase = normalizedVoiceLang.split('-')[0] ?? normalizedVoiceLang;
  const targetBase = normalizedTargetLang.split('-')[0] ?? normalizedTargetLang;
  return Boolean(voiceBase && targetBase && voiceBase === targetBase);
}

function resolveBrowserSpeechVoice(
  browserVoiceUri?: string,
  lang?: string,
): SpeechSynthesisVoiceLike | undefined {
  const normalizedVoiceUri = browserVoiceUri?.trim();
  if (!normalizedVoiceUri) return undefined;

  return getNativeSynthesisVoices().find(
    (voice) => voice.voiceURI === normalizedVoiceUri && matchesSpeechLanguage(voice.lang, lang),
  );
}

export function getBrowserSpeechSynthesisVoices(): BrowserSpeechSynthesisVoiceOption[] {
  return getNativeSynthesisVoices().map(toBrowserVoiceOption).sort(compareBrowserVoiceOptions);
}

function formatSpeechSynthesisError(errorCode?: string): string {
  const normalizedCode = errorCode?.trim().toLowerCase();
  switch (normalizedCode) {
    case 'canceled':
      return '已取消';
    case 'interrupted':
      return '已中断';
    case 'audio-busy':
      return '音频设备正忙';
    case 'audio-hardware':
      return '音频设备不可用';
    case 'network':
      return '网络异常';
    case 'synthesis-unavailable':
      return '当前浏览器不支持语音合成';
    case 'synthesis-failed':
      return '语音合成失败';
    case 'language-unavailable':
      return '不支持所选语言';
    case 'voice-unavailable':
      return '不支持所选声音';
    case 'text-too-long':
      return '内容过长';
    case 'invalid-argument':
      return '参数无效';
    case 'not-allowed':
      return '浏览器已阻止语音合成';
    default:
      return '语音合成失败';
  }
}

export function getBrowserSpeechCapabilities(
  options: SpeechCapabilityOptions = {},
): BrowserSpeechCapabilities {
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
    recognitionSupported:
      recognitionMode === 'dashscope-proxy'
        ? proxyRecognitionSupported
        : nativeRecognitionSupported,
    synthesisSupported:
      synthesisMode === 'dashscope-proxy' ? proxySynthesisSupported : nativeSynthesisSupported,
  };
}

export class BrowserSpeechRecognitionController implements SpeechRecognitionController {
  private activeRecognition: SpeechRecognitionLike | null = null;

  constructor(private readonly options: BrowserSpeechRecognitionOptions = {}) {}

  async transcribeOnce(request: SpeechRecognitionRequest = {}): Promise<string> {
    const RecognitionCtor = getNativeRecognitionCtor();
    if (!RecognitionCtor) {
      throw new Error('当前浏览器不支持语音识别');
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
        reject(
          new Error(
            event.error === 'aborted'
              ? SPEECH_ABORTED_ERROR_MESSAGE
              : (event.error ?? '语音识别失败'),
          ),
        );
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
      return Promise.reject(new Error('当前浏览器不支持语音合成'));
    }

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.options.lang ?? 'zh-CN';
      const selectedVoice = resolveBrowserSpeechVoice(this.options.browserVoiceUri, utterance.lang);
      if (selectedVoice) {
        utterance.voice = selectedVoice as SpeechSynthesisVoice;
      }
      utterance.onend = () => resolve();
      utterance.onerror = (event) => {
        const errorCode = (event as Event & { error?: string }).error?.trim();
        reject(new Error(formatSpeechSynthesisError(errorCode)));
      };
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

export function createSpeechSynthesizer(
  options: BrowserSpeechSynthesisOptions = {},
): SpeechSynthesizer {
  if (options.mode === 'dashscope-proxy') {
    return new DashscopeProxySpeechSynthesizer(options);
  }

  return new BrowserSpeechSynthesizer(options);
}
