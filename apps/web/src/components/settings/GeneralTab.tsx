import type { Dispatch, SetStateAction } from 'react';
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
import { SettingSelect } from './SettingSelect.js';
import { SettingSegmented } from './SettingSegmented.js';
import { SettingToggle } from './SettingToggle.js';

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
        <label key={field.key} htmlFor={fieldId}>
          <span>{field.label}</span>
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
      <label key={field.key} htmlFor={fieldId}>
        <span>{field.label}</span>
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
      <section className="settings-group">
        <h3 className="settings-group-title">基础</h3>

        <SettingSegmented
          label="主题"
          value={settingsDraft.themeMode}
          onValueChange={(value) =>
            setSettingsDraft((current) => ({
              ...current,
              themeMode: value as BrowserAppSettings['themeMode'],
            }))
          }
          options={[
            { value: 'auto', label: '跟随系统' },
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' },
          ]}
        />
      </section>

      <section className="settings-group">
        <h3 className="settings-group-title">模型服务</h3>

        <label>
          <span>服务提供方</span>
          <SettingSelect
            value={settingsDraft.provider.providerId}
            onValueChange={(value) => switchProvider(value as ProviderId)}
            options={PROVIDER_DEFINITIONS.map((provider) => ({
              value: provider.id,
              label: provider.browserSupported
                ? provider.name
                : `${provider.name}（当前浏览器不可用）`,
            }))}
          />
        </label>

        {selectedProviderDef?.hint && (
          <div className="provider-hint">{selectedProviderDef.hint}</div>
        )}

        {selectedProviderDef?.fields.map((field) => renderProviderField(field))}

        <SettingSegmented
          label="上下文策略"
          value={settingsDraft.modelContextStrategy}
          onValueChange={(value) =>
            setSettingsDraft((current) => ({
              ...current,
              modelContextStrategy: value as BrowserAppSettings['modelContextStrategy'],
            }))
          }
          options={[
            { value: 'last-user-turn', label: '上一轮' },
            { value: 'last-five-user-turns', label: '前五轮' },
            { value: 'full-history', label: '无限制' },
          ]}
        />

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
      </section>
    </div>
  );
}
