/**
 * Web Bluetooth adapter — thin pass-through to navigator.bluetooth.
 * Used on desktop browsers and any environment that supports Web Bluetooth natively.
 */

import type { BleAdapter, BleDevice, RequestDeviceOptions } from './ble-types';

export function createWebBleAdapter(): BleAdapter {
  return {
    async requestDevice(options: RequestDeviceOptions): Promise<BleDevice> {
      const bt = (navigator as any).bluetooth;
      if (!bt) throw new Error('Web Bluetooth API 不可用');
      return bt.requestDevice(options) as Promise<BleDevice>;
    },
  };
}
