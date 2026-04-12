/**
 * Shared BLE interface types that mirror the Web Bluetooth API shape.
 *
 * Both the Web adapter (pass-through to navigator.bluetooth) and the
 * Capacitor adapter implement these interfaces so that bluetooth.ts
 * can work on both platforms with zero protocol-level changes.
 */

export interface BleCharacteristic extends EventTarget {
  value: DataView | null;
  writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BleCharacteristic>;
  stopNotifications(): Promise<BleCharacteristic>;
}

export interface BleService {
  getCharacteristic(characteristic: string): Promise<BleCharacteristic>;
}

export interface BleServer {
  connected: boolean;
  connect(): Promise<BleServer>;
  disconnect(): void;
  getPrimaryService(service: string): Promise<BleService>;
}

export interface BleDevice extends EventTarget {
  id: string;
  name: string | undefined;
  gatt: BleServer;
}

export interface RequestDeviceOptions {
  filters?: Array<{ namePrefix?: string; name?: string; services?: string[] }>;
  optionalServices?: string[];
}

export interface BleAdapter {
  requestDevice(options: RequestDeviceOptions): Promise<BleDevice>;
}
