import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@dg-agent/web-app/App';
import { TauriBlecDeviceClient } from '@dg-agent/device-tauri-ble';
import { showDevicePicker } from './components/show-device-picker';
import './styles.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App
      servicesOverrides={{
        disableSpeech: true,
        disableBridge: true,
        disableUpdateChecker: true,
        createDeviceClient: (protocol) =>
          new TauriBlecDeviceClient({
            protocol,
            selectDevice: showDevicePicker,
            namePrefixes: ['47L121', 'D-LAB'],
            scanDurationMs: 8000,
          }),
      }}
    />
  </React.StrictMode>,
);
