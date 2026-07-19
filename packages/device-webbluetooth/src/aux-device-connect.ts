/**
 * Shared connect/disconnect bookkeeping for the three "auxiliary" device
 * kinds (opossum, paw-prints, civet-edging), factored out of
 * `WebBluetoothDeviceClient`'s own connect()/disconnect() so the new
 * `WebBluetoothOpossumClient`/`WebBluetoothSensorClient` don't each
 * reimplement the same requestDevice → gatt.connect → adapter.onConnected →
 * listener-wiring dance.
 *
 * Deliberately does NOT replicate `WebBluetoothDeviceClient`'s
 * `autoReconnect` option — none of the three new device kinds need it (see
 * the runtime-side `OpossumClient`/`SensorDeviceClient` contracts, which
 * only require connect/disconnect/state, no reconnect semantics), and
 * skipping it keeps this helper — and the two clients built on it — simple.
 */
import { getWebBluetoothAvailability } from '@dg-kit/transport-webbluetooth';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTServerLike,
  NavigatorBluetoothLike,
  RequestDeviceOptionsLike,
  WebBluetoothConnectionContext,
} from '@dg-kit/protocol';

/** Minimal shape both `OpossumVibrateAdapter` and the sensor adapters satisfy. */
export interface ConnectableAdapter {
  onConnected(context: WebBluetoothConnectionContext): Promise<void>;
  onDisconnected(): Promise<void>;
}

export interface AuxDeviceConnectOptions {
  navigatorRef?: NavigatorBluetoothLike;
  requestDeviceOptions: RequestDeviceOptionsLike;
}

/**
 * Opens the Bluetooth chooser scoped to `options.requestDeviceOptions`,
 * connects GATT, and hands the connection to `adapter.onConnected()`.
 * Mirrors `WebBluetoothDeviceClient.connect()`'s "replace the previous
 * device only after the new one succeeds" ordering, minus the reconnect
 * bookkeeping that client also carries.
 *
 * Returns the newly connected device; the caller is responsible for storing
 * it and passing it back in on the next call (as `previousDevice`) and to
 * `disconnectAuxDevice`.
 */
export async function connectAuxDevice(
  options: AuxDeviceConnectOptions,
  adapter: ConnectableAdapter,
  previousDevice: BluetoothDeviceLike | null,
  onGattDisconnected: (event: Event) => void,
): Promise<BluetoothDeviceLike> {
  const nav =
    options.navigatorRef ??
    (typeof navigator === 'undefined'
      ? undefined
      : (navigator as unknown as NavigatorBluetoothLike));

  const availability = getWebBluetoothAvailability(nav);
  if (!availability.supported) {
    throw new Error(availability.reason);
  }

  const bluetooth = nav?.bluetooth;
  if (!bluetooth) {
    throw new Error('当前环境不支持 Web Bluetooth');
  }

  const nextDevice = await bluetooth.requestDevice(options.requestDeviceOptions);
  const gatt = nextDevice.gatt;
  if (!gatt) {
    throw new Error('所选蓝牙设备不支持 GATT');
  }

  const server = await gatt.connect();
  return attachAuxDevice(nextDevice, server, adapter, previousDevice, onGattDisconnected);
}

/**
 * Attaches to an already-obtained `(device, server)` pair instead of
 * running this helper's own `bluetooth.requestDevice()` chooser prompt —
 * the aux-device counterpart to `@dg-kit/transport-webbluetooth`'s
 * `WebBluetoothDeviceClient.connectDevice()`. Lets a caller that already
 * ran ONE shared chooser scoped to every DG-Lab device kind (see
 * `requestDgLabDevice()`) and identified the picked device's kind via
 * `detectDeviceKind()` hand it straight to the matching client, instead of
 * needing a second, kind-scoped chooser prompt. `gatt.connect()` must
 * already have been called by the caller; this only runs the adapter
 * handshake and the same replace-previous-device bookkeeping
 * `connectAuxDevice()` does.
 */
export async function attachAuxDevice(
  nextDevice: BluetoothDeviceLike,
  server: BluetoothRemoteGATTServerLike,
  adapter: ConnectableAdapter,
  previousDevice: BluetoothDeviceLike | null,
  onGattDisconnected: (event: Event) => void,
): Promise<BluetoothDeviceLike> {
  const gatt = nextDevice.gatt;
  const shouldReplacePrevious = !!previousDevice && previousDevice !== nextDevice;

  if (shouldReplacePrevious) {
    previousDevice.removeEventListener('gattserverdisconnected', onGattDisconnected);
  }

  try {
    await adapter.onConnected({ device: nextDevice, server });
  } catch (error) {
    if (shouldReplacePrevious && isGattConnected(previousDevice)) {
      previousDevice.addEventListener('gattserverdisconnected', onGattDisconnected);
    }
    if (gatt?.connected) {
      gatt.disconnect();
    }
    throw error;
  }

  nextDevice.addEventListener('gattserverdisconnected', onGattDisconnected);

  if (shouldReplacePrevious) {
    disconnectDeviceGatt(previousDevice);
  }

  return nextDevice;
}

/**
 * User-initiated disconnect: removes the listener BEFORE calling
 * `gatt.disconnect()` so the resulting `gattserverdisconnected` event never
 * reaches `onGattDisconnected` a second time.
 */
export async function disconnectAuxDevice(
  device: BluetoothDeviceLike | null,
  adapter: ConnectableAdapter,
  onGattDisconnected: (event: Event) => void,
): Promise<void> {
  if (device) {
    device.removeEventListener('gattserverdisconnected', onGattDisconnected);
    if (device.gatt?.connected) {
      device.gatt.disconnect();
    }
  }
  await adapter.onDisconnected();
}

function isGattConnected(device: BluetoothDeviceLike | null): boolean {
  return !!device?.gatt?.connected;
}

function disconnectDeviceGatt(device: BluetoothDeviceLike | null): void {
  if (!device?.gatt?.connected) return;
  device.gatt.disconnect();
}
