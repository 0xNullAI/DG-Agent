import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeviceSelectionController, DiscoveredDevice } from '@dg-agent/device-tauri-ble';
import { DevicePicker } from './DevicePicker';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * Imperatively show the device picker modal. Subscribes to the controller's
 * live device-update stream so newly discovered devices appear in the modal
 * during scanning. Resolves with the chosen device address, or `null` on cancel.
 */
export function showDevicePicker(controller: DeviceSelectionController): Promise<string | null> {
  if (!host) {
    host = document.createElement('div');
    host.id = 'dgaa-device-picker-host';
    document.body.appendChild(host);
    root = createRoot(host);
  }

  return new Promise<string | null>((resolve) => {
    let devices: DiscoveredDevice[] = controller.initial;
    let unsubscribe: (() => void) | null = null;

    const render = () => {
      root!.render(
        createElement(DevicePicker, {
          open: true,
          devices,
          onSelect: (address: string) => close(address),
          onCancel: () => close(null),
        }),
      );
    };

    const close = (value: string | null): void => {
      unsubscribe?.();
      root?.render(createElement(Fragment));
      resolve(value);
    };

    unsubscribe = controller.subscribe((next) => {
      devices = next;
      render();
    });
    render();
  });
}
