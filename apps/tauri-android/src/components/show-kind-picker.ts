import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeviceKind } from '@dg-agent/core';
import { KindPicker } from './KindPicker';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * Imperatively show the "which kind?" modal — see `KindPicker`'s doc.
 * Resolves with the chosen kind, or `null` on cancel.
 */
export function showKindPicker(): Promise<DeviceKind | null> {
  if (!host) {
    host = document.createElement('div');
    host.id = 'dgaa-kind-picker-host';
    document.body.appendChild(host);
    root = createRoot(host);
  }

  return new Promise<DeviceKind | null>((resolve) => {
    const close = (value: DeviceKind | null): void => {
      root?.render(createElement(Fragment));
      resolve(value);
    };

    root!.render(
      createElement(KindPicker, {
        open: true,
        onSelect: (kind: DeviceKind) => close(kind),
        onCancel: () => close(null),
      }),
    );
  });
}
