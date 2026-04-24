import type { BridgeLogEntry, BridgeManagerStatus } from '@dg-agent/bridge-core';
import type { RuntimeEvent } from '@dg-agent/core';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { Badge } from '@/components/ui/badge';
import { formatTimestamp } from '../../utils/ui-formatters.js';

interface LogsTabProps {
  bridgeLogs: BridgeLogEntry[];
  bridgeStatus: BridgeManagerStatus | null;
  events: RuntimeEvent[];
  settings: BrowserAppSettings;
}

export function BridgeLogsTab({ bridgeLogs, bridgeStatus, settings }: LogsTabProps) {
  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">桥接日志</h3>

        <div className="settings-log-badges">
          <Badge
            variant={
              !settings.bridge.enabled ? 'default' : bridgeStatus?.started ? 'success' : 'warning'
            }
          >
            {!settings.bridge.enabled
              ? '桥接未启用'
              : bridgeStatus?.started
                ? '桥接管理器已启动'
                : '桥接管理器已停止'}
          </Badge>
          {(bridgeStatus?.adapters ?? []).map((adapter) => (
            <Badge key={adapter.platform} variant={adapter.connected ? 'success' : 'default'}>
              {adapter.platform}：{adapter.connected ? '已连接' : '未连接'}
            </Badge>
          ))}
        </div>

        <div className="settings-log-list">
          {bridgeLogs.length === 0 && <div className="settings-log-empty">还没有桥接日志</div>}
          {bridgeLogs.map((entry, index) => (
            <pre key={`${entry.timestamp}-${index}`} className="settings-log-entry">
              [{formatTimestamp(entry.timestamp)}] {entry.level.toUpperCase()} {entry.text}
            </pre>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ModelToolLogsTab({ events }: LogsTabProps) {
  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">模型日志</h3>

        <div className="settings-log-list">
          {events.length === 0 && (
            <div className="settings-log-empty">还没有模型或工具调用日志</div>
          )}
          {events.map((event, index) => (
            <pre key={`${event.type}-${index}`} className="settings-log-entry">
              {JSON.stringify(event, null, 2)}
            </pre>
          ))}
        </div>
      </section>
    </div>
  );
}
