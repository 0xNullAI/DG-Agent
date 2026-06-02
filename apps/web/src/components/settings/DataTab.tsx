import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatTimestamp } from '../../utils/ui-formatters.js';

export interface ExportableSession {
  id: string;
  title: string;
  updatedAt: number;
}

export interface DataTabProps {
  sessions: ExportableSession[];
  onExport: (sessionIds: string[]) => void;
  onImport: (file: File) => void;
}

export function DataTab({ sessions, onExport, onImport }: DataTabProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Default to everything selected; falls back gracefully if the list changes.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(sessions.map((s) => s.id)));

  const selectableIds = sessions.map((s) => s.id);
  const selectedCount = selectableIds.filter((id) => selected.has(id)).length;
  const allSelected = sessions.length > 0 && selectedCount === sessions.length;

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">聊天记录</h3>
        <p className="text-[13px] leading-relaxed text-[var(--text-soft)]">
          勾选要导出的会话，导出为 zip 压缩包（每个会话一个 JSON 文件，采用 OpenTelemetry GenAI
          语义约定）。导入支持 zip 或单个 JSON，
          <span className="text-[var(--text)]">同 id 的会话会被覆盖</span>。
        </p>

        {sessions.length === 0 ? (
          <div className="settings-log-empty">暂无会话</div>
        ) : (
          <>
            <label className="flex cursor-pointer items-center gap-2.5 border-b border-[var(--surface-border)] pb-2 text-[13px] text-[var(--text-soft)]">
              <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
              <span>
                全选（已选 {selectedCount} / {sessions.length}）
              </span>
            </label>

            <div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
              {sessions.map((session) => (
                <label
                  key={session.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-1.5 py-2 transition-colors hover:bg-[var(--bg-soft)]"
                >
                  <Checkbox
                    checked={selected.has(session.id)}
                    onCheckedChange={() => toggle(session.id)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
                    {session.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--text-faint)]">
                    {formatTimestamp(session.updatedAt)}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onExport(selectableIds.filter((id) => selected.has(id)))}
            disabled={selectedCount === 0}
          >
            <Download className="h-4 w-4" />
            导出所选（{selectedCount}）
          </Button>
          <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4" />
            导入
          </Button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip,application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            e.target.value = '';
          }}
        />
      </section>
    </div>
  );
}
