import type { WaveformDefinition } from '@dg-agent/core';
import { Pencil, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionDivider } from './settings/SectionDivider.js';

interface WaveformsPanelProps {
  waveforms: WaveformDefinition[];
  customWaveforms: WaveformDefinition[];
  onImport: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  onEdit: (waveform: WaveformDefinition) => void;
}

export function WaveformsPanel({
  waveforms,
  customWaveforms,
  onImport,
  onRemove,
  onEdit,
}: WaveformsPanelProps) {
  return (
    <div className="space-y-4">
      <SectionDivider label="波形库" />

      {waveforms.length === 0 && (
        <div className="py-4 text-center text-sm text-[var(--text-faint)]">
          还没有可用波形，点击下方按钮导入
        </div>
      )}

      <div className="space-y-1.5">
        {waveforms.map((waveform) => {
          const isCustom = customWaveforms.some((c) => c.id === waveform.id);
          return (
            <div key={waveform.id} className="group flex items-center gap-1">
              <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[10px] px-3 py-2.5">
                <span className="shrink-0 text-lg">{isCustom ? '📝' : '〰️'}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-[var(--text)]">{waveform.name}</div>
                  <div className="mt-0.5 truncate text-[12px] text-[var(--text-faint)]">
                    {waveform.id} · {waveform.frames.length} 帧
                  </div>
                </div>
              </div>
              {isCustom && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--text)]"
                  onClick={() => onEdit(waveform)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                onClick={() => onRemove(waveform.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </div>

      <label className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed border-[var(--surface-border)] px-4 py-2.5 text-sm text-[var(--text-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
        <Upload className="h-4 w-4" />
        导入波形文件
        <input
          type="file"
          accept=".pulse,.zip"
          multiple
          className="hidden"
          onChange={(event) => onImport(event.target.files)}
        />
      </label>
    </div>
  );
}
