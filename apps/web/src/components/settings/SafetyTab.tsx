import type { Dispatch, SetStateAction } from 'react';
import { Minus, Plus } from 'lucide-react';

import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { cn } from '@/lib/utils';
import { SectionDivider } from './SectionDivider.js';
import { SettingToggle } from './SettingToggle.js';

interface SafetyTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function SafetyTab({ settingsDraft, setSettingsDraft }: SafetyTabProps) {
  function setStrengthA(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxStrengthA: clamp(value, 0, 200),
    }));
  }

  function setStrengthB(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxStrengthB: clamp(value, 0, 200),
    }));
  }

  const permissionOptions: Array<{
    value: BrowserAppSettings['permissionMode'];
    label: string;
    desc: string;
    warn?: boolean;
  }> = [
    { value: 'confirm', label: '每次询问', desc: '推荐，最安全' },
    { value: 'timed', label: '5 分钟内免询问', desc: '到期自动恢复询问' },
    { value: 'allow-all', label: '全部允许', desc: '高风险，不再弹窗', warn: true },
  ];

  return (
    <div className="settings-panel-tab-content space-y-5">
      <SectionDivider label="最大强度上限" />

      <div className="grid grid-cols-2 gap-3">
        <StrengthControl channel="A" value={settingsDraft.maxStrengthA} onChange={setStrengthA} />
        <StrengthControl channel="B" value={settingsDraft.maxStrengthB} onChange={setStrengthB} />
      </div>

      <SectionDivider label="工具调用确认模式" />

      <div className="grid grid-cols-3 gap-2">
        {permissionOptions.map((opt) => {
          const active = settingsDraft.permissionMode === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              className={cn(
                'rounded-[10px] border px-3 py-3 text-left transition-colors',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--surface-border)] bg-[var(--bg-strong)] hover:border-[var(--text-faint)]',
              )}
              onClick={() =>
                setSettingsDraft((current) => ({ ...current, permissionMode: opt.value }))
              }
            >
              <div className={cn('text-[13px] font-semibold', active ? 'text-[var(--accent)]' : 'text-[var(--text)]')}>
                {opt.label}
              </div>
              <div className={cn('mt-0.5 text-[11px]', opt.warn ? 'text-[var(--danger)]' : 'text-[var(--text-faint)]')}>
                {opt.desc}
              </div>
            </button>
          );
        })}
      </div>

      <SectionDivider label="后台行为" />

      <div className="space-y-3">
        <SettingToggle
          label="切到后台时停止输出"
          checked={settingsDraft.backgroundBehavior === 'stop'}
          onCheckedChange={(checked) =>
            setSettingsDraft((current) => ({
              ...current,
              backgroundBehavior: checked ? 'stop' : 'keep',
            }))
          }
        />

        <SettingToggle
          label="启动时显示安全确认"
          checked={settingsDraft.showSafetyNoticeOnStartup}
          onCheckedChange={(checked) =>
            setSettingsDraft((current) => ({
              ...current,
              showSafetyNoticeOnStartup: checked,
            }))
          }
        />
      </div>
    </div>
  );
}

function StrengthControl({
  channel,
  value,
  onChange,
}: {
  channel: 'A' | 'B';
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-[12px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-[var(--accent)] text-sm font-bold text-[var(--accent)]">
        {channel}
      </span>
      <div className="flex flex-1 items-center justify-end gap-0">
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-l-[8px] bg-[var(--bg-elevated)] text-[var(--text-soft)] transition-colors hover:text-[var(--text)]"
          onClick={() => onChange(value - 5)}
        >
          <Minus className="h-4 w-4" />
        </button>
        <input
          type="number"
          min={0}
          max={200}
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          className="h-8 w-12 bg-[var(--bg-elevated)] text-center text-sm font-bold tabular-nums text-[var(--text)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-r-[8px] bg-[var(--bg-elevated)] text-[var(--text-soft)] transition-colors hover:text-[var(--text)]"
          onClick={() => onChange(value + 5)}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
