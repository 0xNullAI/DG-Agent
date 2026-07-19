/**
 * Tauri Android's `App.connectDeviceTauri` implementation — see the doc on
 * that prop in `apps/web/src/App.tsx`.
 *
 * `@dg-kit/transport-tauri-blec` doesn't expose a single cross-kind picker
 * the way `@dg-agent/device-webbluetooth`'s `requestDgLabDevice()` does for
 * Web Bluetooth: getting one scan to auto-detect which of the 4 kinds was
 * picked needs a `TauriBlecDeviceClient.connectDevice(device, server)`-style
 * passthrough on all 4 client kinds that doesn't exist upstream yet (DG-Kit
 * follow-up). Until then: ask the user which kind first (`showKindPicker`),
 * then call that kind's own client `.connect()` — each of
 * `TauriBlecDeviceClient`/`TauriBlecOpossumClient`/`TauriBlecPawPrintsClient`/
 * `TauriBlecCivetEdgingClient` already runs its own self-contained
 * scan + `showDevicePicker()` + plugin-blec connect, so this needs no new
 * DG-Kit surface.
 */
import type { DeviceClient, DeviceKind } from '@dg-agent/core';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from '@dg-agent/runtime';
import { showKindPicker } from './components/show-kind-picker';

export interface ConnectAnyDeviceTauriClients {
  device: DeviceClient;
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
}

/**
 * Cancelling the kind picker throws this exact message so it's recognized
 * by `isBluetoothChooserCancelledError()` (extended to check for it — see
 * `apps/web/src/utils/ui-formatters.ts`) the same way a cancelled Web
 * Bluetooth chooser is, instead of surfacing as a red error.
 */
const KIND_PICKER_CANCELLED_MESSAGE = 'User cancelled the requestDevice() chooser';

export async function connectAnyDgLabDeviceTauri(
  clients: ConnectAnyDeviceTauriClients,
): Promise<{ kind: DeviceKind; name: string }> {
  const kind = await showKindPicker();
  if (!kind) {
    throw new Error(KIND_PICKER_CANCELLED_MESSAGE);
  }

  switch (kind) {
    case 'coyote': {
      await clients.device.connect();
      const state = await clients.device.getState();
      return { kind, name: state.deviceName ?? '' };
    }
    case 'opossum': {
      await clients.opossum.connect();
      const state = await clients.opossum.getState();
      return { kind, name: state.deviceName ?? '' };
    }
    case 'paw-prints': {
      await clients.pawPrints.connect();
      const state = await clients.pawPrints.getState();
      return { kind, name: state.deviceName ?? '' };
    }
    case 'civet-edging': {
      await clients.civetEdging.connect();
      const state = await clients.civetEdging.getState();
      return { kind, name: state.deviceName ?? '' };
    }
  }
}
