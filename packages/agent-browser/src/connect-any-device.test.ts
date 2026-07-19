import { describe, expect, it, vi } from 'vitest';
import type { NavigatorBluetoothLike } from '@dg-agent/device-webbluetooth';
import { connectAnyDgLabDevice, type ConnectAnyDeviceClients } from './connect-any-device.js';

class FakeGatt {
  connected = false;
  connect = vi.fn<() => Promise<this>>(async () => {
    this.connected = true;
    return this;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
  });
}

class FakeBluetoothDevice extends EventTarget {
  gatt: FakeGatt = new FakeGatt();
  constructor(public name: string) {
    super();
  }
}

function setupNav(deviceName: string): NavigatorBluetoothLike {
  const device = new FakeBluetoothDevice(deviceName);
  const requestDevice = vi.fn(async () => device);
  return { bluetooth: { requestDevice } } as unknown as NavigatorBluetoothLike;
}

function fakeClientWithConnectDevice(): { connectDevice: ReturnType<typeof vi.fn> } {
  return { connectDevice: vi.fn(async () => undefined) };
}

function fakeClientWithoutConnectDevice(): { connect: ReturnType<typeof vi.fn> } {
  return { connect: vi.fn(async () => undefined) };
}

function baseClients(overrides: Partial<ConnectAnyDeviceClients> = {}): ConnectAnyDeviceClients {
  return {
    device: fakeClientWithConnectDevice(),
    opossum: fakeClientWithConnectDevice(),
    pawPrints: fakeClientWithConnectDevice(),
    civetEdging: fakeClientWithConnectDevice(),
    ...overrides,
  } as unknown as ConnectAnyDeviceClients;
}

describe('connectAnyDgLabDevice', () => {
  it('routes a Coyote pick to the device client', async () => {
    const clients = baseClients();
    const nav = setupNav('47L121000');

    const result = await connectAnyDgLabDevice(clients, { navigatorRef: nav });

    expect(result.kind).toBe('coyote');
    expect(fakeConnectDevice(clients.device)).toHaveBeenCalledTimes(1);
    expect(fakeConnectDevice(clients.opossum)).not.toHaveBeenCalled();
  });

  it('routes an Opossum pick to the opossum client', async () => {
    const clients = baseClients();
    const nav = setupNav('47L127000');

    const result = await connectAnyDgLabDevice(clients, { navigatorRef: nav });

    expect(result.kind).toBe('opossum');
    expect(fakeConnectDevice(clients.opossum)).toHaveBeenCalledTimes(1);
  });

  it('routes a paw-prints pick to the pawPrints client', async () => {
    const clients = baseClients();
    const nav = setupNav('47L120000');

    const result = await connectAnyDgLabDevice(clients, { navigatorRef: nav });

    expect(result.kind).toBe('paw-prints');
    expect(fakeConnectDevice(clients.pawPrints)).toHaveBeenCalledTimes(1);
  });

  it('routes a civet-edging pick to the civetEdging client', async () => {
    const clients = baseClients();
    const nav = setupNav('47L124000');

    const result = await connectAnyDgLabDevice(clients, { navigatorRef: nav });

    expect(result.kind).toBe('civet-edging');
    expect(fakeConnectDevice(clients.civetEdging)).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when the target client has no connectDevice support (e.g. Tauri)', async () => {
    const clients = baseClients({
      device: fakeClientWithoutConnectDevice() as unknown as ConnectAnyDeviceClients['device'],
    });
    const nav = setupNav('47L121000');

    await expect(connectAnyDgLabDevice(clients, { navigatorRef: nav })).rejects.toThrow(
      '当前环境不支持连接郊狼设备',
    );
  });

  it('propagates the unknown-device rejection from requestDgLabDevice untouched', async () => {
    const clients = baseClients();
    const nav = setupNav('some-other-thing');

    await expect(connectAnyDgLabDevice(clients, { navigatorRef: nav })).rejects.toThrow(
      '未识别的设备',
    );
  });
});

function fakeConnectDevice(client: unknown): ReturnType<typeof vi.fn> {
  return (client as { connectDevice: ReturnType<typeof vi.fn> }).connectDevice;
}
