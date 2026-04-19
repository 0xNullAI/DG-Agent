import { createEmptyDeviceState } from '@dg-agent/core';
import { describe, expect, it } from 'vitest';
import { CoyoteProtocolAdapter } from './coyote-protocol.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

class MockCharacteristic extends EventTarget {
  value: DataView | null = null;

  constructor(private readonly onWrite: (value: Uint8Array) => Promise<void>) {
    super();
  }

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    const buffer =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    await this.onWrite(new Uint8Array(buffer));
  }

  async readValue(): Promise<DataView> {
    return new DataView(new ArrayBuffer(0));
  }

  async startNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  async stopNotifications(): Promise<MockCharacteristic> {
    return this;
  }
}

describe('CoyoteProtocolAdapter', () => {
  it('waits for an in-flight tick before writing the emergency stop packet', async () => {
    const firstTickWrite = createDeferred<void>();
    const writes: number[][] = [];

    const characteristic = new MockCharacteristic(async (value) => {
      writes.push(Array.from(value));
      if (writes.length === 1) {
        await firstTickWrite.promise;
      }
    });

    const protocol = new CoyoteProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      deviceVersion: 2 | 3;
      writeChar: MockCharacteristic | null;
      pendingStrA: number;
      pendingStrB: number;
      onTick(): Promise<void>;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
    };
    protocolInternal.deviceVersion = 3;
    protocolInternal.writeChar = characteristic;
    protocolInternal.pendingStrA = 42;
    protocolInternal.pendingStrB = 0;

    const tickPromise = protocolInternal.onTick();
    expect(writes).toHaveLength(1);

    const stopPromise = protocol.emergencyStop();
    await Promise.resolve();
    expect(writes).toHaveLength(1);

    firstTickWrite.resolve();
    await tickPromise;
    await stopPromise;

    expect(writes).toHaveLength(2);
    expect(writes[0]?.slice(0, 4)).toEqual([0xb0, 0x00, 42, 0]);
    expect(writes[1]?.slice(0, 4)).toEqual([0xb0, 0x33, 0, 0]);
    expect(protocol.getState().strengthA).toBe(0);
    expect(protocol.getState().strengthB).toBe(0);
  });

  it('ignores stale non-zero strength notifications after emergency stop', async () => {
    const characteristic = new MockCharacteristic(async () => undefined);
    const protocol = new CoyoteProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      deviceVersion: 2 | 3;
      writeChar: MockCharacteristic | null;
      handleV3Notification(event: Event): void;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
      strengthA: 10,
    };
    protocolInternal.deviceVersion = 3;
    protocolInternal.writeChar = characteristic;

    await protocol.emergencyStop();
    expect(protocol.getState().strengthA).toBe(0);

    protocolInternal.handleV3Notification({
      target: {
        value: new DataView(Uint8Array.from([0xb1, 0x01, 10, 0]).buffer),
      },
    } as unknown as Event);

    expect(protocol.getState().strengthA).toBe(0);
    expect(protocol.getState().strengthB).toBe(0);
  });
});
