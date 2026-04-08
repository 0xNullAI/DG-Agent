/**
 * app.ts -- Main application entry point for DG-Agent.
 * Wires together Bluetooth, AI service, chat UI, tool execution, and history.
 */

import * as chat from './chat';
import * as history from './history';
import type { DeviceState, AppSettings, ProviderDef, ConversationRecord } from './types';

// -- Dynamic module refs --
let bt: any = null;
let ai: any = null;
let toolsMod: any = null;

// -- State --
const conversationHistory: { role: string; content: string }[] = [];
let currentAssistantMsgId: string | null = null;
let isProcessing = false;
let activePresetId = 'gentle';
let currentConversation: ConversationRecord | null = null;
let openDropdown: string | null = null; // which dropdown is open

// -- Providers --
const PROVIDERS: ProviderDef[] = [
  {
    id: 'free',
    name: '免费体验',
    hint: '无需 API Key，每分钟限 10 条',
    fields: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'deepseek-chat' },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'qwen-plus' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-4o-mini' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://api.openai.com/v1' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'AIza...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gemini-2.5-flash' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://generativelanguage.googleapis.com' },
    ],
  },
];

const SAVED_PROMPTS_KEY = 'dg-agent-saved-prompts';
const SETTINGS_STORAGE_KEY = 'dg-agent-settings';

// ============================================================
// BOOT
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  try { bt = await import('./bluetooth'); } catch (_) { /* */ }
  try { ai = await import('./ai-service'); } catch (_) { /* */ }
  try { toolsMod = await import('./tools'); } catch (_) { /* */ }

  chat.initChat({ onSendMessage: handleSendMessage });

  // Topbar buttons
  $('btn-sidebar')!.addEventListener('click', toggleSidebar);
  $('btn-connect')!.addEventListener('click', handleConnect);
  $('btn-settings')!.addEventListener('click', openSettingsModal);
  $('btn-close-settings')!.addEventListener('click', closeSettingsModal);
  $('settings-modal')!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'settings-modal') closeSettingsModal();
  });
  $('btn-theme')!.addEventListener('click', toggleTheme);

  // Pills → dropdowns
  $('pill-scene')!.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown('dropdown-scene', 'pill-scene'); });
  $('pill-provider')!.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown('dropdown-provider', 'pill-provider'); });

  // Close dropdown on outside click
  document.addEventListener('click', () => closeAllDropdowns());
  $('dropdown-scene')!.addEventListener('click', (e) => e.stopPropagation());
  $('dropdown-provider')!.addEventListener('click', (e) => e.stopPropagation());

  // Sidebar overlay
  $('sidebar-overlay')!.addEventListener('click', closeSidebar);

  // History
  $('btn-new-conv')!.addEventListener('click', startNewConversation);

  // Custom prompt
  $('scene-custom-btn')!.addEventListener('click', toggleCustomPromptInline);
  $('btn-save-prompt')!.addEventListener('click', openSavePromptDialog);

  // Save prompt dialog
  $('btn-close-save-dialog')!.addEventListener('click', closeSavePromptDialog);
  $('save-prompt-dialog')!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'save-prompt-dialog') closeSavePromptDialog();
  });
  $('btn-confirm-save-prompt')!.addEventListener('click', confirmSavePrompt);

  // Restore theme
  const savedTheme = localStorage.getItem('dg-agent-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(savedTheme);

  // Restore settings
  const saved = loadAllSettings();
  activePresetId = saved.presetId || 'gentle';

  // Build UI
  renderSceneDropdown();
  renderProviderDropdown();
  renderSettingsTabs();
  renderSettingsConfig(saved.provider);
  renderSavedPrompts();
  updatePillLabels();
  renderHistoryList();

  // Restore custom prompt textarea
  const promptEl = $('custom-system-prompt') as HTMLTextAreaElement | null;
  if (promptEl && saved.customPrompt) promptEl.value = saved.customPrompt;

  // Device callbacks
  if (bt?.setOnStatusChange) bt.setOnStatusChange(updateDeviceUI);

  // Restore last conversation or welcome
  const conversations = history.loadConversations();
  if (conversations.length > 0) {
    loadConversation(conversations[0]);
  } else {
    showWelcomeMessage();
  }
});

function $(id: string): HTMLElement | null { return document.getElementById(id); }

// ============================================================
// THEME
// ============================================================

function toggleTheme(): void {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('dg-agent-theme', theme);

  // Toggle sun/moon icons
  const iconDark = $('icon-theme-dark');
  const iconLight = $('icon-theme-light');
  if (iconDark && iconLight) {
    iconDark.classList.toggle('hidden', theme === 'dark');
    iconLight.classList.toggle('hidden', theme !== 'dark');
  }

  // Meta theme-color
  const meta = $('meta-theme') as HTMLMetaElement | null;
  if (meta) meta.content = theme === 'dark' ? '#080808' : '#fdf5f7';
}

// ============================================================
// DROPDOWNS
// ============================================================

function toggleDropdown(dropdownId: string, anchorId: string): void {
  if (openDropdown === dropdownId) {
    closeAllDropdowns();
    return;
  }
  closeAllDropdowns();

  const dd = $(dropdownId)!;
  const anchor = $(anchorId)!;
  dd.classList.remove('hidden');
  openDropdown = dropdownId;

  // Position (desktop only — on mobile CSS forces bottom sheet)
  if (window.innerWidth > 767) {
    const rect = anchor.getBoundingClientRect();
    dd.style.top = rect.bottom + 6 + 'px';
    dd.style.left = Math.max(8, rect.left) + 'px';
    dd.style.right = '';
    dd.style.bottom = '';

    // Clamp right edge
    requestAnimationFrame(() => {
      const ddRect = dd.getBoundingClientRect();
      if (ddRect.right > window.innerWidth - 8) {
        dd.style.left = '';
        dd.style.right = '8px';
      }
    });
  }

  // Mark anchor pill as active
  anchor.classList.add('active');
}

function closeAllDropdowns(): void {
  if (!openDropdown) return;
  const dd = $(openDropdown);
  if (dd) dd.classList.add('hidden');

  // Remove active from pills
  $('pill-scene')?.classList.remove('active');
  $('pill-provider')?.classList.remove('active');

  openDropdown = null;
}

// ============================================================
// SCENE DROPDOWN
// ============================================================

function renderSceneDropdown(): void {
  const container = $('scene-list')!;
  container.innerHTML = '';
  const presets = toolsMod?.PROMPT_PRESETS || [];

  presets.forEach((p: any) => {
    const btn = document.createElement('button');
    btn.className = 'dropdown-item' + (p.id === activePresetId ? ' active' : '');
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
  activePresetId = id;

  // Update active states
  document.querySelectorAll('#scene-list .dropdown-item').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.id === id);
  });
  // Deactivate custom
  $('scene-custom-btn')?.classList.remove('active');

  updatePillLabels();
  saveSettings();
  closeAllDropdowns();
}

function toggleCustomPromptInline(): void {
  const area = $('custom-prompt-inline')!;
  const btn = $('scene-custom-btn')!;
  const isOpen = !area.classList.contains('hidden');

  if (isOpen) {
    area.classList.add('hidden');
  } else {
    area.classList.remove('hidden');
    activePresetId = 'custom';
    // Deactivate scene items
    document.querySelectorAll('#scene-list .dropdown-item').forEach((el) => {
      (el as HTMLElement).classList.remove('active');
    });
    btn.classList.add('active');
    updatePillLabels();
    saveSettings();
  }
}

function updatePillLabels(): void {
  const presets = toolsMod?.PROMPT_PRESETS || [];
  const p = presets.find((x: any) => x.id === activePresetId);

  const iconEl = $('pill-scene-icon')!;
  const labelEl = $('pill-scene-label')!;

  if (p) {
    iconEl.textContent = p.icon;
    labelEl.textContent = p.name;
  } else {
    iconEl.textContent = '✏️';
    labelEl.textContent = '自定义';
  }

  // Provider
  const saved = loadAllSettings();
  const prov = PROVIDERS.find((x) => x.id === saved.provider);
  $('pill-provider-label')!.textContent = prov?.name || saved.provider;
}

// ============================================================
// PROVIDER DROPDOWN
// ============================================================

function renderProviderDropdown(): void {
  const container = $('provider-list')!;
  container.innerHTML = '';
  const saved = loadAllSettings();

  PROVIDERS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'provider-item' + (p.id === saved.provider ? ' active' : '');
    btn.dataset.id = p.id;
    btn.innerHTML = `
      <div>
        <div class="provider-item-name">${p.name}</div>
        ${p.hint ? `<div class="provider-item-hint">${p.hint}</div>` : ''}
      </div>
      <span class="check-mark">✓</span>
    `;
    btn.addEventListener('click', () => selectProvider(p.id));
    container.appendChild(btn);
  });
}

function selectProvider(id: string): void {
  // Save immediately
  const saved = loadAllSettings();
  saved.provider = id;
  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(saved)); } catch (_) { /* */ }

  // Update dropdown UI
  document.querySelectorAll('.provider-item').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.id === id);
  });

  // Update settings modal
  renderSettingsTabs();
  renderSettingsConfig(id);

  updatePillLabels();
  closeAllDropdowns();
}

// ============================================================
// SETTINGS MODAL (API keys)
// ============================================================

function openSettingsModal(): void {
  $('settings-modal')!.classList.remove('hidden');
  const saved = loadAllSettings();
  renderSettingsTabs();
  renderSettingsConfig(saved.provider);
}

function closeSettingsModal(): void {
  $('settings-modal')!.classList.add('hidden');
  saveSettings();
}

function renderSettingsTabs(): void {
  const container = $('settings-provider-tabs')!;
  container.innerHTML = '';
  const saved = loadAllSettings();

  PROVIDERS.forEach((p) => {
    const tab = document.createElement('button');
    tab.className = 'provider-tab' + (p.id === saved.provider ? ' active' : '');
    tab.textContent = p.name;
    tab.addEventListener('click', () => {
      selectProvider(p.id);
    });
    container.appendChild(tab);
  });
}

function renderSettingsConfig(providerId: string): void {
  const container = $('provider-config')!;
  container.innerHTML = '';

  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return;

  const saved = loadAllSettings();
  const values = saved.configs?.[providerId] || {};

  if (provider.hint) {
    const hint = document.createElement('p');
    hint.className = 'provider-hint';
    hint.textContent = provider.hint;
    container.appendChild(hint);
  }

  // Free tier: no config needed
  if (provider.fields.length === 0) return;

  provider.fields.forEach((f) => {
    const group = document.createElement('div');
    group.className = 'setting-group';

    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `cfg-${f.key}`;

    const input = document.createElement('input');
    input.type = f.type || 'text';
    input.id = `cfg-${f.key}`;
    input.dataset.provider = providerId;
    input.dataset.key = f.key;
    input.placeholder = f.placeholder || '';
    input.value = values[f.key] || '';
    input.classList.add('provider-cfg-input');
    group.appendChild(label);
    group.appendChild(input);
    container.appendChild(group);
  });

  // Save button
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => {
    saveSettings();
    saveBtn.textContent = '已保存 ✓';
    saveBtn.classList.add('btn-saved');
    setTimeout(() => {
      saveBtn.textContent = '保存';
      saveBtn.classList.remove('btn-saved');
    }, 1500);
  });
  actions.appendChild(saveBtn);
  container.appendChild(actions);
}

// ============================================================
// SIDEBAR (History)
// ============================================================

function toggleSidebar(): void {
  const sidebar = $('sidebar')!;
  const isOpen = !sidebar.classList.contains('sidebar-closed');
  if (isOpen) closeSidebar(); else openSidebar();
}

function openSidebar(): void {
  const sidebar = $('sidebar')!;
  sidebar.classList.remove('sidebar-closed');
  $('btn-sidebar')?.classList.add('active');

  // Show overlay on mobile/tablet
  if (window.innerWidth <= 1023) {
    $('sidebar-overlay')!.classList.remove('hidden');
  }
  renderHistoryList();
}

function closeSidebar(): void {
  $('sidebar')!.classList.add('sidebar-closed');
  $('btn-sidebar')?.classList.remove('active');
  $('sidebar-overlay')!.classList.add('hidden');
}

function renderHistoryList(): void {
  const listEl = $('history-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const conversations = history.loadConversations();

  if (conversations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '暂无历史记录';
    listEl.appendChild(empty);
    return;
  }

  conversations.forEach((conv) => {
    const item = document.createElement('div');
    item.className = 'history-item' + (currentConversation?.id === conv.id ? ' active' : '');

    const infoDiv = document.createElement('div');
    infoDiv.className = 'history-item-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'history-item-title';
    titleEl.textContent = conv.title;

    const dateEl = document.createElement('div');
    dateEl.className = 'history-item-date';
    dateEl.textContent = formatDate(conv.updatedAt);

    infoDiv.appendChild(titleEl);
    infoDiv.appendChild(dateEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'history-item-del';
    delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    delBtn.title = '删除';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      history.deleteConversation(conv.id);
      if (currentConversation?.id === conv.id) startNewConversation();
      renderHistoryList();
    });

    item.appendChild(infoDiv);
    item.appendChild(delBtn);
    item.addEventListener('click', () => {
      loadConversation(conv);
      if (window.innerWidth <= 1023) closeSidebar();
    });

    listEl.appendChild(item);
  });
}

function loadConversation(conv: ConversationRecord): void {
  conversationHistory.length = 0;
  currentAssistantMsgId = null;
  currentConversation = conv;
  activePresetId = conv.presetId || 'gentle';

  const messagesEl = $('messages');
  if (messagesEl) messagesEl.innerHTML = '';

  conv.messages.forEach((msg) => {
    conversationHistory.push({ role: msg.role, content: msg.content });
    if (msg.role === 'user') chat.addUserMessage(msg.content);
    else if (msg.role === 'assistant') chat.addAssistantMessage(msg.content);
  });

  updatePillLabels();
  chat.scrollToBottom(true);
  renderHistoryList();
}

function startNewConversation(): void {
  conversationHistory.length = 0;
  currentAssistantMsgId = null;
  currentConversation = null;

  const messagesEl = $('messages');
  if (messagesEl) messagesEl.innerHTML = '';

  showWelcomeMessage();
  renderHistoryList();
  if (window.innerWidth <= 1023) closeSidebar();
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

// ============================================================
// CONNECT
// ============================================================

async function handleConnect(): Promise<void> {
  if (!bt) {
    chat.addAssistantMessage('蓝牙模块尚未加载，请稍后再试。');
    return;
  }

  const statusDot = $('device-status') as HTMLSpanElement;

  if (statusDot.classList.contains('connected') && bt.disconnect) {
    try {
      await bt.disconnect();
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
    await bt.scanAndConnect();
    statusDot.className = 'status-dot connected';
    $('device-bar')!.classList.remove('hidden');
    chat.addAssistantMessage('设备已成功连接！你现在可以告诉我想要的操作了。');
  } catch (err: any) {
    statusDot.className = 'status-dot disconnected';
    chat.addAssistantMessage(`连接失败: ${err.message || err}`);
  }
}

// ============================================================
// DEVICE UI
// ============================================================

function updateDeviceUI(status: DeviceState): void {
  if (!status) return;

  const statusDot = $('device-status') as HTMLSpanElement;
  const deviceBar = $('device-bar') as HTMLDivElement;

  if (status.connected) {
    statusDot.className = 'status-dot connected';
    deviceBar.classList.remove('hidden');
  } else {
    statusDot.className = 'status-dot disconnected';
    deviceBar.classList.add('hidden');
  }

  if (status.strengthA !== undefined) {
    const max = (status as any).maxStrength || 200;
    const pct = Math.min(100, (status.strengthA / max) * 100);
    ($('strength-a') as HTMLDivElement).style.width = pct + '%';
    ($('strength-a-val') as HTMLSpanElement).textContent = String(status.strengthA);
  }
  if (status.strengthB !== undefined) {
    const max = (status as any).maxStrength || 200;
    const pct = Math.min(100, (status.strengthB / max) * 100);
    ($('strength-b') as HTMLDivElement).style.width = pct + '%';
    ($('strength-b-val') as HTMLSpanElement).textContent = String(status.strengthB);
  }

  if (status.battery !== undefined) {
    ($('battery-val') as HTMLSpanElement).textContent = status.battery + '%';
  }

  // Wave indicators
  ['a', 'b'].forEach((ch) => {
    const active = ch === 'a' ? status.waveActiveA : status.waveActiveB;
    const el = $(`wave-${ch}`);
    if (el) el.classList.toggle('hidden', !active);
  });
}

// ============================================================
// WELCOME
// ============================================================

function showWelcomeMessage(): void {
  chat.addAssistantMessage(
    '你好！我是 DG-Agent，可以帮你通过自然语言控制 DG-Lab Coyote 设备。\n\n' +
    '请先点击右上角蓝牙按钮连接设备，然后告诉我你想做什么。'
  );
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

async function handleSendMessage(text: string): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  chat.setInputEnabled(false);
  chat.addUserMessage(text);
  conversationHistory.push({ role: 'user', content: text });

  if (!currentConversation) {
    currentConversation = history.createConversation(activePresetId);
  }

  chat.showTyping();
  currentAssistantMsgId = null;

  try {
    if (!ai) throw new Error('AI 服务模块尚未加载。请在设置中配置 API 并刷新页面。');

    const customPrompt = ($('custom-system-prompt') as HTMLTextAreaElement | null)?.value || '';
    const systemPrompt: string = toolsMod?.buildSystemPrompt
      ? toolsMod.buildSystemPrompt(activePresetId, customPrompt)
      : customPrompt || '你是一个友好的助手。';

    const toolDefs = toolsMod?.tools || [];
    let streamedText = '';

    const response = await ai.chat(
      conversationHistory,
      systemPrompt,
      toolDefs,
      async (toolName: string, toolArgs: Record<string, unknown>) => {
        chat.hideTyping();
        let result: string;
        try {
          result = toolsMod
            ? await toolsMod.executeTool(toolName, toolArgs)
            : JSON.stringify({ error: 'tools module not loaded' });
        } catch (err: any) {
          result = JSON.stringify({ error: err.message });
        }
        chat.addToolNotification(toolName, toolArgs, result);
        return result;
      },
      (textChunk: string) => {
        chat.hideTyping();
        streamedText += textChunk;
        currentAssistantMsgId = chat.addAssistantMessage(streamedText, currentAssistantMsgId || undefined);
      }
    );

    chat.hideTyping();
    if (response?.content) {
      currentAssistantMsgId = chat.addAssistantMessage(response.content, currentAssistantMsgId || undefined);
      chat.finalizeAssistantMessage(currentAssistantMsgId);
      conversationHistory.push({ role: 'assistant', content: response.content });
    }
  } catch (err: any) {
    chat.hideTyping();
    chat.addAssistantMessage(`出错了: ${err.message || err}`);
  } finally {
    isProcessing = false;
    chat.setInputEnabled(true);

    if (currentConversation) {
      currentConversation.messages = [...conversationHistory];
      currentConversation.title = history.generateTitle(conversationHistory);
      currentConversation.updatedAt = Date.now();
      history.saveConversation(currentConversation);
      renderHistoryList();
    }
  }
}

// ============================================================
// SAVED CUSTOM PROMPTS
// ============================================================

interface SavedPromptItem { id: string; name: string; prompt: string; }

function loadSavedPrompts(): SavedPromptItem[] {
  try { return JSON.parse(localStorage.getItem(SAVED_PROMPTS_KEY) || '[]') || []; }
  catch { return []; }
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
    nameBtn.title = item.prompt.slice(0, 100) + '…';
    nameBtn.addEventListener('click', () => {
      const el = $('custom-system-prompt') as HTMLTextAreaElement | null;
      if (el) el.value = item.prompt;
      saveSettings();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'saved-prompt-del';
    delBtn.textContent = '✕';
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

// ============================================================
// PERSISTENCE
// ============================================================

function saveSettings(): void {
  const saved = loadAllSettings();

  // Collect config inputs
  const inputs = document.querySelectorAll('.provider-cfg-input') as NodeListOf<HTMLInputElement>;
  if (inputs.length > 0) {
    const currentCfg: Record<string, string> = {};
    inputs.forEach((inp) => { currentCfg[inp.dataset.key!] = inp.value; });
    saved.configs[saved.provider] = currentCfg;
  }

  saved.presetId = activePresetId;
  saved.customPrompt = ($('custom-system-prompt') as HTMLTextAreaElement | null)?.value || '';

  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(saved)); } catch (_) { /* */ }
}

function loadAllSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppSettings;
  } catch (_) { /* */ }
  return { provider: 'free', configs: {}, presetId: 'gentle', customPrompt: '' };
}

export function getProviderConfig(): Record<string, string> & { provider: string } {
  const saved = loadAllSettings();
  const cfg = saved.configs?.[saved.provider] || {};
  return { provider: saved.provider, ...cfg };
}
