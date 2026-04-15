/**
 * tts.ts — Streaming text-to-speech via DashScope CosyVoice WebSocket.
 *
 * Duplex protocol per official spec
 * (https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api):
 *   run-task (config) -> task-started -> continue-task* (text)
 *     -> finish-task -> task-finished
 *
 * Audio PCM chunks arrive as binary frames interleaved with JSON events
 * and play gaplessly via Web Audio API. Synthesis starts as soon as the
 * first continue-task is delivered.
 *
 * Two entry points:
 *   - speak(text): one-shot convenience wrapper
 *   - startSpeaking() / appendText(chunk) / finishSpeaking(): true streaming,
 *     driven by LLM text deltas for lowest first-audio latency.
 *
 * 23-second idle timeout protection: spec says continue-task interval must
 * not exceed 23s. A heartbeat sends a single space every ~18s of inactivity
 * to keep the connection alive while the LLM is mid-think.
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
/** Send a heartbeat continue-task if no real text was sent in this many ms. */
const HEARTBEAT_IDLE_MS = 18000;
/** Heartbeat polling interval. */
const HEARTBEAT_TICK_MS = 5000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let status: TtsStatus = 'idle';
let statusCb: TtsStatusCallback | null = null;
let taskId = '';

/** True once task-started arrived; continue-task is only legal after this. */
let taskStarted = false;
/** Text queued before task-started — sent as soon as the server is ready. */
let pendingTextBuffer: string[] = [];
/** True if finishSpeaking() was called before task-started fired. */
let finishPending = false;
/** Settles when task-finished arrives (resolve) or synthesis fails (reject). */
let finishResolve: (() => void) | null = null;
let finishReject: ((err: Error) => void) | null = null;
/** Timestamp of the last continue-task we sent (real or heartbeat). */
let lastSendTime = 0;
/** Heartbeat poller id. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
  // DashScope spec requires UUID for task_id.
  return crypto.randomUUID();
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
 * One-shot convenience: speak a complete string. Internally uses the
 * streaming API so audio still starts playing as soon as the server
 * returns the first PCM chunk.
 */
export async function speak(text: string): Promise<void> {
  if (!text.trim() || !isEnabled()) return;
  startSpeaking();
  appendText(text);
  return finishSpeaking();
}

/**
 * Open the WebSocket and send run-task. Safe to call while already active —
 * any in-flight stream is stopped (and its pending promise rejected) first.
 */
export function startSpeaking(): void {
  console.log('[TTS] startSpeaking()');
  if (!isEnabled()) return;
  stop();

  const vs = loadVoiceSettings();
  taskId = generateTaskId();
  taskStarted = false;
  pendingTextBuffer = [];
  finishPending = false;
  finishResolve = null;
  finishReject = null;
  lastSendTime = Date.now();

  setStatus('connecting');
  console.log('[TTS] task_id:', taskId, 'voice:', vs.speaker || 'longxiaochun_v2');

  audioCtx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
  audioQueue = [];
  activeSources = [];
  nextStartTime = 0;

  const wsUrl = _resolveWsUrl('tts');
  console.log('[TTS] opening WebSocket:', wsUrl);
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const thisWs = ws;

  thisWs.onopen = () => {
    if (ws !== thisWs || thisWs.readyState !== WebSocket.OPEN) {
      console.log('[TTS] onopen fired but ws was replaced/closed — ignoring');
      return;
    }
    console.log('[TTS] WebSocket open — sending run-task (config only)');
    setStatus('synthesizing');
    thisWs.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: 'cosyvoice-v2',
          parameters: {
            text_type: 'PlainText',
            voice: vs.speaker || 'longxiaochun_v2',
            format: 'pcm',
            sample_rate: TTS_SAMPLE_RATE,
          },
          input: {},
        },
      }),
    );
  };

  let audioChunkCount = 0;
  thisWs.onmessage = (e) => {
    // Drop late messages from a previous stream that beat us to onclose.
    if (ws !== thisWs) return;

    if (e.data instanceof ArrayBuffer) {
      audioChunkCount++;
      if (audioChunkCount === 1 || audioChunkCount % 20 === 0) {
        console.log(`[TTS] <- audio chunk #${audioChunkCount} (${e.data.byteLength} bytes)`);
      }
      handleAudioChunk(e.data);
      return;
    }
    if (typeof e.data !== 'string') return;
    try {
      const msg = JSON.parse(e.data);
      const event = msg.header?.event;
      console.log('[TTS] <-', event, msg);
      if (event === 'task-started') {
        taskStarted = true;
        startHeartbeat(thisWs);
        // Flush buffered text that arrived before task-started.
        if (thisWs.readyState === WebSocket.OPEN) {
          for (const chunk of pendingTextBuffer) sendContinueTask(thisWs, chunk);
          pendingTextBuffer = [];
          if (finishPending) sendFinishTask(thisWs);
        }
      } else if (event === 'task-finished') {
        const r = finishResolve;
        finishResolve = null;
        finishReject = null;
        stopHeartbeat();
        thisWs.close();
        ws = null;
        if (audioQueue.length === 0 && activeSources.length === 0) setStatus('idle');
        r?.();
      } else if (event === 'task-failed') {
        const errMsg = msg.payload?.message || msg.header?.error_message || 'TTS 合成失败';
        console.error('[TTS] task-failed:', errMsg);
        const rej = finishReject;
        // Clear settle handles BEFORE stop() so stop() doesn't resolve them.
        finishResolve = null;
        finishReject = null;
        stop();
        rej?.(new Error(errMsg));
      }
    } catch (err) {
      console.warn('[TTS] parse error', err);
    }
  };

  thisWs.onerror = (ev) => {
    if (ws !== thisWs) return;
    console.warn('[TTS] WebSocket onerror', ev);
    const rej = finishReject;
    finishResolve = null;
    finishReject = null;
    stop();
    rej?.(new Error('TTS WebSocket error'));
  };

  thisWs.onclose = (ev) => {
    console.log(`[TTS] WebSocket close code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`);
    // Only settle current stream's promise if THIS ws is still the active one.
    if (ws !== thisWs) return;
    ws = null;
    stopHeartbeat();
    if (status === 'connecting' || status === 'synthesizing') {
      if (audioQueue.length === 0 && activeSources.length === 0) setStatus('idle');
    }
    // Connection closed without explicit task-finished → resolve so caller
    // doesn't hang. (task-failed path already cleared finishResolve.)
    const r = finishResolve;
    finishResolve = null;
    finishReject = null;
    r?.();
  };
}

/**
 * Send another chunk of text to the in-flight synthesis. No-op if the
 * stream was never started or has already been stopped/finished.
 */
export function appendText(chunk: string): void {
  if (!chunk) return;
  const sanitized = sanitizeForTts(chunk);
  if (!sanitized) return;
  if (!ws || finishPending) return;
  if (!taskStarted) {
    pendingTextBuffer.push(sanitized);
    return;
  }
  if (ws.readyState === WebSocket.OPEN) sendContinueTask(ws, sanitized);
}

/**
 * Strip characters CosyVoice PlainText can't synthesize. Empirically,
 * emoji and pictographs trigger error 418 ("InvalidParameter"); markdown
 * punctuation like `*` / `_` is also dropped so it isn't read aloud.
 */
function sanitizeForTts(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Signal that no more text will be added. Returns a promise that resolves
 * when all audio has been received (task-finished), the connection closes
 * cleanly, or rejects on synthesis failure / interrupt.
 */
export function finishSpeaking(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!ws) {
      resolve();
      return;
    }
    finishResolve = resolve;
    finishReject = reject;
    finishPending = true;
    if (!taskStarted) return; // flush happens on task-started
    if (ws.readyState === WebSocket.OPEN) sendFinishTask(ws);
  });
}

function sendContinueTask(w: WebSocket, text: string): void {
  console.log(`[TTS] -> continue-task (${text.length} chars)`);
  w.send(
    JSON.stringify({
      header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: { text } },
    }),
  );
  lastSendTime = Date.now();
}

function sendFinishTask(w: WebSocket): void {
  console.log('[TTS] -> finish-task');
  w.send(
    JSON.stringify({
      header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: {} },
    }),
  );
  stopHeartbeat();
}

// ---------------------------------------------------------------------------
// Heartbeat — keep the WS alive when LLM stalls > 23s between text chunks
// ---------------------------------------------------------------------------

function startHeartbeat(targetWs: WebSocket): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws !== targetWs || targetWs.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    if (finishPending) return;
    if (Date.now() - lastSendTime >= HEARTBEAT_IDLE_MS) {
      console.log('[TTS] -> continue-task (heartbeat)');
      // A single space avoids audible artifacts in CosyVoice while resetting
      // the 23-second idle timer.
      sendContinueTask(targetWs, ' ');
    }
  }, HEARTBEAT_TICK_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** Stop any current TTS playback and synthesis. Rejects in-flight promise. */
export function stop(): void {
  if (ws || audioCtx || activeSources.length || audioQueue.length) {
    console.log('[TTS] stop() called, status:', status);
  }
  stopHeartbeat();

  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
    ws = null;
  }

  for (const src of activeSources) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  activeSources = [];
  audioQueue = [];

  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  taskStarted = false;
  pendingTextBuffer = [];
  finishPending = false;
  nextStartTime = 0;

  // Reject any caller waiting on finishSpeaking() so they can distinguish
  // "interrupted" from "completed". Capture before clearing.
  const rej = finishReject;
  const res = finishResolve;
  finishResolve = null;
  finishReject = null;
  if (rej) rej(new Error('TTS aborted'));
  else res?.();

  setStatus('idle');
}

// ---------------------------------------------------------------------------
// Audio processing
// ---------------------------------------------------------------------------

function handleAudioChunk(data: ArrayBuffer): void {
  if (!audioCtx) return;
  // Guard against odd byte counts (Int16Array requires even).
  if (data.byteLength < 2 || data.byteLength % 2 !== 0) {
    console.warn(`[TTS] dropping malformed audio chunk (${data.byteLength} bytes)`);
    return;
  }

  // DashScope PCM is signed 16-bit little-endian. All target browsers run
  // on little-endian hosts (x86/ARM), so Int16Array's host-endian view is
  // safe here.
  const int16 = new Int16Array(data);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  const buffer = audioCtx.createBuffer(1, float32.length, TTS_SAMPLE_RATE);
  buffer.getChannelData(0).set(float32);

  scheduleBuffer(buffer);

  if (status !== 'playing') setStatus('playing');
}

function scheduleBuffer(buffer: AudioBuffer): void {
  if (!audioCtx) return;

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  const startAt = Math.max(now, nextStartTime);
  source.start(startAt);
  nextStartTime = startAt + buffer.duration;

  activeSources.push(source);

  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx >= 0) activeSources.splice(idx, 1);
    if (activeSources.length === 0 && !ws) setStatus('idle');
  };
}
