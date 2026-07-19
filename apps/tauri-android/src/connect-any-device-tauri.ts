/**
 * Tauri Android's `App.connectDeviceTauri` implementation — see the doc on
 * that prop in `apps/web/src/App.tsx`.
 *
 * Mirrors `@dg-agent/agent-browser`'s `connectAnyDgLabDevice()` almost
 * exactly: one shared scan+picker across all 4 DG-Lab device kinds
 * (`@dg-kit/transport-tauri-blec`'s `requestDgLabDeviceTauri()`, the Tauri
 * counterpart to Web Bluetooth's `requestDgLabDevice()`), the picked
 * device's kind auto-detected, then routed to the matching client's
 * `connectDevice(device, server)` passthrough. Previously this had to ask
 * the user which kind first (`showKindPicker`) because no such passthrough
 * existed on the Tauri clients — that gap is now closed upstream in
 * DG-Kit (`TauriBlecDeviceClient`/`TauriBlecOpossumClient`/
 * `TauriBlecPawPrintsClient`/`TauriBlecCivetEdgingClient` all implement
 * `connectDevice()` now).
 */
import type { DeviceClient, DeviceKind } from '@dg-agent/core';
import {
  requestDgLabDeviceTauri,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type RequestDgLabDeviceTauriOptions,
} from '@dg-agent/device-tauri-ble';
import {
  DEVICE_KIND_DISPLAY_NAME,
  type CivetEdgingClient,
  type OpossumClient,
  type PawPrintsClient,
} from '@dg-agent/runtime';
import { showDevicePicker } from './components/show-device-picker';

export interface ConnectAnyDeviceTauriClients {
  device: DeviceClient;
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
}

interface SupportsConnectDevice {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
}

function supportsConnectDevice(value: unknown): value is SupportsConnectDevice {
  return !!value && typeof (value as Partial<SupportsConnectDevice>).connectDevice === 'function';
}

export async function connectAnyDgLabDeviceTauri(
  clients: ConnectAnyDeviceTauriClients,
  options?: Omit<RequestDgLabDeviceTauriOptions, 'selectDevice'>,
): Promise<{ kind: DeviceKind; name: string }> {
  const { kind, device, server } = await requestDgLabDeviceTauri({
    selectDevice: showDevicePicker,
    ...options,
  });

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
