/**
 * Web Bluetooth-backed `SensorDeviceClient<TReading>` — the "one layer up"
 * concrete implementation the runtime's `PawPrintsClient`/`CivetEdgingClient`
 * contracts (see `@dg-agent/runtime`'s `device-clients.ts`) expect browser
 * composition code to construct. A single generic client wraps either of
 * `@dg-kit/protocol`'s sensor adapters (`PawPrintsSensorAdapter`,
 * `CivetPressureSensorAdapter`) — they share the exact same
 * `WebBluetoothSensorAdapter<TReading>` shape (onConnected/onDisconnected/
 * getState/subscribe/onStateChanged), only their LED-setting method name
 * differs (`setLedSolid` vs `setIndicatorColor`), which is why
 * `setIndicatorColor` is threaded in as a constructor callback rather than
 * called directly on the adapter.
 */
import {
  CivetPressureSensorAdapter,
  PawPrintsSensorAdapter,
  type CivetPressureReading,
  type PawPrintsReading,
  type WebBluetoothSensorAdapter,
} from '@dg-kit/protocol';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTServerLike,
  NavigatorBluetoothLike,
  RequestDeviceOptionsLike,
} from '@dg-kit/protocol';
import type { SensorState } from '@dg-agent/core';
import type { SensorDeviceClient } from '@dg-agent/runtime';
import { attachAuxDevice, connectAuxDevice, disconnectAuxDevice } from './aux-device-connect.js';
import {
  CIVET_EDGING_REQUEST_DEVICE_OPTIONS,
  PAW_PRINTS_REQUEST_DEVICE_OPTIONS,
} from './request-device-options.js';

export interface WebBluetoothSensorClientOptions<TReading> {
  adapter: WebBluetoothSensorAdapter<TReading>;
  requestDeviceOptions: RequestDeviceOptionsLike;
  navigatorRef?: NavigatorBluetoothLike;
  setIndicatorColor: (color: number) => Promise<void>;
}

export class WebBluetoothSensorClient<TReading> implements SensorDeviceClient<TReading> {
  private readonly listeners = new Set<(state: SensorState) => void>();
  private device: BluetoothDeviceLike | null = null;

  constructor(private readonly options: WebBluetoothSensorClientOptions<TReading>) {
    this.options.adapter.onStateChanged((state) => this.emit(state));
  }

  async connect(): Promise<void> {
    this.device = await connectAuxDevice(
      {
        navigatorRef: this.options.navigatorRef,
        requestDeviceOptions: this.options.requestDeviceOptions,
      },
      this.options.adapter,
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
      this.options.adapter,
      this.device,
      this.handleGattDisconnected,
    );
  }

  async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    await disconnectAuxDevice(device, this.options.adapter, this.handleGattDisconnected);
  }

  async getState(): Promise<SensorState> {
    return this.options.adapter.getState();
  }

  subscribe(listener: (reading: TReading) => void): () => void {
    return this.options.adapter.subscribe(listener);
  }

  onStateChanged(listener: (state: SensorState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setIndicatorColor(color: number): Promise<void> {
    await this.options.setIndicatorColor(color);
  }

  private readonly handleGattDisconnected = (): void => {
    const device = this.device;
    this.device = null;
    device?.removeEventListener('gattserverdisconnected', this.handleGattDisconnected);
    void this.options.adapter.onDisconnected();
  };

  private emit(state: SensorState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

export interface WebBluetoothAuxSensorClientOptions {
  navigatorRef?: NavigatorBluetoothLike;
  /** Overrides the default kind-scoped scan filter — mainly for tests. */
  requestDeviceOptions?: RequestDeviceOptionsLike;
}

export class WebBluetoothPawPrintsClient extends WebBluetoothSensorClient<PawPrintsReading> {
  constructor(options: WebBluetoothAuxSensorClientOptions = {}) {
    const adapter = new PawPrintsSensorAdapter();
    super({
      adapter,
      navigatorRef: options.navigatorRef,
      requestDeviceOptions: options.requestDeviceOptions ?? PAW_PRINTS_REQUEST_DEVICE_OPTIONS,
      // Paw-prints exposes a dedicated "set solid color" LED command.
      setIndicatorColor: (color) => adapter.setLedSolid(color),
    });
  }
}

export class WebBluetoothCivetEdgingClient extends WebBluetoothSensorClient<CivetPressureReading> {
  constructor(options: WebBluetoothAuxSensorClientOptions = {}) {
    const adapter = new CivetPressureSensorAdapter();
    super({
      adapter,
      navigatorRef: options.navigatorRef,
      requestDeviceOptions: options.requestDeviceOptions ?? CIVET_EDGING_REQUEST_DEVICE_OPTIONS,
      // civet-edging has no standalone "set color" opcode — setIndicatorColor()
      // re-sends the pressure-reporting packet with streaming state preserved.
      setIndicatorColor: (color) => adapter.setIndicatorColor(color),
    });
  }
}
