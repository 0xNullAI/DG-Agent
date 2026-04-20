import type { DevicePort } from '@dg-agent/contracts';
import type { DeviceCommand, DeviceCommandResult } from '@dg-agent/core';

export class DeviceCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly device: DevicePort) {}

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
