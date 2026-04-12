/**
 * Capacitor BLE adapter — wraps @capacitor-community/bluetooth-le into
 * the Web Bluetooth API object shape so bluetooth.ts can use it unchanged.
 *
 * The Capacitor BLE plugin has a flat/procedural API:
 *   BleClient.write(deviceId, serviceUuid, charUuid, data)
 *
 * We wrap this in an object hierarchy that mirrors Web Bluetooth:
 *   device.gatt.connect() → server.getPrimaryService(uuid) → service.getCharacteristic(uuid) → char.write(...)
 */

import { BleClient } from '@capacitor-community/bluetooth-le';
import type {
  BleAdapter,
  BleDevice,
  BleServer,
  BleService,
  BleCharacteristic,
  RequestDeviceOptions,
} from './ble-types';

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  await BleClient.initialize({ androidNeverForLocation: true });
  initialized = true;
}

// ---------------------------------------------------------------------------
// EventTarget helper — lightweight event target for disconnect & notify
// ---------------------------------------------------------------------------
function makeEventTarget(): EventTarget {
  const et = new EventTarget();
  return et;
}

// ---------------------------------------------------------------------------
// Characteristic wrapper
// ---------------------------------------------------------------------------
function createCharacteristic(
  deviceId: string,
  serviceUuid: string,
  charUuid: string,
): BleCharacteristic {
  const et = makeEventTarget();
  const char: BleCharacteristic = Object.assign(et, {
    value: null as DataView | null,

    async writeValueWithoutResponse(data: ArrayBufferView | ArrayBuffer): Promise<void> {
      const buffer = data instanceof ArrayBuffer ? data : data.buffer;
      await BleClient.writeWithoutResponse(deviceId, serviceUuid, charUuid, new DataView(buffer));
    },

    async readValue(): Promise<DataView> {
      const dv = await BleClient.read(deviceId, serviceUuid, charUuid);
      char.value = dv;
      return dv;
    },

    async startNotifications(): Promise<BleCharacteristic> {
      await BleClient.startNotifications(deviceId, serviceUuid, charUuid, (dv: DataView) => {
        char.value = dv;
        // Dispatch the same event type that Web Bluetooth uses
        const event = new Event('characteristicvaluechanged');
        // The handler reads event.target.value, so we need target to be char
        Object.defineProperty(event, 'target', { value: char });
        char.dispatchEvent(event);
      });
      return char;
    },

    async stopNotifications(): Promise<BleCharacteristic> {
      await BleClient.stopNotifications(deviceId, serviceUuid, charUuid);
      return char;
    },
  });
  return char;
}

// ---------------------------------------------------------------------------
// Service wrapper
// ---------------------------------------------------------------------------
function createService(deviceId: string, serviceUuid: string): BleService {
  return {
    async getCharacteristic(charUuid: string): Promise<BleCharacteristic> {
      return createCharacteristic(deviceId, serviceUuid, charUuid);
    },
  };
}

// ---------------------------------------------------------------------------
// Server wrapper
// ---------------------------------------------------------------------------
function createServer(deviceId: string, deviceTarget: EventTarget): BleServer {
  let _connected = false;

  const server: BleServer = {
    get connected() {
      return _connected;
    },

    async connect(): Promise<BleServer> {
      await BleClient.connect(deviceId, () => {
        _connected = false;
        const event = new Event('gattserverdisconnected');
        deviceTarget.dispatchEvent(event);
      });
      _connected = true;
      return server;
    },

    disconnect(): void {
      _connected = false;
      BleClient.disconnect(deviceId).catch(() => {});
    },

    async getPrimaryService(serviceUuid: string): Promise<BleService> {
      // Capacitor BLE discovers services during connect — no extra call needed.
      // We just return a wrapper that knows the deviceId + serviceUuid.
      return createService(deviceId, serviceUuid);
    },
  };
  return server;
}

// ---------------------------------------------------------------------------
// Device wrapper
// ---------------------------------------------------------------------------
function createDevice(deviceId: string, name: string | undefined): BleDevice {
  const et = makeEventTarget();
  const server = createServer(deviceId, et);

  const device: BleDevice = Object.assign(et, {
    id: deviceId,
    name,
    gatt: server,
  });
  return device;
}

// ---------------------------------------------------------------------------
// Adapter entry point
// ---------------------------------------------------------------------------
export function createCapacitorBleAdapter(): BleAdapter {
  return {
    async requestDevice(options: RequestDeviceOptions): Promise<BleDevice> {
      await ensureInitialized();

      // Map Web Bluetooth filter format → Capacitor BLE format
      const services: string[] = [];
      const nameFilters: string[] = [];

      if (options.filters) {
        for (const f of options.filters) {
          if (f.namePrefix) nameFilters.push(f.namePrefix);
          if (f.services) services.push(...f.services);
        }
      }
      if (options.optionalServices) {
        services.push(...options.optionalServices);
      }

      const result = await BleClient.requestDevice({
        services: services.length > 0 ? services : undefined,
        namePrefix: nameFilters.length === 1 ? nameFilters[0] : undefined,
        optionalServices: options.optionalServices,
      });

      return createDevice(result.deviceId, result.name);
    },
  };
}
