/**
 * chat.ts -- Chat UI manager for DG-Agent
 * Manages message rendering, auto-scroll, and input handling.
 */

// -- DOM refs (set in initChat) --
let messagesEl: HTMLDivElement;
let inputEl: HTMLTextAreaElement;
let sendBtn: HTMLButtonElement;
let chatContainer: HTMLDivElement;

// -- State --
let userScrolledUp = false;
let typingEl: HTMLDivElement | null = null;
let msgCounter = 0;
let isBusy = false;
let onAbortCb: (() => void) | null = null;

// -- Icons --
const SEND_ICON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_ICON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';

// -- Initialise --

export function initChat(opts: {
  onSendMessage: (text: string) => void;
  onAbort?: () => void;
}): void {
  messagesEl = document.getElementById('messages') as HTMLDivElement;
  inputEl = document.getElementById('user-input') as HTMLTextAreaElement;
  sendBtn = document.getElementById('btn-send') as HTMLButtonElement;
  chatContainer = document.getElementById('chat-container') as HTMLDivElement;

  onAbortCb = opts.onAbort || null;

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  });

  // Send on Enter (Shift+Enter = newline). Disabled while busy.
  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isBusy) dispatchSend(opts.onSendMessage);
    }
  });

  // Send button doubles as stop button while a turn is in flight.
  sendBtn.addEventListener('click', () => {
    if (isBusy) {
      if (onAbortCb) onAbortCb();
    } else {
      dispatchSend(opts.onSendMessage);
    }
  });

  // Track whether user has scrolled away from bottom
  chatContainer.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = chatContainer;
    userScrolledUp = scrollHeight - scrollTop - clientHeight > 60;
  });
}

function dispatchSend(onSendMessage: (text: string) => void): void {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  onSendMessage(text);
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
  sendBtn.innerHTML = busy ? STOP_ICON_SVG : SEND_ICON_SVG;
  sendBtn.title = busy ? '停止本次回复' : '发送';
  sendBtn.setAttribute('aria-label', busy ? '停止本次回复' : '发送');
  sendBtn.classList.toggle('busy', busy);
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
