/**
 * @dg-agent/device-webbluetooth
 *
 * Thin shim that re-exports the protocol + Web Bluetooth transport from
 * `@dg-kit/protocol` and `@dg-kit/transport-webbluetooth`. The actual code
 * lives in DG-Kit so DG-Chat (and any future browser consumer) shares it.
 *
 * Local source files (constants/types/coyote-*.ts/web-bluetooth-device-client.ts)
 * have been removed; the test file is kept under DG-Kit's `packages/protocol`.
 */

export * from '@dg-kit/protocol';
export * from '@dg-kit/transport-webbluetooth';
