import type { WaveformDefinition } from '@dg-agent/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface WaveformsPanelProps {
  waveforms: WaveformDefinition[];
  customWaveforms: WaveformDefinition[];
  onImport: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  onEdit: (waveform: WaveformDefinition) => void;
}

export function WaveformsPanel({ waveforms, customWaveforms, onImport, onRemove, onEdit }: WaveformsPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>波形库</CardTitle>
            <CardDescription>导入 `.pulse` / `.zip`，并管理你的自定义波形。</CardDescription>
          </div>
          <Badge variant="default">
            共 {waveforms.length} 个 / 自定义 {customWaveforms.length} 个
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <label className="mb-4 flex flex-col gap-2 text-sm font-medium text-[var(--text)]">
          <span>导入文件</span>
          <input
            className="block w-full rounded-md border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm text-[var(--text-soft)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--accent-soft)] file:px-3 file:py-2 file:text-sm file:font-medium file:text-[var(--accent)]"
            type="file"
            accept=".pulse,.zip"
            multiple
            onChange={(event) => onImport(event.target.files)}
          />
        </label>

        <div className="flex flex-col gap-3">
          {waveforms.length === 0 && <div className="text-sm text-[var(--text-soft)]">还没有可用波形。</div>}
          {waveforms.map((waveform) => {
            const isCustom = customWaveforms.some((item) => item.id === waveform.id);
            return (
              <div
                key={waveform.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-[var(--surface-border)] bg-[var(--bg-strong)] p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-[var(--text)]">{waveform.name}</div>
                  <div className="mt-1 text-sm text-[var(--text-soft)]">
                    {waveform.id} · {waveform.frames.length} 帧
                  </div>
                </div>

                {isCustom ? (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(waveform)}>
                      编辑
                    </Button>
                    <Button variant="ghost" size="sm" className="text-[var(--danger)] hover:text-[var(--danger)]" onClick={() => onRemove(waveform.id)}>
                      删除
                    </Button>
                  </div>
                ) : (
                  <Badge variant="default">内置</Badge>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
