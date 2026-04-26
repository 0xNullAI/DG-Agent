import type { BridgeLogEntry, BridgeManagerStatus } from '@dg-agent/bridge';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import type { ModelLogTurn } from '../../services/model-log-store.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatTimestamp } from '../../utils/ui-formatters.js';
import { SettingToggle } from './SettingToggle.js';

interface BridgeLogsTabProps {
  bridgeLogs: BridgeLogEntry[];
  bridgeStatus: BridgeManagerStatus | null;
  settings: BrowserAppSettings;
}

export function BridgeLogsTab({ bridgeLogs, bridgeStatus, settings }: BridgeLogsTabProps) {
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

function CollapsibleJson({
  label,
  data,
  defaultOpen = false,
}: {
  label: string;
  data: unknown;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="rounded-[8px] border border-[var(--surface-border)] bg-[var(--bg-soft)]"
      open={defaultOpen}
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-[var(--text-soft)] hover:text-[var(--text)]">
        {label}
      </summary>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-[var(--surface-border)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-soft)]">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function formatTurnDuration(turn: ModelLogTurn): string {
  if (turn.completedAt === undefined) return '进行中…';
  const ms = turn.completedAt - turn.startedAt;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

interface ModelLogsTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: React.Dispatch<React.SetStateAction<BrowserAppSettings>>;
  turns: ModelLogTurn[];
  onClear: () => void;
}

export function ModelLogsTab({
  settingsDraft,
  setSettingsDraft,
  turns,
  onClear,
}: ModelLogsTabProps) {
  const enabled = settingsDraft.modelLogEnabled;
  const sortedTurns = [...turns].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <div className="flex items-center justify-between gap-3">
          <h3 className="settings-card-legend !mb-0">模型日志</h3>
          <Button variant="secondary" size="sm" onClick={onClear} disabled={turns.length === 0}>
            清空日志（{turns.length}）
          </Button>
        </div>

        <SettingToggle
          checked={enabled}
          onCheckedChange={(checked) =>
            setSettingsDraft((current) => ({ ...current, modelLogEnabled: checked }))
          }
          label="记录模型日志"
          description="开启后，所有 LLM 请求和响应都会永久保存到本地，直到手动清空。关闭只是停止收集，已有记录会保留。"
        />

        {!enabled && turns.length === 0 && (
          <div className="settings-log-empty">请先开启「记录模型日志」开关</div>
        )}

        {enabled && turns.length === 0 && (
          <div className="settings-log-empty">
            还没有模型调用记录。下次和 AI 对话时，本回合的 LLM 请求和响应会出现在这里。
          </div>
        )}

        {turns.length > 0 && (
          <div className="flex flex-col gap-3">
            {sortedTurns.map((turn) => (
              <div
                key={turn.id}
                className="rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-3"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-soft)]">
                  <span className="font-medium text-[var(--text)]">
                    会话 {turn.sessionId.slice(-8)} · iteration {turn.iteration}
                  </span>
                  <span className="text-[var(--text-faint)]">
                    {formatTimestamp(turn.startedAt)}
                  </span>
                  <span className="text-[var(--text-faint)]">用时 {formatTurnDuration(turn)}</span>
                  {turn.response && turn.response.toolCalls.length > 0 && (
                    <Badge variant="default">工具 × {turn.response.toolCalls.length}</Badge>
                  )}
                  {turn.completedAt === undefined && <Badge variant="warning">未完成</Badge>}
                </div>

                <div className="mt-2 flex flex-col gap-2">
                  {turn.request && (
                    <CollapsibleJson label="📤 请求 (request)" data={turn.request} />
                  )}
                  {turn.response && (
                    <CollapsibleJson label="📥 响应 (response)" data={turn.response} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
