/**
 * Single unified "连接设备" entry point: opens ONE shared Web Bluetooth
 * chooser scoped to every DG-Lab device kind (Coyote, Opossum, paw-prints,
 * civet-edging), auto-detects which kind was picked, and routes it into the
 * matching client. Calling this repeatedly lets a user add one device at a
 * time without needing a separate connect button per kind.
 *
 * Falls back to a clear error (rather than a silent no-op) when the active
 * `device`/`opossum`/`pawPrints`/`civetEdging` client doesn't support
 * attaching a pre-chosen device — this only happens on the Tauri Android
 * shell today, where `device` is a `TauriBlecDeviceClient` (no
 * `connectDevice()` yet) and the three aux clients have no Tauri transport
 * at all (see DG-Chat's `DeviceSession` doc comment for the same gap).
 */
import type { DeviceClient, DeviceKind } from '@dg-agent/core';
import {
  requestDgLabDevice,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type RequestDgLabDeviceOptions,
} from '@dg-agent/device-webbluetooth';
import {
  DEVICE_KIND_DISPLAY_NAME,
  type CivetEdgingClient,
  type OpossumClient,
  type PawPrintsClient,
} from '@dg-agent/runtime';

export interface ConnectAnyDeviceClients {
  device: DeviceClient;
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
}

export interface ConnectAnyDeviceResult {
  kind: DeviceKind;
  name: string;
}

interface SupportsConnectDevice {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
}

function supportsConnectDevice(value: unknown): value is SupportsConnectDevice {
  return !!value && typeof (value as Partial<SupportsConnectDevice>).connectDevice === 'function';
}

export async function connectAnyDgLabDevice(
  clients: ConnectAnyDeviceClients,
  options?: RequestDgLabDeviceOptions,
): Promise<ConnectAnyDeviceResult> {
  const { kind, device, server } = await requestDgLabDevice(options);

  const target: unknown =
    kind === 'coyote'
      ? clients.device
      : kind === 'opossum'
        ? clients.opossum
        : kind === 'paw-prints'
          ? clients.pawPrints
          : clients.civetEdging;

  if (!supportsConnectDevice(target)) {
    throw new Error(`当前环境不支持连接${DEVICE_KIND_DISPLAY_NAME[kind]}设备`);
  }

  await target.connectDevice(device, server);
  return { kind, name: device.name ?? '' };
}
