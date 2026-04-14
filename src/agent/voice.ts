/**
 * voice.ts — Real-time speech-to-text via DashScope Paraformer WebSocket.
 *
 * Records audio from the microphone using Web Audio API, streams raw PCM
 * chunks over a WebSocket connection to DashScope (through a proxy), and
 * receives partial/final transcription results in real-time.
 */

import type { VoiceSettings } from '../ui/settings';
import { loadVoiceSettings } from '../ui/settings';

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

export type VoiceStatus = 'idle' | 'connecting' | 'recording' | 'transcribing';

export type VoiceStatusCallback = (status: VoiceStatus) => void;
export type PartialTranscriptCallback = (text: string) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FREE_PROXY_URL = 'wss://dg-agent-proxy-eloracuikl.cn-hangzhou.fcapp.run';
const SAMPLE_RATE = 16000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let status: VoiceStatus = 'idle';
let statusCb: VoiceStatusCallback | null = null;
let partialCb: PartialTranscriptCallback | null = null;
let taskId = '';
let finalTranscript = '';
let pendingResolve: ((text: string) => void) | null = null;
let pendingReject: ((err: Error) => void) | null = null;
/** Whether we have sent finish-task and are waiting for final result. */
let finishing = false;

function setStatus(s: VoiceStatus): void {
  status = s;
  statusCb?.(s);
}

function generateTaskId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function onStatusChange(cb: VoiceStatusCallback): void {
  statusCb = cb;
}

export function onPartialTranscript(cb: PartialTranscriptCallback): void {
  partialCb = cb;
}

export function getStatus(): VoiceStatus {
  return status;
}

export function isSupported(): boolean {
  return !!navigator.mediaDevices?.getUserMedia;
}

/** Voice is always enabled when the browser supports it. */
export function isEnabled(): boolean {
  return true;
}

/**
 * Start recording: open mic, connect WebSocket, stream audio chunks.
 */
export async function startRecording(): Promise<void> {
  if (status === 'recording' || status === 'connecting') return;

  setStatus('connecting');
  taskId = generateTaskId();
  finalTranscript = '';
  finishing = false;

  try {
    // Get microphone
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMPLE_RATE },
    });

    // Set up audio processing for raw PCM extraction
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessorNode (widely supported, including Safari)
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (e) => {
      if (ws?.readyState !== WebSocket.OPEN || finishing) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = float32ToInt16(float32);
      ws.send(int16.buffer as ArrayBuffer);
    };
    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);

    // Connect WebSocket to proxy
    const wsUrl = resolveWsUrl('asr');
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Send run-task
      ws!.send(
        JSON.stringify({
          header: {
            action: 'run-task',
            task_id: taskId,
            streaming: 'duplex',
          },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: 'paraformer-realtime-v2',
            parameters: {
              format: 'pcm',
              sample_rate: SAMPLE_RATE,
              language_hints: ['zh', 'en'],
            },
            input: {},
          },
        }),
      );
      setStatus('recording');
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const msg = JSON.parse(e.data);
        handleAsrMessage(msg);
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      cleanup();
      pendingReject?.(new Error('语音识别 WebSocket 连接失败'));
      pendingResolve = null;
      pendingReject = null;
    };

    ws.onclose = () => {
      if (finishing && pendingResolve) {
        // Connection closed before we got final result; return what we have
        pendingResolve(finalTranscript);
        pendingResolve = null;
        pendingReject = null;
      }
      cleanup();
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Stop recording and get the final transcription.
 */
export function stopRecording(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (status !== 'recording' && status !== 'connecting') {
      reject(new Error('未在录音'));
      return;
    }

    pendingResolve = resolve;
    pendingReject = reject;
    finishing = true;
    setStatus('transcribing');

    // Stop audio processing
    scriptNode?.disconnect();
    scriptNode = null;
    audioContext?.close().catch(() => {});
    audioContext = null;
    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;

    // Send finish-task
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          header: {
            action: 'finish-task',
            task_id: taskId,
            streaming: 'duplex',
          },
          payload: {
            input: {},
          },
        }),
      );

      // Timeout: if no final result in 5s, return what we have
      setTimeout(() => {
        if (pendingResolve) {
          pendingResolve(finalTranscript);
          pendingResolve = null;
          pendingReject = null;
          ws?.close();
          cleanup();
        }
      }, 5000);
    } else {
      resolve(finalTranscript);
      pendingResolve = null;
      pendingReject = null;
      cleanup();
    }
  });
}

export function cancelRecording(): void {
  pendingResolve = null;
  pendingReject = null;
  finishing = false;
  ws?.close();
  cleanup();
}

// ---------------------------------------------------------------------------
// ASR message handling
// ---------------------------------------------------------------------------

function handleAsrMessage(msg: any): void {
  const header = msg.header || {};
  const payload = msg.payload || {};

  if (header.event === 'task-started') {
    // Task acknowledged, ready to receive audio
    return;
  }

  if (header.event === 'result-generated') {
    const output = payload.output || {};
    const sentence = output.sentence;
    if (sentence && typeof sentence.text === 'string') {
      finalTranscript = sentence.text;
      partialCb?.(finalTranscript);
    }
  }

  if (header.event === 'task-finished') {
    // Final result
    if (pendingResolve) {
      pendingResolve(finalTranscript);
      pendingResolve = null;
      pendingReject = null;
    }
    ws?.close();
    cleanup();
  }

  if (header.event === 'task-failed') {
    const errMsg = payload.message || header.error_message || '语音识别失败';
    if (pendingReject) {
      pendingReject(new Error(errMsg));
      pendingResolve = null;
      pendingReject = null;
    }
    ws?.close();
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveWsUrl(service: 'asr' | 'tts'): string {
  const vs: VoiceSettings = loadVoiceSettings();
  if (vs.proxyUrl) {
    const base = vs.proxyUrl.replace(/\/+$/, '');
    return `${base}/ws/${service}`;
  }
  return `${FREE_PROXY_URL}/ws/${service}`;
}

function cleanup(): void {
  scriptNode?.disconnect();
  scriptNode = null;
  audioContext?.close().catch(() => {});
  audioContext = null;
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  ws = null;
  finishing = false;
  setStatus('idle');
}

/** Convert Float32 audio samples to Int16 Little-Endian PCM. */
function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

// Re-export resolveWsUrl for TTS module
export { resolveWsUrl as _resolveWsUrl };
