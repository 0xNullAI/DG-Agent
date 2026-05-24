import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@dg-agent/web-app/App';
import { TauriBlecDeviceClient } from '@dg-agent/device-tauri-ble';
import { showDevicePicker } from './components/show-device-picker';
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
      }}
    />
  </React.StrictMode>,
);
