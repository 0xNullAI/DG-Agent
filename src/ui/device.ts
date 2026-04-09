/**
 * ui/device.ts — Device status bar UI updates.
 */

import type { DeviceState } from '../types';
import { $ } from './index';

export function updateDeviceUI(status: DeviceState): void {
  if (!status) return;

  const statusDot = $('device-status') as HTMLSpanElement;
  const deviceBar = $('device-bar') as HTMLDivElement;

  if (status.connected) {
    statusDot.className = 'status-dot connected';
    deviceBar.classList.remove('hidden');
  } else {
    statusDot.className = 'status-dot disconnected';
    deviceBar.classList.add('hidden');
  }

  if (status.strengthA !== undefined) {
    const max = 200;
    const pct = Math.min(100, (status.strengthA / max) * 100);
    ($('strength-a') as HTMLDivElement).style.width = pct + '%';
    ($('strength-a-val') as HTMLSpanElement).textContent = String(status.strengthA);
  }
  if (status.strengthB !== undefined) {
    const max = 200;
    const pct = Math.min(100, (status.strengthB / max) * 100);
    ($('strength-b') as HTMLDivElement).style.width = pct + '%';
    ($('strength-b-val') as HTMLSpanElement).textContent = String(status.strengthB);
  }

  if (status.battery !== undefined) {
    ($('battery-val') as HTMLSpanElement).textContent = status.battery + '%';
  }

  ['a', 'b'].forEach((ch) => {
    const active = ch === 'a' ? status.waveActiveA : status.waveActiveB;
    const el = $(`wave-${ch}`);
    if (el) el.classList.toggle('hidden', !active);
  });
}
