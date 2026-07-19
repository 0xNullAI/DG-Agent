/**
 * Sensor Trigger Engine — threshold/edge-detection for sensor devices
 * (paw-prints, civet-edging), applied BEFORE anything reaches the LLM.
 *
 * civet-edging streams a pressure reading roughly every 100ms; piping every
 * single one through an LLM turn would be both extremely expensive and
 * nonsensical UX. Instead this engine subscribes directly to a connected
 * sensor client and only calls `onTrigger` for readings that clear a
 * per-device-kind "worth surfacing" rule:
 *
 *  - paw-prints: only a discrete `type: 'trigger'` reading (a button-press
 *    event) counts. The `type: 'physical'` stream (posture/acceleration,
 *    pushed continuously) never fires.
 *  - civet-edging: only surface when the pressure has moved by more than
 *    `civetPressureDeltaThresholdKPa` since the last *surfaced* reading, AND
 *    at least `debounceMs` has passed since the last surfaced trigger for
 *    this device. Both are constructor options with defaults, not hardcoded.
 *
 * This mirrors the existing `timer` mechanism's shape (something outside
 * the chat turn eventually calls back into the runtime as an internal-only
 * prompt) but the trigger *source* is sensor readings instead of a
 * `setTimeout`. See `agent-runtime.ts`'s `processSensorTrigger` /
 * `buildSensorTriggerPrompt` for the other half of the pipeline.
 */
import type { DeviceKind } from '@dg-agent/core';
import type { CivetPressureReading, PawPrintsReading } from '@dg-kit/protocol';
import type { CivetEdgingClient, PawPrintsClient } from './device-clients.js';

/** Default minimum pressure change (kPa) since the last surfaced reading required to fire. */
export const DEFAULT_CIVET_PRESSURE_DELTA_KPA = 2;
/** Default minimum time (ms) between two surfaced triggers for the same device. */
export const DEFAULT_SENSOR_TRIGGER_DEBOUNCE_MS = 1500;

export interface SensorFiredTrigger {
  sessionId: string;
  deviceKind: DeviceKind;
  summary: string;
  firedAt: number;
}

export interface SensorTriggerEngineOptions {
  sessionId: string;
  pawPrints?: PawPrintsClient;
  civetEdging?: CivetEdgingClient;
  onTrigger: (trigger: SensorFiredTrigger) => void;
  /** Minimum |Δ pressure| (kPa) since the last surfaced civet-edging reading required to fire. */
  civetPressureDeltaThresholdKPa?: number;
  /** Minimum time (ms) since the last surfaced trigger for a given device before it can fire again. */
  debounceMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class SensorTriggerEngine {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly civetPressureDeltaThresholdKPa: number;
  private readonly debounceMs: number;
  private readonly now: () => number;

  // civet-edging edge-detection state. `null` baseline means "no surfaced
  // reading yet" — the very first reading only establishes the baseline, it
  // never fires on its own (there is nothing to compare it against yet).
  private lastSurfacedCivetKPa: number | null = null;
  private lastCivetFiredAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: SensorTriggerEngineOptions) {
    this.civetPressureDeltaThresholdKPa =
      options.civetPressureDeltaThresholdKPa ?? DEFAULT_CIVET_PRESSURE_DELTA_KPA;
    this.debounceMs = options.debounceMs ?? DEFAULT_SENSOR_TRIGGER_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;

    if (options.pawPrints) {
      const pawPrints = options.pawPrints;
      this.unsubscribers.push(
        pawPrints.subscribe((reading) => this.handlePawPrintsReading(reading)),
      );
    }
    if (options.civetEdging) {
      const civetEdging = options.civetEdging;
      this.unsubscribers.push(civetEdging.subscribe((reading) => this.handleCivetReading(reading)));
    }
  }

  /** Unsubscribes from every sensor client. Idempotent. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
  }

  private handlePawPrintsReading(reading: PawPrintsReading): void {
    // Only a discrete button-press event is worth surfacing. The 100ms
    // `physical` posture/acceleration stream, and the other paw-prints
    // reading kinds (status/triggerCancel/parameterChange/autoDetectResult)
    // are all noise from the trigger engine's point of view.
    if (reading.type !== 'trigger') return;

    this.fire('paw-prints', `按钮触发（事件${reading.eventId}）`, this.now());
  }

  private handleCivetReading(reading: CivetPressureReading): void {
    const firedAt = this.now();

    if (this.lastSurfacedCivetKPa === null) {
      // First reading ever: establish the baseline, nothing to compare
      // against yet, so it never fires on its own.
      this.lastSurfacedCivetKPa = reading.kPa;
      return;
    }

    const delta = reading.kPa - this.lastSurfacedCivetKPa;
    if (Math.abs(delta) < this.civetPressureDeltaThresholdKPa) return;

    if (firedAt - this.lastCivetFiredAt < this.debounceMs) {
      // Debounced: a qualifying delta exists, but not enough time has
      // passed since the last surfaced trigger. Deliberately does NOT
      // update the baseline here — the delta is measured "since the last
      // *surfaced* reading", so a debounced reading doesn't reset the
      // reference point, and the very next non-debounced check can fire on
      // the accumulated delta instead of needing to re-cross the threshold
      // from scratch.
      return;
    }

    this.lastSurfacedCivetKPa = reading.kPa;
    this.lastCivetFiredAt = firedAt;

    const sign = delta > 0 ? '+' : '';
    const summary = `气压变化 ${sign}${delta.toFixed(1)}kPa（当前 ${reading.kPa.toFixed(1)}kPa）`;
    this.fire('civet-edging', summary, firedAt);
  }

  private fire(deviceKind: DeviceKind, summary: string, firedAt: number): void {
    this.options.onTrigger({
      sessionId: this.options.sessionId,
      deviceKind,
      summary,
      firedAt,
    });
  }
}
