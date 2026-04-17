import type { BridgeLogEntry, BridgeManagerStatus } from '@dg-agent/bridge-core';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatTimestamp } from '../utils/ui-formatters.js';

interface BridgePanelProps {
  enabled: boolean;
  bridgeStatus: BridgeManagerStatus | null;
  bridgeLogs: BridgeLogEntry[];
}

export function BridgePanel({ enabled, bridgeStatus, bridgeLogs }: BridgePanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>桥接状态</CardTitle>
        <CardDescription>查看 Telegram / QQ 桥接连接状态与最近日志。</CardDescription>
      </CardHeader>

      <CardContent className="pt-0">
        <div className="flex flex-wrap gap-2">
          {(bridgeStatus?.adapters ?? []).map((adapter) => (
            <Badge key={adapter.platform} variant={adapter.connected ? 'success' : 'default'}>
              {adapter.platform}：{adapter.connected ? '已连接' : '未连接'}
            </Badge>
          ))}
          {!enabled && <Badge variant="default">桥接功能未启用</Badge>}
        </div>

        <ScrollArea className="mt-4 max-h-72 pr-1">
          <div className="flex flex-col gap-3">
            {bridgeLogs.length === 0 && <div className="text-sm text-[var(--text-soft)]">还没有桥接日志。</div>}
            {bridgeLogs.map((entry, index) => (
              <pre
                key={`${entry.timestamp}-${index}`}
                className="m-0 rounded-xl border border-[var(--surface-border)] bg-[var(--bg-strong)] p-4 text-sm leading-6 text-[var(--text-soft)]"
              >
                [{formatTimestamp(entry.timestamp)}] {entry.level.toUpperCase()} {entry.text}
              </pre>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
