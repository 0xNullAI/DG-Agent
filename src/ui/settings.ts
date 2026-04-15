/**
 * ui/settings.ts — Settings modal rendering & provider config.
 */

import {
  PROVIDERS,
  loadSettings,
  saveSettings as persistSettings,
  DEFAULT_MAX_STRENGTH,
  MAX_STRENGTH_CEILING,
} from '../agent/providers';
import {
  getEffectiveMode,
  setMode as setPermissionMode,
  getTimedRemainingMs,
} from '../agent/permissions';
import type { AppSettings, PermissionMode } from '../types';
import * as bluetooth from '../agent/bluetooth';
import * as waveforms from '../agent/waveforms';
import * as theme from './theme';
import { updateStrengthCapMarker } from './device';
import { $, updateBridgeOverlay } from './index';
import {
  DEFAULT_BRIDGE_SETTINGS,
  type BridgeSettings,
  initBridge,
  stopBridge,
  getAdapterStatus,
} from '../bridge';

let activePresetIdRef: () => string;
let customPromptRef: () => string;

export function init(getPresetId: () => string, getCustomPrompt: () => string): void {
  activePresetIdRef = getPresetId;
  customPromptRef = getCustomPrompt;
}

// Live countdown tick for the "5 分钟免询问" option. Only runs while the
// settings modal is open; cleaned up on close.
let permissionCountdownTimer: number | null = null;

type TopTab = 'basic' | 'security' | 'waveforms' | 'bridge' | 'voice';
let activeTopTab: TopTab = 'basic';

export function open(): void {
  $('settings-modal')!.classList.remove('hidden');
  const saved = loadSettings();
  activeTopTab = 'basic';
  updateCurrentAiLabel();
  renderTopTabs();
  renderPageConfig();
  renderTabs();
  renderConfig(saved.provider);
  renderBehaviorSettings(saved);
  renderWaveformsPanel();
  renderBridgePanel();
  renderVoicePanel();
  updateTopPanelVisibility();
  startPermissionCountdown();
}

function renderTopTabs(): void {
  const container = $('settings-top-tabs')!;
  container.innerHTML = '';

  const tabs: Array<{ id: TopTab; label: string }> = [
    { id: 'basic', label: '基础' },
    { id: 'security', label: '安全' },
    { id: 'waveforms', label: '波形' },
    { id: 'voice', label: '语音' },
    { id: 'bridge', label: 'Bot' },
  ];

  tabs.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-tab' + (t.id === activeTopTab ? ' active' : '');
    btn.textContent = t.label;
    btn.dataset.tab = t.id;
    btn.addEventListener('click', () => {
      activeTopTab = t.id;
      container.querySelectorAll<HTMLButtonElement>('.provider-tab').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === t.id);
      });
      updateTopPanelVisibility();
    });
    container.appendChild(btn);
  });
}

function updateTopPanelVisibility(): void {
  $('settings-panel-basic')!.classList.toggle('hidden', activeTopTab !== 'basic');
  $('settings-panel-security')!.classList.toggle('hidden', activeTopTab !== 'security');
  $('settings-panel-waveforms')!.classList.toggle('hidden', activeTopTab !== 'waveforms');
  const bridgePanel = $('settings-panel-bridge');
  if (bridgePanel) bridgePanel.classList.toggle('hidden', activeTopTab !== 'bridge');
  const voicePanel = $('settings-panel-voice');
  if (voicePanel) voicePanel.classList.toggle('hidden', activeTopTab !== 'voice');
}

function renderPageConfig(): void {
  const container = $('basic-page-config');
  if (!container) return;
  container.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'setting-group setting-group-inline';

  const label = document.createElement('label');
  label.textContent = '主题模式';
  row.appendChild(label);

  const seg = document.createElement('div');
  seg.className = 'segmented';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', '主题模式');

  const options: Array<{ mode: theme.ThemeMode; label: string }> = [
    { mode: 'auto', label: '跟随系统' },
    { mode: 'light', label: '浅色' },
    { mode: 'dark', label: '深色' },
  ];

  const current = theme.getMode();

  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segmented-btn' + (opt.mode === current ? ' active' : '');
    btn.dataset.mode = opt.mode;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(opt.mode === current));
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      theme.apply(opt.mode);
      seg.querySelectorAll<HTMLButtonElement>('.segmented-btn').forEach((b) => {
        const isActive = b.dataset.mode === opt.mode;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-checked', String(isActive));
      });
    });
    seg.appendChild(btn);
  });

  row.appendChild(seg);
  container.appendChild(row);
}

export function close(): void {
  $('settings-modal')!.classList.add('hidden');
  stopPermissionCountdown();
  saveCurrentSettings();
}

function startPermissionCountdown(): void {
  stopPermissionCountdown();
  permissionCountdownTimer = window.setInterval(() => {
    updatePermissionCountdownUI();
  }, 1000);
}

function stopPermissionCountdown(): void {
  if (permissionCountdownTimer != null) {
    window.clearInterval(permissionCountdownTimer);
    permissionCountdownTimer = null;
  }
}

function formatMMSS(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/**
 * Rerender the countdown text and the active-option highlight without
 * rebuilding the whole settings panel (which would lose focus / scroll).
 */
function updatePermissionCountdownUI(): void {
  const remainEl = $('cfg-perm-timed-remain');
  const mode = getEffectiveMode();
  const remaining = getTimedRemainingMs();

  if (remainEl) {
    if (mode === 'timed' && remaining > 0) {
      remainEl.textContent = `剩余 ${formatMMSS(remaining)}`;
      remainEl.classList.remove('hidden');
    } else {
      remainEl.textContent = '';
      remainEl.classList.add('hidden');
    }
  }

  // Timed window may have expired — reflect that in the active highlight.
  document.querySelectorAll<HTMLButtonElement>('.perm-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
  });
}

export function selectProvider(id: string): void {
  const saved = loadSettings();
  saved.provider = id;
  persistSettings(saved);

  renderTabs();
  renderConfig(id);
  updateCurrentAiLabel();
}

export function updateCurrentAiLabel(): void {
  const saved = loadSettings();
  const prov = PROVIDERS.find((x) => x.id === saved.provider);
  const el = $('settings-current-ai');
  if (el) el.innerHTML = `当前模型：<strong>${prov?.name || saved.provider}</strong>`;
}

export function saveCurrentSettings(): void {
  const saved = loadSettings();

  const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    '.provider-cfg-input',
  );
  if (inputs.length > 0) {
    const currentCfg: Record<string, string> = {};
    inputs.forEach((inp) => {
      currentCfg[inp.dataset.key!] = inp.value;
    });
    saved.configs[saved.provider] = currentCfg;
  }

  saved.presetId = activePresetIdRef();
  saved.customPrompt = customPromptRef();

  persistSettings(saved);
}

export function getBackgroundBehavior(): 'stop' | 'keep' {
  return loadSettings().backgroundBehavior || 'stop';
}

function renderBehaviorSettings(saved: AppSettings): void {
  const container = $('security-config')!;
  container.innerHTML = '';

  const section = document.createElement('div');

  // Max strength caps (per channel) ----------------------------------------
  const capsWrap = document.createElement('div');
  capsWrap.className = 'max-strength-wrap';

  const capsHeader = document.createElement('div');
  capsHeader.className = 'max-strength-header';
  capsHeader.textContent = '最大强度上限';
  capsWrap.appendChild(capsHeader);

  const capsRow = document.createElement('div');
  capsRow.className = 'max-strength-row';

  const makeStepper = (channel: 'A' | 'B'): HTMLDivElement => {
    const initial = normalizeCap(channel === 'A' ? saved.maxStrengthA : saved.maxStrengthB);

    const card = document.createElement('div');
    card.className = 'strength-stepper';
    card.dataset.channel = channel;

    const chLabel = document.createElement('span');
    chLabel.className = 'strength-stepper-channel';
    chLabel.textContent = channel;
    card.appendChild(chLabel);

    const control = document.createElement('div');
    control.className = 'strength-stepper-control';

    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'strength-stepper-btn';
    dec.textContent = '−';
    dec.setAttribute('aria-label', `${channel} 通道减小`);

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'strength-stepper-input';
    input.min = '0';
    input.max = String(MAX_STRENGTH_CEILING);
    input.step = '1';
    input.value = String(initial);
    input.inputMode = 'numeric';
    input.id = `cfg-max-strength-${channel.toLowerCase()}`;

    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'strength-stepper-btn';
    inc.textContent = '+';
    inc.setAttribute('aria-label', `${channel} 通道增大`);

    const commit = (): void => {
      const next = normalizeCap(Number(input.value));
      input.value = String(next);

      const s = loadSettings();
      if (channel === 'A') s.maxStrengthA = next;
      else s.maxStrengthB = next;
      persistSettings(s);
      updateStrengthCapMarker();

      // If device is connected and current strength exceeds the new cap,
      // pull this channel back down immediately.
      try {
        const status = bluetooth.getStatus();
        if (status.connected) {
          const cur = channel === 'A' ? status.strengthA : status.strengthB;
          if (cur > next) bluetooth.setStrength(channel, next);
        }
      } catch (_) {
        /* ignore */
      }
    };

    const bump = (delta: number): void => {
      input.value = String(normalizeCap(Number(input.value) + delta));
      commit();
    };

    dec.addEventListener('click', () => bump(-1));
    inc.addEventListener('click', () => bump(1));
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);

    control.appendChild(dec);
    control.appendChild(input);
    control.appendChild(inc);
    card.appendChild(control);

    return card;
  };

  capsRow.appendChild(makeStepper('A'));
  capsRow.appendChild(makeStepper('B'));
  capsWrap.appendChild(capsRow);
  section.appendChild(capsWrap);

  // Permission confirmation mode ------------------------------------------
  renderPermissionModeControl(section);

  // Background behavior ---------------------------------------------------
  renderBackgroundBehaviorControl(section, saved);

  container.appendChild(section);
}

function renderBackgroundBehaviorControl(parent: HTMLElement, saved: AppSettings): void {
  const wrap = document.createElement('div');
  wrap.className = 'bg-behavior-wrap';

  const header = document.createElement('div');
  header.className = 'perm-mode-header';
  const headerText = document.createElement('span');
  headerText.textContent = '后台行为';
  header.appendChild(headerText);
  wrap.appendChild(header);

  const group = document.createElement('div');
  group.className = 'setting-group setting-group-inline';

  const label = document.createElement('label');
  label.textContent = '切换后台时停止输出';
  label.htmlFor = 'cfg-bg-behavior';

  const toggle = document.createElement('button');
  toggle.id = 'cfg-bg-behavior';
  const isStop = (saved.backgroundBehavior || 'stop') === 'stop';
  toggle.className = 'toggle-btn' + (isStop ? ' active' : '');
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(isStop));

  const knob = document.createElement('span');
  knob.className = 'toggle-knob';
  toggle.appendChild(knob);

  toggle.addEventListener('click', () => {
    const current = toggle.classList.contains('active');
    toggle.classList.toggle('active', !current);
    toggle.setAttribute('aria-checked', String(!current));
    const s = loadSettings();
    s.backgroundBehavior = current ? 'keep' : 'stop';
    persistSettings(s);
  });

  group.appendChild(label);
  group.appendChild(toggle);
  wrap.appendChild(group);

  parent.appendChild(wrap);
}

/**
 * Segmented control for the three permission modes, bound to the dialog
 * behavior: picking 'timed' or 'always' makes the dialog stop showing up
 * until the timed window expires or the user switches back.
 */
function renderPermissionModeControl(parent: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'perm-mode-wrap';

  const header = document.createElement('div');
  header.className = 'perm-mode-header';

  const headerText = document.createElement('span');
  headerText.textContent = '工具调用确认模式';
  header.appendChild(headerText);

  const remainTag = document.createElement('span');
  remainTag.id = 'cfg-perm-timed-remain';
  remainTag.className = 'perm-mode-remain hidden';
  header.appendChild(remainTag);

  wrap.appendChild(header);

  const group = document.createElement('div');
  group.className = 'perm-mode-group';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', '工具调用确认模式');

  const currentMode = getEffectiveMode();

  const options: Array<{
    mode: PermissionMode;
    label: string;
    sub: string;
    cls: string;
  }> = [
    { mode: 'ask', label: '每次询问', sub: '推荐，最安全', cls: 'ask' },
    { mode: 'timed', label: '5 分钟内免询问', sub: '到期自动恢复询问', cls: 'timed' },
    { mode: 'always', label: '全部允许', sub: '高风险，不再弹窗', cls: 'always' },
  ];

  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      `perm-mode-btn perm-mode-btn-${opt.cls}` + (opt.mode === currentMode ? ' active' : '');
    btn.dataset.mode = opt.mode;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(opt.mode === currentMode));

    const labelEl = document.createElement('div');
    labelEl.className = 'perm-mode-btn-label';
    labelEl.textContent = opt.label;
    btn.appendChild(labelEl);

    const subEl = document.createElement('div');
    subEl.className = 'perm-mode-btn-sub';
    subEl.textContent = opt.sub;
    btn.appendChild(subEl);

    btn.addEventListener('click', () => {
      setPermissionMode(opt.mode);
      // Refresh active highlight across all three buttons.
      group.querySelectorAll<HTMLButtonElement>('.perm-mode-btn').forEach((b) => {
        const isActive = b.dataset.mode === opt.mode;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-checked', String(isActive));
      });
      // Immediately refresh the countdown display (don't wait for the tick).
      updatePermissionCountdownUI();
    });

    group.appendChild(btn);
  });

  wrap.appendChild(group);

  parent.appendChild(wrap);

  // Initial countdown render (covers the case where user reopens settings
  // during a still-valid timed window).
  updatePermissionCountdownUI();
}

// ---------------------------------------------------------------------------
// Waveform library panel
// ---------------------------------------------------------------------------

function renderWaveformsPanel(): void {
  const container = $('waveforms-config');
  if (!container) return;
  container.innerHTML = '';

  // Action bar
  const actions = document.createElement('div');
  actions.className = 'waveform-actions';

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'btn-primary';
  importBtn.textContent = '导入波形…';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.pulse,.zip';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files || fileInput.files.length === 0) return;
    const files = Array.from(fileInput.files);
    fileInput.value = '';
    const { added, errors } = await waveforms.importFiles(files);
    renderWaveformsPanel();
    if (errors.length > 0) {
      alert(`已导入 ${added.length} 个波形\n\n失败：\n${errors.join('\n')}`);
    }
  });
  importBtn.addEventListener('click', () => fileInput.click());

  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'btn-secondary';
  restoreBtn.textContent = '恢复默认';
  restoreBtn.addEventListener('click', () => {
    if (!confirm('恢复默认会清空当前波形库并重新载入六个内置波形，确定继续？')) return;
    waveforms.restoreDefaults();
    renderWaveformsPanel();
  });

  actions.appendChild(importBtn);
  actions.appendChild(restoreBtn);
  actions.appendChild(fileInput);
  container.appendChild(actions);

  // List
  const list = waveforms.getAll();

  // Hint — combines usage instructions and the count warning. Every waveform
  // adds to the tool schema the AI has to read each turn, which noticeably
  // slows response time once the library grows past ~10 entries.
  const hint = document.createElement('p');
  hint.className = 'provider-hint';
  const over = list.length > 10;
  const countLine = over
    ? `⚠️ 当前 ${list.length} 个波形，超过 10 个会显著拖慢 AI 响应速度，建议精简。`
    : `当前 ${list.length} 个波形，建议不超过 10 个——波形数量会影响 AI 性能。`;
  hint.textContent =
    '支持导入单个 .pulse 文件或包含多个 .pulse 的 .zip 压缩包。导入后可手动编辑名称和说明，这些信息会被 AI 用来选择合适的波形。' +
    '\n\n' +
    countLine;
  hint.style.whiteSpace = 'pre-line';
  if (over) hint.style.color = 'var(--color-danger, #d33)';
  container.appendChild(hint);

  const listEl = document.createElement('div');
  listEl.className = 'waveform-list';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'waveform-empty';
    empty.textContent = '波形库为空，请先导入或恢复默认。';
    listEl.appendChild(empty);
  }

  for (const w of list) {
    const row = document.createElement('div');
    row.className = 'waveform-row';
    row.dataset.id = w.id;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'waveform-name-input';
    nameInput.value = w.name;
    nameInput.placeholder = '名称';
    nameInput.addEventListener('change', () => {
      waveforms.updateMeta(w.id, { name: nameInput.value.trim() || w.id });
    });

    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'waveform-desc-input';
    descInput.value = w.description;
    descInput.placeholder = '说明（会显示给 AI 用于选择）';
    descInput.addEventListener('change', () => {
      waveforms.updateMeta(w.id, { description: descInput.value.trim() });
    });

    const meta = document.createElement('div');
    meta.className = 'waveform-meta';
    meta.textContent = `${w.frames.length} 帧`;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'waveform-del';
    delBtn.textContent = '删除';
    delBtn.disabled = list.length <= 1;
    delBtn.title = delBtn.disabled ? '至少保留一个波形' : '删除此波形';
    delBtn.addEventListener('click', () => {
      if (!confirm(`确定删除波形「${w.name}」？`)) return;
      if (waveforms.remove(w.id)) renderWaveformsPanel();
    });

    row.appendChild(nameInput);
    row.appendChild(descInput);
    row.appendChild(meta);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  }

  container.appendChild(listEl);
}

// ---------------------------------------------------------------------------
// Social platform bridge panel
// ---------------------------------------------------------------------------

function loadBridgeSettings(): BridgeSettings {
  const saved = loadSettings();
  return saved.bridge || DEFAULT_BRIDGE_SETTINGS;
}

function saveBridgeSettings(bs: BridgeSettings): void {
  const saved = loadSettings();
  saved.bridge = bs;
  persistSettings(saved);
}

type BridgeTab = 'qq' | 'telegram';
let activeBridgeTab: BridgeTab = 'qq';

function renderBridgePanel(): void {
  const container = $('settings-panel-bridge');
  if (!container) return;
  container.innerHTML = '';

  const bs = loadBridgeSettings();

  // ---- Top row: status + save button ----
  const topRow = document.createElement('div');
  topRow.className = 'bridge-top-row';

  const statusRow = document.createElement('div');
  statusRow.className = 'bridge-status-row';
  const statuses = getAdapterStatus();
  if (statuses.length > 0) {
    for (const s of statuses) {
      const dot = document.createElement('span');
      dot.className = `bridge-status-dot ${s.connected ? 'connected' : 'disconnected'}`;
      dot.textContent = `${s.platform.toUpperCase()}: ${s.connected ? '已连接' : '未连接'}`;
      statusRow.appendChild(dot);
    }
  } else {
    statusRow.textContent = '未启用任何平台';
  }
  topRow.appendChild(statusRow);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-primary';
  applyBtn.textContent = '保存并重新连接';
  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    applyBtn.textContent = '连接中…';
    try {
      await stopBridge();
      const { sendMessage } = await import('../agent/conversation');
      await initBridge((text) => sendMessage(text));
      applyBtn.textContent = '已连接 ✓';
      updateBridgeOverlay();
      setTimeout(() => renderBridgePanel(), 1500);
    } catch (err) {
      applyBtn.textContent = '连接失败';
      console.error('[Bridge] Reconnect error:', err);
      setTimeout(() => renderBridgePanel(), 2000);
    }
  });
  topRow.appendChild(applyBtn);
  container.appendChild(topRow);

  // Master toggle
  container.appendChild(
    makeToggleRow('启用社交平台桥接', bs.enabled, (on) => {
      bs.enabled = on;
      saveBridgeSettings(bs);
    }),
  );

  // ---- Platform tabs ----
  const tabBar = document.createElement('div');
  tabBar.className = 'provider-tabs bridge-tabs';

  const tabs: Array<{ id: BridgeTab; label: string; connected: boolean | null }> = [
    {
      id: 'qq',
      label: 'QQ',
      connected: statuses.find((s) => s.platform === 'qq')?.connected ?? null,
    },
    {
      id: 'telegram',
      label: 'Telegram',
      connected: statuses.find((s) => s.platform === 'telegram')?.connected ?? null,
    },
  ];

  tabs.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-tab' + (t.id === activeBridgeTab ? ' active' : '');
    btn.dataset.tab = t.id;
    if (t.connected === true) btn.classList.add('tab-connected');
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      activeBridgeTab = t.id;
      tabBar.querySelectorAll<HTMLButtonElement>('.provider-tab').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === t.id);
      });
      updateBridgeTabContent(container, bs);
    });
    tabBar.appendChild(btn);
  });
  container.appendChild(tabBar);

  // ---- Tab content ----
  const content = document.createElement('div');
  content.id = 'bridge-tab-content';
  container.appendChild(content);
  updateBridgeTabContent(container, bs);
}

function updateBridgeTabContent(container: HTMLElement, bs: BridgeSettings): void {
  const content = container.querySelector('#bridge-tab-content');
  if (!content) return;
  content.innerHTML = '';

  if (activeBridgeTab === 'qq') {
    renderQQTab(content as HTMLElement, bs);
  } else {
    renderTelegramTab(content as HTMLElement, bs);
  }
}

function renderQQTab(content: HTMLElement, bs: BridgeSettings): void {
  const hint = document.createElement('p');
  hint.className = 'provider-hint';
  hint.textContent =
    '需要在本机运行 NapCat 并用手机 QQ 扫码登录。NapCat 提供 OneBot v11 WebSocket 接口，默认端口 3001。';
  content.appendChild(hint);

  content.appendChild(
    makeToggleRow('启用 QQ', bs.qq.enabled, (on) => {
      bs.qq.enabled = on;
      saveBridgeSettings(bs);
    }),
  );

  content.appendChild(
    makeInputRow('NapCat WebSocket 地址', bs.qq.wsUrl, 'ws://localhost:3001', (val) => {
      bs.qq.wsUrl = val;
      saveBridgeSettings(bs);
    }),
  );

  content.appendChild(
    makeInputRow(
      '允许的 QQ 用户号（逗号分隔）',
      bs.qq.allowUsers.join(','),
      '12345678,87654321',
      (val) => {
        bs.qq.allowUsers = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        saveBridgeSettings(bs);
      },
    ),
  );

  content.appendChild(
    makeInputRow('允许的 QQ 群号（逗号分隔）', bs.qq.allowGroups.join(','), '', (val) => {
      bs.qq.allowGroups = val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      saveBridgeSettings(bs);
    }),
  );

  content.appendChild(
    makePermModeRow('权限模式', bs.qq.permissionMode, (mode) => {
      bs.qq.permissionMode = mode;
      saveBridgeSettings(bs);
    }),
  );
}

function renderTelegramTab(content: HTMLElement, bs: BridgeSettings): void {
  const hint = document.createElement('p');
  hint.className = 'provider-hint';
  hint.textContent =
    '在 Telegram 找 @BotFather 发 /newbot 创建机器人获取 Token。如遇 CORS 问题需填写代理 URL。';
  content.appendChild(hint);

  content.appendChild(
    makeToggleRow('启用 Telegram', bs.telegram.enabled, (on) => {
      bs.telegram.enabled = on;
      saveBridgeSettings(bs);
    }),
  );

  content.appendChild(
    makeInputRow(
      'Bot Token',
      bs.telegram.botToken,
      '123456:ABC-DEF...',
      (val) => {
        bs.telegram.botToken = val;
        saveBridgeSettings(bs);
      },
      'password',
    ),
  );

  content.appendChild(
    makeInputRow('CORS 代理 URL（可选）', bs.telegram.proxyUrl, 'https://your-proxy.com', (val) => {
      bs.telegram.proxyUrl = val;
      saveBridgeSettings(bs);
    }),
  );

  content.appendChild(
    makeInputRow(
      '允许的用户 ID（逗号分隔）',
      bs.telegram.allowUsers.join(','),
      '987654321',
      (val) => {
        bs.telegram.allowUsers = val
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => n > 0);
        saveBridgeSettings(bs);
      },
    ),
  );

  content.appendChild(
    makePermModeRow('权限模式', bs.telegram.permissionMode, (mode) => {
      bs.telegram.permissionMode = mode;
      saveBridgeSettings(bs);
    }),
  );
}

function makeToggleRow(
  label: string,
  value: boolean,
  onChange: (on: boolean) => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'setting-group setting-group-inline';

  const lbl = document.createElement('label');
  lbl.textContent = label;
  row.appendChild(lbl);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle-btn' + (value ? ' active' : '');
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(value));

  const knob = document.createElement('span');
  knob.className = 'toggle-knob';
  toggle.appendChild(knob);

  toggle.addEventListener('click', () => {
    const next = !toggle.classList.contains('active');
    toggle.classList.toggle('active', next);
    toggle.setAttribute('aria-checked', String(next));
    onChange(next);
  });

  row.appendChild(toggle);
  return row;
}

function makeInputRow(
  label: string,
  value: string,
  placeholder: string,
  onChange: (val: string) => void,
  type?: string,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'setting-group';

  const lbl = document.createElement('label');
  lbl.textContent = label;
  row.appendChild(lbl);

  const input = document.createElement('input');
  input.type = type || 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('change', () => onChange(input.value.trim()));
  row.appendChild(input);

  return row;
}

function makePermModeRow(
  label: string,
  value: 'ask' | 'always',
  onChange: (mode: 'ask' | 'always') => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'setting-group setting-group-inline';

  const lbl = document.createElement('label');
  lbl.textContent = label;
  row.appendChild(lbl);

  const seg = document.createElement('div');
  seg.className = 'segmented';

  const options: Array<{ mode: 'ask' | 'always'; label: string }> = [
    { mode: 'ask', label: '每次询问' },
    { mode: 'always', label: '全部允许' },
  ];

  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segmented-btn' + (opt.mode === value ? ' active' : '');
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      seg.querySelectorAll<HTMLButtonElement>('.segmented-btn').forEach((b) => {
        b.classList.toggle('active', b.textContent === opt.label);
      });
      onChange(opt.mode);
    });
    seg.appendChild(btn);
  });

  row.appendChild(seg);
  return row;
}

// ---------------------------------------------------------------------------
// Voice settings panel
// ---------------------------------------------------------------------------

export interface VoiceSettings {
  speaker: string;
  dashscopeApiKey: string;
  proxyUrl: string;
  autoStopEnabled: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  speaker: 'longyingtian',
  dashscopeApiKey: '',
  proxyUrl: '',
  autoStopEnabled: true,
};

const VOICE_SPEAKERS: Array<{ id: string; label: string }> = [
  { id: 'longyingtian', label: 'longyingtian' },
];

export function loadVoiceSettings(): VoiceSettings {
  const saved = loadSettings();
  return { ...DEFAULT_VOICE_SETTINGS, ...(saved.voice || {}) };
}

function saveVoiceSettings(vs: VoiceSettings): void {
  const saved = loadSettings();
  saved.voice = vs;
  persistSettings(saved);
}

function renderVoicePanel(): void {
  const container = $('settings-panel-voice');
  if (!container) return;
  container.innerHTML = '';

  const vs = loadVoiceSettings();

  const hint = document.createElement('p');
  hint.className = 'provider-hint';
  hint.textContent =
    '输入框为空时点击波形按钮即可进入语音对话模式。' +
    '免费语音模式与免费 AI 对话共享额度（每分钟 10 次），建议填写自己的百炼 API Key 以获得更好的体验。';
  container.appendChild(hint);

  // Speaker selection
  const speakerGroup = document.createElement('div');
  speakerGroup.className = 'setting-group';
  const speakerLabel = document.createElement('label');
  speakerLabel.textContent = '音色';
  speakerGroup.appendChild(speakerLabel);

  const speakerSelect = document.createElement('select');
  VOICE_SPEAKERS.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === vs.speaker) opt.selected = true;
    speakerSelect.appendChild(opt);
  });
  speakerSelect.addEventListener('change', () => {
    vs.speaker = speakerSelect.value;
    saveVoiceSettings(vs);
  });
  speakerGroup.appendChild(speakerSelect);
  container.appendChild(speakerGroup);

  // Auto-stop (VAD)
  container.appendChild(
    makeToggleRow('自动结束录音（静音检测）', vs.autoStopEnabled, (on) => {
      vs.autoStopEnabled = on;
      saveVoiceSettings(vs);
    }),
  );

  // API Key
  container.appendChild(
    makeInputRow(
      '百炼 API Key',
      vs.dashscopeApiKey,
      'sk-…（留空使用免费共享额度）',
      (val) => {
        vs.dashscopeApiKey = val;
        saveVoiceSettings(vs);
      },
      'password',
    ),
  );

  // Custom proxy URL
  container.appendChild(
    makeInputRow('WebSocket 代理地址（可选）', vs.proxyUrl, '留空使用默认免费代理', (val) => {
      vs.proxyUrl = val;
      saveVoiceSettings(vs);
    }),
  );
}

function normalizeCap(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STRENGTH;
  return Math.max(0, Math.min(MAX_STRENGTH_CEILING, Math.round(n)));
}

function renderTabs(): void {
  const container = $('settings-provider-tabs')!;
  container.innerHTML = '';
  const saved = loadSettings();

  PROVIDERS.forEach((p) => {
    const tab = document.createElement('button');
    tab.className = 'provider-tab' + (p.id === saved.provider ? ' active' : '');
    tab.textContent = p.name;
    tab.addEventListener('click', () => selectProvider(p.id));
    container.appendChild(tab);
  });
}

function renderConfig(providerId: string): void {
  const container = $('provider-config')!;
  container.innerHTML = '';

  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return;

  const saved = loadSettings();
  const values = saved.configs?.[providerId] || {};

  if (provider.hint) {
    const hint = document.createElement('p');
    hint.className = 'provider-hint';
    hint.textContent = provider.hint;
    container.appendChild(hint);
  }

  if (provider.fields.length === 0) return;

  provider.fields.forEach((f) => {
    const group = document.createElement('div');
    group.className = 'setting-group';

    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `cfg-${f.key}`;

    let control: HTMLInputElement | HTMLSelectElement;
    if (f.type === 'select' && f.options) {
      const select = document.createElement('select');
      const currentVal = values[f.key] || f.default || f.options[0].value;
      f.options.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === currentVal) o.selected = true;
        select.appendChild(o);
      });
      control = select;
    } else {
      const input = document.createElement('input');
      input.type = f.type || 'text';
      input.placeholder = f.placeholder || '';
      input.value = values[f.key] || f.default || '';
      control = input;
    }
    control.id = `cfg-${f.key}`;
    control.dataset.provider = providerId;
    control.dataset.key = f.key;
    control.classList.add('provider-cfg-input');
    group.appendChild(label);
    group.appendChild(control);
    container.appendChild(group);
  });

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => {
    saveCurrentSettings();
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
