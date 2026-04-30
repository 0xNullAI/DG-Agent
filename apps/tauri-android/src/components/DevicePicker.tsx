import { useMemo } from 'react';
import type { DiscoveredDevice } from '@dg-agent/device-tauri-ble';
import './DevicePicker.css';

interface Props {
  open: boolean;
  devices: DiscoveredDevice[];
  onSelect: (address: string) => void;
  onCancel: () => void;
}

export function DevicePicker({ open, devices, onSelect, onCancel }: Props) {
  const sorted = useMemo(
    () => [...devices].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
    [devices],
  );
  if (!open) return null;
  return (
    <div className="dgaa-picker-backdrop" role="dialog" aria-modal="true">
      <div className="dgaa-picker-panel">
        <header className="dgaa-picker-header">选择郊狼设备</header>
        <ul className="dgaa-picker-list">
          {sorted.length === 0 ? (
            <li className="dgaa-picker-empty">未发现设备 — 请确认设备已开机并按住按键开启广播</li>
          ) : (
            sorted.map((d) => (
              <li key={d.address}>
                <button
                  className="dgaa-picker-row"
                  type="button"
                  onClick={() => onSelect(d.address)}
                >
                  <span className="dgaa-picker-name">{d.name || '未知设备'}</span>
                  <span className="dgaa-picker-meta">
                    {d.address} · RSSI {d.rssi}
                  </span>
                </button>
              </li>
            ))
          )}
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
