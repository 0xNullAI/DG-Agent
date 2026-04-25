import type { BridgeLogEntry, BridgeManagerStatus } from '@dg-agent/bridge';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestamp } from '../utils/ui-formatters.js';

interface BridgePanelProps {
  enabled: boolean;
  bridgeStatus: BridgeManagerStatus | null;
  bridgeLogs: BridgeLogEntry[];
}

export function BridgePanel({ enabled, bridgeStatus, bridgeLogs }: BridgePanelProps) {
  return (
    <Card>
      <CardHeader className="px-4 pb-3">
        <CardTitle>桥接状态</CardTitle>
        <CardDescription>查看 QQ / Telegram 桥接是否启动、是否连接，以及最近日志</CardDescription>
      </CardHeader>

      <CardContent className="px-4 pt-0">
        <div className="flex flex-wrap gap-2">
          <Badge variant={!enabled ? 'default' : bridgeStatus?.started ? 'success' : 'warning'}>
            {!enabled
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

        <div className="mt-4 flex flex-col gap-3">
          {bridgeLogs.length === 0 && (
            <div className="text-sm text-[var(--text-soft)]">还没有桥接日志</div>
          )}
          {bridgeLogs.map((entry, index) => (
            <pre
              key={`${entry.timestamp}-${index}`}
              className="m-0 whitespace-pre-wrap break-all rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-5 py-4 text-sm leading-6 text-[var(--text-soft)]"
            >
              [{formatTimestamp(entry.timestamp)}] {entry.level.toUpperCase()} {entry.text}
            </pre>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
