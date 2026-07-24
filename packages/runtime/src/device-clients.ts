/**
 * Client contracts for the three newer DG-Lab device families (paw-prints,
 * civet-edging, opossum) alongside the existing Coyote `DeviceClient`.
 *
 * Re-exported from `@dg-kit/*` (extracted there in 1.13.0) rather than
 * declared here — `@dg-kit/transport-tauri-blec` shipped concrete Tauri
 * clients against these exact shapes well before this package had a home
 * for the shared contract, so DG-MCP and any future consumer now get the
 * same types this runtime uses instead of a third independent copy.
 */
export {
  type OpossumClient,
  type OpossumCommandResult,
  type PawPrintsClient,
  type CivetEdgingClient,
} from '@dg-kit/protocol';
export { type SensorDeviceClient, DEVICE_KIND_DISPLAY_NAME } from '@dg-kit/core';
