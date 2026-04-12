/**
 * Platform adapter — auto-detects the runtime and returns the correct BLE adapter.
 *
 * - Capacitor native (Android/iOS): uses @capacitor-community/bluetooth-le
 * - Browser: uses Web Bluetooth API (navigator.bluetooth)
 */

import { Capacitor } from '@capacitor/core';
import { createCapacitorBleAdapter } from './ble-capacitor';
import { createWebBleAdapter } from './ble-web';
import type { BleAdapter } from './ble-types';

export type { BleAdapter, BleDevice, BleServer, BleService, BleCharacteristic } from './ble-types';

let _adapter: BleAdapter | null = null;

export function getBleAdapter(): BleAdapter {
  if (_adapter) return _adapter;
  _adapter = Capacitor.isNativePlatform()
    ? createCapacitorBleAdapter()
    : createWebBleAdapter();
  return _adapter;
}
