import type { RuntimeEvent } from '@dg-agent/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface EventsPanelProps {
  events: RuntimeEvent[];
}

export function EventsPanel({ events }: EventsPanelProps) {
  return (
    <Card>
      <CardHeader className="px-4 pb-3">
        <CardTitle>最近事件</CardTitle>
        <CardDescription>用于排查工具调用、设备状态变化和系统提示</CardDescription>
      </CardHeader>

      <CardContent className="px-4 pt-0">
        <div className="flex flex-col gap-3">
          {events.length === 0 && (
            <div className="text-sm text-[var(--text-soft)]">还没有事件记录</div>
          )}
          {events.map((event, index) => (
            <pre
              key={`${event.type}-${index}`}
              className="m-0 whitespace-pre-wrap break-all rounded-xl border border-[var(--surface-border)] bg-[var(--bg-strong)] px-5 py-4 text-sm leading-6 text-[var(--text-soft)]"
            >
              {JSON.stringify(event, null, 2)}
            </pre>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
