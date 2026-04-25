import type { BridgeLogEntry, BridgeManagerStatus } from '@dg-agent/bridge';
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

interface LlmLogEntry {
  label: string;
  requestJson?: unknown;
  responseJson?: unknown;
  detail?: string;
}

function formatLlmTurnStartEntry(event: RuntimeEvent & { type: 'llm-turn-start' }): LlmLogEntry {
  const tools = event.toolNames.length > 0 ? event.toolNames.join(', ') : '（无）';
  return {
    label: `▶ LLM 请求  iteration=${event.iteration}  消息×${event.messages.length}  工具：${tools}`,
    requestJson: {
      iteration: event.iteration,
      instructions: event.instructions,
      messages: event.messages,
      toolNames: event.toolNames,
    },
  };
}

function formatLlmTurnCompleteEntry(
  event: RuntimeEvent & { type: 'llm-turn-complete' },
): LlmLogEntry {
  return {
    label: `◀ LLM 响应  iteration=${event.iteration}  工具×${event.toolCalls.length}`,
    requestJson: event.rawRequest,
    responseJson: event.rawResponse ?? {
      assistantMessage: event.assistantMessage,
      toolCalls: event.toolCalls,
    },
  };
}

function formatEvent(event: RuntimeEvent): { label: string; detail?: string } | null {
  switch (event.type) {
    case 'llm-turn-start':
    case 'llm-turn-complete':
      return null; // handled separately as LlmLogEntry

    case 'device-command-executed': {
      const cmd = event.command;
      let summary: string = cmd.type;
      if (cmd.type === 'start')
        summary = `start ${cmd.channel} 强度=${cmd.strength} 波形=${cmd.waveform.id}`;
      else if (cmd.type === 'stop') summary = `stop ${cmd.channel ?? '全部'}`;
      else if (cmd.type === 'adjustStrength')
        summary = `adjust ${cmd.channel} delta=${cmd.delta > 0 ? '+' : ''}${cmd.delta}`;
      else if (cmd.type === 'changeWave')
        summary = `changeWave ${cmd.channel} → ${cmd.waveform.id}`;
      else if (cmd.type === 'burst')
        summary = `burst ${cmd.channel} 强度=${cmd.strength} ${cmd.durationMs}ms`;
      else if (cmd.type === 'emergencyStop') summary = 'emergencyStop';
      const state = event.result.state;
      const detail = `A=${state.strengthA}/${state.limitA}  B=${state.strengthB}/${state.limitB}`;
      return { label: `🔧 ${summary}`, detail };
    }

    case 'tool-call-denied':
      return { label: `⛔ 拒绝：${event.toolCall.name}`, detail: event.reason };

    case 'tool-call-failed':
      return { label: `❌ 失败：${event.toolCall.name}`, detail: event.error };

    case 'timer-scheduled':
      return {
        label: `⏰ 定时：${event.label}（${Math.round((event.dueAt - Date.now()) / 1000)}s 后）`,
      };

    case 'timer-fired':
      return { label: `⏰ 触发：${event.label}` };

    case 'runtime-warning':
      return { label: `⚠️ 警告`, detail: event.message };

    case 'user-message-accepted':
      return { label: `👤 用户消息`, detail: event.message.content.slice(0, 100) };

    case 'assistant-message-completed':
      return {
        label: `✅ 回复完成`,
        detail: event.message.content.slice(0, 100) || '（工具执行）',
      };

    case 'assistant-message-aborted':
      return { label: `🛑 回复中止`, detail: event.reason };

    default:
      return null;
  }
}

function CollapsibleJson({ label, data }: { label: string; data: unknown }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer select-none text-[11px] text-[var(--text-faint)] hover:text-[var(--text-soft)]">
        {label}
      </summary>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-[6px] bg-[var(--bg-soft)] p-2 text-[10px] leading-relaxed text-[var(--text-soft)]">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

export function ModelToolLogsTab({ events }: LogsTabProps) {
  const visibleEvents = [...events].reverse().filter((e) => {
    return (
      e.type !== 'assistant-message-delta' &&
      e.type !== 'device-state-changed' &&
      e.type !== 'session-updated'
    );
  });

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">模型日志</h3>

        <div className="settings-log-list">
          {visibleEvents.length === 0 && (
            <div className="settings-log-empty">还没有模型或工具调用日志</div>
          )}
          {visibleEvents.map((event, index) => {
            if (event.type === 'llm-turn-start') {
              const entry = formatLlmTurnStartEntry(event);
              return (
                <div key={index} className="settings-log-entry flex flex-col gap-0.5">
                  <span className="font-medium">{entry.label}</span>
                  {entry.requestJson !== undefined && (
                    <CollapsibleJson label="请求内容" data={entry.requestJson} />
                  )}
                </div>
              );
            }
            if (event.type === 'llm-turn-complete') {
              const entry = formatLlmTurnCompleteEntry(event);
              return (
                <div key={index} className="settings-log-entry flex flex-col gap-0.5">
                  <span className="font-medium">{entry.label}</span>
                  {entry.requestJson !== undefined && (
                    <CollapsibleJson label="HTTP 请求" data={entry.requestJson} />
                  )}
                  {entry.responseJson !== undefined && (
                    <CollapsibleJson label="HTTP 响应" data={entry.responseJson} />
                  )}
                </div>
              );
            }
            const formatted = formatEvent(event);
            if (!formatted) return null;
            return (
              <div key={index} className="settings-log-entry flex flex-col gap-0.5">
                <span className="font-medium">{formatted.label}</span>
                {formatted.detail && (
                  <pre className="whitespace-pre-wrap text-[var(--text-faint)] text-[11px] leading-relaxed">
                    {formatted.detail}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
