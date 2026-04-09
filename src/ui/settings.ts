/**
 * ui/settings.ts — Settings modal rendering & provider config.
 */

import { PROVIDERS, loadSettings, saveSettings as persistSettings } from '../agent/providers';
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

  const inputs = document.querySelectorAll('.provider-cfg-input') as NodeListOf<HTMLInputElement>;
  if (inputs.length > 0) {
    const currentCfg: Record<string, string> = {};
    inputs.forEach((inp) => { currentCfg[inp.dataset.key!] = inp.value; });
    saved.configs[saved.provider] = currentCfg;
  }

  saved.presetId = activePresetIdRef();
  saved.customPrompt = customPromptRef();

  persistSettings(saved);
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
