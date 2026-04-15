/**
 * tts.ts — Real-time text-to-speech via DashScope CosyVoice WebSocket.
 *
 * Sends text to CosyVoice through a WebSocket proxy, receives PCM audio
 * chunks, and plays them via Web Audio API with gapless streaming.
 */

import { _resolveWsUrl } from './voice';
import { loadVoiceSettings } from '../ui/settings';

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

export type TtsStatus = 'idle' | 'connecting' | 'synthesizing' | 'playing';
export type TtsStatusCallback = (status: TtsStatus) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TTS_SAMPLE_RATE = 22050;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let status: TtsStatus = 'idle';
let statusCb: TtsStatusCallback | null = null;
let taskId = '';

/** Queued audio buffers for gapless playback. */
let audioQueue: AudioBuffer[] = [];
/** When the next buffer should start playing. */
let nextStartTime = 0;
/** Currently scheduled source nodes (for stop/interrupt). */
let activeSources: AudioBufferSourceNode[] = [];

function setStatus(s: TtsStatus): void {
  if (status !== s) console.log(`[TTS] status: ${status} -> ${s}`);
  status = s;
  statusCb?.(s);
}

function generateTaskId(): string {
  return 'tts-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function onStatusChange(cb: TtsStatusCallback): void {
  statusCb = cb;
}

export function getStatus(): TtsStatus {
  return status;
}

/** TTS is always enabled. */
export function isEnabled(): boolean {
  return true;
}

/**
 * Speak the given text using CosyVoice TTS.
 * Interrupts any currently playing audio first.
 */
export async function speak(text: string): Promise<void> {
  console.log(`[TTS] speak() called, text length=${text.length}`);
  if (!text.trim() || !isEnabled()) {
    console.log('[TTS] empty text or disabled — skip');
    return;
  }

  // Stop any current playback
  stop();

  const vs = loadVoiceSettings();
  taskId = generateTaskId();
  setStatus('connecting');
  console.log('[TTS] task_id:', taskId, 'voice:', vs.speaker || 'longyan_v3');

  // Create audio context for playback
  audioCtx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
  audioQueue = [];
  activeSources = [];
  nextStartTime = 0;

  return new Promise<void>((resolve, reject) => {
    const wsUrl = _resolveWsUrl('tts');
    console.log('[TTS] opening WebSocket:', wsUrl);
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    const thisWs = ws;
    thisWs.onopen = () => {
      // Guard against races: stop() may have replaced/cleared ws before onopen fires.
      if (ws !== thisWs || thisWs.readyState !== WebSocket.OPEN) {
        console.log('[TTS] onopen fired but ws was replaced/closed — ignoring');
        return;
      }
      console.log('[TTS] WebSocket open — sending run-task');
      setStatus('synthesizing');
      thisWs.send(
        JSON.stringify({
          header: {
            action: 'run-task',
            task_id: taskId,
            streaming: 'out',
          },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model: 'cosyvoice-v3',
            parameters: {
              voice: vs.speaker || 'longyan_v3',
              format: 'pcm',
              sample_rate: TTS_SAMPLE_RATE,
            },
            input: { text },
          },
        }),
      );
    };

    let audioChunkCount = 0;
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        // Binary frame: PCM audio data
        audioChunkCount++;
        if (audioChunkCount === 1 || audioChunkCount % 20 === 0) {
          console.log(`[TTS] <- audio chunk #${audioChunkCount} (${e.data.byteLength} bytes)`);
        }
        handleAudioChunk(e.data);
      } else if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          const event = msg.header?.event;
          console.log('[TTS] <-', event, msg);
          if (event === 'task-finished') {
            // All audio received
            ws?.close();
            ws = null;
            // Status will transition to 'idle' when all buffers finish playing
            if (audioQueue.length === 0 && activeSources.length === 0) {
              setStatus('idle');
            }
            resolve();
          } else if (event === 'task-failed') {
            const errMsg = msg.payload?.message || msg.header?.error_message || 'TTS 合成失败';
            console.error('[TTS] task-failed:', errMsg);
            stop();
            reject(new Error(errMsg));
          }
        } catch (err) {
          console.warn('[TTS] parse error', err);
        }
      }
    };

    ws.onerror = (ev) => {
      console.warn('[TTS] WebSocket onerror', ev);
      stop();
      reject(new Error('TTS WebSocket 连接失败'));
    };

    ws.onclose = (ev) => {
      console.log(`[TTS] WebSocket close code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`);
      ws = null;
      if (status === 'connecting' || status === 'synthesizing') {
        if (audioQueue.length === 0 && activeSources.length === 0) {
          setStatus('idle');
          resolve();
        }
      }
    };
  });
}

/** Stop any current TTS playback and synthesis. */
export function stop(): void {
  if (ws || audioCtx || activeSources.length || audioQueue.length) {
    console.log('[TTS] stop() called, status:', status);
  }
  // Close WebSocket
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
    ws = null;
  }

  // Stop all playing audio
  for (const src of activeSources) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  activeSources = [];
  audioQueue = [];

  // Close audio context
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  nextStartTime = 0;
  setStatus('idle');
}

// ---------------------------------------------------------------------------
// Audio processing
// ---------------------------------------------------------------------------

function handleAudioChunk(data: ArrayBuffer): void {
  if (!audioCtx) return;

  // Convert Int16 PCM to Float32 AudioBuffer
  const int16 = new Int16Array(data);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  const buffer = audioCtx.createBuffer(1, float32.length, TTS_SAMPLE_RATE);
  buffer.getChannelData(0).set(float32);

  scheduleBuffer(buffer);

  if (status !== 'playing') {
    setStatus('playing');
  }
}

function scheduleBuffer(buffer: AudioBuffer): void {
  if (!audioCtx) return;

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  // Schedule for gapless playback
  const now = audioCtx.currentTime;
  const startAt = Math.max(now, nextStartTime);
  source.start(startAt);
  nextStartTime = startAt + buffer.duration;

  activeSources.push(source);

  // Clean up when done
  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx >= 0) activeSources.splice(idx, 1);
    // If all audio done and WebSocket closed, go idle
    if (activeSources.length === 0 && !ws) {
      setStatus('idle');
    }
  };
}
