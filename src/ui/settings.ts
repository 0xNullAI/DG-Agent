/**
 * ui/settings.ts — Settings modal rendering & provider config.
 */

import { PROVIDERS, loadSettings, saveSettings as persistSettings } from '../agent/providers';
import type { AppSettings } from '../types';
import { $ } from './index';

let activePresetIdRef: () => string;
let customPromptRef: () => string;

export function init(getPresetId: () => string, getCustomPrompt: () => string): void {
  activePresetIdRef = getPresetId;
  customPromptRef = getCustomPrompt;
}

export function open(): void {
  $('settings-modal')!.classList.remove('hidden');
  const saved = loadSettings();
  updateCurrentAiLabel();
  renderTabs();
  renderConfig(saved.provider);
  renderBehaviorSettings(saved);
}

export function close(): void {
  $('settings-modal')!.classList.add('hidden');
  saveCurrentSettings();
}

export function selectProvider(id: string): void {
  const saved = loadSettings();
  saved.provider = id;
  persistSettings(saved);

  renderTabs();
  renderConfig(id);
  renderBehaviorSettings(saved);
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

  const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.provider-cfg-input');
  if (inputs.length > 0) {
    const currentCfg: Record<string, string> = {};
    inputs.forEach((inp) => { currentCfg[inp.dataset.key!] = inp.value; });
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
  const container = $('provider-config')!;

  const section = document.createElement('div');
  section.className = 'behavior-settings';

  const title = document.createElement('h3');
  title.className = 'behavior-settings-title';
  title.textContent = '安全设置';
  section.appendChild(title);

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
  section.appendChild(group);

  const hint = document.createElement('p');
  hint.className = 'provider-hint';
  hint.textContent = '开启后，切换到其他应用或标签页时将自动停止所有波形并将强度归零';
  section.appendChild(hint);

  container.appendChild(section);
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
