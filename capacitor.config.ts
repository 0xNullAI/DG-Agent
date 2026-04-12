import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.dgagent.app',
  appName: 'DG Agent',
  webDir: 'dist',
plugins: {
    BluetoothLe: {
      // Display strings shown in the Android system permission dialog
      displayStrings: {
        scanning: '正在扫描蓝牙设备…',
        cancel: '取消',
        availableDevices: '可用设备',
        noDeviceFound: '未发现设备',
      },
    },
  },
};

export default config;
