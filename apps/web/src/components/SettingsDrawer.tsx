import React from 'react';
import type { BridgeLogEntry, BridgeManagerStatus } from '@dg-agent/bridge';
import type { WaveformDefinition } from '@dg-agent/core';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from '@dg-agent/runtime';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import type { ModelLogTurn } from '../services/model-log-store.js';
import {
  ArrowLeft,
  Bluetooth,
  Bot,
  Database,
  FileSearch,
  LayoutTemplate,
  Logs,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Volume2,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GeneralTab } from './settings/GeneralTab.js';
import { SafetyTab } from './settings/SafetyTab.js';
import { BridgeTab } from './settings/BridgeTab.js';
import { BridgeLogsTab, ModelLogsTab } from './settings/LogsTab.js';
import { VoiceTab } from './settings/VoiceTab.js';
import { DataTab, type ExportableSession } from './settings/DataTab.js';
import { DevicesTab } from './settings/DevicesTab.js';
import { PresetSelector } from './PresetSelector.js';
import { WaveformsPanel } from './WaveformsPanel.js';

export type SettingsModalTab =
  | 'general'
  | 'preset'
  | 'safety'
  | 'waveforms'
  | 'devices'
  | 'bridge'
  | 'voice'
  | 'data'
  | 'bridge-logs'
  | 'model-tool-logs';

export const SETTINGS_NAV_ITEMS: Array<{
  value: SettingsModalTab;
  label: string;
  description: string;
  icon: LucideIcon;
  sections: Record<string, string>;
}> = [
  {
    value: 'general',
    label: '基础',
    description: '主题、上下文和模型供应商',
    icon: Settings2,
    sections: {
      基本设置: '调整界面主题和会话上下文策略。',
      模型选择: '选择模型供应商，并配置该供应商需要的参数。',
    },
  },
  {
    value: 'preset',
    label: '场景',
    description: '内置场景和自定义场景',
    icon: LayoutTemplate,
    sections: {
      内置场景: '选择内置互动风格。',
      自定义场景: '管理你自己的场景预设。',
    },
  },
  {
    value: 'safety',
    label: '安全',
    description: '强度上限、权限和离开保护',
    icon: ShieldCheck,
    sections: {
      最大强度上限: '限制每个通道允许输出的最高强度。',
      工具调用确认模式: '决定 AI 控制设备前需要怎样确认。',
      后台行为: '设置切换后台和启动安全确认行为。',
    },
  },
  {
    value: 'waveforms',
    label: '波形',
    description: '内置波形和自定义波形库',
    icon: Waves,
    sections: {},
  },
  {
    value: 'devices',
    label: '扩展设备',
    description: '负鼠、爪印、灵猫的独立蓝牙连接',
    icon: Bluetooth,
    sections: {
      扩展设备:
        '独立连接或断开负鼠振动控制器、爪印传感器、灵猫传感器，互不影响，也不影响郊狼连接。',
    },
  },
  {
    value: 'bridge',
    label: 'Bot',
    description: 'QQ、Telegram 和远程控制',
    icon: Bot,
    sections: {
      桥接: '配置远程消息入口和允许访问的用户。',
    },
  },
  {
    value: 'voice',
    label: '语音',
    description: '语音识别和语音合成配置',
    icon: Volume2,
    sections: {
      语音: '配置语音识别、语音合成和相关后端。',
    },
  },
  {
    value: 'data',
    label: '数据',
    description: '聊天记录导入与导出',
    icon: Database,
    sections: {},
  },
  {
    value: 'model-tool-logs',
    label: '模型日志',
    description: '永久保存的 LLM 请求与响应记录',
    icon: FileSearch,
    sections: {},
  },
  {
    value: 'bridge-logs',
    label: '桥接日志',
    description: 'QQ / Telegram 桥接状态和运行日志',
    icon: Logs,
    sections: {},
  },
];

export const SETTINGS_NAV_GROUPS: Array<{
  label: string;
  values: SettingsModalTab[];
}> = [
  { label: '配置', values: ['general', 'preset', 'safety', 'waveforms'] },
  { label: '扩展', values: ['devices', 'bridge', 'voice', 'data'] },
  { label: '日志', values: ['model-tool-logs', 'bridge-logs'] },
];

export interface SettingsDrawerProps {
  tab: SettingsModalTab;
  onTabChange: (tab: SettingsModalTab) => void;
  mobileNavOpen: boolean;
  onMobileNavOpenChange: (open: boolean) => void;
  onClose: () => void;
  onRequestReset: () => void;
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: React.Dispatch<React.SetStateAction<BrowserAppSettings>>;
  onDeleteSavedPromptPreset: (id: string) => void;
  waveforms: WaveformDefinition[];
  customWaveforms: WaveformDefinition[];
  onImportWaveforms: (files: FileList | null) => void;
  onImportWaveformFromMarket: (waveform: WaveformDefinition) => void | Promise<void>;
  onRemoveWaveform: (id: string) => void;
  onEditWaveform: (waveform: WaveformDefinition) => void;
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
  sensorTriggersEnabled: boolean;
  onToggleSensorTriggers: (enabled: boolean) => void;
  bridgeLogs: BridgeLogEntry[];
  bridgeStatus: BridgeManagerStatus | null;
  modelLogTurns: ModelLogTurn[];
  onClearModelLogs: () => void;
  settings: BrowserAppSettings;
  exportableSessions: ExportableSession[];
  onExportSessions: (sessionIds: string[]) => void;
  onImportSessions: (file: File) => void;
}

function SettingsTabContent({
  tab,
  settingsDraft,
  setSettingsDraft,
  onDeleteSavedPromptPreset,
  waveforms,
  customWaveforms,
  onImportWaveforms,
  onImportWaveformFromMarket,
  onRemoveWaveform,
  onEditWaveform,
  opossum,
  pawPrints,
  civetEdging,
  sensorTriggersEnabled,
  onToggleSensorTriggers,
  bridgeLogs,
  bridgeStatus,
  modelLogTurns,
  onClearModelLogs,
  settings,
  exportableSessions,
  onExportSessions,
  onImportSessions,
}: Omit<
  SettingsDrawerProps,
  'mobileNavOpen' | 'onMobileNavOpenChange' | 'onClose' | 'onRequestReset' | 'onTabChange'
>) {
  switch (tab) {
    case 'general':
      return <GeneralTab settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} />;
    case 'preset':
      return (
        <PresetSelector
          settingsDraft={settingsDraft}
          setSettingsDraft={setSettingsDraft}
          onDeleteSavedPromptPreset={onDeleteSavedPromptPreset}
        />
      );
    case 'safety':
      return <SafetyTab settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} />;
    case 'waveforms':
      return (
        <WaveformsPanel
          waveforms={waveforms}
          customWaveforms={customWaveforms}
          onImport={(files) => onImportWaveforms(files)}
          onImportFromMarket={onImportWaveformFromMarket}
          onRemove={(id) => onRemoveWaveform(id)}
          onEdit={onEditWaveform}
        />
      );
    case 'devices':
      return (
        <DevicesTab
          opossum={opossum}
          pawPrints={pawPrints}
          civetEdging={civetEdging}
          sensorTriggersEnabled={sensorTriggersEnabled}
          onToggleSensorTriggers={onToggleSensorTriggers}
        />
      );
    case 'bridge':
      return <BridgeTab settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} />;
    case 'voice':
      return <VoiceTab settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} />;
    case 'data':
      return (
        <DataTab
          sessions={exportableSessions}
          onExport={onExportSessions}
          onImport={onImportSessions}
        />
      );
    case 'bridge-logs':
      return (
        <BridgeLogsTab bridgeLogs={bridgeLogs} bridgeStatus={bridgeStatus} settings={settings} />
      );
    case 'model-tool-logs':
      return (
        <ModelLogsTab
          settingsDraft={settingsDraft}
          setSettingsDraft={setSettingsDraft}
          turns={modelLogTurns}
          onClear={onClearModelLogs}
        />
      );
    default:
      return null;
  }
}

export function SettingsSidebar({
  tab,
  onTabChange,
  onMobileNavOpenChange,
  onClose,
  onRequestReset,
}: Pick<
  SettingsDrawerProps,
  'tab' | 'onTabChange' | 'onMobileNavOpenChange' | 'onClose' | 'onRequestReset'
>) {
  return (
    <aside className="settings-sidebar">
      <button type="button" className="settings-sidebar-back" onClick={onClose}>
        <ArrowLeft className="h-4 w-4" />
        <span>返回聊天</span>
      </button>

      <nav className="settings-sidebar-nav" aria-label="设置分类">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <div className="settings-nav-group-label">{group.label}</div>
            {group.values.map((value) => {
              const item = SETTINGS_NAV_ITEMS.find((entry) => entry.value === value)!;
              const active = item.value === tab;
              const Icon = item.icon;
              return (
                <button
                  key={item.value}
                  type="button"
                  className={active ? 'settings-nav-item active' : 'settings-nav-item'}
                  onClick={() => {
                    onTabChange(item.value);
                    onMobileNavOpenChange(false);
                  }}
                >
                  <Icon className="settings-nav-icon" />
                  <span className="sidebar-icon-label">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="settings-sidebar-footer">
        <Button variant="ghost" className="settings-sidebar-reset" onClick={onRequestReset}>
          <RotateCcw className="h-4 w-4 shrink-0" />
          <span className="sidebar-icon-label">恢复默认</span>
        </Button>
        <Button variant="ghost" className="settings-sidebar-reset" asChild>
          <a
            href="https://github.com/0xNullAI/DG-Agent"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="项目主页"
          >
            <GitHubMark className="h-4 w-4 shrink-0" />
            <span className="sidebar-icon-label">项目主页</span>
          </a>
        </Button>
      </div>
    </aside>
  );
}

// GitHub 官方 mark — lucide-react 已移除 Github 图标，这里手写一个 SVG
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.73-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18a10.92 10.92 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.8.56C20.22 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export function SettingsWorkspace(props: SettingsDrawerProps) {
  const { tab, onTabChange, mobileNavOpen, onMobileNavOpenChange, onClose, onRequestReset } = props;

  const currentItem =
    SETTINGS_NAV_ITEMS.find((item) => item.value === tab) ?? SETTINGS_NAV_ITEMS[0]!;

  return (
    <section
      className={
        mobileNavOpen ? 'settings-workspace settings-mobile-nav-open' : 'settings-workspace'
      }
    >
      <section className="settings-mobile-directory lg:hidden">
        <header className="settings-mobile-directory-header">
          <button type="button" onClick={onClose} aria-label="返回聊天">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2>设置</h2>
          <button type="button" onClick={onClose} aria-label="关闭设置">
            <X className="h-4 w-4" />
          </button>
        </header>
        <nav className="settings-mobile-directory-list" aria-label="设置分类">
          {SETTINGS_NAV_GROUPS.map((group) => (
            <div key={group.label} className="settings-mobile-directory-group">
              <div className="settings-mobile-directory-group-label">{group.label}</div>
              {group.values.map((value) => {
                const item = SETTINGS_NAV_ITEMS.find((entry) => entry.value === value)!;
                const Icon = item.icon;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => {
                      onTabChange(item.value);
                      onMobileNavOpenChange(false);
                    }}
                  >
                    <Icon className="settings-mobile-directory-icon" />
                    <span className="sidebar-icon-label">{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="settings-mobile-directory-footer">
          <button type="button" onClick={onRequestReset}>
            <RotateCcw className="h-4 w-4" />
            <span className="sidebar-icon-label">恢复默认</span>
          </button>
          <a
            href="https://github.com/0xNullAI/DG-Agent"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="项目主页"
          >
            <GitHubMark className="h-4 w-4" />
            <span className="sidebar-icon-label">项目主页</span>
          </a>
        </div>
      </section>

      <header className="settings-mobile-header lg:hidden">
        <button
          type="button"
          className="settings-mobile-back"
          onClick={() => onMobileNavOpenChange(true)}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span>{currentItem.label}</span>
        <button
          type="button"
          className="settings-mobile-back"
          onClick={onClose}
          aria-label="关闭设置"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <main className="settings-workspace-main">
        <header className="settings-workspace-title">
          <h2>{currentItem.label}</h2>
          <p>{currentItem.description}</p>
        </header>

        <div className="settings-workspace-content">
          <div className="settings settings-grouped settings-panel-body">
            <SettingsTabContent {...props} />
          </div>
        </div>
      </main>
    </section>
  );
}
