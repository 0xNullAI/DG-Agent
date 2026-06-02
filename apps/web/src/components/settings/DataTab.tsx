import { useRef } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface DataTabProps {
  sessionCount: number;
  onExport: () => void;
  onImport: (file: File) => void;
}

export function DataTab({ sessionCount, onExport, onImport }: DataTabProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">聊天记录</h3>
        <p className="text-[13px] leading-relaxed text-[var(--text-soft)]">
          导入 / 导出全部会话，采用 OpenTelemetry GenAI 语义约定的 JSON
          格式，可用于备份或迁移到其他设备。导入时
          <span className="text-[var(--text)]">同 id 的会话会被覆盖</span>。
        </p>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onExport} disabled={sessionCount === 0}>
            <Download className="h-4 w-4" />
            导出全部（{sessionCount}）
          </Button>
          <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4" />
            导入 JSON
          </Button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            // 允许再次选择同一个文件
            e.target.value = '';
          }}
        />
      </section>
    </div>
  );
}
