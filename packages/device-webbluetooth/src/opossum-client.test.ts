import { describe, expect, it, vi } from 'vitest';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
  type OpossumState,
} from '@dg-kit/protocol';
import { WebBluetoothOpossumClient } from './opossum-client.js';
import { OPOSSUM_REQUEST_DEVICE_OPTIONS } from './request-device-options.js';

// Minimal fake GATT characteristic — only the bits `writeCharacteristicValue`
// / `readValue` in @dg-kit/protocol actually touch. Kept local to this file
// rather than shared, mirroring DG-Kit's own adapter test convention.
class MockCharacteristic extends EventTarget {
  value: DataView | null = null;
  writes: number[][] = [];

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    const buffer =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.writes.push(Array.from(buffer));
  }

  async readValue(): Promise<DataView> {
    return new DataView(new Uint8Array([88]).buffer);
  }

  async startNotifications(): Promise<this> {
    return this;
  }

  async stopNotifications(): Promise<this> {
    return this;
  }
}

// Acts as both `device.gatt` (connect/disconnect/connected) and the
// `BluetoothRemoteGATTServerLike` returned from `connect()` — real Web
// Bluetooth uses the same object for both roles.
class FakeGatt {
  connected = false;
  writeChar = new MockCharacteristic();
  notifyChar = new MockCharacteristic();
  batteryChar = new MockCharacteristic();

  connect = vi.fn(async () => {
    this.connected = true;
    return this;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
  });

  async getPrimaryService(service: string) {
    if (service === V3_PRIMARY_SERVICE) {
      return {
        getCharacteristic: async (characteristic: string) => {
          if (characteristic === V3_WRITE_CHAR) return this.writeChar;
          if (characteristic === V3_NOTIFY_CHAR) return this.notifyChar;
          throw new Error(`unknown characteristic: ${characteristic}`);
        },
      };
    }
    if (service === V3_BATTERY_SERVICE) {
      return {
        getCharacteristic: async (characteristic: string) => {
          if (characteristic === V3_BATTERY_CHAR) return this.batteryChar;
          throw new Error(`unknown characteristic: ${characteristic}`);
        },
      };
    }
    throw new Error(`unknown service: ${service}`);
  }
}

class FakeBluetoothDevice extends EventTarget {
  gatt = new FakeGatt();
  name = '47L127000';
  id = 'opossum-1';
}

class FakeBluetooth {
  device = new FakeBluetoothDevice();
  requestDevice = vi.fn(async () => this.device);
}

class FakeNavigator {
  bluetooth = new FakeBluetooth();
}

function setup(): { nav: FakeNavigator; device: FakeBluetoothDevice } {
  const nav = new FakeNavigator();
  return { nav, device: nav.bluetooth.device };
}

describe('WebBluetoothOpossumClient', () => {
  it('connect() scopes requestDevice to the opossum-only filter and resolves connected state', async () => {
    const { nav } = setup();
    const client = new WebBluetoothOpossumClient({ navigatorRef: nav });

    await client.connect();

    expect(nav.bluetooth.requestDevice).toHaveBeenCalledWith(OPOSSUM_REQUEST_DEVICE_OPTIONS);
    const state = await client.getState();
    expect(state.connected).toBe(true);
    expect(state.battery).toBe(88);
  });

  it('disconnect() tears down the GATT connection and clears state', async () => {
    const { nav, device } = setup();
    const client = new WebBluetoothOpossumClient({ navigatorRef: nav });
    await client.connect();

    await client.disconnect();

    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
    const state = await client.getState();
    expect(state.connected).toBe(false);
  });

  it('onStateChanged listeners fire on connect, execute(), and a passive gattserverdisconnected', async () => {
    const { nav, device } = setup();
    const client = new WebBluetoothOpossumClient({ navigatorRef: nav });
    const seen: OpossumState[] = [];
    const unsubscribe = client.onStateChanged((state) => seen.push(state));

    await client.connect();
    expect(seen.some((s) => s.connected)).toBe(true);

    await client.execute({ type: 'vibrateStart', channel: 'A', intensity: 50 });
    expect(seen.some((s) => s.intensityA === 50)).toBe(true);

    device.gatt.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.at(-1)?.connected).toBe(false);
    unsubscribe();
  });

  it('emergencyStop drives both channels to zero', async () => {
    const { nav } = setup();
    const client = new WebBluetoothOpossumClient({ navigatorRef: nav });
    await client.connect();
    await client.execute({ type: 'vibrateStart', channel: 'A', intensity: 80 });
    await client.execute({ type: 'vibrateStart', channel: 'B', intensity: 60 });

    await client.emergencyStop();

    const state = await client.getState();
    expect(state.intensityA).toBe(0);
    expect(state.intensityB).toBe(0);
  });

  it('vibrateStop with no channel is an emergency stop of both channels', async () => {
    const { nav } = setup();
    const client = new WebBluetoothOpossumClient({ navigatorRef: nav });
    await client.connect();
    await client.execute({ type: 'vibrateStart', channel: 'A', intensity: 80 });
    await client.execute({ type: 'vibrateStart', channel: 'B', intensity: 60 });

    await client.execute({ type: 'vibrateStop' });

    const state = await client.getState();
    expect(state.intensityA).toBe(0);
    expect(state.intensityB).toBe(0);
  });

  it('setIndicatorColor writes the LED packet with button reporting kept on', async () => {
    const { nav, device } = setup();
    const client = new WebBluetoothOpossumClient({ navigatorRef: nav });
    await client.connect();

    await client.setIndicatorColor(3);

    // The connect handshake also writes a 15-byte 0x50 init packet
    // (V3_INIT_PACKET), so match on the 3-byte LED command specifically
    // rather than the first 0x50-prefixed write.
    const ledWrite = device.gatt.writeChar.writes.find(
      (bytes) => bytes[0] === 0x50 && bytes.length === 3,
    );
    expect(ledWrite).toEqual([0x50, 3, 1]);
  });
});
