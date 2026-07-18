/**
 * @dg-agent/device-webbluetooth
 *
 * Re-exports the protocol + Web Bluetooth transport from `@dg-kit/protocol`
 * and `@dg-kit/transport-webbluetooth` — Coyote's Web Bluetooth-backed
 * `DeviceClient` (`WebBluetoothDeviceClient`) lives entirely in DG-Kit so
 * DG-Chat (and any future browser consumer) shares it.
 *
 * The three newer device kinds (opossum, paw-prints, civet-edging) have no
 * DG-Kit-side transport equivalent yet — DG-Kit only ships the protocol
 * adapters (`OpossumVibrateAdapter`, `PawPrintsSensorAdapter`,
 * `CivetPressureSensorAdapter`), not a Web Bluetooth-connected client — so
 * `opossum-client.ts`/`sensor-client.ts` are local source implementing
 * `@dg-agent/runtime`'s `OpossumClient`/`SensorDeviceClient` contracts on top
 * of those adapters, the same way DG-Kit's own `WebBluetoothDeviceClient`
 * wraps `CoyoteProtocolAdapter`.
 */

export * from '@dg-kit/protocol';
export * from '@dg-kit/transport-webbluetooth';
export * from './opossum-client.js';
export * from './sensor-client.js';
export * from './request-device-options.js';
