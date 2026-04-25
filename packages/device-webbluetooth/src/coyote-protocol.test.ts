import { createEmptyDeviceState } from '@dg-agent/core';
import { describe, expect, it } from 'vitest';
import {
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
  V2_PRIMARY_SERVICE,
  V2_STRENGTH_CHAR,
  V2_WAVE_A_CHAR,
  V2_WAVE_B_CHAR,
} from './constants.js';
import {
  CoyoteProtocolAdapter,
  CoyoteV2ProtocolAdapter,
  CoyoteV3ProtocolAdapter,
} from './coyote-protocol.js';

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

class MockResponseOnlyCharacteristic extends EventTarget {
  value: DataView | null = null;

  constructor(private readonly onWrite: (value: Uint8Array) => Promise<void>) {
    super();
  }

  async writeValueWithResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    const buffer =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    await this.onWrite(new Uint8Array(buffer));
  }

  async readValue(): Promise<DataView> {
    return new DataView(new ArrayBuffer(0));
  }

  async startNotifications(): Promise<MockResponseOnlyCharacteristic> {
    return this;
  }

  async stopNotifications(): Promise<MockResponseOnlyCharacteristic> {
    return this;
  }
}

describe('CoyoteV3ProtocolAdapter', () => {
  it('waits for an in-flight tick before writing the emergency stop packet', async () => {
    const firstTickWrite = createDeferred<void>();
    const writes: number[][] = [];

    const characteristic = new MockCharacteristic(async (value) => {
      writes.push(Array.from(value));
      if (writes.length === 1) {
        await firstTickWrite.promise;
      }
    });

    const protocol = new CoyoteV3ProtocolAdapter();
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
    expect(writes[1]?.slice(0, 4)).toEqual([0xb0, 0x0f, 0, 0]);
    expect(protocol.getState().strengthA).toBe(0);
    expect(protocol.getState().strengthB).toBe(0);
  });

  it('ignores stale non-zero strength notifications after emergency stop', async () => {
    const characteristic = new MockCharacteristic(async () => undefined);
    const protocol = new CoyoteV3ProtocolAdapter();
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

  it('packs four sequential V3 wave frames into each B0 packet and pads the tail with silence', async () => {
    const writes: number[][] = [];
    const characteristic = new MockCharacteristic(async (value) => {
      writes.push(Array.from(value));
    });

    const protocol = new CoyoteV3ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      deviceVersion: 2 | 3;
      writeChar: MockCharacteristic | null;
      waveState: {
        A: { frames: [number, number][] | null; index: number; loop: boolean; active: boolean };
        B: { frames: [number, number][] | null; index: number; loop: boolean; active: boolean };
      };
      onTick(): Promise<void>;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
    };
    protocolInternal.deviceVersion = 3;
    protocolInternal.writeChar = characteristic;
    protocolInternal.waveState.A = {
      frames: [
        [11, 10],
        [22, 20],
        [33, 30],
        [44, 40],
        [55, 50],
      ],
      index: 0,
      loop: false,
      active: true,
    };
    protocolInternal.waveState.B = {
      frames: null,
      index: 0,
      loop: false,
      active: false,
    };

    await protocolInternal.onTick();
    await protocolInternal.onTick();

    expect(writes).toHaveLength(2);
    expect(writes[0]?.slice(4, 8)).toEqual([11, 22, 33, 44]);
    expect(writes[0]?.slice(8, 12)).toEqual([10, 20, 30, 40]);
    expect(writes[1]?.slice(4, 8)).toEqual([55, 10, 10, 10]);
    expect(writes[1]?.slice(8, 12)).toEqual([50, 0, 0, 0]);
    expect(writes[1]?.slice(12, 20)).toEqual([0, 0, 0, 0, 0, 0, 0, 101]);
    expect(protocol.getState().waveActiveA).toBe(false);
  });
});

describe('CoyoteV2ProtocolAdapter', () => {
  it('connects and initializes when V2 characteristics only support write with response', async () => {
    const strengthWrites: number[][] = [];
    const waveWrites: number[][] = [];
    const strengthChar = new MockResponseOnlyCharacteristic(async (value) => {
      strengthWrites.push(Array.from(value));
    });
    const waveAChar = new MockResponseOnlyCharacteristic(async (value) => {
      waveWrites.push(Array.from(value));
    });
    const waveBChar = new MockResponseOnlyCharacteristic(async (value) => {
      waveWrites.push(Array.from(value));
    });

    const protocol = new CoyoteV2ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      pendingStrA: number;
      onTick(): Promise<void>;
    };

    await protocol.onConnected({
      device: { name: 'D-LAB ESTIM01', id: 'v2-device' },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V2_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V2_STRENGTH_CHAR) return strengthChar;
              if (characteristic === V2_WAVE_A_CHAR) return waveAChar;
              if (characteristic === V2_WAVE_B_CHAR) return waveBChar;
              throw new Error(`unknown characteristic: ${characteristic}`);
            },
          };
        },
      },
    });

    expect(protocol.getState().connected).toBe(true);
    expect(strengthWrites[0]).toEqual([0, 0, 0]);

    protocolInternal.pendingStrA = 10;
    await protocolInternal.onTick();

    expect(strengthWrites).toHaveLength(2);
    expect(strengthWrites[1]).not.toBeUndefined();

    await protocol.onDisconnected();
  });

  it('rolls back to a disconnected state when early V2 initialization fails', async () => {
    const protocol = new CoyoteV2ProtocolAdapter();

    await expect(
      protocol.onConnected({
        device: { name: 'D-LAB ESTIM01', id: 'broken-v2' },
        server: {
          connected: true,
          async getPrimaryService() {
            throw new Error('primary service unavailable');
          },
        },
      }),
    ).rejects.toThrow('primary service unavailable');

    expect(protocol.getState().connected).toBe(false);
    expect(protocol.getState().deviceName).toBe('D-LAB ESTIM01');
  });
});

describe('CoyoteV3ProtocolAdapter rollback', () => {
  it('rolls back to a disconnected state when early V3 initialization fails', async () => {
    const protocol = new CoyoteV3ProtocolAdapter();

    await expect(
      protocol.onConnected({
        device: { name: '47L121000', id: 'broken-v3' },
        server: {
          connected: true,
          async getPrimaryService() {
            throw new Error('primary service unavailable');
          },
        },
      }),
    ).rejects.toThrow('primary service unavailable');

    expect(protocol.getState().connected).toBe(false);
    expect(protocol.getState().deviceName).toBe('47L121000');
  });
});

describe('CoyoteProtocolAdapter facade', () => {
  it('does not forward a stale disconnect snapshot from the target protocol when switching back', async () => {
    const facade = new CoyoteProtocolAdapter();
    const forwarded: Array<{ connected: boolean; deviceName: string }> = [];
    facade.subscribe((state) => {
      forwarded.push({
        connected: state.connected,
        deviceName: state.deviceName,
      });
    });

    const v3Write = new MockCharacteristic(async () => undefined);
    const v3Notify = new MockCharacteristic(async () => undefined);
    const v2Strength = new MockResponseOnlyCharacteristic(async () => undefined);
    const v2WaveA = new MockResponseOnlyCharacteristic(async () => undefined);
    const v2WaveB = new MockResponseOnlyCharacteristic(async () => undefined);

    const v3Context = {
      device: { name: '47L121000', id: 'v3-first' },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V3_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V3_WRITE_CHAR) return v3Write;
              if (characteristic === V3_NOTIFY_CHAR) return v3Notify;
              throw new Error(`unknown V3 characteristic: ${characteristic}`);
            },
          };
        },
      },
    };

    const v2Context = {
      device: { name: 'D-LAB ESTIM01', id: 'v2-middle' },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V2_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V2_STRENGTH_CHAR) return v2Strength;
              if (characteristic === V2_WAVE_A_CHAR) return v2WaveA;
              if (characteristic === V2_WAVE_B_CHAR) return v2WaveB;
              throw new Error(`unknown V2 characteristic: ${characteristic}`);
            },
          };
        },
      },
    };

    const v3ReturnContext = {
      device: { name: '47L121000', id: 'v3-second' },
      server: v3Context.server,
    };

    await facade.onConnected(v3Context);
    await facade.onConnected(v2Context);

    forwarded.length = 0;
    await facade.onConnected(v3ReturnContext);

    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]).toEqual({ connected: false, deviceName: 'D-LAB ESTIM01' });
    expect(forwarded[1]).toEqual({ connected: true, deviceName: '47L121000' });
    expect(forwarded.some((event) => !event.connected && event.deviceName === '47L121000')).toBe(
      false,
    );
  });

  it('keeps the old active protocol state when switching devices and the new initialization fails', async () => {
    const facade = new CoyoteProtocolAdapter();
    const v3Write = new MockCharacteristic(async () => undefined);
    const v3Notify = new MockCharacteristic(async () => undefined);

    const v3Context = {
      device: { name: '47L121000', id: 'v3-stable' },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V3_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V3_WRITE_CHAR) return v3Write;
              if (characteristic === V3_NOTIFY_CHAR) return v3Notify;
              throw new Error(`unknown V3 characteristic: ${characteristic}`);
            },
          };
        },
      },
    };

    await facade.onConnected(v3Context);
    const stableState = facade.getState();

    await expect(
      facade.onConnected({
        device: { name: 'D-LAB ESTIM01', id: 'broken-switch' },
        server: {
          connected: true,
          async getPrimaryService() {
            throw new Error('switch failed');
          },
        },
      }),
    ).rejects.toThrow('switch failed');

    expect(facade.getState()).toMatchObject({
      connected: stableState.connected,
      deviceName: stableState.deviceName,
      address: stableState.address,
    });
  });

  it('does not activate the new protocol if disconnecting the previous protocol fails', async () => {
    const facade = new CoyoteProtocolAdapter();
    const forwarded: Array<{ connected: boolean; deviceName: string }> = [];
    facade.subscribe((state) => {
      forwarded.push({
        connected: state.connected,
        deviceName: state.deviceName,
      });
    });

    const v3Write = new MockCharacteristic(async () => undefined);
    const v3Notify = new MockCharacteristic(async () => undefined);
    const v2Strength = new MockResponseOnlyCharacteristic(async () => undefined);
    const v2WaveA = new MockResponseOnlyCharacteristic(async () => undefined);
    const v2WaveB = new MockResponseOnlyCharacteristic(async () => undefined);

    await facade.onConnected({
      device: { name: '47L121000', id: 'stable-v3' },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V3_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V3_WRITE_CHAR) return v3Write;
              if (characteristic === V3_NOTIFY_CHAR) return v3Notify;
              throw new Error(`unknown V3 characteristic: ${characteristic}`);
            },
          };
        },
      },
    });

    const facadeInternal = facade as unknown as {
      activeProtocol: { onDisconnected: () => Promise<void> };
    };
    const originalOnDisconnected = facadeInternal.activeProtocol.onDisconnected.bind(
      facadeInternal.activeProtocol,
    );
    facadeInternal.activeProtocol.onDisconnected = async () => {
      throw new Error('old disconnect failed');
    };

    forwarded.length = 0;
    await expect(
      facade.onConnected({
        device: { name: 'D-LAB ESTIM01', id: 'new-v2' },
        server: {
          connected: true,
          async getPrimaryService(service: string) {
            if (service !== V2_PRIMARY_SERVICE) {
              throw new Error('battery unavailable');
            }
            return {
              async getCharacteristic(characteristic: string) {
                if (characteristic === V2_STRENGTH_CHAR) return v2Strength;
                if (characteristic === V2_WAVE_A_CHAR) return v2WaveA;
                if (characteristic === V2_WAVE_B_CHAR) return v2WaveB;
                throw new Error(`unknown V2 characteristic: ${characteristic}`);
              },
            };
          },
        },
      }),
    ).rejects.toThrow('old disconnect failed');

    expect(forwarded).toHaveLength(0);
    expect(facade.getState()).toMatchObject({
      connected: true,
      deviceName: '47L121000',
      address: 'stable-v3',
    });

    facadeInternal.activeProtocol.onDisconnected = originalOnDisconnected;
  });
});
