import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { parseCommaSeparated } from '../../utils/ui-formatters.js';
import { SettingLabel } from './SettingLabel.js';
import { SettingSelect } from './SettingSelect.js';

function formatCommaSeparatedInput(values: string[]): string {
  return values.join(', ');
}

interface BridgeTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
}

export function BridgeTab({ settingsDraft, setSettingsDraft }: BridgeTabProps) {
  const [qqAllowUsersInput, setQqAllowUsersInput] = useState(() =>
    formatCommaSeparatedInput(settingsDraft.bridge.qq.allowUsers),
  );
  const [qqAllowGroupsInput, setQqAllowGroupsInput] = useState(() =>
    formatCommaSeparatedInput(settingsDraft.bridge.qq.allowGroups),
  );
  const [telegramAllowUsersInput, setTelegramAllowUsersInput] = useState(() =>
    formatCommaSeparatedInput(settingsDraft.bridge.telegram.allowUsers),
  );

  useEffect(() => {
    const formatted = formatCommaSeparatedInput(settingsDraft.bridge.qq.allowUsers);
    const normalizedLocal = formatCommaSeparatedInput(parseCommaSeparated(qqAllowUsersInput));
    if (formatted !== normalizedLocal) {
      setQqAllowUsersInput(formatted);
    }
  }, [qqAllowUsersInput, settingsDraft.bridge.qq.allowUsers]);

  useEffect(() => {
    const formatted = formatCommaSeparatedInput(settingsDraft.bridge.qq.allowGroups);
    const normalizedLocal = formatCommaSeparatedInput(parseCommaSeparated(qqAllowGroupsInput));
    if (formatted !== normalizedLocal) {
      setQqAllowGroupsInput(formatted);
    }
  }, [qqAllowGroupsInput, settingsDraft.bridge.qq.allowGroups]);

  useEffect(() => {
    const formatted = formatCommaSeparatedInput(settingsDraft.bridge.telegram.allowUsers);
    const normalizedLocal = formatCommaSeparatedInput(parseCommaSeparated(telegramAllowUsersInput));
    if (formatted !== normalizedLocal) {
      setTelegramAllowUsersInput(formatted);
    }
  }, [settingsDraft.bridge.telegram.allowUsers, telegramAllowUsersInput]);

  return (
    <div className="settings-panel-tab-content">
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
          <SettingLabel>启用软件桥接</SettingLabel>
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
              <SettingLabel>启用 QQ Napcat 桥接</SettingLabel>
            </label>

            {settingsDraft.bridge.qq.enabled && (
              <>
                <label>
                  <SettingLabel>Napcat WebSocket Server 地址</SettingLabel>
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
                    placeholder="Napcat Websocket Server 的地址"
                  />
                </label>

                <label>
                  <SettingLabel>NapCat WebSocket Token</SettingLabel>
                  <Input
                    type="password"
                    value={settingsDraft.bridge.qq.accessToken}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        bridge: {
                          ...current.bridge,
                          qq: {
                            ...current.bridge.qq,
                            accessToken: event.target.value,
                          },
                        },
                      }))
                    }
                    placeholder="Napcat Websocket Server 设置的 Token"
                  />
                </label>

                <label>
                  <SettingLabel>允许的 QQ 用户</SettingLabel>
                  <Input
                    value={qqAllowUsersInput}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setQqAllowUsersInput(nextValue);
                      setSettingsDraft((current) => ({
                        ...current,
                        bridge: {
                          ...current.bridge,
                          qq: {
                            ...current.bridge.qq,
                            allowUsers: parseCommaSeparated(nextValue),
                          },
                        },
                      }));
                    }}
                    placeholder="12345678, 23456789（逗号分隔）"
                  />
                </label>

                <label>
                  <SettingLabel>允许的 QQ 群组</SettingLabel>
                  <Input
                    value={qqAllowGroupsInput}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setQqAllowGroupsInput(nextValue);
                      setSettingsDraft((current) => ({
                        ...current,
                        bridge: {
                          ...current.bridge,
                          qq: {
                            ...current.bridge.qq,
                            allowGroups: parseCommaSeparated(nextValue),
                          },
                        },
                      }));
                    }}
                    placeholder="123456789, 234567890（逗号分隔）"
                  />
                </label>

                <label>
                  <SettingLabel>权限模式</SettingLabel>
                  <SettingSelect
                    value={settingsDraft.bridge.qq.permissionMode}
                    onValueChange={(value) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        bridge: {
                          ...current.bridge,
                          qq: {
                            ...current.bridge.qq,
                            permissionMode:
                              value as BrowserAppSettings['bridge']['qq']['permissionMode'],
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

            <Separator className="my-1.5" />

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
              <SettingLabel>启用 Telegram 桥接</SettingLabel>
            </label>

            {settingsDraft.bridge.telegram.enabled && (
              <>
                <label>
                  <SettingLabel>Telegram 机器人 Token</SettingLabel>
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
                  <SettingLabel>Telegram 代理地址</SettingLabel>
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
                  <SettingLabel>Telegram 允许用户</SettingLabel>
                  <Input
                    value={telegramAllowUsersInput}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setTelegramAllowUsersInput(nextValue);
                      setSettingsDraft((current) => ({
                        ...current,
                        bridge: {
                          ...current.bridge,
                          telegram: {
                            ...current.bridge.telegram,
                            allowUsers: parseCommaSeparated(nextValue),
                          },
                        },
                      }));
                    }}
                    placeholder="123456789"
                  />
                </label>

                <label>
                  <SettingLabel>Telegram 权限模式</SettingLabel>
                  <SettingSelect
                    value={settingsDraft.bridge.telegram.permissionMode}
                    onValueChange={(value) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        bridge: {
                          ...current.bridge,
                          telegram: {
                            ...current.bridge.telegram,
                            permissionMode:
                              value as BrowserAppSettings['bridge']['telegram']['permissionMode'],
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
    </div>
  );
}
