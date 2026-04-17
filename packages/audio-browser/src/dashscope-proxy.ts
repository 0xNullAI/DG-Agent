import {
  DEFAULT_PROXY_TTS_SPEAKER,
  SPEECH_ABORTED_ERROR_MESSAGE,
  SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE,
  type BrowserSpeechRecognitionOptions,
  type BrowserSpeechSynthesisOptions,
  type SpeechRecognitionController,
  type SpeechRecognitionRequest,
  type SpeechSynthesisSession,
  type SpeechSynthesizer,
} from './types.js';

const FREE_PROXY_URL = 'https://dg-agent-proxy-eloracuikl.cn-hangzhou.fcapp.run';
const SAMPLE_RATE = 16000;
const TTS_SAMPLE_RATE = 22050;
const SILENCE_THRESHOLD = 0.02;
const SILENCE_DURATION_MS = 1500;
const SPEECH_CONFIRM_FRAMES = 3;
const ASR_FINAL_TIMEOUT_MS = 5000;

let pcmWorkletModuleUrl: string | null = null;

interface BrowserAudioWindowLike extends Window {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function getBrowserWindow(): BrowserAudioWindowLike | undefined {
  return typeof window === 'undefined' ? undefined : (window as BrowserAudioWindowLike);
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  return getBrowserWindow()?.AudioContext ?? getBrowserWindow()?.webkitAudioContext;
}

export function isDashscopeProxyRecognitionSupported(): boolean {
  return Boolean(
    getAudioContextCtor() &&
      typeof WebSocket !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof Blob !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices?.getUserMedia,
  );
}

export function isDashscopeProxySynthesisSupported(): boolean {
  return Boolean(getAudioContextCtor() && typeof WebSocket !== 'undefined');
}

function createTaskId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveProxyWsUrl(service: 'asr' | 'tts', proxyUrl?: string, apiKey?: string): string {
  const usingCustomProxy = Boolean(proxyUrl?.trim());
  const rawBase = usingCustomProxy ? proxyUrl!.trim() : FREE_PROXY_URL;
  const normalizedBase =
    rawBase.startsWith('ws://') || rawBase.startsWith('wss://')
      ? rawBase.replace(/\/+$/, '')
      : rawBase.replace(/^http/, 'ws').replace(/\/+$/, '');
  const url = `${normalizedBase}/ws/${service}`;

  if (usingCustomProxy && apiKey?.trim()) {
    return `${url}?api_key=${encodeURIComponent(apiKey.trim())}`;
  }

  return url;
}

function computeRms(float32: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < float32.length; index++) {
    const sample = float32[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / float32.length);
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let index = 0; index < float32.length; index++) {
    const sample = Math.max(-1, Math.min(1, float32[index] ?? 0));
    int16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16;
}

function sanitizeForTts(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TTS_BOUNDARY = /[。！？；.!?;\n]/g;

const PCM_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._batchSize = 4096;
    this._buffer = new Float32Array(this._batchSize);
    this._filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(this._batchSize - this._filled, channel.length - offset);
      this._buffer.set(channel.subarray(offset, offset + take), this._filled);
      this._filled += take;
      offset += take;
      if (this._filled >= this._batchSize) {
        this.port.postMessage(this._buffer.slice(0));
        this._filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

export class DashscopeProxySpeechRecognitionController implements SpeechRecognitionController {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private taskId = '';
  private pendingResolve: ((text: string) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private partialTranscriptCb: ((text: string) => void) | null = null;
  private finalTranscript = '';
  private sentencesById = new Map<number, string>();
  private finishing = false;
  private speechDetected = false;
  private speechFrames = 0;
  private silenceStart = 0;
  private finalTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private manualStop = false;

  constructor(private readonly options: BrowserSpeechRecognitionOptions = {}) {}

  async transcribeOnce(request: SpeechRecognitionRequest = {}): Promise<string> {
    if (!isDashscopeProxyRecognitionSupported()) {
      throw new Error('DashScope proxy speech recognition is not supported in this browser.');
    }

    this.abort(true);
    this.partialTranscriptCb = request.onPartialTranscript ?? null;
    this.manualStop = Boolean(request.manualStop);

    return await new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      void this.startSession().catch((error) => {
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
        this.cleanup();
      });
    });
  }

  abort(silent = false): void {
    const reject = this.pendingReject;
    this.clearPending();
    this.cleanup();
    if (!silent) {
      reject?.(new Error(SPEECH_ABORTED_ERROR_MESSAGE));
    }
  }

  stop(): void {
    this.finishRecording();
  }

  private async startSession(): Promise<void> {
    this.taskId = createTaskId();
    this.finalTranscript = '';
    this.sentencesById.clear();
    this.finishing = false;
    this.speechDetected = false;
    this.speechFrames = 0;
    this.silenceStart = 0;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMPLE_RATE },
    });

    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      throw new Error('AudioContext is unavailable in this browser.');
    }

    this.audioContext = new AudioContextCtor({ sampleRate: SAMPLE_RATE });
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);

    if (!this.audioContext.audioWorklet) {
      throw new Error('AudioWorklet is unavailable in this browser.');
    }

    if (!pcmWorkletModuleUrl) {
      pcmWorkletModuleUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' }));
    }

    await this.audioContext.audioWorklet.addModule(pcmWorkletModuleUrl);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');
    this.workletNode.port.onmessage = (event) => {
      const float32 = event.data as Float32Array;
      if (this.ws?.readyState !== WebSocket.OPEN || this.finishing) return;

      const int16 = float32ToInt16(float32);
      this.ws.send(int16.buffer as ArrayBuffer);

      if (this.manualStop || !this.options.autoStopEnabled) return;
      this.handleVadFrame(float32);
    };

    source.connect(this.workletNode);
    this.workletNode.connect(this.audioContext.destination);

    const wsUrl = resolveProxyWsUrl('asr', this.options.proxyUrl, this.options.apiKey);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';
    const activeWs = this.ws;

    activeWs.onopen = () => {
      if (this.ws !== activeWs || activeWs.readyState !== WebSocket.OPEN) return;

      activeWs.send(
        JSON.stringify({
          header: {
            action: 'run-task',
            task_id: this.taskId,
            streaming: 'duplex',
          },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: 'gummy-realtime-v1',
            parameters: {
              format: 'pcm',
              sample_rate: SAMPLE_RATE,
              transcription_enabled: true,
              translation_enabled: false,
              source_language: 'auto',
            },
            input: {},
          },
        }),
      );
    };

    activeWs.onmessage = (event) => {
      if (typeof event.data !== 'string') return;

      try {
        const message = JSON.parse(event.data);
        this.handleAsrMessage(message);
      } catch {
        // Ignore malformed frames from the proxy and keep listening.
      }
    };

    activeWs.onerror = () => {
      this.rejectPending(new Error('Voice recognition WebSocket connection failed.'));
      this.cleanup();
    };

    activeWs.onclose = () => {
      if (this.finishing && this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.clearPending();
        this.cleanup();
        resolve(this.finalTranscript);
        return;
      }

      if (this.pendingReject) {
        const reject = this.pendingReject;
        this.clearPending();
        this.cleanup();
        reject(new Error('Voice recognition connection closed.'));
        return;
      }

      this.cleanup();
    };
  }

  private handleVadFrame(float32: Float32Array): void {
    const rms = computeRms(float32);
    if (rms > SILENCE_THRESHOLD) {
      if (!this.speechDetected) {
        this.speechFrames += 1;
        if (this.speechFrames >= SPEECH_CONFIRM_FRAMES) {
          this.speechDetected = true;
          this.silenceStart = 0;
        }
      } else {
        this.silenceStart = 0;
      }
      return;
    }

    if (this.speechDetected) {
      const now = Date.now();
      if (this.silenceStart === 0) {
        this.silenceStart = now;
        return;
      }

      if (now - this.silenceStart >= SILENCE_DURATION_MS) {
        this.finishRecording();
        this.speechDetected = false;
        this.speechFrames = 0;
        this.silenceStart = 0;
      }
      return;
    }

    this.speechFrames = Math.max(0, this.speechFrames - 1);
  }

  private finishRecording(): void {
    if (this.finishing) return;
    this.finishing = true;
    this.teardownCapture();

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          header: {
            action: 'finish-task',
            task_id: this.taskId,
            streaming: 'duplex',
          },
          payload: {
            input: {},
          },
        }),
      );

      this.finalTimeoutId = setTimeout(() => {
        if (!this.pendingResolve) return;
        const resolve = this.pendingResolve;
        this.clearPending();
        this.cleanup();
        resolve(this.finalTranscript);
      }, ASR_FINAL_TIMEOUT_MS);
      return;
    }

    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.clearPending();
      this.cleanup();
      resolve(this.finalTranscript);
    }
  }

  private handleAsrMessage(message: any): void {
    const header = message.header ?? {};
    const payload = message.payload ?? {};

    if (header.event === 'result-generated') {
      const output = payload.output ?? {};
      const sentence = output.transcription ?? output.sentence;
      if (sentence && typeof sentence.text === 'string') {
        const sentenceId = typeof sentence.sentence_id === 'number' ? sentence.sentence_id : 0;
        this.sentencesById.set(sentenceId, sentence.text);
        this.finalTranscript = [...this.sentencesById.keys()]
          .sort((left, right) => left - right)
          .map((key) => this.sentencesById.get(key) ?? '')
          .join('');
        this.partialTranscriptCb?.(this.finalTranscript);
      }
      return;
    }

    if (header.event === 'task-finished') {
      const resolve = this.pendingResolve;
      this.clearPending();
      this.cleanup();
      resolve?.(this.finalTranscript);
      return;
    }

    if (header.event === 'task-failed') {
      const errorMessage = payload.message ?? header.error_message ?? 'Voice recognition failed.';
      this.rejectPending(new Error(errorMessage));
      this.cleanup();
    }
  }

  private rejectPending(error: Error): void {
    const reject = this.pendingReject;
    this.clearPending();
    reject?.(error);
  }

  private clearPending(): void {
    this.pendingResolve = null;
    this.pendingReject = null;
    if (this.finalTimeoutId) {
      clearTimeout(this.finalTimeoutId);
      this.finalTimeoutId = null;
    }
  }

  private teardownCapture(): void {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private cleanup(): void {
    this.teardownCapture();
    this.partialTranscriptCb = null;
    this.manualStop = false;
    this.finishing = false;
    this.speechDetected = false;
    this.speechFrames = 0;
    this.silenceStart = 0;

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

export class DashscopeProxySpeechSynthesizer implements SpeechSynthesizer {
  private readonly activeSessions = new Set<DashscopeProxySpeechSynthesisSession>();

  constructor(private readonly options: BrowserSpeechSynthesisOptions = {}) {}

  async speak(text: string): Promise<void> {
    const session = this.createStreamingSession();
    session.pushAccumulatedText(text);
    await session.finish(text);
  }

  createStreamingSession(): SpeechSynthesisSession {
    const session = new DashscopeProxySpeechSynthesisSession(this.options, () => {
      this.activeSessions.delete(session);
    });
    this.activeSessions.add(session);
    return session;
  }

  stop(): void {
    for (const session of [...this.activeSessions]) {
      session.abort();
    }
  }
}

class DashscopeProxySpeechSynthesisSession implements SpeechSynthesisSession {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private activeSources: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
  private taskId = createTaskId();
  private taskStarted = false;
  private pendingTextBuffer: string[] = [];
  private finishPending = false;
  private finishPromise: Promise<void> | null = null;
  private finishResolve: (() => void) | null = null;
  private finishReject: ((error: Error) => void) | null = null;
  private lastSendTime = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sentLength = 0;
  private latestAccumulatedText = '';
  private aborted = false;

  constructor(
    private readonly options: BrowserSpeechSynthesisOptions,
    private readonly onClose: () => void,
  ) {}

  pushAccumulatedText(accumulatedText: string): void {
    if (this.aborted) return;
    this.latestAccumulatedText = accumulatedText;
    this.flushAtBoundary(accumulatedText, false);
  }

  finish(finalText?: string): Promise<void> {
    if (this.aborted) {
      return Promise.reject(new Error(SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE));
    }

    const accumulatedText = finalText ?? this.latestAccumulatedText;
    this.latestAccumulatedText = accumulatedText;
    this.flushAtBoundary(accumulatedText, true);

    if (!this.ws && this.pendingTextBuffer.length === 0) {
      this.onClose();
      return Promise.resolve();
    }

    if (this.finishPromise) {
      return this.finishPromise;
    }

    this.finishPromise = new Promise<void>((resolve, reject) => {
      this.finishResolve = resolve;
      this.finishReject = reject;
      this.finishPending = true;

      if (!this.ws) {
        void this.openStream().catch((error) => {
          this.rejectAndCleanup(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      if (this.taskStarted && this.ws.readyState === WebSocket.OPEN) {
        this.sendFinishTask(this.ws);
      }
    });

    return this.finishPromise;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    const reject = this.finishReject;
    this.clearFinishPromise();
    this.cleanup();
    reject?.(new Error(SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE));
    this.onClose();
  }

  private flushAtBoundary(accumulatedText: string, final: boolean): void {
    const pending = accumulatedText.slice(this.sentLength);
    if (!pending) return;

    let cutoff = 0;
    if (final) {
      cutoff = pending.length;
    } else {
      TTS_BOUNDARY.lastIndex = 0;
      let match: RegExpExecArray | null;
      let lastBoundary = -1;
      while ((match = TTS_BOUNDARY.exec(pending)) !== null) {
        lastBoundary = match.index + 1;
      }
      cutoff = lastBoundary;
    }

    if (cutoff <= 0) return;

    const chunk = sanitizeForTts(pending.slice(0, cutoff));
    this.sentLength += cutoff;
    if (!chunk) return;

    if (!this.ws) {
      this.pendingTextBuffer.push(chunk);
      void this.openStream().catch((error) => {
        this.rejectAndCleanup(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }

    if (!this.taskStarted) {
      this.pendingTextBuffer.push(chunk);
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendContinueTask(this.ws, chunk);
    }
  }

  private async openStream(): Promise<void> {
    if (this.aborted || this.ws) return;
    if (!isDashscopeProxySynthesisSupported()) {
      throw new Error('DashScope proxy speech synthesis is not supported in this browser.');
    }

    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      throw new Error('AudioContext is unavailable in this browser.');
    }

    this.audioContext = new AudioContextCtor({ sampleRate: TTS_SAMPLE_RATE });
    const wsUrl = resolveProxyWsUrl('tts', this.options.proxyUrl, this.options.apiKey);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';
    const activeWs = this.ws;

    activeWs.onopen = () => {
      if (this.ws !== activeWs || activeWs.readyState !== WebSocket.OPEN) return;

      activeWs.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model: 'cosyvoice-v2',
            parameters: {
              text_type: 'PlainText',
              voice: this.options.speaker || DEFAULT_PROXY_TTS_SPEAKER,
              format: 'pcm',
              sample_rate: TTS_SAMPLE_RATE,
            },
            input: {},
          },
        }),
      );
    };

    activeWs.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleAudioChunk(event.data);
        return;
      }

      if (typeof event.data !== 'string') return;

      try {
        const message = JSON.parse(event.data);
        const eventName = message.header?.event;
        if (eventName === 'task-started') {
          this.taskStarted = true;
          this.startHeartbeat(activeWs);

          if (activeWs.readyState === WebSocket.OPEN) {
            for (const chunk of this.pendingTextBuffer) {
              this.sendContinueTask(activeWs, chunk);
            }
            this.pendingTextBuffer = [];

            if (this.finishPending) {
              this.sendFinishTask(activeWs);
            }
          }
          return;
        }

        if (eventName === 'task-finished') {
          const resolve = this.finishResolve;
          this.clearFinishPromise();
          this.cleanup();
          resolve?.();
          this.onClose();
          return;
        }

        if (eventName === 'task-failed') {
          const errorMessage = message.payload?.message ?? message.header?.error_message ?? 'Speech synthesis failed.';
          this.rejectAndCleanup(new Error(errorMessage));
        }
      } catch {
        // Ignore malformed frames and keep the session alive.
      }
    };

    activeWs.onerror = () => {
      this.rejectAndCleanup(new Error('Speech synthesis WebSocket connection failed.'));
    };

    activeWs.onclose = () => {
      if (this.ws !== activeWs) return;
      const resolve = this.finishResolve;
      this.clearFinishPromise();
      this.cleanup();
      resolve?.();
      this.onClose();
    };
  }

  private rejectAndCleanup(error: Error): void {
    const reject = this.finishReject;
    this.clearFinishPromise();
    this.cleanup();
    reject?.(error);
    this.onClose();
  }

  private clearFinishPromise(): void {
    this.finishPromise = null;
    this.finishResolve = null;
    this.finishReject = null;
    this.finishPending = false;
  }

  private sendContinueTask(ws: WebSocket, text: string): void {
    ws.send(
      JSON.stringify({
        header: { action: 'continue-task', task_id: this.taskId, streaming: 'duplex' },
        payload: { input: { text } },
      }),
    );
    this.lastSendTime = Date.now();
  }

  private sendFinishTask(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
        payload: { input: {} },
      }),
    );
    this.stopHeartbeat();
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }

      if (this.finishPending) return;
      if (Date.now() - this.lastSendTime < 18_000) return;
      this.sendContinueTask(ws, ' ');
    }, 5_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleAudioChunk(data: ArrayBuffer): void {
    if (!this.audioContext) return;
    if (data.byteLength < 2 || data.byteLength % 2 !== 0) return;

    const int16 = new Int16Array(data);
    const float32 = new Float32Array(int16.length);
    for (let index = 0; index < int16.length; index++) {
      float32[index] = (int16[index] ?? 0) / 32768;
    }

    const buffer = this.audioContext.createBuffer(1, float32.length, TTS_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);
    this.scheduleBuffer(buffer);
  }

  private scheduleBuffer(buffer: AudioBuffer): void {
    if (!this.audioContext) return;

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    const startAt = Math.max(this.audioContext.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.push(source);
    source.onended = () => {
      const index = this.activeSources.indexOf(source);
      if (index >= 0) {
        this.activeSources.splice(index, 1);
      }
    };
  }

  private cleanup(): void {
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }

    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Ignore already-stopped nodes.
      }
    }
    this.activeSources = [];
    this.nextStartTime = 0;

    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }

    this.taskStarted = false;
    this.pendingTextBuffer = [];
  }
}
