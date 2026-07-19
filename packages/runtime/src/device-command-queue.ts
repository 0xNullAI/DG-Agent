import type { DeviceClient, OpossumCommand } from '@dg-agent/core';
import type { DeviceCommand, DeviceCommandResult } from '@dg-agent/core';
import type { OpossumClient, OpossumCommandResult } from './device-clients.js';

export class DeviceCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly device: DeviceClient) {}

  async enqueue(command: DeviceCommand): Promise<DeviceCommandResult> {
    if (command.type === 'emergencyStop') {
      this.generation += 1;
      await this.device.emergencyStop();
      return {
        state: await this.device.getState(),
        notes: ['queue-drained-by-emergency-stop'],
      };
    }

    const generation = this.generation;

    const task = this.tail.then(async () => {
      if (generation !== this.generation) {
        return {
          state: await this.device.getState(),
          notes: ['skipped-after-priority-interrupt'],
        };
      }

      return this.device.execute(command);
    });

    this.tail = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }
}

/**
 * Serializes Opossum vibration commands the same way `DeviceCommandQueue`
 * serializes Coyote commands, so concurrent `vibrate_*` tool calls can't
 * race each other's writes. No `emergencyStop`-style generation bump is
 * needed here: Opossum has no command analogous to Coyote's `emergencyStop`
 * variant in its own command union (`vibrate_stop` already exists for that),
 * and the runtime-wide panic button calls `OpossumClient.emergencyStop()`
 * directly (see `AgentRuntime.emergencyStop`), bypassing the queue exactly
 * like Coyote's does.
 */
export class OpossumCommandQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly device: OpossumClient) {}

  async enqueue(command: OpossumCommand): Promise<OpossumCommandResult> {
    const task = this.tail.then(() => this.device.execute(command));

    this.tail = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }
}
