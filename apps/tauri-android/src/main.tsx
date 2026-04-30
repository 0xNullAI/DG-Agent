import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@dg-agent/web-app/App';
import { TauriBlecDeviceClient } from '@dg-agent/device-tauri-ble';
import { showDevicePicker } from './components/show-device-picker';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App
      servicesOverrides={{
        disableSpeech: true,
        disableBridge: true,
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
