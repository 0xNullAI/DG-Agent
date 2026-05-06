import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { Input } from '@/components/ui/input';

import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import {
  PROVIDER_DEFINITIONS,
  createProviderSettings,
  getProviderDefinition,
  normalizeProviderSettings,
  type ProviderFieldDefinition,
  type ProviderId,
} from '@dg-agent/providers-catalog';
import { HelpTip } from '../HelpTip.js';
import { SettingLabel } from './SettingLabel.js';
import { SettingSelect } from './SettingSelect.js';
import { SettingToggle } from './SettingToggle.js';
import strengthStyles from './SafetyTab.module.css';

interface GeneralTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
}

export function GeneralTab({ settingsDraft, setSettingsDraft }: GeneralTabProps) {
  const selectedProviderDef = getProviderDefinition(settingsDraft.provider.providerId);

  function updateProviderField<K extends keyof BrowserAppSettings['provider']>(
    key: K,
    value: BrowserAppSettings['provider'][K],
  ): void {
    setSettingsDraft((current) => ({
      ...current,
      provider: {
        ...current.provider,
        [key]: value,
      },
      providerConfigs: {
        ...current.providerConfigs,
        [current.provider.providerId]: {
          ...current.provider,
          [key]: value,
        },
      },
    }));
  }

  function switchProvider(providerId: ProviderId): void {
    setSettingsDraft((current) => {
      const providerConfigs = {
        ...current.providerConfigs,
        [current.provider.providerId]: current.provider,
      };
      const nextProvider = normalizeProviderSettings(
        providerConfigs[providerId] ?? createProviderSettings(providerId),
      );

      return {
        ...current,
        provider: nextProvider,
        providerConfigs: {
          ...providerConfigs,
          [providerId]: nextProvider,
        },
      };
    });
  }

  function renderProviderField(field: ProviderFieldDefinition) {
    const fieldId = `provider-${field.key}`;

    if (field.type === 'select') {
      if (field.key !== 'endpoint' && field.key !== 'useStrict') {
        return null;
      }

      const value =
        field.key === 'useStrict'
          ? String(settingsDraft.provider.useStrict)
          : settingsDraft.provider[field.key];

      return (
        <label key={field.key} htmlFor={fieldId} className="settings-inline-field">
          <SettingLabel>{field.label}</SettingLabel>
          <SettingSelect
            value={value}
            onValueChange={(nextValue) => {
              if (field.key === 'endpoint') {
                updateProviderField(
                  'endpoint',
                  nextValue as BrowserAppSettings['provider']['endpoint'],
                );
                return;
              }

              if (field.key === 'useStrict') {
                updateProviderField('useStrict', nextValue === 'true');
              }
            }}
            options={(field.options ?? []).map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />
        </label>
      );
    }

    if (field.key !== 'apiKey' && field.key !== 'model' && field.key !== 'baseUrl') {
      return null;
    }

    return (
      <label key={field.key} htmlFor={fieldId} className="settings-inline-field">
        <SettingLabel>{field.label}</SettingLabel>
        <Input
          id={fieldId}
          type={field.type}
          value={settingsDraft.provider[field.key]}
          onChange={(event) => updateProviderField(field.key, event.target.value)}
          placeholder={field.placeholder}
        />
      </label>
    );
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-section">
        <div className="settings-row-card grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3">
          <h3 className="settings-card-legend">基本设置</h3>
          <SettingLabel>主题模式</SettingLabel>
          <div className="settings-inline-field-control text-xs flex rounded-full bg-[var(--bg-strong)] p-0.5">
            {(
              [
                { value: 'auto', label: '系统' },
                { value: 'dark', label: '深色' },
                { value: 'light', label: '浅色' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={`flex-1 rounded-full px-3.5 py-1 text-xs font-medium transition-all duration-150 ${
                  settingsDraft.themeMode === option.value
                    ? 'bg-[var(--accent)] text-[var(--button-text)]'
                    : 'text-[var(--text-soft)] hover:text-[var(--text)]'
                }`}
                onClick={() =>
                  setSettingsDraft((current) => ({
                    ...current,
                    themeMode: option.value as BrowserAppSettings['themeMode'],
                  }))
                }
              >
                {option.label}
              </button>
            ))}
          </div>

          <SettingLabel className="whitespace-nowrap">
            上下文策略
            <HelpTip text="策略越复杂，模型可以记住越长的对话历史，但工具调用的稳定性可能会下降，请按需选择。" />
          </SettingLabel>
          <div className="settings-inline-field-control">
            <SettingSelect
              value={settingsDraft.modelContextStrategy}
              onValueChange={(value) =>
                setSettingsDraft((current) => ({
                  ...current,
                  modelContextStrategy: value as BrowserAppSettings['modelContextStrategy'],
                }))
              }
              options={[
                { value: 'last-user-turn', label: '基础' },
                { value: 'last-five-user-turns', label: '中等' },
                { value: 'full-history', label: '复杂' },
              ]}
            />
          </div>

          <SettingLabel className="whitespace-nowrap">
            回复多样性
            <HelpTip text="越接近 1 多样性越高，模型回复更发散；越接近 0 越保守稳定，工具调用更可控。" />
          </SettingLabel>
          <div className="settings-inline-field-control">
            <div
              className="flex items-center gap-3"
              style={
                {
                  '--strength-fill': 'var(--accent)',
                  '--strength-fill-soft': 'var(--accent-soft)',
                  '--strength-value': `${settingsDraft.temperature * 100}%`,
                } as CSSProperties
              }
            >
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settingsDraft.temperature}
                aria-label="回复多样性滑杆"
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    temperature: Number(event.target.value),
                  }))
                }
                className={`flex-1 ${strengthStyles.strengthSlider}`}
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settingsDraft.temperature}
                aria-label="回复多样性"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) {
                    setSettingsDraft((current) => ({
                      ...current,
                      temperature: Math.min(1, Math.max(0, next)),
                    }));
                  }
                }}
                className={strengthStyles.strengthValueInput}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-row-section">
        <div className="settings-row-card">
          <h3 className="settings-card-legend">模型选择</h3>
          <div className="text-xs text-sm text-[var(--text-soft)]">
            当前：
            <span className="text-xs font-medium text-[var(--text)]">
              {selectedProviderDef?.name ?? '未知'}
            </span>
            {settingsDraft.provider.model && (
              <span className="text-xs ml-1 text-[var(--text-faint)]">
                / {settingsDraft.provider.model}
              </span>
            )}
          </div>

          <ProviderScroller
            currentProviderId={settingsDraft.provider.providerId}
            onSwitch={switchProvider}
          />

          {selectedProviderDef?.hint && (
            <div className="rounded-[8px] bg-[var(--accent-soft)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-soft)]">
              {selectedProviderDef.id === 'free' ? (
                <>
                  无需配置 API-Key，当前由{' '}
                  <a
                    href="https://aihub.071129.xyz/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-[var(--accent)] hover:text-[var(--text)]"
                  >
                    MapLeaf API
                  </a>{' '}
                  提供支持。
                </>
              ) : (
                selectedProviderDef.hint
              )}
            </div>
          )}

          {selectedProviderDef && selectedProviderDef.fields.length > 0 && (
            <div className="grid gap-3">
              {selectedProviderDef.fields.map((field) => renderProviderField(field))}
              {selectedProviderDef.fields.some((f) => f.key === 'apiKey') && (
                <SettingToggle
                  label="在当前设备记住 API 密钥"
                  checked={settingsDraft.rememberApiKey}
                  onCheckedChange={(checked) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      rememberApiKey: checked,
                    }))
                  }
                />
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ProviderScroller({
  currentProviderId,
  onSwitch,
}: {
  currentProviderId: ProviderId;
  onSwitch: (id: ProviderId) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 text-xs">
      {PROVIDER_DEFINITIONS.map((provider) => {
        const active = provider.id === currentProviderId;
        return (
          <button
            key={provider.id}
            type="button"
            className={`rounded-full px-2 py-1.5 text-[13px] font-medium transition-all duration-150 ${
              active
                ? 'bg-[var(--accent)] text-[var(--button-text)]'
                : 'bg-[var(--bg-strong)] text-[var(--text-soft)] hover:text-[var(--text)]'
            } ${!provider.browserSupported ? 'opacity-50' : ''}`}
            onClick={() => onSwitch(provider.id)}
          >
            {provider.name}
          </button>
        );
      })}
    </div>
  );
}
