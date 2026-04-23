import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { MessageCircle, Send, type LucideIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { parseCommaSeparated } from '../../utils/ui-formatters.js';
import { SettingLabel } from './SettingLabel.js';
import { SettingSelect } from './SettingSelect.js';

type BridgeConnector = 'qq' | 'telegram';

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

  /* eslint-disable react-hooks/set-state-in-effect -- sync local text fields with external draft */
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
  /* eslint-enable react-hooks/set-state-in-effect */

  function setQqEnabled(enabled: boolean): void {
    setSettingsDraft((current) => {
      const qq = { ...current.bridge.qq, enabled };
      const bridge = {
        ...current.bridge,
        qq,
        enabled: qq.enabled || current.bridge.telegram.enabled,
      };
      return { ...current, bridge };
    });
  }

  function setTelegramEnabled(enabled: boolean): void {
    setSettingsDraft((current) => {
      const telegram = { ...current.bridge.telegram, enabled };
      const bridge = {
        ...current.bridge,
        telegram,
        enabled: current.bridge.qq.enabled || telegram.enabled,
      };
      return { ...current, bridge };
    });
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">桥接入口</h3>

        <div className="bridge-connector-list">
          <BridgeConnectorRow
            icon={MessageCircle}
            title="QQ / NapCat"
            description="通过 OneBot WebSocket 接收和回复 QQ 消息"
            enabled={settingsDraft.bridge.qq.enabled}
            onToggle={() => setQqEnabled(!settingsDraft.bridge.qq.enabled)}
          />
          <BridgeConnectorRow
            icon={Send}
            title="Telegram"
            description="通过 Telegram Bot 接收和回复消息"
            enabled={settingsDraft.bridge.telegram.enabled}
            onToggle={() => setTelegramEnabled(!settingsDraft.bridge.telegram.enabled)}
          />
        </div>
      </section>

      {settingsDraft.bridge.qq.enabled && (
        <section className="settings-row-card bridge-config-card">
          <h3 className="settings-card-legend">QQ / NapCat 配置</h3>
          <div className="bridge-config-grid">
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

            <label className="settings-inline-field">
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
          </div>
        </section>
      )}

      {settingsDraft.bridge.telegram.enabled && (
        <section className="settings-row-card bridge-config-card">
          <h3 className="settings-card-legend">Telegram 配置</h3>
          <div className="bridge-config-grid">
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

            <label className="settings-inline-field">
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
          </div>
        </section>
      )}
    </div>
  );
}

function BridgeConnectorRow({
  icon: Icon,
  title,
  description,
  enabled,
  onToggle,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={cn('bridge-connector-row', enabled && 'enabled')}
      onClick={onToggle}
    >
      <span className="bridge-connector-main">
        <span className="bridge-connector-icon">
          <Icon className="h-4 w-4" />
        </span>
        <span className="bridge-connector-copy">
          <span>{title}</span>
          <small>{description}</small>
        </span>
      </span>
      <span className={cn('bridge-connector-status', enabled && 'enabled')}>
        {enabled ? '已启用' : '未启用'}
      </span>
    </button>
  );
}
