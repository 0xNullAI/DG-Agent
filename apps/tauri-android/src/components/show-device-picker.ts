import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiscoveredDevice } from '@dg-agent/device-tauri-ble';
import { DevicePicker } from './DevicePicker';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * Imperatively show the device picker modal. Resolves with the chosen device
 * address, or `null` if the user cancels. Mounts a singleton React tree at
 * `<body>`'s end so it doesn't conflict with the main app's React root.
 */
export function showDevicePicker(devices: DiscoveredDevice[]): Promise<string | null> {
  if (!host) {
    host = document.createElement('div');
    host.id = 'dgaa-device-picker-host';
    document.body.appendChild(host);
    root = createRoot(host);
  }

  return new Promise<string | null>((resolve) => {
    const close = (value: string | null): void => {
      root?.render(createElement(Fragment));
      resolve(value);
    };
    root!.render(
      createElement(DevicePicker, {
        open: true,
        devices,
        onSelect: (address: string) => close(address),
        onCancel: () => close(null),
      }),
    );
  });
}
