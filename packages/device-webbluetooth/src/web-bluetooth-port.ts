import type { DevicePort } from '@dg-agent/contracts';
import type { DeviceCommand, DeviceCommandResult, DeviceState } from '@dg-agent/core';
import { COYOTE_REQUEST_DEVICE_OPTIONS } from './constants.js';
import type { BluetoothDeviceLike, NavigatorBluetoothLike, RequestDeviceOptionsLike } from './types.js';
import type { WebBluetoothAvailability, WebBluetoothProtocolAdapter } from './coyote-protocol.js';

export function getWebBluetoothAvailability(
  nav: NavigatorBluetoothLike | undefined =
    typeof navigator === 'undefined' ? undefined : (navigator as unknown as NavigatorBluetoothLike),
): WebBluetoothAvailability {
  if (!nav) {
    return { supported: false, reason: 'Navigator is unavailable in this environment.' };
  }

  if (!nav.bluetooth) {
    return {
      supported: false,
      reason: 'Web Bluetooth is not available. Use Chrome/Edge over HTTPS or localhost.',
    };
  }

  return { supported: true };
}

export interface WebBluetoothDevicePortOptions {
  protocol: WebBluetoothProtocolAdapter;
  navigatorRef?: NavigatorBluetoothLike;
  requestDeviceOptions?: RequestDeviceOptionsLike;
}

export class WebBluetoothDevicePort implements DevicePort {
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private readonly nav: NavigatorBluetoothLike | undefined;
  private device: EventTarget | null = null;
  private disconnecting = false;

  constructor(private readonly options: WebBluetoothDevicePortOptions) {
    this.nav =
      options.navigatorRef ??
      (typeof navigator === 'undefined' ? undefined : (navigator as unknown as NavigatorBluetoothLike));

    this.options.protocol.subscribe((state) => {
      this.emit(state);
    });
  }

  async connect(): Promise<void> {
    const availability = getWebBluetoothAvailability(this.nav);
    if (!availability.supported) {
      throw new Error(availability.reason);
    }

    const bluetooth = this.nav?.bluetooth;
    if (!bluetooth) {
      throw new Error('Web Bluetooth is unavailable.');
    }

    const nextDevice = await bluetooth.requestDevice(this.options.requestDeviceOptions ?? COYOTE_REQUEST_DEVICE_OPTIONS);
    const gatt = nextDevice.gatt;

    if (!gatt) {
      throw new Error('Selected Bluetooth device does not expose GATT.');
    }

    const server = await gatt.connect();
    const previousDevice = this.device as BluetoothDeviceLike | null;
    const shouldReplacePrevious = !!previousDevice && previousDevice !== nextDevice;

    if (shouldReplacePrevious) {
      previousDevice.removeEventListener('gattserverdisconnected', this.onDisconnected);
    }

    try {
      await this.options.protocol.onConnected({ device: nextDevice, server });
    } catch (error) {
      if (shouldReplacePrevious && isGattConnected(previousDevice)) {
        previousDevice.addEventListener('gattserverdisconnected', this.onDisconnected);
      }
      if (gatt.connected) {
        gatt.disconnect();
      }
      throw error;
    }

    this.device = nextDevice;
    nextDevice.addEventListener('gattserverdisconnected', this.onDisconnected);

    if (shouldReplacePrevious) {
      disconnectDevice(previousDevice);
    }
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    try {
      await this.options.protocol.emergencyStop();
      const device = this.device as { gatt?: { connected: boolean; disconnect(): void } } | null;
      if (device?.gatt?.connected) {
        device.gatt.disconnect();
      }
      await this.options.protocol.onDisconnected();
    } finally {
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
      }
      this.device = null;
      this.disconnecting = false;
    }
  }

  async getState(): Promise<DeviceState> {
    return this.options.protocol.getState();
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    return this.options.protocol.execute(command);
  }

  async emergencyStop(): Promise<void> {
    await this.options.protocol.emergencyStop();
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readonly onDisconnected = async (): Promise<void> => {
    if (this.disconnecting) return;
    await this.options.protocol.onDisconnected();
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    }
    this.device = null;
  };

  private emit(state: DeviceState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function isGattConnected(device: BluetoothDeviceLike | null): boolean {
  return !!device?.gatt?.connected;
}

function disconnectDevice(device: BluetoothDeviceLike | null): void {
  if (!device) return;
  const gatt = device.gatt;
  if (!gatt?.connected) return;
  gatt.disconnect();
}

