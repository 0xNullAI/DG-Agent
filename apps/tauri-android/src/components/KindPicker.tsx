import type { DeviceKind } from '@dg-agent/core';
import './DevicePicker.css';

interface Props {
  open: boolean;
  onSelect: (kind: DeviceKind) => void;
  onCancel: () => void;
}

const KIND_OPTIONS: { kind: DeviceKind; label: string }[] = [
  { kind: 'coyote', label: 'Coyote 主机' },
  { kind: 'opossum', label: 'Opossum 振动控制器' },
  { kind: 'paw-prints', label: '爪印传感器' },
  { kind: 'civet-edging', label: '灵猫边缘传感器' },
];

/**
 * "Which kind?" step for Tauri Android's connect flow — shown before the
 * `DevicePicker` device-list modal. `@dg-kit/transport-tauri-blec` doesn't
 * expose a single cross-kind scan+auto-detect picker yet (see
 * `connect-any-device-tauri.ts`'s doc), so the kind has to be chosen first,
 * then that kind's own client runs its own scan+device-picker.
 */
export function KindPicker({ open, onSelect, onCancel }: Props) {
  if (!open) return null;
  return (
    <div className="dgaa-picker-backdrop" role="dialog" aria-modal="true">
      <div className="dgaa-picker-panel">
        <header className="dgaa-picker-header">选择设备种类</header>
        <ul className="dgaa-picker-list">
          {KIND_OPTIONS.map(({ kind, label }) => (
            <li key={kind}>
              <button className="dgaa-picker-row" type="button" onClick={() => onSelect(kind)}>
                <span className="dgaa-picker-name">{label}</span>
              </button>
            </li>
          ))}
        </ul>
        <footer className="dgaa-picker-footer">
          <button className="dgaa-picker-cancel" type="button" onClick={onCancel}>
            取消
          </button>
        </footer>
      </div>
    </div>
  );
}
