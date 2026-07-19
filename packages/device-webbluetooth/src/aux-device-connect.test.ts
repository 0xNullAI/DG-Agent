import { describe, expect, it, vi } from 'vitest';
import { attachAuxDevice, type ConnectableAdapter } from './aux-device-connect.js';

class FakeGatt {
  connected = true;
  disconnect = vi.fn(() => {
    this.connected = false;
  });
}

class FakeDevice extends EventTarget {
  gatt = new FakeGatt();
}

function fakeAdapter(onConnected: ConnectableAdapter['onConnected']): ConnectableAdapter {
  return {
    onConnected,
    onDisconnected: vi.fn(async () => undefined),
  };
}

describe('attachAuxDevice GATT-ready retry', () => {
  it('retries onConnected on a transient "no services matching" error and succeeds', async () => {
    const device = new FakeDevice();
    const onConnected = vi
      .fn()
      .mockRejectedValueOnce(new Error('No services matching UUID 0000180c... found in Device'))
      .mockResolvedValueOnce(undefined);
    const adapter = fakeAdapter(onConnected);

    const result = await attachAuxDevice(device, device.gatt, adapter, null, () => undefined, {
      gattReadyInitialDelayMs: 0,
      gattReadyIntervalMs: 0,
    });

    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(result).toBe(device);
  });

  it('does not retry a non-transient onConnected error and disconnects', async () => {
    const device = new FakeDevice();
    const onConnected = vi.fn().mockRejectedValue(new Error('设备拒绝了握手'));
    const adapter = fakeAdapter(onConnected);

    await expect(
      attachAuxDevice(device, device.gatt, adapter, null, () => undefined, {
        gattReadyInitialDelayMs: 0,
        gattReadyIntervalMs: 0,
      }),
    ).rejects.toThrow('设备拒绝了握手');

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
  });
});
