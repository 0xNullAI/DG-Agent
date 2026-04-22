import type { CSSProperties, Dispatch, SetStateAction } from 'react';

import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { cn } from '@/lib/utils';
import { SettingToggle } from './SettingToggle.js';
import styles from './SafetyTab.module.css';

interface SafetyTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const STRENGTH_MIN = 0;
const STRENGTH_MAX = 200;
const STRENGTH_STEP = 5;

function getStrengthTone(value: number): 'normal' | 'warning' | 'danger' {
  if (value > 150) return 'danger';
  if (value > 100) return 'warning';
  return 'normal';
}

function getStrengthStatus(value: number): string {
  if (value > 150) return '危险强度';
  if (value > 100) return '高强度';
  return '常规';
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
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">最大强度上限</h3>
        <div className={styles.strengthControlList}>
          <StrengthControl channel="A" value={settingsDraft.maxStrengthA} onChange={setStrengthA} />
          <StrengthControl channel="B" value={settingsDraft.maxStrengthB} onChange={setStrengthB} />
        </div>
      </section>

      <section className="settings-row-card">
        <h3 className="settings-card-legend">工具调用确认模式</h3>
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
                <div
                  className={cn(
                    'text-[13px] font-semibold',
                    active ? 'text-[var(--accent)]' : 'text-[var(--text)]',
                  )}
                >
                  {opt.label}
                </div>
                <div
                  className={cn(
                    'mt-0.5 text-[11px]',
                    opt.warn ? 'text-[var(--danger)]' : 'text-[var(--text-faint)]',
                  )}
                >
                  {opt.desc}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-row-card">
        <h3 className="settings-card-legend">后台行为</h3>
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
      </section>
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
  const tone = getStrengthTone(value);
  const inputId = `max-strength-${channel.toLowerCase()}`;
  const strengthStyle = {
    '--strength-value': `${(clamp(value, STRENGTH_MIN, STRENGTH_MAX) / STRENGTH_MAX) * 100}%`,
  } as CSSProperties;

  return (
    <div className={styles.strengthControl} data-tone={tone}>
      <div className={styles.strengthControlHeader}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={styles.strengthControlChannel}>{channel} 通道</span>
          <span className={styles.strengthControlStatus}>{getStrengthStatus(value)}</span>
        </div>

        <input
          id={inputId}
          type="number"
          min={STRENGTH_MIN}
          max={STRENGTH_MAX}
          step={STRENGTH_STEP}
          value={value}
          aria-label={`${channel} 通道最大强度`}
          onChange={(event) => onChange(Number(event.target.value) || 0)}
          className={styles.strengthValueInput}
        />
      </div>

      <input
        type="range"
        min={STRENGTH_MIN}
        max={STRENGTH_MAX}
        step={STRENGTH_STEP}
        value={value}
        aria-label={`${channel} 通道最大强度滑条`}
        onChange={(event) => onChange(Number(event.target.value))}
        className={styles.strengthSlider}
        style={strengthStyle}
      />

      <div className={styles.strengthControlScale} aria-hidden="true">
        <span>0</span>
        <span className="-mr-[10px]">100</span>
        <span>200</span>
      </div>
    </div>
  );
}
