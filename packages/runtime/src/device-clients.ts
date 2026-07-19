/**
 * Client contracts for the three new DG-Lab device families (paw-prints,
 * civet-edging, opossum) alongside the existing Coyote `DeviceClient`.
 *
 * Mirrors DG-Kit's own "don't force a common interface across genuinely
 * different device shapes" principle (see DG-Kit CLAUDE.md): Coyote keeps
 * its `DeviceClient`/`DeviceCommand` contract untouched, sensors get a
 * narrow read-only contract parameterized by their reading type, and Opossum
 * (which both accepts commands and reports button presses) gets its own
 * standalone contract instead of being squeezed into `DeviceClient`.
 *
 * These are runtime-level contracts, not concrete implementations — actual
 * Web Bluetooth-backed instances are constructed one layer up (device
 * adapter / composition code), the same way `DeviceClient` itself is today.
 * The runtime only needs to know how to *talk to* a connected client, not
 * how one gets connected.
 */
import type { DeviceKind, OpossumCommand, SensorState } from '@dg-agent/core';
import type { CivetPressureReading, OpossumState, PawPrintsReading } from '@dg-kit/protocol';

export interface OpossumCommandResult {
  state: OpossumState;
}

export interface OpossumClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): Promise<OpossumState>;
  execute(command: OpossumCommand): Promise<OpossumCommandResult>;
  /** Best-effort: drive both channels to zero. Used by the runtime-wide emergency stop. */
  emergencyStop(): Promise<void>;
  setIndicatorColor(color: number): Promise<void>;
  onStateChanged(listener: (state: OpossumState) => void): () => void;
}

/**
 * Contract for sensor-family clients (paw-prints, civet-edging): read-only
 * event streams plus an optional LED setter (civet-edging's indicator color
 * is set via the same packet as its pressure-reporting toggle; paw-prints
 * has a dedicated LED command — both satisfy this optional method).
 */
export interface SensorDeviceClient<TReading> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): Promise<SensorState>;
  subscribe(listener: (reading: TReading) => void): () => void;
  onStateChanged(listener: (state: SensorState) => void): () => void;
  setIndicatorColor?(color: number): Promise<void>;
}

export type PawPrintsClient = SensorDeviceClient<PawPrintsReading>;
export type CivetEdgingClient = SensorDeviceClient<CivetPressureReading>;

/** Chinese display name for each device kind, used in user-facing denial/guidance text. */
export const DEVICE_KIND_DISPLAY_NAME: Record<DeviceKind, string> = {
  coyote: '郊狼',
  'paw-prints': '爪印',
  'civet-edging': '灵猫',
  opossum: '负鼠',
};
