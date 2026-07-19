import type { DeviceClient, OpossumCommand } from '@dg-agent/core';
import type { DeviceCommand, DeviceCommandResult } from '@dg-agent/core';
import type { OpossumClient, OpossumCommandResult } from './device-clients.js';

export interface PriorityInterrupt<TCommand, TResult> {
  /** Which command(s) should bypass the queue and run immediately. */
  matches(command: TCommand): boolean;
  /** How to actually run a matched command (typically not via `execute()`). */
  run(command: TCommand): Promise<TResult>;
  /** Result for a task that was already queued when a later interrupt fired. */
  skippedResult(): Promise<TResult>;
}

export interface SerialCommandQueueOptions<TCommand, TResult> {
  execute(command: TCommand): Promise<TResult>;
  /** Omit for a plain FIFO queue with no priority-interrupt concept. */
  priorityInterrupt?: PriorityInterrupt<TCommand, TResult>;
}

/**
 * Runs commands against a device one at a time, so concurrent tool calls
 * can't race each other's writes — a rejected command doesn't jam the
 * queue, the next enqueued command still runs.
 *
 * An optional `priorityInterrupt` lets one command "type" (Coyote's
 * `emergencyStop`) skip the line entirely: it bumps a generation counter
 * and runs immediately via `run()` rather than `execute()`, and any
 * already-queued-but-not-yet-run task notices its generation is stale and
 * resolves with `skippedResult()` instead of actually executing. Extracted
 * from `DeviceCommandQueue` (which needs the interrupt) and reused as a
 * plain FIFO by `OpossumCommandQueue` (which doesn't — see its own doc
 * comment for why).
 */
export class SerialCommandQueue<TCommand, TResult> {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly options: SerialCommandQueueOptions<TCommand, TResult>) {}

  async enqueue(command: TCommand): Promise<TResult> {
    const interrupt = this.options.priorityInterrupt;
    if (interrupt?.matches(command)) {
      this.generation += 1;
      return interrupt.run(command);
    }

    const generation = this.generation;

    const task = this.tail.then(async () => {
      if (interrupt && generation !== this.generation) {
        return interrupt.skippedResult();
      }

      return this.options.execute(command);
    });

    this.tail = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }
}

export class DeviceCommandQueue {
  private readonly queue: SerialCommandQueue<DeviceCommand, DeviceCommandResult>;

  constructor(private readonly device: DeviceClient) {
    this.queue = new SerialCommandQueue({
      execute: (command) => this.device.execute(command),
      priorityInterrupt: {
        matches: (command) => command.type === 'emergencyStop',
        run: async () => {
          await this.device.emergencyStop();
          return {
            state: await this.device.getState(),
            notes: ['queue-drained-by-emergency-stop'],
          };
        },
        skippedResult: async () => ({
          state: await this.device.getState(),
          notes: ['skipped-after-priority-interrupt'],
        }),
      },
    });
  }

  async enqueue(command: DeviceCommand): Promise<DeviceCommandResult> {
    return this.queue.enqueue(command);
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
  private readonly queue: SerialCommandQueue<OpossumCommand, OpossumCommandResult>;

  constructor(private readonly device: OpossumClient) {
    this.queue = new SerialCommandQueue({
      execute: (command) => this.device.execute(command),
    });
  }

  async enqueue(command: OpossumCommand): Promise<OpossumCommandResult> {
    return this.queue.enqueue(command);
  }
}
