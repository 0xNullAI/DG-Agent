import { describe, expect, it } from 'vitest';
import { isBluetoothChooserCancelledError, formatUiErrorMessage } from '../utils/ui-formatters.js';

describe('isBluetoothChooserCancelledError', () => {
  it('recognizes the Web Bluetooth chooser cancellation message', () => {
    expect(
      isBluetoothChooserCancelledError(new Error('User cancelled the requestDevice() chooser.')),
    ).toBe(true);
  });

  it('recognizes the Tauri Android kind/device picker cancellation message', () => {
    // Thrown by connect-any-device-tauri.ts (kind picker) and by
    // @dg-kit/transport-tauri-blec's TauriBlecDeviceClient/connectTauriAuxDevice
    // (device picker) when the user backs out — both should read as a
    // cancellation, not a real error, same as the Web Bluetooth case.
    expect(isBluetoothChooserCancelledError(new Error('用户取消了设备选择'))).toBe(true);
  });

  it('does not treat unrelated errors as cancellation', () => {
    expect(isBluetoothChooserCancelledError(new Error('GATT 服务发现超时，请重新连接'))).toBe(
      false,
    );
  });
});

describe('formatUiErrorMessage', () => {
  it('shows a friendly cancellation message for the Tauri picker cancellation', () => {
    expect(formatUiErrorMessage(new Error('用户取消了设备选择'))).toBe('你已取消设备选择');
  });
});
