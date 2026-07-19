import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@dg-agent/web-app/App';
import {
  TauriBlecDeviceClient,
  TauriBlecOpossumClient,
  TauriBlecPawPrintsClient,
  TauriBlecCivetEdgingClient,
} from '@dg-agent/device-tauri-ble';
import { showDevicePicker } from './components/show-device-picker';
import { connectAnyDgLabDeviceTauri } from './connect-any-device-tauri';
import { wrapWithLifecycleSafety } from './lifecycle-safety';
import { installAndroidShellBehaviours, withBlePermissionHelp } from './android-shell';
import './styles.css';

// Wire up Android-only behaviours (status bar tint, keyboard scroll,
// hardware back button) before React renders.
installAndroidShellBehaviours();

// Fade out the splash placed in index.html once React commits its first frame.
queueMicrotask(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('dgaa-splash');
    if (splash) {
      splash.classList.add('dgaa-splash-loaded');
      setTimeout(() => splash.remove(), 250);
    }
  });
});

// Vite inlines this at build time. The Android shell signs requests to the
// free-tier proxy with an HMAC of the current timestamp so the proxy can
// allow Android (no browser Origin) without opening the door for anyone.
const freeProxySecret = import.meta.env.VITE_DG_PROXY_SECRET;

/**
 * Wrap `inner.connect()` with `withBlePermissionHelp` in place, mutating
 * `inner`'s own `connect` property to shadow the class's prototype method
 * for this instance, then returning the same instance.
 *
 * Deliberately NOT `{ ...inner, connect: ... }`: `inner` here is a plain
 * `TauriBlecOpossumClient`/`TauriBlecSensorClient` class instance (unlike
 * Coyote's `inner` above, which is first run through
 * `wrapWithLifecycleSafety()` and comes out as a plain object literal).
 * Spreading a class instance only copies its OWN enumerable properties —
 * methods declared as `methodName() {}` in a class body live on the
 * prototype, not the instance, so a spread silently drops
 * disconnect/getState/execute/etc., leaving a broken object that throws
 * "is not a function" the moment anything but `connect` is called.
 */
function withConnectPermissionHelp<T extends { connect(): Promise<void> }>(inner: T): T {
  const rawConnect = inner.connect.bind(inner);
  inner.connect = () => withBlePermissionHelp(rawConnect);
  return inner;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App
      servicesOverrides={{
        disableSpeech: true,
        disableBridge: true,
        disableUpdateChecker: true,
        freeProxySecret,
        createDeviceClient: (protocol) => {
          const inner = wrapWithLifecycleSafety(
            new TauriBlecDeviceClient({
              protocol,
              selectDevice: showDevicePicker,
              namePrefixes: ['47L121', 'D-LAB'],
              scanDurationMs: 8000,
            }),
          );
          // Surface a friendly modal when the user denies the BLE permission
          // prompt. The inner client throws "未授予蓝牙权限"; without this
          // wrapper that error just shows as a small toast and the user has
          // no idea what to do.
          return {
            ...inner,
            connect: () => withBlePermissionHelp(() => inner.connect()),
          };
        },
        // The three auxiliary device kinds — previously Web Bluetooth only
        // (no override hook existed at all; see the comment this replaced
        // in use-browser-app-services.ts). The unified connect flow
        // (connectAnyDgLabDeviceTauri, below) attaches to these via
        // connectDevice() after ONE shared scan+picker, so `selectDevice`/
        // `scanDurationMs` here only matter if something falls back to a
        // client's own self-contained .connect() (its own scan + picker +
        // plugin-blec connect) — same permission-prompt wrapping as Coyote
        // above either way.
        createOpossumClient: () =>
          withConnectPermissionHelp(
            new TauriBlecOpossumClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
          ),
        createPawPrintsClient: () =>
          withConnectPermissionHelp(
            new TauriBlecPawPrintsClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
          ),
        createCivetEdgingClient: () =>
          withConnectPermissionHelp(
            new TauriBlecCivetEdgingClient({
              selectDevice: showDevicePicker,
              scanDurationMs: 8000,
            }),
          ),
      }}
      // The unified picker's own permission check (inside
      // requestDgLabDeviceTauri(), before any client's own .connect() ever
      // runs) is what actually throws "未授予蓝牙权限" now — wrap it here so
      // a denied prompt still surfaces the friendly modal, mirroring the
      // per-client wrapping above.
      connectDeviceTauri={(clients) =>
        withBlePermissionHelp(() => connectAnyDgLabDeviceTauri(clients))
      }
    />
  </React.StrictMode>,
);
