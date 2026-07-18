import { describe, expect, it, vi } from 'vitest';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from '@dg-kit/protocol';
import type { SensorState } from '@dg-agent/core';
import { WebBluetoothCivetEdgingClient, WebBluetoothPawPrintsClient } from './sensor-client.js';
import {
  CIVET_EDGING_REQUEST_DEVICE_OPTIONS,
  PAW_PRINTS_REQUEST_DEVICE_OPTIONS,
} from './request-device-options.js';

// Minimal fake GATT characteristic, kept local to this file (mirrors
// DG-Kit's own adapter test convention of not sharing mocks across files).
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
    return new DataView(new Uint8Array([42]).buffer);
  }

  async startNotifications(): Promise<this> {
    return this;
  }

  async stopNotifications(): Promise<this> {
    return this;
  }
}

// Acts as both `device.gatt` and the `BluetoothRemoteGATTServerLike`
// returned from `connect()`, same as real Web Bluetooth.
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

  constructor(public name: string) {
    super();
  }
}

class FakeBluetooth {
  constructor(public device: FakeBluetoothDevice) {}
  requestDevice = vi.fn(async () => this.device);
}

class FakeNavigator {
  bluetooth: FakeBluetooth;
  constructor(device: FakeBluetoothDevice) {
    this.bluetooth = new FakeBluetooth(device);
  }
}

describe('WebBluetoothPawPrintsClient', () => {
  it('connect() scopes requestDevice to the paw-prints-only filter and resolves connected state', async () => {
    const device = new FakeBluetoothDevice('47L120000');
    const nav = new FakeNavigator(device);
    const client = new WebBluetoothPawPrintsClient({ navigatorRef: nav });

    await client.connect();

    expect(nav.bluetooth.requestDevice).toHaveBeenCalledWith(PAW_PRINTS_REQUEST_DEVICE_OPTIONS);
    const state = await client.getState();
    expect(state.connected).toBe(true);
    expect(state.battery).toBe(42);
  });

  it('disconnect() tears down the GATT connection and clears state', async () => {
    const device = new FakeBluetoothDevice('47L120000');
    const nav = new FakeNavigator(device);
    const client = new WebBluetoothPawPrintsClient({ navigatorRef: nav });
    await client.connect();

    await client.disconnect();

    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
    const state = await client.getState();
    expect(state.connected).toBe(false);
  });

  it('onStateChanged listeners fire on connect and on a passive gattserverdisconnected', async () => {
    const device = new FakeBluetoothDevice('47L120000');
    const nav = new FakeNavigator(device);
    const client = new WebBluetoothPawPrintsClient({ navigatorRef: nav });
    const seen: SensorState[] = [];
    const unsubscribe = client.onStateChanged((state) => seen.push(state));

    await client.connect();
    expect(seen.some((s) => s.connected)).toBe(true);

    device.gatt.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.at(-1)?.connected).toBe(false);
    unsubscribe();
  });

  it('setIndicatorColor delegates to the paw-prints LED opcode (0x70)', async () => {
    const device = new FakeBluetoothDevice('47L120000');
    const nav = new FakeNavigator(device);
    const client = new WebBluetoothPawPrintsClient({ navigatorRef: nav });
    await client.connect();

    await client.setIndicatorColor(4);

    expect(device.gatt.writeChar.writes).toContainEqual([0x70, 4]);
  });
});

describe('WebBluetoothCivetEdgingClient', () => {
  it('connect() scopes requestDevice to the civet-edging-only filter and resolves connected state', async () => {
    const device = new FakeBluetoothDevice('47L124000');
    const nav = new FakeNavigator(device);
    const client = new WebBluetoothCivetEdgingClient({ navigatorRef: nav });

    await client.connect();

    expect(nav.bluetooth.requestDevice).toHaveBeenCalledWith(CIVET_EDGING_REQUEST_DEVICE_OPTIONS);
    const state = await client.getState();
    expect(state.connected).toBe(true);
  });

  it('disconnect() tears down the GATT connection and clears state', async () => {
    const device = new FakeBluetoothDevice('47L124000');
    const nav = new FakeNavigator(device);
    const client = new WebBluetoothCivetEdgingClient({ navigatorRef: nav });
    await client.connect();

    await client.disconnect();

    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
    const state = await client.getState();
    expect(state.connected).toBe(false);
  });

  it('setIndicatorColor re-sends the 0x50 packet (civet-edging has no dedicated color opcode)', async () => {
    const device = new FakeBluetoothDevice('47L124000');
    const nav = new FakeNavigator(device);
    const client = new WebBluetoothCivetEdgingClient({ navigatorRef: nav });
    await client.connect();
    device.gatt.writeChar.writes = [];

    await client.setIndicatorColor(5);

    const colorWrite = device.gatt.writeChar.writes.find((bytes) => bytes[0] === 0x50);
    expect(colorWrite?.[1]).toBe(5);
  });
});
