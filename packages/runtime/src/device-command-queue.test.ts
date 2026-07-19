import { describe, expect, it } from 'vitest';
import type {
  DeviceClient,
  DeviceCommand,
  DeviceCommandResult,
  DeviceState,
  OpossumCommand,
} from '@dg-agent/core';
import { createEmptyDeviceState } from '@dg-agent/core';
import type { OpossumClient, OpossumCommandResult } from './device-clients.js';
import { DeviceCommandQueue, OpossumCommandQueue } from './device-command-queue.js';
import type { OpossumState } from '@dg-kit/protocol';

function createState(overrides: Partial<DeviceState> = {}): DeviceState {
  return { ...createEmptyDeviceState(), connected: true, ...overrides };
}

class ScriptedDevice implements DeviceClient {
  state = createState();
  executed: DeviceCommand[] = [];
  emergencyStopCount = 0;
  executeImpl?: (command: DeviceCommand) => Promise<DeviceCommandResult>;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState(): Promise<DeviceState> {
    return this.state;
  }
  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    this.executed.push(command);
    if (this.executeImpl) return this.executeImpl(command);
    return { state: this.state };
  }
  async emergencyStop(): Promise<void> {
    this.emergencyStopCount += 1;
    this.state = createState();
  }
  onStateChanged(): () => void {
    return () => {};
  }
}

describe('DeviceCommandQueue', () => {
  it('propagates errors from device.execute back to the caller', async () => {
    const device = new ScriptedDevice();
    device.executeImpl = async () => {
      throw new Error('GATT write failed');
    };
    const queue = new DeviceCommandQueue(device);

    await expect(
      queue.enqueue({
        type: 'start',
        channel: 'A',
        strength: 10,
        waveform: { id: 'pulse_mid', source: 'basic' },
        loop: true,
      }),
    ).rejects.toThrow('GATT write failed');
  });

  it('continues processing subsequent commands after a prior command rejected', async () => {
    const device = new ScriptedDevice();
    let callCount = 0;
    device.executeImpl = async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('first command failed');
      return { state: createState({ strengthA: 5 }) };
    };
    const queue = new DeviceCommandQueue(device);

    const first = queue.enqueue({
      type: 'start',
      channel: 'A',
      strength: 10,
      waveform: { id: 'pulse_mid', source: 'basic' },
      loop: true,
    });
    const second = queue.enqueue({
      type: 'adjustStrength',
      channel: 'A',
      delta: 5,
    });

    await expect(first).rejects.toThrow('first command failed');
    const secondResult = await second;
    expect(secondResult.state.strengthA).toBe(5);
    expect(callCount).toBe(2);
  });

  it('drains the queue and bumps generation on emergencyStop', async () => {
    const device = new ScriptedDevice();
    const queue = new DeviceCommandQueue(device);

    const result = await queue.enqueue({ type: 'emergencyStop' });

    expect(device.emergencyStopCount).toBe(1);
    expect(result.notes).toContain('queue-drained-by-emergency-stop');
  });

  it('skips commands that were enqueued before an emergencyStop', async () => {
    const device = new ScriptedDevice();
    let resolveFirst: ((value: DeviceCommandResult) => void) | undefined;
    let resolveSecond: ((value: DeviceCommandResult) => void) | undefined;
    const firstStarted: Promise<void> = new Promise((r) => {
      device.executeImpl = (command) => {
        if (command.type === 'start') {
          r();
          return new Promise<DeviceCommandResult>((res) => {
            resolveFirst = res;
          });
        }
        return new Promise<DeviceCommandResult>((res) => {
          resolveSecond = res;
        });
      };
    });
    const queue = new DeviceCommandQueue(device);

    const slowFirst = queue.enqueue({
      type: 'start',
      channel: 'A',
      strength: 10,
      waveform: { id: 'pulse_mid', source: 'basic' },
      loop: true,
    });
    const queuedSecond = queue.enqueue({
      type: 'adjustStrength',
      channel: 'A',
      delta: 5,
    });

    await firstStarted;
    const emergency = queue.enqueue({ type: 'emergencyStop' });
    resolveFirst?.({ state: createState() });
    resolveSecond?.({ state: createState({ strengthA: 99 }) });

    await slowFirst;
    const queuedResult = await queuedSecond;
    await emergency;
    expect(queuedResult.notes).toContain('skipped-after-priority-interrupt');
  });
});

function createOpossumState(overrides: Partial<OpossumState> = {}): OpossumState {
  return { connected: true, battery: 100, intensityA: 0, intensityB: 0, ...overrides };
}

class ScriptedOpossumClient implements OpossumClient {
  state = createOpossumState();
  executed: OpossumCommand[] = [];
  emergencyStopCount = 0;
  executeImpl?: (command: OpossumCommand) => Promise<OpossumCommandResult>;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState(): Promise<OpossumState> {
    return this.state;
  }
  async execute(command: OpossumCommand): Promise<OpossumCommandResult> {
    this.executed.push(command);
    if (this.executeImpl) return this.executeImpl(command);
    return { state: this.state };
  }
  async emergencyStop(): Promise<void> {
    this.emergencyStopCount += 1;
    this.state = createOpossumState({ intensityA: 0, intensityB: 0 });
  }
  async setIndicatorColor(): Promise<void> {}
  onStateChanged(): () => void {
    return () => {};
  }
}

describe('OpossumCommandQueue', () => {
  it('serializes commands in enqueue order', async () => {
    const device = new ScriptedOpossumClient();
    const order: string[] = [];
    device.executeImpl = async (command) => {
      order.push(command.type);
      return { state: device.state };
    };
    const queue = new OpossumCommandQueue(device);

    const first = queue.enqueue({ type: 'vibrateStart', channel: 'A', intensity: 10 });
    const second = queue.enqueue({ type: 'vibrateAdjust', channel: 'A', delta: 5 });

    await first;
    await second;

    expect(order).toEqual(['vibrateStart', 'vibrateAdjust']);
  });

  it('propagates errors from device.execute back to the caller', async () => {
    const device = new ScriptedOpossumClient();
    device.executeImpl = async () => {
      throw new Error('GATT write failed');
    };
    const queue = new OpossumCommandQueue(device);

    await expect(
      queue.enqueue({ type: 'vibrateStart', channel: 'A', intensity: 10 }),
    ).rejects.toThrow('GATT write failed');
  });

  it('continues processing subsequent commands after a prior command rejected', async () => {
    const device = new ScriptedOpossumClient();
    let callCount = 0;
    device.executeImpl = async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('first command failed');
      return { state: createOpossumState({ intensityA: 5 }) };
    };
    const queue = new OpossumCommandQueue(device);

    const first = queue.enqueue({ type: 'vibrateStart', channel: 'A', intensity: 10 });
    const second = queue.enqueue({ type: 'vibrateAdjust', channel: 'A', delta: 5 });

    await expect(first).rejects.toThrow('first command failed');
    const secondResult = await second;
    expect(secondResult.state.intensityA).toBe(5);
    expect(callCount).toBe(2);
  });
});
