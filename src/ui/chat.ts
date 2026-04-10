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

// -- Initialise --

export function initChat(opts: { onSendMessage: (text: string) => void }): void {
  messagesEl = document.getElementById('messages') as HTMLDivElement;
  inputEl = document.getElementById('user-input') as HTMLTextAreaElement;
  sendBtn = document.getElementById('btn-send') as HTMLButtonElement;
  chatContainer = document.getElementById('chat-container') as HTMLDivElement;

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  });

  // Send on Enter (Shift+Enter = newline)
  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      dispatchSend(opts.onSendMessage);
    }
  });

  sendBtn.addEventListener('click', () => dispatchSend(opts.onSendMessage));

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

/** Disable / enable the send button and input */
export function setInputEnabled(enabled: boolean): void {
  sendBtn.disabled = !enabled;
  inputEl.disabled = !enabled;
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
export function addToolNotification(toolName: string, args: Record<string, unknown>, result: string): void {
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
  typingEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
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
