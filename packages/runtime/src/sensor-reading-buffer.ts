/**
 * Rolling-window aggregation for the two continuous-stream sensor kinds
 * (paw-prints, civet-edging), so `[当前设备状态]` and sensor-trigger prompts
 * can describe a recent *trend* instead of only the single last surfaced
 * event. Independent of `SensorTriggerEngine`'s opt-in "interrupt the chat"
 * toggle (see agent-runtime.ts's `setSensorTriggersEnabled` doc comment) —
 * this is a passive summary line the LLM only sees when it's already being
 * invoked for some other reason, not a proactive message, so it buffers
 * unconditionally from the moment a sensor connects.
 *
 * civet-edging streams a pressure reading roughly every 100ms; piping every
 * sample into a summary line would be as noisy as piping it straight to the
 * LLM. `SensorReadingBuffer` is the aggregation layer that prevents that —
 * raw samples go in via `record()`, only a computed summary string ever
 * reaches a prompt.
 */

export interface SensorReadingBufferOptions {
  /** Entries older than this (ms, relative to the most recent `record()`) are evicted. */
  windowMs: number;
  /** Hard cap independent of age, in case the window is long relative to reading rate. */
  maxEntries: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Generic time-windowed ring buffer — the mechanics are identical for both sensor kinds, only the entry shape and the summary computed from it differ. */
export class SensorReadingBuffer<TEntry> {
  private entries: Array<{ entry: TEntry; at: number }> = [];
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: SensorReadingBufferOptions) {
    this.windowMs = options.windowMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  record(entry: TEntry, at: number = this.now()): void {
    this.entries.push({ entry, at });
    this.evict(at);
  }

  /** Entries still inside the window as of `at` (defaults to now), oldest first. */
  windowEntries(at: number = this.now()): TEntry[] {
    this.evict(at);
    return this.entries.map((item) => item.entry);
  }

  private evict(at: number): void {
    const cutoff = at - this.windowMs;
    while (this.entries.length > 0 && (this.entries[0]?.at ?? 0) < cutoff) {
      this.entries.shift();
    }
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }
}

const CIVET_WINDOW_MS = 30_000;
const CIVET_MAX_ENTRIES = 300;
// Reuses the trigger engine's own "meaningfully different" bar (see
// sensor-trigger-engine.ts's DEFAULT_CIVET_PRESSURE_DELTA_KPA) rather than a
// second, unrelated magic number for a similar concept — below this, two
// thirds-of-the-window averages count as noise, not a trend.
const CIVET_TREND_FLAT_THRESHOLD_KPA = 2;

export function createCivetPressureBuffer(now?: () => number): SensorReadingBuffer<number> {
  return new SensorReadingBuffer<number>({
    windowMs: CIVET_WINDOW_MS,
    maxEntries: CIVET_MAX_ENTRIES,
    now,
  });
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function classifyCivetTrend(samples: readonly number[]): '上升' | '下降' | '平稳' {
  if (samples.length < 3) return '平稳';
  const thirdSize = Math.max(1, Math.floor(samples.length / 3));
  const delta = mean(samples.slice(-thirdSize)) - mean(samples.slice(0, thirdSize));
  if (delta > CIVET_TREND_FLAT_THRESHOLD_KPA) return '上升';
  if (delta < -CIVET_TREND_FLAT_THRESHOLD_KPA) return '下降';
  return '平稳';
}

/** `null` when the buffer has no samples yet (sensor just connected, or window fully aged out). */
export function summarizeCivetPressure(kPaSamples: readonly number[]): string | null {
  if (kPaSamples.length === 0) return null;
  const current = kPaSamples[kPaSamples.length - 1] as number;
  const min = Math.min(...kPaSamples);
  const max = Math.max(...kPaSamples);
  const trend = classifyCivetTrend(kPaSamples);
  return `当前 ${current.toFixed(1)}kPa，30s 内 ${min.toFixed(1)}~${max.toFixed(1)}kPa，趋势${trend}`;
}

const PAW_PRINTS_WINDOW_MS = 60_000;
const PAW_PRINTS_MAX_ENTRIES = 300;

export interface PawPrintsTriggerEntry {
  eventId: number;
}

export function createPawPrintsTriggerBuffer(
  now?: () => number,
): SensorReadingBuffer<PawPrintsTriggerEntry> {
  return new SensorReadingBuffer<PawPrintsTriggerEntry>({
    windowMs: PAW_PRINTS_WINDOW_MS,
    maxEntries: PAW_PRINTS_MAX_ENTRIES,
    now,
  });
}

/** `null` when no trigger events fired within the window. */
export function summarizePawPrintsTriggers(
  events: readonly PawPrintsTriggerEntry[],
): string | null {
  if (events.length === 0) return null;
  const last = events[events.length - 1] as PawPrintsTriggerEntry;
  return `60s 内触发 ${events.length} 次，最近事件${last.eventId}`;
}
