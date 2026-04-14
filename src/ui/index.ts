/**
 * ui/index.ts — Boot initialization, event wiring, and scene dropdown.
 * Bridges agent logic and UI rendering.
 */

import type { ConversationRecord } from '../types';
import { getItemText } from '../types';
import { bluetooth, conversation, history, PROMPT_PRESETS, bridge } from '../agent';
import { loadSettings } from '../agent/providers';
import * as chat from './chat';
import * as theme from './theme';
import * as dropdowns from './dropdowns';
import * as settings from './settings';
import * as sidebar from './sidebar';
import { updateDeviceUI } from './device';
import { initUpdateCheck } from './update-check';
import { askPermission, closeActiveDialog } from './permission-dialog';

// ---------------------------------------------------------------------------
// DOM helper (shared across ui modules)
// ---------------------------------------------------------------------------
export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Saved custom prompts
// ---------------------------------------------------------------------------

const SAVED_PROMPTS_KEY = 'dg-agent-saved-prompts';

interface SavedPromptItem {
  id: string;
  name: string;
  prompt: string;
}

function loadSavedPrompts(): SavedPromptItem[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_PROMPTS_KEY) || '[]') || [];
  } catch {
    return [];
  }
}

function saveSavedPrompts(list: SavedPromptItem[]): void {
  localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(list));
}

function openSavePromptDialog(): void {
  const text = ($('custom-system-prompt') as HTMLTextAreaElement | null)?.value?.trim();
  if (!text) return;
  ($('save-prompt-name') as HTMLInputElement).value = '';
  $('save-prompt-dialog')!.classList.remove('hidden');
  ($('save-prompt-name') as HTMLInputElement).focus();
}

function closeSavePromptDialog(): void {
  $('save-prompt-dialog')!.classList.add('hidden');
}

function confirmSavePrompt(): void {
  const name = ($('save-prompt-name') as HTMLInputElement).value.trim();
  const text = ($('custom-system-prompt') as HTMLTextAreaElement | null)?.value?.trim();
  if (!name || !text) return;

  const list = loadSavedPrompts();
  list.push({ name, prompt: text, id: Date.now().toString() });
  saveSavedPrompts(list);
  renderSavedPrompts();
  closeSavePromptDialog();
}

function renderSavedPrompts(): void {
  const container = $('saved-prompts-list');
  if (!container) return;
  container.innerHTML = '';

  const list = loadSavedPrompts();
  if (list.length === 0) return;

  list.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'saved-prompt-row';

    const nameBtn = document.createElement('button');
    nameBtn.className = 'saved-prompt-name';
    nameBtn.textContent = item.name;
    nameBtn.title = item.prompt.slice(0, 100) + '\u2026';
    nameBtn.addEventListener('click', () => {
      const el = $('custom-system-prompt') as HTMLTextAreaElement | null;
      if (el) el.value = item.prompt;
      settings.saveCurrentSettings();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'saved-prompt-del';
    delBtn.textContent = '\u2715';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveSavedPrompts(loadSavedPrompts().filter((p) => p.id !== item.id));
      renderSavedPrompts();
    });

    row.appendChild(nameBtn);
    row.appendChild(delBtn);
    container.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Scene dropdown
// ---------------------------------------------------------------------------

function renderSceneDropdown(): void {
  const container = $('scene-list')!;
  container.innerHTML = '';

  PROMPT_PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'dropdown-item' + (p.id === conversation.getActivePresetId() ? ' active' : '');
    btn.dataset.id = p.id;
    btn.innerHTML = `
      <span class="dropdown-item-icon">${p.icon}</span>
      <div>
        <div>${p.name}</div>
        <div class="dropdown-item-desc">${p.description?.slice(0, 30) || ''}</div>
      </div>
      <svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
    `;
    btn.addEventListener('click', () => selectScene(p.id));
    container.appendChild(btn);
  });
}

function selectScene(id: string): void {
  conversation.setActivePresetId(id);

  document.querySelectorAll('#scene-list .dropdown-item').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.id === id);
  });
  $('scene-custom-btn')?.classList.remove('active');

  updatePillLabels();
  settings.saveCurrentSettings();
  dropdowns.closeAll();
}

function toggleCustomPromptInline(): void {
  const area = $('custom-prompt-inline')!;
  const btn = $('scene-custom-btn')!;
  const isOpen = !area.classList.contains('hidden');

  if (isOpen) {
    area.classList.add('hidden');
  } else {
    area.classList.remove('hidden');
    conversation.setActivePresetId('custom');
    document.querySelectorAll('#scene-list .dropdown-item').forEach((el) => {
      (el as HTMLElement).classList.remove('active');
    });
    btn.classList.add('active');
    updatePillLabels();
    settings.saveCurrentSettings();
  }
}

function updatePillLabels(): void {
  const p = PROMPT_PRESETS.find((x) => x.id === conversation.getActivePresetId());
  const iconEl = $('pill-scene-icon')!;
  const labelEl = $('pill-scene-label')!;

  if (p) {
    iconEl.textContent = p.icon;
    labelEl.textContent = p.name;
  } else {
    iconEl.textContent = '\u270F\uFE0F';
    labelEl.textContent = '自定义';
  }
}

// ---------------------------------------------------------------------------
// Bluetooth connect
// ---------------------------------------------------------------------------

async function handleConnect(): Promise<void> {
  if (!(navigator as any).bluetooth) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      chat.addAssistantMessage(
        'iOS 系统不支持 Web Bluetooth。\n\n' +
          '请在 App Store 下载 **Bluefy** 浏览器（免费），然后用 Bluefy 打开本页面即可正常连接设备。',
      );
    } else {
      chat.addAssistantMessage(
        '当前浏览器不支持 Web Bluetooth。\n\n' + '请使用 **Chrome** 或 **Edge** 浏览器打开本页面。',
      );
    }
    return;
  }

  const statusDot = $('device-status') as HTMLSpanElement;

  if (statusDot.classList.contains('connected')) {
    try {
      await bluetooth.disconnect();
      statusDot.className = 'status-dot disconnected';
      $('device-bar')!.classList.add('hidden');
      chat.addAssistantMessage('设备已断开连接。');
    } catch (err: any) {
      chat.addAssistantMessage(`断开连接失败: ${err.message || err}`);
    }
    return;
  }

  statusDot.className = 'status-dot connecting';

  try {
    await bluetooth.scanAndConnect();
    statusDot.className = 'status-dot connected';
    $('device-bar')!.classList.remove('hidden');
    chat.addAssistantMessage('设备已成功连接！你现在可以告诉我想要的操作了。');
  } catch (err: any) {
    statusDot.className = 'status-dot disconnected';
    chat.addAssistantMessage(`连接失败: ${err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Conversation load / new
// ---------------------------------------------------------------------------

function loadConversationUI(conv: ConversationRecord): void {
  conversation.loadConversation(conv);

  const messagesEl = $('messages');
  if (messagesEl) messagesEl.innerHTML = '';

  for (const item of conv.items) {
    const display = getItemText(item);
    if (!display) continue;
    if (display.role === 'user') chat.addUserMessage(display.text);
    else if (display.role === 'assistant') chat.addAssistantMessage(display.text);
  }

  updatePillLabels();
  chat.scrollToBottom(true);
  sidebar.renderList();
}

function startNewConversationUI(): void {
  conversation.createConversation();

  const messagesEl = $('messages');
  if (messagesEl) messagesEl.innerHTML = '';

  showWelcomeMessage();
  sidebar.renderList();
  if (window.innerWidth <= 1023) sidebar.close();
}

function showWelcomeMessage(): void {
  chat.addAssistantMessage(
    '你好！我是 DG-Agent，可以帮你通过自然语言控制 DG-Lab Coyote 设备。\n\n' +
      '请先点击右上角蓝牙按钮连接设备，然后告诉我你想做什么。',
  );
}

// ---------------------------------------------------------------------------
// Bridge overlay
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 20;

export function updateBridgeOverlay(): void {
  const overlay = $('bridge-overlay');
  const chatContainer = $('chat-container');
  const inputArea = $('input-area');
  if (!overlay) return;

  const active = bridge.isActive();
  overlay.classList.toggle('hidden', !active);
  if (chatContainer) chatContainer.classList.toggle('hidden', active);
  if (inputArea) inputArea.classList.toggle('hidden', active);

  if (active) {
    // Update platform list
    const platformsEl = $('bridge-overlay-platforms');
    if (platformsEl) {
      platformsEl.innerHTML = '';
      for (const s of bridge.getAdapterStatus()) {
        if (!s.connected) continue;
        const tag = document.createElement('span');
        tag.className = 'bridge-platform-tag';
        tag.textContent = s.platform.toUpperCase();
        platformsEl.appendChild(tag);
      }
    }

    // Wire up log callback
    bridge.setOnBridgeLog((text) => {
      const logEl = $('bridge-overlay-log');
      if (!logEl) return;
      const line = document.createElement('div');
      line.className = 'bridge-log-line';
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      line.textContent = `[${time}] ${text}`;
      logEl.appendChild(line);
      // Trim old lines
      while (logEl.children.length > MAX_LOG_LINES) {
        logEl.removeChild(logEl.firstChild!);
      }
      logEl.scrollTop = logEl.scrollHeight;
    });
  } else {
    bridge.setOnBridgeLog(null);
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleSendMessage(text: string): Promise<void> {
  await conversation.sendMessage(text);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function showSafetyNotice(): void {
  const modal = $('safety-notice') as HTMLDivElement | null;
  const btn = $('safety-notice-accept') as HTMLButtonElement | null;
  const checkbox = $('safety-notice-ignore') as HTMLInputElement | null;
  const countdownEl = $('safety-notice-countdown') as HTMLSpanElement | null;
  if (!modal || !btn || !countdownEl) return;

  const openSafetyNotice = (): void => {
    modal.classList.remove('hidden');
    document.body.classList.add('safety-notice-open');
  };

  const closeSafetyNotice = (): void => {
    modal.classList.add('hidden');
    document.body.classList.remove('safety-notice-open');
  };

  const ignoreStorageKey = 'dg-agent-safety-notice-ignore';
  if (localStorage.getItem(ignoreStorageKey) === 'true') {
    closeSafetyNotice();
    return;
  }

  openSafetyNotice();

  const TOTAL = 10;
  let remaining = TOTAL;
  btn.disabled = true;
  countdownEl.textContent = `(${remaining}s)`;

  const timer = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      countdownEl.textContent = `(${remaining}s)`;
    } else {
      clearInterval(timer);
      btn.disabled = false;
      btn.firstChild!.textContent = '我已阅读并同意 ';
      countdownEl.textContent = '';
    }
  }, 1000);

  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    closeSafetyNotice();
    if (checkbox?.checked) {
      localStorage.setItem(ignoreStorageKey, 'true');
    }
  });
}

export function boot(): void {
  // Mandatory safety notice — shown on every page load, 10s lockout.
  showSafetyNotice();

  // Init conversation
  conversation.initConversation({
    onUserMessage: (text) => chat.addUserMessage(text),
    onAssistantStream: (text, msgId) => chat.addAssistantMessage(text, msgId),
    onAssistantFinalize: (msgId) => chat.finalizeAssistantMessage(msgId),
    onAssistantDiscard: (msgId) => chat.removeAssistantMessage(msgId),
    onToolCall: (name, args, result) => chat.addToolNotification(name, args, result),
    onSystemMessage: (text) => chat.addSystemMessage(text),
    onTypingStart: () => chat.showTyping(),
    onTypingEnd: () => chat.hideTyping(),
    onBusyChange: (busy) => chat.setChatBusy(busy),
    onError: (msg) => chat.addAssistantMessage(msg),
    onHistoryChange: () => sidebar.renderList(),
    onQueryCustomPrompt: () =>
      ($('custom-system-prompt') as HTMLTextAreaElement | null)?.value || '',
    onRequestPermission: (name, args) => askPermission(name, args),
  });

  // Init sub-modules
  chat.initChat({
    onSendMessage: handleSendMessage,
    onAbort: () => {
      // Close any open permission dialog first so its promise resolves as
      // 'deny' and the runner can unwind cleanly into the abort branch.
      closeActiveDialog();
      conversation.abortCurrent();
    },
  });
  settings.init(
    () => conversation.getActivePresetId(),
    () => ($('custom-system-prompt') as HTMLTextAreaElement | null)?.value || '',
  );
  sidebar.setOnLoadConversation(loadConversationUI);

  // Topbar buttons
  $('btn-sidebar')!.addEventListener('click', () => sidebar.toggle());
  $('btn-connect')!.addEventListener('click', handleConnect);
  $('btn-settings')!.addEventListener('click', () => settings.open());
  $('btn-close-settings')!.addEventListener('click', () => settings.close());
  $('settings-modal')!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'settings-modal') settings.close();
  });

  // Scene dropdown
  $('pill-scene')!.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdowns.toggle('dropdown-scene', 'pill-scene');
  });
  document.addEventListener('click', () => dropdowns.closeAll());
  $('dropdown-scene')!.addEventListener('click', (e) => e.stopPropagation());

  // Sidebar overlay
  $('sidebar-overlay')!.addEventListener('click', () => sidebar.close());

  // History
  $('btn-new-conv')!.addEventListener('click', startNewConversationUI);

  // Custom prompt
  $('scene-custom-btn')!.addEventListener('click', toggleCustomPromptInline);
  $('btn-save-prompt')!.addEventListener('click', openSavePromptDialog);

  // Save prompt dialog
  $('btn-close-save-dialog')!.addEventListener('click', closeSavePromptDialog);
  $('save-prompt-dialog')!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'save-prompt-dialog') closeSavePromptDialog();
  });
  $('btn-confirm-save-prompt')!.addEventListener('click', confirmSavePrompt);

  // Theme
  theme.restore();

  // Restore settings
  const saved = loadSettings();
  conversation.setActivePresetId(saved.presetId || 'gentle');

  // Build UI
  renderSceneDropdown();
  renderSavedPrompts();
  updatePillLabels();
  settings.updateCurrentAiLabel();
  sidebar.renderList();

  // Restore custom prompt textarea
  const promptEl = $('custom-system-prompt') as HTMLTextAreaElement | null;
  if (promptEl && saved.customPrompt) promptEl.value = saved.customPrompt;

  // Device callbacks
  bluetooth.setOnStatusChange(updateDeviceUI);

  // Restore last conversation or welcome
  const conversations = history.loadConversations();
  if (conversations.length > 0) {
    loadConversationUI(conversations[0]);
  } else {
    showWelcomeMessage();
  }

  // Safety: full stop on page unload (close tab / close browser) and on
  // visibility change.
  function fullStop(): void {
    try {
      conversation.fullStop();
    } catch (_) {
      /* */
    }
  }
  window.addEventListener('beforeunload', fullStop);
  window.addEventListener('pagehide', fullStop);

  // Background / foreground lifecycle
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && settings.getBackgroundBehavior() === 'stop') {
      fullStop();
    }
  });

  // Emergency stop button
  $('btn-emergency-stop')?.addEventListener('click', () => {
    fullStop();
    chat.addSystemMessage('\u26A1 紧急停止：已停止所有波形、强度归零');
  });

  // Poll for new deployments and show a reload banner when available.
  initUpdateCheck();

  // Social platform bridge — connect to QQ / Telegram if configured.
  // Errors are non-fatal; the app works fine without the bridge.
  bridge
    .initBridge((text) => conversation.sendMessage(text))
    .then(() => {
      updateBridgeOverlay();
    })
    .catch((err) => {
      console.error('[Boot] Bridge init failed (non-fatal):', err);
    });
}
