import type { BridgeManagerStatus } from '@dg-agent/bridge-core';
import type { DeviceState } from '@dg-agent/core';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import type { BrowserSpeechCapabilities } from '@dg-agent/audio-browser';
import type { AgentClient } from '@dg-agent/client';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { describeBrowserModes } from '../composition/create-browser-agent-client.js';

interface RuntimeStatusPanelProps {
  client: AgentClient;
  modes: ReturnType<typeof describeBrowserModes>;
  settings: BrowserAppSettings;
  bridgeStatus: BridgeManagerStatus | null;
  activeSessionId: string | null;
  deviceState: DeviceState;
  voiceMode: boolean;
  voiceState: string;
  speechCapabilities: BrowserSpeechCapabilities;
}

export function RuntimeStatusPanel({
  client,
  modes,
  settings,
  bridgeStatus,
  activeSessionId,
  deviceState,
  voiceMode,
  voiceState,
  speechCapabilities,
}: RuntimeStatusPanelProps) {
  const deviceLines = [
    `设备名称：${deviceState.deviceName || '—'}`,
    `设备模式：${modes.deviceMode}`,
    `Web Bluetooth：${modes.bluetoothAvailability.supported ? '可用' : '不可用'}`,
    `A / B 强度上限：${settings.maxStrengthA} / ${settings.maxStrengthB}`,
    `A 通道：${deviceState.strengthA} / ${deviceState.currentWaveA ?? '未运行'}`,
    `B 通道：${deviceState.strengthB} / ${deviceState.currentWaveB ?? '未运行'}`,
    !modes.bluetoothAvailability.supported ? `不可用原因：${modes.bluetoothAvailability.reason ?? '—'}` : null,
  ].filter(Boolean) as string[];

  const modelLines = [
    `传输方式：${client.transport}`,
    `模型模式：${modes.llmMode}`,
    `服务提供方：${modes.providerId}`,
    `权限模式：${modes.permissionMode}`,
    `当前模式：${settings.promptPresetId}`,
    `当前会话：${activeSessionId ?? '—'}`,
  ];

  const voiceLines = [
    `语音输入：${settings.voiceInputEnabled ? '开启' : '关闭'}`,
    `TTS 播报：${settings.ttsEnabled ? '开启' : '关闭'}`,
    `语音后端：${settings.voice.mode}`,
    `语音识别：${speechCapabilities.recognitionSupported ? '可用' : '不可用'}`,
    `语音播报：${speechCapabilities.synthesisSupported ? '可用' : '不可用'}`,
    `当前语音状态：${voiceMode ? voiceState : '关闭'}`,
  ];

  const bridgeLines = [
    `社交桥接：${settings.bridge.enabled ? '已开启' : '已关闭'}`,
    `桥接运行中：${bridgeStatus?.started ? '是' : '否'}`,
    `桥接队列：${bridgeStatus?.pendingMessages ?? 0}`,
    `背景行为：${settings.backgroundBehavior}`,
    `离开页面自动停止：${settings.safetyStopOnLeave ? '开启' : '关闭'}`,
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>运行概览</CardTitle>
        <CardDescription>把设备、模型、语音和桥接分开看，避免所有东西都堆在设备下面。</CardDescription>
      </CardHeader>

      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--bg-strong)] p-4">
            <div className="text-sm text-[var(--text-faint)]">连接状态</div>
            <div className="mt-1 text-lg font-semibold">{deviceState.connected ? '已连接' : '未连接'}</div>
          </div>
          <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--bg-strong)] p-4">
            <div className="text-sm text-[var(--text-faint)]">电量</div>
            <div className="mt-1 text-lg font-semibold">{deviceState.battery ?? 0}%</div>
          </div>
          <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--bg-strong)] p-4">
            <div className="text-sm text-[var(--text-faint)]">语音模式</div>
            <div className="mt-1 text-lg font-semibold">{voiceMode ? voiceState : '关闭'}</div>
          </div>
          <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--bg-strong)] p-4">
            <div className="text-sm text-[var(--text-faint)]">桥接队列</div>
            <div className="mt-1 text-lg font-semibold">{bridgeStatus?.pendingMessages ?? 0}</div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Badge variant={deviceState.connected ? 'success' : 'default'}>{deviceState.connected ? '设备在线' : '设备离线'}</Badge>
          <Badge variant={settings.bridge.enabled ? 'accent' : 'default'}>{settings.bridge.enabled ? '桥接已开启' : '桥接未开启'}</Badge>
          <Badge variant={speechCapabilities.recognitionSupported ? 'success' : 'warning'}>
            {speechCapabilities.recognitionSupported ? '语音识别可用' : '语音识别不可用'}
          </Badge>
        </div>

        <div className="mt-4 grid gap-4">
          {[
            { title: 'DGLAB 设备', lines: deviceLines },
            { title: '模型与会话', lines: modelLines },
            { title: '语音', lines: voiceLines },
            { title: '桥接与安全', lines: bridgeLines },
          ].map((section) => (
            <section key={section.title} className="rounded-xl border border-[var(--surface-border)] bg-[var(--bg-strong)] p-4">
              <div className="text-sm font-semibold text-[var(--text)]">{section.title}</div>
              <ul className="mt-3 grid gap-2">
                {section.lines.map((line) => (
                  <li key={line} className="text-sm leading-6 text-[var(--text-soft)]">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
