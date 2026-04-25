import { V2_DEVICE_NAME_PREFIX } from './constants.js';
import type { DeviceCommand, DeviceCommandResult, DeviceState } from '@dg-agent/core';
import {
  type StateListener,
  type WebBluetoothConnectionContext,
  type WebBluetoothProtocolAdapter,
} from './coyote-protocol-base.js';
import { CoyoteV2ProtocolAdapter } from './coyote-v2-protocol.js';
import { CoyoteV3ProtocolAdapter } from './coyote-v3-protocol.js';

export type {
  StateListener,
  WebBluetoothAvailability,
  WebBluetoothConnectionContext,
  WebBluetoothProtocolAdapter,
} from './coyote-protocol-base.js';
export { CoyoteV2ProtocolAdapter } from './coyote-v2-protocol.js';
export { CoyoteV3ProtocolAdapter } from './coyote-v3-protocol.js';

export class CoyoteProtocolAdapter implements WebBluetoothProtocolAdapter {
  private readonly listeners = new Set<StateListener>();
  private activeProtocol: WebBluetoothProtocolAdapter = new CoyoteV3ProtocolAdapter();
  private unsubscribeActiveProtocol: (() => void) | null = null;

  constructor() {
    this.bindActiveProtocol(this.activeProtocol);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async onConnected(context: WebBluetoothConnectionContext): Promise<void> {
    const nextProtocol = this.createProtocol(context);
    await nextProtocol.onConnected(context);

    const previousProtocol = this.activeProtocol;
    if (previousProtocol !== nextProtocol) {
      try {
        await previousProtocol.onDisconnected();
      } catch (error) {
        try {
          await nextProtocol.onDisconnected();
        } catch {
          // ignore cleanup failure; preserve the original disconnect error
        }
        throw error;
      }
    }

    this.bindActiveProtocol(nextProtocol);
    this.emit(nextProtocol.getState());
  }

  async onDisconnected(): Promise<void> {
    await this.activeProtocol.onDisconnected();
  }

  getState(): DeviceState {
    return this.activeProtocol.getState();
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    return this.activeProtocol.execute(command);
  }

  async emergencyStop(): Promise<void> {
    await this.activeProtocol.emergencyStop();
  }

  private createProtocol(context: WebBluetoothConnectionContext): WebBluetoothProtocolAdapter {
    const name = context.device.name ?? '';
    return name.startsWith(V2_DEVICE_NAME_PREFIX)
      ? new CoyoteV2ProtocolAdapter()
      : new CoyoteV3ProtocolAdapter();
  }

  private bindActiveProtocol(protocol: WebBluetoothProtocolAdapter): void {
    this.unsubscribeActiveProtocol?.();
    this.activeProtocol = protocol;
    this.unsubscribeActiveProtocol = protocol.subscribe((state) => {
      if (this.activeProtocol === protocol) {
        this.emit(state);
      }
    });
  }

  private emit(state: DeviceState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
