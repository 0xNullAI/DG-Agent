/**
 * Web Bluetooth-backed `OpossumClient` — the "one layer up" concrete
 * implementation the runtime's `OpossumClient` contract (see
 * `@dg-agent/runtime`'s `device-clients.ts`) expects browser composition
 * code to construct. Wraps `@dg-kit/protocol`'s `OpossumVibrateAdapter` the
 * same way `WebBluetoothDeviceClient` wraps `CoyoteProtocolAdapter` for
 * Coyote, minus the auto-reconnect option (see `aux-device-connect.ts`'s
 * doc comment for why that's intentionally out of scope here).
 */
import { OpossumVibrateAdapter, type OpossumState } from '@dg-kit/protocol';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTServerLike,
  NavigatorBluetoothLike,
  RequestDeviceOptionsLike,
} from '@dg-kit/protocol';
import type { OpossumCommand } from '@dg-agent/core';
import type { OpossumClient, OpossumCommandResult } from '@dg-agent/runtime';
import { attachAuxDevice, connectAuxDevice, disconnectAuxDevice } from './aux-device-connect.js';
import { OPOSSUM_REQUEST_DEVICE_OPTIONS } from './request-device-options.js';

export interface WebBluetoothOpossumClientOptions {
  navigatorRef?: NavigatorBluetoothLike;
  /** Overrides the default opossum-only scan filter — mainly for tests. */
  requestDeviceOptions?: RequestDeviceOptionsLike;
}

export class WebBluetoothOpossumClient implements OpossumClient {
  private readonly adapter = new OpossumVibrateAdapter();
  private readonly listeners = new Set<(state: OpossumState) => void>();
  private device: BluetoothDeviceLike | null = null;

  constructor(private readonly options: WebBluetoothOpossumClientOptions = {}) {
    this.adapter.onStateChanged((state) => this.emit(state));
  }

  async connect(): Promise<void> {
    this.device = await connectAuxDevice(
      {
        navigatorRef: this.options.navigatorRef,
        requestDeviceOptions: this.options.requestDeviceOptions ?? OPOSSUM_REQUEST_DEVICE_OPTIONS,
      },
      this.adapter,
      this.device,
      this.handleGattDisconnected,
    );
  }

  /**
   * Attach to an already-obtained `(device, server)` pair instead of
   * running this client's own chooser prompt — see
   * `aux-device-connect.ts`'s `attachAuxDevice()` doc comment.
   */
  async connectDevice(
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<void> {
    this.device = await attachAuxDevice(
      device,
      server,
      this.adapter,
      this.device,
      this.handleGattDisconnected,
    );
  }

  async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    await disconnectAuxDevice(device, this.adapter, this.handleGattDisconnected);
  }

  async getState(): Promise<OpossumState> {
    return this.adapter.getState();
  }

  async execute(command: OpossumCommand): Promise<OpossumCommandResult> {
    switch (command.type) {
      case 'vibrateStart':
        await this.adapter.setIntensity(
          command.channel === 'A' ? command.intensity : 'unchanged',
          command.channel === 'B' ? command.intensity : 'unchanged',
        );
        break;
      case 'vibrateStop':
        if (command.channel) {
          await this.adapter.setIntensity(
            command.channel === 'A' ? 0 : 'unchanged',
            command.channel === 'B' ? 0 : 'unchanged',
          );
        } else {
          await this.adapter.emergencyStop();
        }
        break;
      case 'vibrateAdjust':
        await this.adapter.adjustIntensity(command.channel, command.delta);
        break;
    }
    return { state: this.adapter.getState() };
  }

  async emergencyStop(): Promise<void> {
    await this.adapter.emergencyStop();
  }

  async setIndicatorColor(color: number): Promise<void> {
    // enableButtonReporting stays on — a purely cosmetic color change must
    // not silently disable the button-press notifications the room/session
    // relies on, mirroring civet-edging's setIndicatorColor() doc comment.
    await this.adapter.setLed(color, true);
  }

  onStateChanged(listener: (state: OpossumState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readonly handleGattDisconnected = (): void => {
    const device = this.device;
    this.device = null;
    device?.removeEventListener('gattserverdisconnected', this.handleGattDisconnected);
    void this.adapter.onDisconnected();
  };

  private emit(state: OpossumState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
