/**
 * chat.ts -- Chat UI manager for DG-Agent
 * Manages message rendering, auto-scroll, input handling, and voice mode.
 *
 * The send button is context-sensitive:
 *   - Input empty + voice enabled → waveform icon (click to enter voice mode)
 *   - Input has text → send icon (click to send)
 *   - Agent busy → stop icon (click to abort)
 *
 * Voice mode is a continuous conversation loop: record → transcribe → send →
 * TTS reply → record again. The chat messages area is replaced by a voice
 * overlay showing status and partial transcript, but all content and safety
 * policies remain active under the hood.
 */

import * as voice from '../agent/voice';
import * as tts from '../agent/tts';

// -- DOM refs (set in initChat) --
let messagesEl: HTMLDivElement;
let inputEl: HTMLTextAreaElement;
let sendBtn: HTMLButtonElement;
let chatContainer: HTMLDivElement;
let voiceOverlay: HTMLDivElement;
let voiceOverlayStatus: HTMLDivElement;
let voiceOverlayTranscript: HTMLDivElement;
let voiceOverlayStop: HTMLButtonElement;

// -- State --
let userScrolledUp = false;
let typingEl: HTMLDivElement | null = null;
let msgCounter = 0;
let isBusy = false;
let onAbortCb: (() => void) | null = null;
/** Whether we are in continuous voice conversation mode. */
let voiceMode = false;
/** Cached send handler for use in voice loop. */
let sendHandler: ((text: string) => void) | null = null;

// -- Icons --
const SEND_ICON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_ICON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const WAVEFORM_ICON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="8" x2="4" y2="16"/><line x1="8" y1="5" x2="8" y2="19"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="16" y1="7" x2="16" y2="17"/><line x1="20" y1="10" x2="20" y2="14"/></svg>';

// -- Initialise --

export function initChat(opts: {
  onSendMessage: (text: string) => void;
  onAbort?: () => void;
}): void {
  messagesEl = document.getElementById('messages') as HTMLDivElement;
  inputEl = document.getElementById('user-input') as HTMLTextAreaElement;
  sendBtn = document.getElementById('btn-send') as HTMLButtonElement;
  chatContainer = document.getElementById('chat-container') as HTMLDivElement;
  voiceOverlay = document.getElementById('voice-overlay') as HTMLDivElement;
  voiceOverlayStatus = document.getElementById('voice-overlay-status') as HTMLDivElement;
  voiceOverlayTranscript = document.getElementById('voice-overlay-transcript') as HTMLDivElement;
  voiceOverlayStop = document.getElementById('voice-overlay-stop') as HTMLButtonElement;

  onAbortCb = opts.onAbort || null;
  sendHandler = opts.onSendMessage;

  // Auto-resize textarea & update button icon on input change
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
    updateSendButton();
  });

  // Send on Enter (Shift+Enter = newline). Disabled while busy.
  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isBusy) dispatchSend(opts.onSendMessage);
    }
  });

  // Send button: context-sensitive click
  sendBtn.addEventListener('click', () => {
    if (isBusy) {
      if (onAbortCb) onAbortCb();
      return;
    }
    const text = inputEl.value.trim();
    if (text) {
      dispatchSend(opts.onSendMessage);
    } else if (voice.isSupported() && voice.isEnabled()) {
      enterVoiceMode();
    }
  });

  // Voice overlay stop button
  voiceOverlayStop.addEventListener('click', () => {
    exitVoiceMode();
  });

  // Track whether user has scrolled away from bottom
  chatContainer.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = chatContainer;
    userScrolledUp = scrollHeight - scrollTop - clientHeight > 60;
  });

  // Set initial button state
  updateSendButton();

  // Voice overlay: tap to stop recording and send
  initVoiceOverlayTapToSend();
}

function dispatchSend(onSendMessage: (text: string) => void): void {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  updateSendButton();
  onSendMessage(text);
}

/**
 * Update the send button icon/style based on current state:
 * busy → stop; has text → send; empty + voice → waveform; empty → send (disabled look)
 */
function updateSendButton(): void {
  if (isBusy) return; // busy state is managed by setChatBusy
  const hasText = inputEl.value.trim().length > 0;
  const voiceAvailable = voice.isSupported() && voice.isEnabled();

  sendBtn.classList.remove('voice-mode', 'recording', 'connecting', 'transcribing', 'busy');

  if (hasText) {
    sendBtn.innerHTML = SEND_ICON_SVG;
    sendBtn.title = '发送';
    sendBtn.setAttribute('aria-label', '发送');
    sendBtn.disabled = false;
  } else if (voiceAvailable) {
    sendBtn.innerHTML = WAVEFORM_ICON_SVG;
    sendBtn.classList.add('voice-mode');
    sendBtn.title = '语音对话';
    sendBtn.setAttribute('aria-label', '语音对话');
    sendBtn.disabled = false;
  } else {
    sendBtn.innerHTML = SEND_ICON_SVG;
    sendBtn.title = '发送';
    sendBtn.setAttribute('aria-label', '发送');
    sendBtn.disabled = false;
  }
}

// -- Public helpers --

/**
 * Toggle the chat into "busy" mode:
 *  - busy=true  → input disabled, send button turns into a stop button
 *  - busy=false → input enabled, send button restored
 */
export function setChatBusy(busy: boolean): void {
  isBusy = busy;
  inputEl.disabled = busy;
  sendBtn.disabled = false; // always clickable — either sends or aborts

  if (busy) {
    sendBtn.classList.remove('voice-mode', 'recording', 'connecting', 'transcribing');
    sendBtn.innerHTML = STOP_ICON_SVG;
    sendBtn.title = '停止本次回复';
    sendBtn.setAttribute('aria-label', '停止本次回复');
    sendBtn.classList.add('busy');
  } else {
    sendBtn.classList.remove('busy');
    updateSendButton();

    // In voice mode, when the agent finishes responding, auto-start next recording
    if (voiceMode) {
      voiceModeNextTurn();
    }
  }
}

// -- Message rendering --

/** Add a user message bubble. */
export function addUserMessage(text: string): void {
  const el = document.createElement('div');
  el.className = 'message user';
  el.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  messagesEl.appendChild(el);
  scrollToBottom();
}

/**
 * Add or update an assistant message (supports streaming).
 * If an element with the given id already exists, its content is replaced.
 * Returns the id used.
 */
export function addAssistantMessage(text: string, id?: string): string {
  id = id || `msg-${++msgCounter}`;
  let el = document.getElementById(id) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'message assistant';
    el.id = id;
    messagesEl.appendChild(el);
  }
  el.innerHTML = renderMarkdown(text);
  scrollToBottom();
  return id;
}

/** Mark a streamed assistant message as complete (currently a no-op style hook). */
export function finalizeAssistantMessage(id: string): void {
  const el = document.getElementById(id);
  if (el) el.classList.add('complete');
}

/** Remove an assistant message bubble entirely (used to discard hallucinated replies). */
export function removeAssistantMessage(id: string): void {
  const el = document.getElementById(id);
  if (el) el.remove();
}

/** Add a compact, collapsible tool-call notification. */
export function addToolNotification(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): void {
  const el = document.createElement('div');
  el.className = 'tool-notification';

  const summary = document.createElement('div');
  summary.className = 'tool-summary';
  summary.textContent = `\uD83D\uDD27 ${formatToolSummary(toolName, args)}`;

  const details = document.createElement('div');
  details.className = 'tool-details';
  details.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

  el.appendChild(summary);
  el.appendChild(details);
  el.addEventListener('click', () => el.classList.toggle('expanded'));

  messagesEl.appendChild(el);
  scrollToBottom();
}

/** Show the typing indicator (three bouncing dots). */
export function showTyping(): void {
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'typing-indicator';
  typingEl.id = 'typing-indicator';
  typingEl.innerHTML =
    '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  messagesEl.appendChild(typingEl);
  scrollToBottom();
}

/** Remove the typing indicator. */
export function hideTyping(): void {
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

/** Add a system notification message (e.g., timer events) to the chat. */
export function addSystemMessage(text: string): void {
  const el = document.createElement('div');
  el.className = 'message system';
  el.innerHTML = renderMarkdown(text);
  messagesEl.appendChild(el);
  scrollToBottom();
}

/** Scroll chat to bottom (respects user-scroll-up). */
export function scrollToBottom(force = false): void {
  if (!chatContainer) return;
  if (!userScrolledUp || force) {
    requestAnimationFrame(() => {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }
}

// ---------------------------------------------------------------------------
// Voice mode — continuous conversation
// ---------------------------------------------------------------------------

const VOICE_STATUS_LABELS: Record<string, string> = {
  idle: '等待中',
  connecting: '连接中…',
  recording: '正在聆听…',
  transcribing: '识别中…',
};

/** Whether we are waiting for TTS to finish before starting the next recording. */
let waitingForTts = false;

function enterVoiceMode(): void {
  if (voiceMode) return;
  voiceMode = true;
  waitingForTts = false;

  // Hide chat, show overlay
  chatContainer.style.display = 'none';
  voiceOverlay.classList.remove('hidden');
  voiceOverlayTranscript.textContent = '';
  voiceOverlayStatus.textContent = '正在启动…';

  // Subscribe to voice events
  voice.onStatusChange((s) => {
    if (!voiceMode) return;
    voiceOverlayStatus.textContent = VOICE_STATUS_LABELS[s] || s;
  });
  voice.onPartialTranscript((text) => {
    if (!voiceMode) return;
    voiceOverlayTranscript.textContent = text;
  });

  // Single TTS status callback — handles display + auto-continue
  tts.onStatusChange((s) => {
    if (!voiceMode) return;
    if (s === 'playing' || s === 'synthesizing') {
      voiceOverlayStatus.textContent = '正在回复…';
    } else if (s === 'idle' && waitingForTts) {
      waitingForTts = false;
      startVoiceRecording();
    }
  });

  // Start first recording
  startVoiceRecording();
}

export function exitVoiceMode(): void {
  if (!voiceMode) return;
  voiceMode = false;
  waitingForTts = false;

  // Cancel any in-flight recording or playback
  voice.cancelRecording();
  tts.stop();

  // Restore chat view
  voiceOverlay.classList.add('hidden');
  chatContainer.style.display = '';
  voiceOverlayTranscript.textContent = '';
  updateSendButton();
  scrollToBottom(true);
}

/** Check if voice mode is active (for external modules). */
export function isVoiceMode(): boolean {
  return voiceMode;
}

async function startVoiceRecording(): Promise<void> {
  if (!voiceMode) return;
  voiceOverlayTranscript.textContent = '';
  try {
    await voice.startRecording();
  } catch (err: any) {
    voiceOverlayStatus.textContent = `录音失败: ${err.message || err}`;
    setTimeout(() => {
      if (voiceMode) exitVoiceMode();
    }, 2000);
  }
}

/**
 * Called when the agent finishes a turn in voice mode.
 * Waits for TTS to finish playing, then starts the next recording.
 */
function voiceModeNextTurn(): void {
  if (!voiceMode) return;

  const ttsStatus = tts.getStatus();
  if (ttsStatus === 'playing' || ttsStatus === 'synthesizing') {
    // The TTS onStatusChange callback set in enterVoiceMode will
    // call startVoiceRecording when TTS goes idle.
    waitingForTts = true;
  } else {
    startVoiceRecording();
  }
}

/** Stop the current recording, transcribe, and auto-send the text. */
async function voiceModeSendRecording(): Promise<void> {
  if (!voiceMode || !sendHandler) return;
  try {
    const text = await voice.stopRecording();
    if (text && voiceMode) {
      voiceOverlayStatus.textContent = '发送中…';
      voiceOverlayTranscript.textContent = text;
      sendHandler(text);
    } else if (voiceMode) {
      // Empty transcription, restart recording
      startVoiceRecording();
    }
  } catch (err: any) {
    voiceOverlayStatus.textContent = `识别失败: ${err.message || err}`;
    setTimeout(() => {
      if (voiceMode) startVoiceRecording();
    }, 1500);
  }
}

/** Tap overlay (except stop button) to finish recording and send. */
function initVoiceOverlayTapToSend(): void {
  voiceOverlay.addEventListener('click', (e) => {
    if (!voiceMode) return;
    if ((e.target as HTMLElement).closest('.voice-overlay-stop')) return;
    if (voice.getStatus() === 'recording') {
      voiceModeSendRecording();
    }
  });
}

// -- Markdown helpers --

/**
 * Very lightweight markdown -> HTML.
 * Handles: fenced code blocks, inline code, bold, italic, newlines.
 */
function renderMarkdown(src: string): string {
  if (!src) return '';

  // Fenced code blocks: ```lang\n...\n```
  let html = escapeHtml(src);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m: string, _lang: string, code: string) => {
    return `<pre><code>${code.trimEnd()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic *text*  (but not inside **)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Newlines outside <pre>
  html = html.replace(/\n/g, '<br>');
  // Clean up <br> inside <pre>
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_m: string, inner: string) => {
    return `<pre><code>${inner.replace(/<br>/g, '\n')}</code></pre>`;
  });

  return html;
}

function escapeHtml(str: string): string {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function formatToolSummary(name: string, args: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return name;
  const parts = Object.entries(args)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  return `${name}(${parts.join(', ')})`;
}
