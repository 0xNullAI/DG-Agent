/**
 * @dg-agent/device-tauri-ble
 *
 * Thin shim re-exporting the Tauri BLE transport from DG-Kit. Mirrors
 * @dg-agent/device-webbluetooth which does the same for the browser.
 */

export * from '@dg-kit/protocol';
export * from '@dg-kit/transport-tauri-blec';
