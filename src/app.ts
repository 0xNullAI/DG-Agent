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

// -- Known AI providers with their config fields --
const PROVIDERS: ProviderDef[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    hint: '\u514D\u8D39 API Key: https://aistudio.google.com/apikey',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'AIza...' },
      { key: 'model', label: '\u6A21\u578B', type: 'text', placeholder: 'gemini-2.0-flash' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI \u517C\u5BB9',
    hint: '\u652F\u6301 OpenAI / DeepSeek / Groq / OpenRouter \u7B49',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '\u6A21\u578B', type: 'text', placeholder: 'gpt-4o-mini' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://api.openai.com/v1' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-ant-...' },
      { key: 'model', label: '\u6A21\u578B', type: 'text', placeholder: 'claude-sonnet-4-20250514' },
    ],
  },
];

// -- Saved custom prompts --
const SAVED_PROMPTS_KEY = 'dg-agent-saved-prompts';
const SETTINGS_STORAGE_KEY = 'dg-agent-settings';

// -- Boot --
document.addEventListener('DOMContentLoaded', async () => {
  // Try to import optional modules (they may not exist yet)
  try { bt = await import('./bluetooth'); } catch (_) { /* not yet */ }
  try { ai = await import('./ai-service'); } catch (_) { /* not yet */ }
  try { toolsMod = await import('./tools'); } catch (_) { /* not yet */ }

  // Init chat UI
  chat.initChat({ onSendMessage: handleSendMessage });

  // Connect button
  document.getElementById('btn-connect')!.addEventListener('click', handleConnect);

  // Settings modal
  document.getElementById('btn-settings')!.addEventListener('click', openSettings);
  document.getElementById('btn-close-settings')!.addEventListener('click', closeSettings);
  document.getElementById('settings-modal')!.addEventListener('click', (e: Event) => {
    if ((e.target as HTMLElement).id === 'settings-modal') closeSettings();
  });

  // Save prompt button
  document.getElementById('btn-save-prompt')!.addEventListener('click', handleSaveCustomPrompt);

  // History
  document.getElementById('btn-history')!.addEventListener('click', toggleHistoryDrawer);
  document.getElementById('btn-new-conv')!.addEventListener('click', startNewConversation);

  // Provider quick-switch
  const quickSelect = document.getElementById('provider-quick') as HTMLSelectElement;
  const saved = loadAllSettings();
  quickSelect.value = saved.provider;
  quickSelect.addEventListener('change', () => {
    const radio = document.getElementById(`provider-${quickSelect.value}`) as HTMLInputElement | null;
    if (radio) {
      radio.checked = true;
      renderProviderConfig(quickSelect.value);
    }
    saveSettings();
  });

  // Theme toggle
  document.getElementById('btn-theme')!.addEventListener('click', toggleTheme);

  // Restore theme
  const savedTheme = localStorage.getItem('dg-agent-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', savedTheme);
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) themeBtn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
  const metaTheme = document.getElementById('meta-theme') as HTMLMetaElement | null;
  if (metaTheme) metaTheme.content = savedTheme === 'dark' ? '#0a0a0a' : '#fff5f7';

  // Populate preset selector & provider radio buttons
  renderPresetSelect();
  renderProviderSelect();
  renderHistoryList();

  // Restore saved settings
  loadSettings();

  // Listen for device status changes
  if (bt && bt.setOnStatusChange) {
    bt.setOnStatusChange(updateDeviceUI);
  }

  // Restore last conversation or show welcome
  const conversations = history.loadConversations();
  if (conversations.length > 0) {
    loadConversation(conversations[0]);
  } else {
    showWelcomeMessage();
  }
});

// -- Theme toggle --

function toggleTheme(): void {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);

  // Update button icon
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';

  // Update meta theme color
  const meta = document.getElementById('meta-theme') as HTMLMetaElement | null;
  if (meta) meta.content = next === 'dark' ? '#0a0a0a' : '#fff5f7';

  // Save preference
  localStorage.setItem('dg-agent-theme', next);
}

// -- Welcome message --

function showWelcomeMessage(): void {
  chat.addAssistantMessage(
    '\u4F60\u597D\uFF01\u6211\u662F DG-Agent\uFF0C\u53EF\u4EE5\u5E2E\u4F60\u901A\u8FC7\u81EA\u7136\u8BED\u8A00\u63A7\u5236 DG-Lab Coyote \u8BBE\u5907\u3002\n\n' +
    '\u8BF7\u5148\u70B9\u51FB\u53F3\u4E0A\u89D2 **\uD83D\uDD17** \u8FDE\u63A5\u8BBE\u5907\uFF0C\u7136\u540E\u544A\u8BC9\u6211\u4F60\u60F3\u505A\u4EC0\u4E48\u3002'
  );
}

// -- Connect handler --

async function handleConnect(): Promise<void> {
  if (!bt) {
    chat.addAssistantMessage('\u84DD\u7259\u6A21\u5757\u5C1A\u672A\u52A0\u8F7D\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002');
    return;
  }

  const statusDot = document.getElementById('device-status') as HTMLSpanElement;
  const deviceInfo = document.getElementById('device-info') as HTMLSpanElement;

  // If already connected, offer to disconnect
  if (statusDot.classList.contains('connected') && bt.disconnect) {
    try {
      await bt.disconnect();
      statusDot.className = 'status-dot disconnected';
      deviceInfo.textContent = '';
      document.getElementById('device-bar')!.classList.add('hidden');
      chat.addAssistantMessage('\u8BBE\u5907\u5DF2\u65AD\u5F00\u8FDE\u63A5\u3002');
    } catch (err: any) {
      chat.addAssistantMessage(`\u65AD\u5F00\u8FDE\u63A5\u5931\u8D25: ${err.message || err}`);
    }
    return;
  }

  statusDot.className = 'status-dot connecting';
  deviceInfo.textContent = '\u8FDE\u63A5\u4E2D...';

  try {
    await bt.scanAndConnect();
    statusDot.className = 'status-dot connected';
    deviceInfo.textContent = '\u5DF2\u8FDE\u63A5';
    document.getElementById('device-bar')!.classList.remove('hidden');
    chat.addAssistantMessage('\u8BBE\u5907\u5DF2\u6210\u529F\u8FDE\u63A5\uFF01\u4F60\u73B0\u5728\u53EF\u4EE5\u544A\u8BC9\u6211\u60F3\u8981\u7684\u64CD\u4F5C\u4E86\u3002');
  } catch (err: any) {
    statusDot.className = 'status-dot disconnected';
    deviceInfo.textContent = '';
    chat.addAssistantMessage(`\u8FDE\u63A5\u5931\u8D25: ${err.message || err}`);
  }
}

// -- Message handling --

async function handleSendMessage(text: string): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  chat.setInputEnabled(false);

  chat.addUserMessage(text);
  conversationHistory.push({ role: 'user', content: text });

  // Auto-create conversation on first message
  if (!currentConversation) {
    currentConversation = history.createConversation(activePresetId);
  }

  chat.showTyping();
  currentAssistantMsgId = null;

  try {
    if (!ai) {
      throw new Error('AI \u670D\u52A1\u6A21\u5757\u5C1A\u672A\u52A0\u8F7D\u3002\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u914D\u7F6E API \u5E76\u5237\u65B0\u9875\u9762\u3002');
    }

    // Build system prompt from active preset + device suffix
    const customPrompt = (document.getElementById('custom-system-prompt') as HTMLTextAreaElement | null)?.value || '';
    const systemPrompt: string = toolsMod?.buildSystemPrompt
      ? toolsMod.buildSystemPrompt(activePresetId, customPrompt)
      : customPrompt || '\u4F60\u662F\u4E00\u4E2A\u53CB\u597D\u7684\u52A9\u624B\u3002';

    const toolDefs = toolsMod?.tools || [];

    // Accumulate streamed text
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

    // Finalise the assistant message
    chat.hideTyping();
    if (response && response.content) {
      currentAssistantMsgId = chat.addAssistantMessage(response.content, currentAssistantMsgId || undefined);
      chat.finalizeAssistantMessage(currentAssistantMsgId);
      conversationHistory.push({ role: 'assistant', content: response.content });
    }
  } catch (err: any) {
    chat.hideTyping();
    chat.addAssistantMessage(`\u51FA\u9519\u4E86: ${err.message || err}`);
  } finally {
    isProcessing = false;
    chat.setInputEnabled(true);

    // Save conversation after each exchange
    if (currentConversation) {
      currentConversation.messages = [...conversationHistory];
      currentConversation.title = history.generateTitle(conversationHistory);
      currentConversation.updatedAt = Date.now();
      history.saveConversation(currentConversation);
      renderHistoryList();
    }
  }
}

// -- Device UI updates --

function updateDeviceUI(status: DeviceState): void {
  if (!status) return;

  const statusDot = document.getElementById('device-status') as HTMLSpanElement;
  const deviceInfo = document.getElementById('device-info') as HTMLSpanElement;
  const deviceBar = document.getElementById('device-bar') as HTMLDivElement;

  if (status.connected) {
    statusDot.className = 'status-dot connected';
    // Show device name and battery in topbar
    const batteryText = status.battery !== undefined ? ` \uD83D\uDD0B${status.battery}%` : '';
    deviceInfo.textContent = (status.deviceName || '\u5DF2\u8FDE\u63A5') + batteryText;
    deviceBar.classList.remove('hidden');
  } else {
    statusDot.className = 'status-dot disconnected';
    deviceInfo.textContent = '';
    deviceBar.classList.add('hidden');
  }

  // Strength bars
  if (status.strengthA !== undefined) {
    const maxStrength = (status as any).maxStrength || 200;
    const pctA = Math.min(100, (status.strengthA / maxStrength) * 100);
    (document.getElementById('strength-a') as HTMLDivElement).style.width = pctA + '%';
    (document.getElementById('strength-a-val') as HTMLSpanElement).textContent = String(status.strengthA);
  }
  if (status.strengthB !== undefined) {
    const maxStrength = (status as any).maxStrength || 200;
    const pctB = Math.min(100, (status.strengthB / maxStrength) * 100);
    (document.getElementById('strength-b') as HTMLDivElement).style.width = pctB + '%';
    (document.getElementById('strength-b-val') as HTMLSpanElement).textContent = String(status.strengthB);
  }

  // Battery in device bar
  if (status.battery !== undefined) {
    (document.getElementById('battery') as HTMLDivElement).textContent = `\uD83D\uDD0B ${status.battery}%`;
  }

  // Wave activity indicators
  updateWaveIndicators(status);
}

function updateWaveIndicators(status: DeviceState): void {
  const channelA = document.getElementById('channel-a');
  const channelB = document.getElementById('channel-b');

  if (channelA) {
    let indicator = channelA.querySelector('.wave-indicator') as HTMLSpanElement | null;
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.className = 'wave-indicator';
      channelA.appendChild(indicator);
    }
    if (status.waveActiveA) {
      indicator.classList.add('active');
      indicator.innerHTML = '<span class="wave-dot"></span>';
    } else {
      indicator.classList.remove('active');
      indicator.innerHTML = '';
    }
  }

  if (channelB) {
    let indicator = channelB.querySelector('.wave-indicator') as HTMLSpanElement | null;
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.className = 'wave-indicator';
      channelB.appendChild(indicator);
    }
    if (status.waveActiveB) {
      indicator.classList.add('active');
      indicator.innerHTML = '<span class="wave-dot"></span>';
    } else {
      indicator.classList.remove('active');
      indicator.innerHTML = '';
    }
  }
}

// -- History drawer --

function toggleHistoryDrawer(): void {
  const drawer = document.getElementById('history-drawer')!;
  drawer.classList.toggle('hidden');
  if (!drawer.classList.contains('hidden')) {
    renderHistoryList();
  }
}

function renderHistoryList(): void {
  const listEl = document.getElementById('history-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const conversations = history.loadConversations();

  if (conversations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '\u6682\u65E0\u5386\u53F2\u8BB0\u5F55';
    listEl.appendChild(empty);
    return;
  }

  conversations.forEach((conv) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    if (currentConversation && currentConversation.id === conv.id) {
      item.classList.add('active');
    }

    const titleEl = document.createElement('div');
    titleEl.className = 'history-item-title';
    titleEl.textContent = conv.title;

    const dateEl = document.createElement('div');
    dateEl.className = 'history-item-date';
    dateEl.textContent = formatDate(conv.updatedAt);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'history-item-delete';
    deleteBtn.textContent = '\u2715';
    deleteBtn.title = '\u5220\u9664';
    deleteBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      history.deleteConversation(conv.id);
      if (currentConversation && currentConversation.id === conv.id) {
        startNewConversation();
      }
      renderHistoryList();
    });

    const infoDiv = document.createElement('div');
    infoDiv.className = 'history-item-info';
    infoDiv.appendChild(titleEl);
    infoDiv.appendChild(dateEl);

    item.appendChild(infoDiv);
    item.appendChild(deleteBtn);
    item.addEventListener('click', () => {
      loadConversation(conv);
      // Close drawer on mobile
      const drawer = document.getElementById('history-drawer');
      if (drawer && window.innerWidth < 768) {
        drawer.classList.add('hidden');
      }
    });

    listEl.appendChild(item);
  });
}

function loadConversation(conv: ConversationRecord): void {
  // Clear current state
  conversationHistory.length = 0;
  currentAssistantMsgId = null;
  currentConversation = conv;
  activePresetId = conv.presetId || 'gentle';

  // Clear chat UI
  const messagesEl = document.getElementById('messages');
  if (messagesEl) messagesEl.innerHTML = '';

  // Replay all messages in chat UI
  conv.messages.forEach((msg) => {
    conversationHistory.push({ role: msg.role, content: msg.content });
    if (msg.role === 'user') {
      chat.addUserMessage(msg.content);
    } else if (msg.role === 'assistant') {
      chat.addAssistantMessage(msg.content);
    }
  });

  // Update preset selection in settings if open
  document.querySelectorAll('.preset-card').forEach((c) => {
    (c as HTMLElement).classList.toggle('active', (c as HTMLElement).dataset.id === activePresetId);
  });

  // Scroll to bottom
  chat.scrollToBottom(true);
  renderHistoryList();
}

function startNewConversation(): void {
  conversationHistory.length = 0;
  currentAssistantMsgId = null;
  currentConversation = null;

  // Clear chat UI
  const messagesEl = document.getElementById('messages');
  if (messagesEl) messagesEl.innerHTML = '';

  showWelcomeMessage();
  renderHistoryList();

  // Close drawer
  const drawer = document.getElementById('history-drawer');
  if (drawer) drawer.classList.add('hidden');
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

// -- Settings modal --

function openSettings(): void {
  document.getElementById('settings-modal')!.classList.remove('hidden');
}

function closeSettings(): void {
  document.getElementById('settings-modal')!.classList.add('hidden');
  saveSettings();
}

function renderProviderSelect(): void {
  const container = document.getElementById('provider-select')!;
  container.innerHTML = '';

  const saved = loadAllSettings();

  PROVIDERS.forEach((p) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'provider-option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'ai-provider';
    radio.id = `provider-${p.id}`;
    radio.value = p.id;
    radio.checked = p.id === saved.provider;
    radio.addEventListener('change', () => {
      renderProviderConfig(p.id);
      // Sync quick-switch select
      const quickSelect = document.getElementById('provider-quick') as HTMLSelectElement | null;
      if (quickSelect) quickSelect.value = p.id;
    });

    const label = document.createElement('label');
    label.htmlFor = `provider-${p.id}`;
    label.textContent = p.name;

    wrapper.appendChild(radio);
    wrapper.appendChild(label);
    container.appendChild(wrapper);
  });

  renderProviderConfig(saved.provider);
}

function renderProviderConfig(providerId: string): void {
  const container = document.getElementById('provider-config')!;
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
    input.addEventListener('change', saveSettings);

    group.appendChild(label);
    group.appendChild(input);
    container.appendChild(group);
  });
}

// -- Preset selector --

function renderPresetSelect(): void {
  const container = document.getElementById('preset-select')!;
  container.innerHTML = '';

  const presets = toolsMod?.PROMPT_PRESETS || [];
  const saved = loadAllSettings();
  activePresetId = saved.presetId || toolsMod?.DEFAULT_PRESET_ID || 'gentle';

  presets.forEach((p: any) => {
    const card = document.createElement('div');
    card.className = 'preset-card' + (p.id === activePresetId ? ' active' : '');
    card.dataset.id = p.id;
    card.innerHTML = `<span class="preset-icon">${p.icon}</span><span class="preset-name">${p.name}</span>`;
    card.title = p.description;
    card.addEventListener('click', () => selectPreset(p.id));
    container.appendChild(card);
  });

  // "Custom" card
  const customCard = document.createElement('div');
  customCard.className = 'preset-card' + (activePresetId === 'custom' ? ' active' : '');
  customCard.dataset.id = 'custom';
  customCard.innerHTML = '<span class="preset-icon">\u270F\uFE0F</span><span class="preset-name">\u81EA\u5B9A\u4E49</span>';
  customCard.title = '\u81EA\u5B9A\u4E49\u4EBA\u8BBE\u63D0\u793A\u8BCD';
  customCard.addEventListener('click', () => selectPreset('custom'));
  container.appendChild(customCard);

  // Show/hide custom prompt area
  toggleCustomPromptArea();
}

function selectPreset(id: string): void {
  activePresetId = id;
  document.querySelectorAll('.preset-card').forEach((c) => {
    (c as HTMLElement).classList.toggle('active', (c as HTMLElement).dataset.id === id);
  });
  toggleCustomPromptArea();
  saveSettings();
}

function toggleCustomPromptArea(): void {
  const area = document.getElementById('custom-prompt-area');
  if (!area) return;
  if (activePresetId === 'custom') {
    area.classList.remove('hidden');
  } else {
    area.classList.add('hidden');
  }
}

// -- Saved custom prompts --

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

function handleSaveCustomPrompt(): void {
  const text = (document.getElementById('custom-system-prompt') as HTMLTextAreaElement | null)?.value?.trim();
  if (!text) return;

  const name = prompt('\u4E3A\u8FD9\u4E2A\u4EBA\u8BBE\u8D77\u4E2A\u540D\u5B57\uFF1A');
  if (!name) return;

  const list = loadSavedPrompts();
  list.push({ name, prompt: text, id: Date.now().toString() });
  saveSavedPrompts(list);
  renderSavedPrompts();
}

function renderSavedPrompts(): void {
  const container = document.getElementById('saved-prompts-list');
  if (!container) return;
  container.innerHTML = '';

  const list = loadSavedPrompts();
  if (list.length === 0) {
    container.innerHTML = '<p class="empty-hint">\u6682\u65E0\u4FDD\u5B58\u7684\u81EA\u5B9A\u4E49\u4EBA\u8BBE</p>';
    return;
  }

  list.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'saved-prompt-row';

    const nameBtn = document.createElement('button');
    nameBtn.className = 'saved-prompt-name';
    nameBtn.textContent = item.name;
    nameBtn.title = item.prompt.slice(0, 100) + '...';
    nameBtn.addEventListener('click', () => {
      const el = document.getElementById('custom-system-prompt') as HTMLTextAreaElement | null;
      if (el) el.value = item.prompt;
      saveSettings();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'saved-prompt-del';
    delBtn.textContent = '\u2715';
    delBtn.title = '\u5220\u9664';
    delBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const updated = loadSavedPrompts().filter((p) => p.id !== item.id);
      saveSavedPrompts(updated);
      renderSavedPrompts();
    });

    row.appendChild(nameBtn);
    row.appendChild(delBtn);
    container.appendChild(row);
  });
}

// -- Persistence --

function saveSettings(): void {
  const selectedRadio = document.querySelector('input[name="ai-provider"]:checked') as HTMLInputElement | null;
  const quickSelect = document.getElementById('provider-quick') as HTMLSelectElement | null;
  const provider = selectedRadio?.value || quickSelect?.value || 'gemini';

  const configs = loadAllSettings().configs || {};
  const inputs = document.querySelectorAll('.provider-cfg-input') as NodeListOf<HTMLInputElement>;
  const currentCfg: Record<string, string> = {};
  inputs.forEach((inp) => {
    currentCfg[inp.dataset.key!] = inp.value;
  });
  configs[provider] = currentCfg;

  const customPrompt = (document.getElementById('custom-system-prompt') as HTMLTextAreaElement | null)?.value || '';

  const data: AppSettings = { provider, configs, presetId: activePresetId, customPrompt };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(data));
  } catch (_) { /* quota */ }

  // Sync quick-switch
  if (quickSelect && quickSelect.value !== provider) {
    quickSelect.value = provider;
  }
}

function loadSettings(): void {
  const saved = loadAllSettings();

  // Restore preset
  activePresetId = saved.presetId || toolsMod?.DEFAULT_PRESET_ID || 'gentle';

  // Restore custom prompt textarea
  const promptEl = document.getElementById('custom-system-prompt') as HTMLTextAreaElement | null;
  if (promptEl && saved.customPrompt) {
    promptEl.value = saved.customPrompt;
  }

  // Sync quick-switch select
  const quickSelect = document.getElementById('provider-quick') as HTMLSelectElement | null;
  if (quickSelect) {
    quickSelect.value = saved.provider;
  }

  // Render saved prompts list
  renderSavedPrompts();
}

function loadAllSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppSettings;
  } catch (_) { /* corrupt */ }
  return { provider: 'gemini', configs: {}, presetId: 'gentle', customPrompt: '' };
}

export function getProviderConfig(): Record<string, string> & { provider: string } {
  const saved = loadAllSettings();
  const cfg = saved.configs?.[saved.provider] || {};
  return { provider: saved.provider, ...cfg };
}
