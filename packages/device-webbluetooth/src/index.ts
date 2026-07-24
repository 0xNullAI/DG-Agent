/**
 * @dg-agent/device-webbluetooth
 *
 * Re-exports the protocol + Web Bluetooth transport from `@dg-kit/protocol`
 * and `@dg-kit/transport-webbluetooth` — every device kind's Web
 * Bluetooth-backed client (`WebBluetoothDeviceClient` for Coyote,
 * `WebBluetoothOpossumClient`/`WebBluetoothPawPrintsClient`/
 * `WebBluetoothCivetEdgingClient` for the three newer kinds) lives entirely
 * in DG-Kit as of 1.13.0, so DG-Chat (and any future browser consumer)
 * shares the same implementation instead of each hand-rolling its own.
 */

export * from '@dg-kit/protocol';
export * from '@dg-kit/transport-webbluetooth';
