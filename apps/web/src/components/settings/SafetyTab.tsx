import { useEffect, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';

import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { SettingLabel } from './SettingLabel.js';
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
const TOOL_LIMIT_MIN = 1;
const TOOL_LIMIT_MAX = 20;
const COLD_START_MIN = 0;
const COLD_START_MAX = 200;
const ADJUST_STEP_MIN = 1;
const ADJUST_STEP_MAX = 200;
const BURST_DURATION_MIN = 100;
const BURST_DURATION_MAX = 20_000;

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
      maxStrengthA: clamp(value, STRENGTH_MIN, STRENGTH_MAX),
    }));
  }

  function setStrengthB(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxStrengthB: clamp(value, STRENGTH_MIN, STRENGTH_MAX),
    }));
  }

  function setToolLimit(
    key:
      | 'maxToolIterations'
      | 'maxToolCallsPerTurn'
      | 'maxAdjustStrengthCallsPerTurn'
      | 'maxBurstCallsPerTurn',
    value: number,
  ) {
    setSettingsDraft((current) => ({
      ...current,
      [key]: clamp(value, TOOL_LIMIT_MIN, TOOL_LIMIT_MAX),
    }));
  }

  function setColdStartStrength(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxColdStartStrength: clamp(value, COLD_START_MIN, COLD_START_MAX),
    }));
  }

  function setAdjustStrengthStep(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxAdjustStrengthStep: clamp(value, ADJUST_STEP_MIN, ADJUST_STEP_MAX),
    }));
  }

  function setBurstDurationMs(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxBurstDurationMs: clamp(value, BURST_DURATION_MIN, BURST_DURATION_MAX),
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

      <section className="settings-row-card">
        <h3 className="settings-card-legend">工具调用安全限制</h3>
        <label htmlFor="max-tool-iterations" className="settings-inline-field">
          <SettingLabel>单轮对话交互轮数上限</SettingLabel>
          <ToolLimitField
            id="max-tool-iterations"
            value={settingsDraft.maxToolIterations}
            onChange={(value) => setToolLimit('maxToolIterations', value)}
          />
        </label>

        <label htmlFor="max-tool-calls-per-turn" className="settings-inline-field">
          <SettingLabel>单轮工具调用次数上限</SettingLabel>
          <ToolLimitField
            id="max-tool-calls-per-turn"
            value={settingsDraft.maxToolCallsPerTurn}
            onChange={(value) => setToolLimit('maxToolCallsPerTurn', value)}
          />
        </label>

        <label htmlFor="max-adjust-strength-calls-per-turn" className="settings-inline-field">
          <SettingLabel>单轮强度调整次数上限</SettingLabel>
          <ToolLimitField
            id="max-adjust-strength-calls-per-turn"
            value={settingsDraft.maxAdjustStrengthCallsPerTurn}
            onChange={(value) => setToolLimit('maxAdjustStrengthCallsPerTurn', value)}
          />
        </label>

        <label htmlFor="max-cold-start-strength" className="settings-inline-field">
          <SettingLabel>单次冷启动强度上限</SettingLabel>
          <ConfigNumberField
            id="max-cold-start-strength"
            value={settingsDraft.maxColdStartStrength}
            min={COLD_START_MIN}
            max={COLD_START_MAX}
            onChange={setColdStartStrength}
          />
        </label>

        <label htmlFor="max-adjust-strength-step" className="settings-inline-field">
          <SettingLabel>单次强度调整幅度上限</SettingLabel>
          <ConfigNumberField
            id="max-adjust-strength-step"
            value={settingsDraft.maxAdjustStrengthStep}
            min={ADJUST_STEP_MIN}
            max={ADJUST_STEP_MAX}
            onChange={setAdjustStrengthStep}
          />
        </label>

        <label htmlFor="max-burst-calls-per-turn" className="settings-inline-field">
          <SettingLabel>单轮突增次数上限</SettingLabel>
          <ToolLimitField
            id="max-burst-calls-per-turn"
            value={settingsDraft.maxBurstCallsPerTurn}
            onChange={(value) => setToolLimit('maxBurstCallsPerTurn', value)}
          />
        </label>

        <label htmlFor="max-burst-duration-ms" className="settings-inline-field">
          <SettingLabel>单次突增时长上限（ms）</SettingLabel>
          <ConfigNumberField
            id="max-burst-duration-ms"
            value={settingsDraft.maxBurstDurationMs}
            min={BURST_DURATION_MIN}
            max={BURST_DURATION_MAX}
            onChange={setBurstDurationMs}
          />
        </label>

        <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3">
          <SettingLabel>突增前必须先启动通道</SettingLabel>
          <SettingToggle
            label=""
            checked={settingsDraft.burstRequiresActiveChannel}
            onCheckedChange={(checked) =>
              setSettingsDraft((current) => ({
                ...current,
                burstRequiresActiveChannel: checked,
              }))
            }
          />
        </div>
      </section>
    </div>
  );
}

function ToolLimitField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <ConfigNumberField
      id={id}
      value={value}
      min={TOOL_LIMIT_MIN}
      max={TOOL_LIMIT_MAX}
      onChange={onChange}
    />
  );
}

function ConfigNumberField({
  id,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(() => String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  function commit(nextDraftValue: string) {
    const digitsOnly = nextDraftValue.replace(/\D+/g, '');
    const nextValue = digitsOnly ? clamp(Number(digitsOnly), min, max) : min;

    setDraftValue(String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={draftValue}
      onChange={(event) => {
        setDraftValue(event.target.value.replace(/\D+/g, ''));
      }}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setDraftValue(String(value));
          event.currentTarget.blur();
        }
      }}
      className="text-right tabular-nums"
    />
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
        aria-label={`${channel} 通道最大强度滑杆`}
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
