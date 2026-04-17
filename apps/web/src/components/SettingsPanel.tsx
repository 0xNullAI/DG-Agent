import { useState, type Dispatch, type SetStateAction } from 'react';
import { PROXY_TTS_SPEAKERS } from '@dg-agent/audio-browser';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { BUILTIN_PROMPT_PRESETS } from '@dg-agent/prompts-basic';
import {
  PROVIDER_DEFINITIONS,
  createProviderSettings,
  getProviderDefinition,
  normalizeProviderSettings,
  type ProviderFieldDefinition,
  type ProviderId,
} from '@dg-agent/providers-catalog';
import { clampStrengthSetting, parseCommaSeparated } from '../utils/ui-formatters.js';

interface SettingsPanelProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
  onSaveCurrentPromptPreset: () => void;
  onLoadSavedPromptPreset: (presetId: string) => void;
  onDeleteSavedPromptPreset: (presetId: string) => void;
  onResetSettings: () => void;
}

interface SelectOption {
  value: string;
  label: string;
}

function SettingSelect({
  value,
  onValueChange,
  options,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SettingsPanel({
  settingsDraft,
  setSettingsDraft,
  onSaveCurrentPromptPreset,
  onLoadSavedPromptPreset,
  onDeleteSavedPromptPreset,
  onResetSettings,
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<'general' | 'model' | 'safety' | 'bridge' | 'voice'>('general');
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
      const nextProvider = normalizeProviderSettings(providerConfigs[providerId] ?? createProviderSettings(providerId));

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

  function updateVoiceSettings<K extends keyof BrowserAppSettings['voice']>(
    key: K,
    value: BrowserAppSettings['voice'][K],
  ): void {
    setSettingsDraft((current) => ({
      ...current,
      voice: {
        ...current.voice,
        [key]: value,
      },
    }));
  }

  function renderProviderField(field: ProviderFieldDefinition) {
    const fieldId = `provider-${field.key}`;

    if (field.type === 'select') {
      if (field.key !== 'endpoint' && field.key !== 'useStrict') {
        return null;
      }

      const value = field.key === 'useStrict' ? String(settingsDraft.provider.useStrict) : settingsDraft.provider[field.key];

      return (
        <label key={field.key} htmlFor={fieldId}>
          <span>{field.label}</span>
          <SettingSelect
            value={value}
            onValueChange={(nextValue) => {
              if (field.key === 'endpoint') {
                updateProviderField('endpoint', nextValue as BrowserAppSettings['provider']['endpoint']);
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
    <article className="panel">
      <div className="panel-header">
        <h2>设置</h2>
      </div>

      <div className="settings settings-grouped">
        <Tabs value={settingsTab} onValueChange={(value) => setSettingsTab(value as typeof settingsTab)} className="control-tabs-shell px-5 pt-4">
          <TabsList className="control-tabs grid w-full grid-cols-2 gap-0 md:grid-cols-5">
            <TabsTrigger className="control-tab-trigger" value="general">常规</TabsTrigger>
            <TabsTrigger className="control-tab-trigger" value="model">模型</TabsTrigger>
            <TabsTrigger className="control-tab-trigger" value="safety">安全</TabsTrigger>
            <TabsTrigger className="control-tab-trigger" value="bridge">桥接</TabsTrigger>
            <TabsTrigger className="control-tab-trigger" value="voice">语音</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-4">
        <section className="settings-group">
          <h3 className="settings-group-title">基础</h3>

          <label>
            <span>主题</span>
            <SettingSelect
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
          </label>

          <label>
            <span>设备来源</span>
            <SettingSelect
              value={settingsDraft.deviceMode}
              onValueChange={(value) =>
                setSettingsDraft((current) => ({
                  ...current,
                  deviceMode: value as BrowserAppSettings['deviceMode'],
                }))
              }
              options={[
                { value: 'web-bluetooth', label: '浏览器蓝牙' },
              ]}
            />
          </label>

          <label>
            <span>模型来源</span>
            <SettingSelect
              value={settingsDraft.llmMode}
              onValueChange={(value) =>
                setSettingsDraft((current) => ({
                  ...current,
                  llmMode: value as BrowserAppSettings['llmMode'],
                }))
              }
              options={[
                { value: 'provider-http', label: '服务提供方 HTTP' },
              ]}
            />
          </label>
        </section>

        <section className="settings-group mt-6">
          <h3 className="settings-group-title">模式与提示词</h3>

          <label>
            <span>模式</span>
            <SettingSelect
              value={settingsDraft.promptPresetId}
              onValueChange={(value) =>
                setSettingsDraft((current) => ({
                  ...current,
                  promptPresetId: value,
                }))
              }
              options={[
                ...BUILTIN_PROMPT_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
                ...settingsDraft.savedPromptPresets.map((preset) => ({ value: preset.id, label: `${preset.name}（已保存）` })),
              ]}
            />
          </label>

          <label>
            <span>自定义提示词</span>
            <Textarea
              value={settingsDraft.customPrompt}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  customPrompt: event.target.value,
                }))
              }
              rows={5}
              placeholder="可选：在当前模式提示词上额外叠加你的自定义要求。"
            />
          </label>

          <div className="settings-actions">
            <Button variant="secondary" onClick={onSaveCurrentPromptPreset}>
              保存提示词
            </Button>
          </div>

          {settingsDraft.savedPromptPresets.length > 0 && (
            <div className="saved-prompt-list">
              {settingsDraft.savedPromptPresets.map((preset) => (
                <div key={preset.id} className="saved-prompt-item">
                  <Button variant="ghost" className="saved-prompt-name" onClick={() => onLoadSavedPromptPreset(preset.id)}>
                    {preset.name}
                  </Button>
                  <Button variant="ghost" className="saved-prompt-delete" onClick={() => onDeleteSavedPromptPreset(preset.id)}>
                    删除
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
          </TabsContent>

          <TabsContent value="model" className="mt-4">
        <section className="settings-group">
          <h3 className="settings-group-title">模型服务</h3>

          <label>
            <span>服务提供方</span>
            <SettingSelect
              value={settingsDraft.provider.providerId}
              onValueChange={(value) => switchProvider(value as ProviderId)}
              options={PROVIDER_DEFINITIONS.map((provider) => ({
                value: provider.id,
                label: provider.browserSupported ? provider.name : `${provider.name}（当前浏览器不可用）`,
              }))}
            />
          </label>

          {selectedProviderDef?.hint && <div className="provider-hint">{selectedProviderDef.hint}</div>}

          {selectedProviderDef?.fields.map((field) => renderProviderField(field))}

          <label className="checkbox-row">
            <Checkbox
              checked={settingsDraft.rememberApiKey}
              onCheckedChange={(checked) =>
                setSettingsDraft((current) => ({
                  ...current,
                  rememberApiKey: Boolean(checked),
                }))
              }
            />
            <span>在当前设备记住 API 密钥</span>
          </label>
        </section>
          </TabsContent>

          <TabsContent value="safety" className="mt-4">
        <section className="settings-group">
          <h3 className="settings-group-title">安全</h3>

          <label>
            <span>权限策略</span>
            <SettingSelect
              value={settingsDraft.permissionMode}
              onValueChange={(value) =>
                setSettingsDraft((current) => ({
                  ...current,
                  permissionMode: value as BrowserAppSettings['permissionMode'],
                }))
              }
              options={[
                { value: 'confirm', label: '每次都确认' },
                { value: 'timed', label: '确认一次后放行 5 分钟' },
                { value: 'allow-all', label: '全部放行' },
              ]}
            />
          </label>

          <label>
            <span>A 通道强度上限</span>
            <Input
              type="number"
              min={0}
              max={200}
              value={settingsDraft.maxStrengthA}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  maxStrengthA: clampStrengthSetting(event.target.value),
                }))
              }
            />
          </label>

          <label>
            <span>B 通道强度上限</span>
            <Input
              type="number"
              min={0}
              max={200}
              value={settingsDraft.maxStrengthB}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  maxStrengthB: clampStrengthSetting(event.target.value),
                }))
              }
            />
          </label>

          <label className="checkbox-row">
            <Checkbox
              checked={settingsDraft.safetyStopOnLeave}
              onCheckedChange={(checked) =>
                setSettingsDraft((current) => ({
                  ...current,
                  safetyStopOnLeave: Boolean(checked),
                }))
              }
            />
            <span>离开页面时自动停止设备输出</span>
          </label>

          <label className="checkbox-row">
            <Checkbox
              checked={settingsDraft.showSafetyNoticeOnStartup}
              onCheckedChange={(checked) =>
                setSettingsDraft((current) => ({
                  ...current,
                  showSafetyNoticeOnStartup: Boolean(checked),
                }))
              }
            />
            <span>启动时显示安全确认</span>
          </label>

          <label>
            <span>后台行为</span>
            <SettingSelect
              value={settingsDraft.backgroundBehavior}
              onValueChange={(value) =>
                setSettingsDraft((current) => ({
                  ...current,
                  backgroundBehavior: value as BrowserAppSettings['backgroundBehavior'],
                }))
              }
              options={[
                { value: 'stop', label: '切到后台时停止输出' },
                { value: 'keep', label: '切到后台后继续运行' },
              ]}
            />
          </label>
        </section>
          </TabsContent>

          <TabsContent value="bridge" className="mt-4">
        <section className="settings-group">
          <h3 className="settings-group-title">桥接</h3>

          <label className="checkbox-row">
            <Checkbox
              checked={settingsDraft.bridge.enabled}
              onCheckedChange={(checked) =>
                setSettingsDraft((current) => ({
                  ...current,
                  bridge: {
                    ...current.bridge,
                    enabled: Boolean(checked),
                  },
                }))
              }
            />
            <span>启用社交桥接</span>
          </label>

          {settingsDraft.bridge.enabled && (
            <div className="bridge-settings">
              <label className="checkbox-row">
                <Checkbox
                  checked={settingsDraft.bridge.qq.enabled}
                  onCheckedChange={(checked) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      bridge: {
                        ...current.bridge,
                        qq: {
                          ...current.bridge.qq,
                          enabled: Boolean(checked),
                        },
                      },
                    }))
                  }
                />
                <span>启用 QQ 桥接</span>
              </label>

              {settingsDraft.bridge.qq.enabled && (
                <>
                  <label>
                    <span>QQ WebSocket 地址</span>
                    <Input
                      value={settingsDraft.bridge.qq.wsUrl}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          bridge: {
                            ...current.bridge,
                            qq: {
                              ...current.bridge.qq,
                              wsUrl: event.target.value,
                            },
                          },
                        }))
                      }
                    />
                  </label>

                  <label>
                    <span>QQ 允许用户</span>
                    <Input
                      value={settingsDraft.bridge.qq.allowUsers.join(', ')}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          bridge: {
                            ...current.bridge,
                            qq: {
                              ...current.bridge.qq,
                              allowUsers: parseCommaSeparated(event.target.value),
                            },
                          },
                        }))
                      }
                      placeholder="12345678, 23456789"
                    />
                  </label>

                  <label>
                    <span>QQ 允许群组</span>
                    <Input
                      value={settingsDraft.bridge.qq.allowGroups.join(', ')}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          bridge: {
                            ...current.bridge,
                            qq: {
                              ...current.bridge.qq,
                              allowGroups: parseCommaSeparated(event.target.value),
                            },
                          },
                        }))
                      }
                      placeholder="123456789"
                    />
                  </label>

                  <label>
                    <span>QQ 权限模式</span>
                    <SettingSelect
                      value={settingsDraft.bridge.qq.permissionMode}
                      onValueChange={(value) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          bridge: {
                            ...current.bridge,
                            qq: {
                              ...current.bridge.qq,
                              permissionMode: value as BrowserAppSettings['bridge']['qq']['permissionMode'],
                            },
                          },
                        }))
                      }
                      options={[
                        { value: 'confirm', label: '远程确认' },
                        { value: 'allow-all', label: '全部放行' },
                      ]}
                    />
                  </label>
                </>
              )}

              <label className="checkbox-row">
                <Checkbox
                  checked={settingsDraft.bridge.telegram.enabled}
                  onCheckedChange={(checked) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      bridge: {
                        ...current.bridge,
                        telegram: {
                          ...current.bridge.telegram,
                          enabled: Boolean(checked),
                        },
                      },
                    }))
                  }
                />
                <span>启用 Telegram 桥接</span>
              </label>

              {settingsDraft.bridge.telegram.enabled && (
                <>
                  <label>
                    <span>Telegram 机器人 Token</span>
                    <Input
                      type="password"
                      value={settingsDraft.bridge.telegram.botToken}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          bridge: {
                            ...current.bridge,
                            telegram: {
                              ...current.bridge.telegram,
                              botToken: event.target.value,
                            },
                          },
                        }))
                      }
                    />
                  </label>

                  <label>
                    <span>Telegram 代理地址</span>
                    <Input
                      value={settingsDraft.bridge.telegram.proxyUrl}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          bridge: {
                            ...current.bridge,
                            telegram: {
                              ...current.bridge.telegram,
                              proxyUrl: event.target.value,
                            },
                          },
                        }))
                      }
                      placeholder="https://你的代理地址.example.com"
                    />
                  </label>

                  <label>
                    <span>Telegram 允许用户</span>
                    <Input
                      value={settingsDraft.bridge.telegram.allowUsers.join(', ')}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          bridge: {
                            ...current.bridge,
                            telegram: {
                              ...current.bridge.telegram,
                              allowUsers: parseCommaSeparated(event.target.value),
                            },
                          },
                        }))
                      }
                      placeholder="123456789"
                    />
                  </label>

                  <label>
                    <span>Telegram 权限模式</span>
                    <SettingSelect
                      value={settingsDraft.bridge.telegram.permissionMode}
                      onValueChange={(value) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          bridge: {
                            ...current.bridge,
                            telegram: {
                              ...current.bridge.telegram,
                              permissionMode: value as BrowserAppSettings['bridge']['telegram']['permissionMode'],
                            },
                          },
                        }))
                      }
                      options={[
                        { value: 'confirm', label: '远程确认' },
                        { value: 'allow-all', label: '全部放行' },
                      ]}
                    />
                  </label>
                </>
              )}
            </div>
          )}
        </section>

          </TabsContent>

          <TabsContent value="voice" className="mt-4">
        <section className="settings-group">
          <h3 className="settings-group-title">语音</h3>

          <label className="checkbox-row">
            <Checkbox
              checked={settingsDraft.voiceInputEnabled}
              onCheckedChange={(checked) =>
                setSettingsDraft((current) => ({
                  ...current,
                  voiceInputEnabled: Boolean(checked),
                }))
              }
            />
            <span>启用语音输入</span>
          </label>

          <label className="checkbox-row">
            <Checkbox
              checked={settingsDraft.ttsEnabled}
              onCheckedChange={(checked) =>
                setSettingsDraft((current) => ({
                  ...current,
                  ttsEnabled: Boolean(checked),
                }))
              }
            />
            <span>朗读 AI 回复</span>
          </label>

          <label>
            <span>语音后端</span>
            <SettingSelect
              value={settingsDraft.voice.mode}
              onValueChange={(value) => updateVoiceSettings('mode', value as BrowserAppSettings['voice']['mode'])}
              options={[
                { value: 'browser', label: '浏览器原生' },
                { value: 'dashscope-proxy', label: 'DashScope 代理' },
              ]}
            />
          </label>

          {settingsDraft.voice.mode === 'dashscope-proxy' && (
            <div className="provider-hint">
              兼容旧版语音链路：浏览器采集麦克风，经过 WebSocket 代理进行 ASR/TTS。留空代理地址时使用内置免费代理。
            </div>
          )}

          <label>
            <span>语音语言</span>
            <Input
              value={settingsDraft.voiceLanguage}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  voiceLanguage: event.target.value,
                }))
              }
              placeholder="zh-CN"
            />
          </label>

          {settingsDraft.voice.mode === 'dashscope-proxy' && (
            <>
              <label>
                <span>语音 API 密钥</span>
                <Input
                  type="password"
                  value={settingsDraft.voice.apiKey}
                  onChange={(event) => updateVoiceSettings('apiKey', event.target.value)}
                  placeholder="sk-...（留空使用免费共享额度）"
                />
              </label>

              <label>
                <span>语音代理地址</span>
                <Input
                  value={settingsDraft.voice.proxyUrl}
                  onChange={(event) => updateVoiceSettings('proxyUrl', event.target.value)}
                  placeholder="留空使用默认免费代理"
                />
              </label>

              <label>
                <span>语音发音人</span>
                <SettingSelect
                  value={settingsDraft.voice.speaker}
                  onValueChange={(value) => updateVoiceSettings('speaker', value)}
                  options={PROXY_TTS_SPEAKERS.map((speaker) => ({
                    value: speaker.id,
                    label: speaker.label,
                  }))}
                />
              </label>

              <label className="checkbox-row">
                <Checkbox
                  checked={settingsDraft.voice.autoStopEnabled}
                  onCheckedChange={(checked) => updateVoiceSettings('autoStopEnabled', Boolean(checked))}
                />
                <span>静音后自动停止收音</span>
              </label>
            </>
          )}
        </section>
          </TabsContent>
        </Tabs>

        <div className="settings-actions settings-actions-footer">
          <div className="text-sm text-[var(--text-faint)]">设置会自动保存到当前浏览器。</div>
          <Button variant="secondary" onClick={onResetSettings}>
            恢复默认
          </Button>
        </div>
      </div>
    </article>
  );
}
