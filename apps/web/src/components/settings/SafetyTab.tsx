import React, { useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

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
const STRENGTH_STEP = 1;
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

  function setOpossumIntensityA(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxOpossumIntensityA: clamp(value, STRENGTH_MIN, STRENGTH_MAX),
    }));
  }

  function setOpossumIntensityB(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxOpossumIntensityB: clamp(value, STRENGTH_MIN, STRENGTH_MAX),
    }));
  }

  function setOpossumColdStartIntensity(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxOpossumColdStartIntensity: clamp(value, COLD_START_MIN, COLD_START_MAX),
    }));
  }

  function setOpossumAdjustStep(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxOpossumAdjustStep: clamp(value, ADJUST_STEP_MIN, ADJUST_STEP_MAX),
    }));
  }

  function setToolLimit(
    key:
      | 'maxToolIterations'
      | 'maxToolCallsPerTurn'
      | 'maxAdjustStrengthCallsPerTurn'
      | 'maxVibrateAdjustCallsPerTurn',
    value: number,
  ) {
    setSettingsDraft((current) => ({
      ...current,
      [key]: clamp(value, TOOL_LIMIT_MIN, TOOL_LIMIT_MAX),
    }));
  }

  function setBurstCallsPerTurn(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      // 0 is the "disable bursts" opt-out (issue #67) — must stay reachable.
      maxBurstCallsPerTurn: clamp(value, 0, TOOL_LIMIT_MAX),
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

  function setBurstStrengthAbsolute(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      // 0 = cap disabled (defer to channel cap); upper bound matches the
      // device's hardware limit space (0..200).
      maxBurstStrengthAbsolute: clamp(value, 0, STRENGTH_MAX),
    }));
  }

  function setBurstStrengthRelative(value: number) {
    setSettingsDraft((current) => ({
      ...current,
      maxBurstStrengthRelative: clamp(value, 0, STRENGTH_MAX),
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
      <CollapsibleSection title="郊狼最大强度上限">
        <div className={styles.strengthControlList}>
          <StrengthControl channel="A" value={settingsDraft.maxStrengthA} onChange={setStrengthA} />
          <StrengthControl channel="B" value={settingsDraft.maxStrengthB} onChange={setStrengthB} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="负鼠最大强度上限">
        <div className={styles.strengthControlList}>
          <StrengthControl
            channel="A"
            value={settingsDraft.maxOpossumIntensityA}
            onChange={setOpossumIntensityA}
            idPrefix="max-opossum-intensity"
          />
          <StrengthControl
            channel="B"
            value={settingsDraft.maxOpossumIntensityB}
            onChange={setOpossumIntensityB}
            idPrefix="max-opossum-intensity"
          />
        </div>
      </CollapsibleSection>

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

      <AdvancedSection>
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
          <SettingLabel>单轮突增次数上限（0 表示关闭突增）</SettingLabel>
          <ToolLimitField
            id="max-burst-calls-per-turn"
            value={settingsDraft.maxBurstCallsPerTurn}
            onChange={setBurstCallsPerTurn}
            min={0}
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

        <label htmlFor="max-burst-strength-absolute" className="settings-inline-field">
          <SettingLabel>突增绝对强度上限（0 = 不限）</SettingLabel>
          <ConfigNumberField
            id="max-burst-strength-absolute"
            value={settingsDraft.maxBurstStrengthAbsolute}
            min={0}
            max={STRENGTH_MAX}
            onChange={setBurstStrengthAbsolute}
          />
        </label>

        <label htmlFor="max-burst-strength-relative" className="settings-inline-field">
          <SettingLabel>突增相对强度上限（当前 + N，0 = 不限）</SettingLabel>
          <ConfigNumberField
            id="max-burst-strength-relative"
            value={settingsDraft.maxBurstStrengthRelative}
            min={0}
            max={STRENGTH_MAX}
            onChange={setBurstStrengthRelative}
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

        <label htmlFor="max-vibrate-adjust-calls-per-turn" className="settings-inline-field">
          <SettingLabel>负鼠单轮振动调整次数上限</SettingLabel>
          <ToolLimitField
            id="max-vibrate-adjust-calls-per-turn"
            value={settingsDraft.maxVibrateAdjustCallsPerTurn}
            onChange={(value) => setToolLimit('maxVibrateAdjustCallsPerTurn', value)}
          />
        </label>

        <label htmlFor="max-opossum-cold-start" className="settings-inline-field">
          <SettingLabel>负鼠单次冷启动强度上限</SettingLabel>
          <ConfigNumberField
            id="max-opossum-cold-start"
            value={settingsDraft.maxOpossumColdStartIntensity}
            min={COLD_START_MIN}
            max={COLD_START_MAX}
            onChange={setOpossumColdStartIntensity}
          />
        </label>

        <label htmlFor="max-opossum-adjust-step" className="settings-inline-field">
          <SettingLabel>负鼠单次振动调整幅度上限</SettingLabel>
          <ConfigNumberField
            id="max-opossum-adjust-step"
            value={settingsDraft.maxOpossumAdjustStep}
            min={ADJUST_STEP_MIN}
            max={ADJUST_STEP_MAX}
            onChange={setOpossumAdjustStep}
          />
        </label>
      </AdvancedSection>
    </div>
  );
}

function ToolLimitField({
  id,
  value,
  onChange,
  min = TOOL_LIMIT_MIN,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  return (
    <ConfigNumberField id={id} value={value} min={min} max={TOOL_LIMIT_MAX} onChange={onChange} />
  );
}

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="settings-row-card">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((current) => !current)}
      >
        <h3 className="settings-card-legend mb-0">{title}</h3>
        <div className="flex items-center gap-1">
          <span className="text-[12px] text-[var(--text-faint)]">{open ? '收起' : '展开'}</span>
          <ChevronDown
            className={cn(
              'h-4 w-4 text-[var(--text-faint)] transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
        </div>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </section>
  );
}

function AdvancedSection({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  function handleToggle() {
    if (open) {
      setOpen(false);
      return;
    }
    if (confirmed) {
      setOpen(true);
    } else {
      setShowConfirm(true);
    }
  }

  return (
    <>
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认开启高级选项</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-[var(--text-soft)]">
            <p>高级选项包含对 AI 工具调用频率、强度边界、冷启动等参数的细粒度控制。</p>
            <p>错误的配置可能导致设备行为超出预期，甚至造成不适或伤害。</p>
            <p className="font-semibold text-[var(--danger)]">
              请确认你了解每项参数的含义，并愿意自行承担修改后产生的风险。
            </p>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowConfirm(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmed(true);
                setShowConfirm(false);
                setOpen(true);
              }}
            >
              我已了解，继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="settings-row-card">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={handleToggle}
        >
          <h3 className="settings-card-legend mb-0">高级选项</h3>
          <div className="flex items-center gap-1">
            <span className="text-[12px] text-[var(--text-faint)]">{open ? '收起' : '展开'}</span>
            <ChevronDown
              className={cn(
                'h-4 w-4 text-[var(--text-faint)] transition-transform duration-200',
                open && 'rotate-180',
              )}
            />
          </div>
        </button>
        {open && <div className="mt-3 space-y-3">{children}</div>}
      </section>
    </>
  );
}

export function ConfigNumberField({
  id,
  value,
  min,
  max,
  onChange,
  allowDecimal = false,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Allows one decimal point (e.g. kPa thresholds) instead of the default integer-only input. */
  allowDecimal?: boolean;
}) {
  const [draftValue, setDraftValue] = useState(String(value));
  const [prevValue, setPrevValue] = useState(value);

  if (prevValue !== value) {
    setPrevValue(value);
    setDraftValue(String(value));
  }

  const sanitize = (raw: string): string =>
    allowDecimal
      ? raw.replace(/[^0-9.]+/g, '').replace(/(\..*)\./g, '$1')
      : raw.replace(/\D+/g, '');

  function commit(nextDraftValue: string) {
    const sanitized = sanitize(nextDraftValue);
    const nextValue = sanitized ? clamp(Number(sanitized), min, max) : min;

    setDraftValue(String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }

  return (
    <Input
      id={id}
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      pattern={allowDecimal ? undefined : '[0-9]*'}
      value={draftValue}
      onChange={(event) => {
        setDraftValue(sanitize(event.target.value));
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
  idPrefix = 'max-strength',
}: {
  channel: 'A' | 'B';
  value: number;
  onChange: (value: number) => void;
  idPrefix?: string;
}) {
  const tone = getStrengthTone(value);
  const inputId = `${idPrefix}-${channel.toLowerCase()}`;
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
