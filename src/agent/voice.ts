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
export type SpeechEndCallback = () => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FREE_PROXY_URL = 'wss://dg-agent-proxy-eloracuikl.cn-hangzhou.fcapp.run';
const SAMPLE_RATE = 16000;

/** RMS threshold below which audio is considered silence. */
const SILENCE_THRESHOLD = 0.02;
/** Seconds of continuous silence after speech to trigger auto-stop. */
const SILENCE_DURATION = 1.5;
/** Audio frames (each ~256 ms at 16 kHz / 4096 buffer) of sustained voice
 *  required before we treat the user as actually speaking. Prevents single
 *  noise spikes from arming the silence countdown before the user talks. */
const SPEECH_CONFIRM_FRAMES = 3;

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
let speechEndCb: SpeechEndCallback | null = null;
let taskId = '';
let finalTranscript = '';
let pendingResolve: ((text: string) => void) | null = null;
let pendingReject: ((err: Error) => void) | null = null;
/** Invoked when startRecording's WebSocket fails before stopRecording is called. */
let startErrorCb: ((err: Error) => void) | null = null;
/** Whether we have sent finish-task and are waiting for final result. */
let finishing = false;

// VAD (Voice Activity Detection) state
/** Whether we have detected speech in the current recording session. */
let speechDetected = false;
/** Consecutive above-threshold frames observed so far (before confirmation). */
let speechFrames = 0;
/** Timestamp (ms) when silence began after speech, or 0 if currently speaking. */
let silenceStart = 0;

function setStatus(s: VoiceStatus): void {
  if (status !== s) console.log(`[ASR] status: ${status} -> ${s}`);
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

/** Register a callback invoked when VAD detects speech has ended (silence after speech). */
export function onSpeechEnd(cb: SpeechEndCallback): void {
  speechEndCb = cb;
}

/** Register a callback invoked if the ASR WebSocket fails during startup. */
export function onStartError(cb: (err: Error) => void): void {
  startErrorCb = cb;
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
  console.log('[ASR] startRecording() called, current status:', status);
  if (status === 'recording' || status === 'connecting') {
    console.log('[ASR] already recording/connecting — skip');
    return;
  }

  setStatus('connecting');
  taskId = generateTaskId();
  finalTranscript = '';
  finishing = false;
  speechDetected = false;
  speechFrames = 0;
  silenceStart = 0;
  console.log('[ASR] task_id:', taskId);

  try {
    // Get microphone
    console.log('[ASR] requesting microphone…');
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMPLE_RATE },
    });
    console.log('[ASR] microphone acquired');

    // Set up audio processing for raw PCM extraction
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessorNode (widely supported, including Safari)
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    let audioChunkCount = 0;
    scriptNode.onaudioprocess = (e) => {
      if (ws?.readyState !== WebSocket.OPEN || finishing) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = float32ToInt16(float32);
      ws.send(int16.buffer as ArrayBuffer);
      audioChunkCount++;
      if (audioChunkCount % 25 === 1) {
        console.log(`[ASR] sent audio chunk #${audioChunkCount} (${int16.byteLength} bytes)`);
      }

      // VAD: detect speech end by monitoring audio energy
      if (!loadVoiceSettings().autoStopEnabled) return;
      const rms = computeRms(float32);
      if (rms > SILENCE_THRESHOLD) {
        // Require several consecutive above-threshold frames before
        // treating this as real speech (avoids single-spike false positives).
        if (!speechDetected) {
          speechFrames++;
          if (speechFrames >= SPEECH_CONFIRM_FRAMES) {
            speechDetected = true;
            silenceStart = 0;
            console.log(`[ASR] VAD: speech detected (rms=${rms.toFixed(4)})`);
          }
        } else {
          silenceStart = 0;
        }
      } else if (speechDetected) {
        const now = Date.now();
        if (silenceStart === 0) {
          silenceStart = now;
          console.log(`[ASR] VAD: silence started (rms=${rms.toFixed(4)})`);
        } else if (now - silenceStart > SILENCE_DURATION * 1000) {
          // Silence long enough after speech — notify
          console.log(`[ASR] VAD: speech end after ${SILENCE_DURATION}s silence — firing callback`);
          speechEndCb?.();
          // Reset so we don't fire again
          speechDetected = false;
          speechFrames = 0;
          silenceStart = 0;
        }
      } else {
        // Below threshold and no confirmed speech yet — decay any partial
        // speech-frame count so transient noise eventually resets.
        speechFrames = Math.max(0, speechFrames - 1);
      }
    };
    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);

    // Connect WebSocket to proxy
    const wsUrl = resolveWsUrl('asr');
    console.log('[ASR] opening WebSocket:', wsUrl);
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    const thisWs = ws;

    thisWs.onopen = () => {
      // Guard against races: cancelRecording/cleanup may have cleared or
      // replaced ws before this late onopen fires.
      if (ws !== thisWs || thisWs.readyState !== WebSocket.OPEN) {
        console.log('[ASR] onopen fired but ws was replaced/closed — ignoring');
        return;
      }
      console.log('[ASR] WebSocket open — sending run-task');
      thisWs.send(
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
        console.log('[ASR] <-', msg.header?.event, msg);
        handleAsrMessage(msg);
      } catch (err) {
        console.warn('[ASR] parse error', err);
      }
    };

    ws.onerror = (ev) => {
      console.warn('[ASR] WebSocket onerror', ev);
      const wasConnecting = status === 'connecting';
      const err = new Error('语音识别 WebSocket 连接失败');
      cleanup();
      if (pendingReject) {
        pendingReject(err);
        pendingResolve = null;
        pendingReject = null;
      } else if (wasConnecting) {
        startErrorCb?.(err);
      }
    };

    ws.onclose = (ev) => {
      console.log(`[ASR] WebSocket close code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`);
      if (finishing && pendingResolve) {
        // Connection closed before we got final result; return what we have
        pendingResolve(finalTranscript);
        pendingResolve = null;
        pendingReject = null;
      }
      cleanup();
    };
  } catch (err) {
    console.error('[ASR] startRecording error:', err);
    cleanup();
    throw err;
  }
}

/**
 * Stop recording and get the final transcription.
 */
export function stopRecording(): Promise<string> {
  console.log('[ASR] stopRecording() called, status:', status);
  return new Promise<string>((resolve, reject) => {
    if (status !== 'recording' && status !== 'connecting') {
      reject(new Error('未在录音'));
      return;
    }

    pendingResolve = resolve;
    pendingReject = reject;
    finishing = true;
    setStatus('transcribing');
    console.log('[ASR] -> finish-task (waiting for final transcript)');

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
  console.log('[ASR] cancelRecording() called, status:', status);
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
  const usingCustomProxy = !!vs.proxyUrl;
  const base = usingCustomProxy ? vs.proxyUrl.replace(/\/+$/, '') : FREE_PROXY_URL;
  const url = `${base}/ws/${service}`;
  // Only append api_key when using a custom proxy that the user controls.
  // The hosted free proxy currently ignores query keys, so appending one
  // would just leak the key without effect.
  if (usingCustomProxy && vs.dashscopeApiKey) {
    return `${url}?api_key=${encodeURIComponent(vs.dashscopeApiKey)}`;
  }
  return url;
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

/** Compute Root Mean Square energy of an audio buffer. */
function computeRms(float32: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) {
    sum += float32[i] * float32[i];
  }
  return Math.sqrt(sum / float32.length);
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
