import { describe, expect, it } from 'vitest';
import {
  createCivetPressureBuffer,
  createPawPrintsTriggerBuffer,
  SensorReadingBuffer,
  summarizeCivetPressure,
  summarizePawPrintsTriggers,
} from './sensor-reading-buffer.js';

describe('SensorReadingBuffer', () => {
  it('evicts entries older than the window', () => {
    let now = 0;
    const buffer = new SensorReadingBuffer<number>({
      windowMs: 1000,
      maxEntries: 100,
      now: () => now,
    });

    buffer.record(1, 0);
    buffer.record(2, 500);
    now = 1200;
    buffer.record(3, 1200);

    // The entry at t=0 is now 1200ms old (> 1000ms window) and should be
    // evicted; t=500 (700ms old) and t=1200 remain.
    expect(buffer.windowEntries(1200)).toEqual([2, 3]);
  });

  it('caps entry count independent of age via maxEntries', () => {
    const buffer = new SensorReadingBuffer<number>({
      windowMs: 1_000_000,
      maxEntries: 3,
      now: () => 0,
    });

    buffer.record(1, 0);
    buffer.record(2, 0);
    buffer.record(3, 0);
    buffer.record(4, 0);

    expect(buffer.windowEntries(0)).toEqual([2, 3, 4]);
  });

  it('windowEntries evicts as of the query time even without a new record()', () => {
    const buffer = new SensorReadingBuffer<number>({
      windowMs: 100,
      maxEntries: 100,
      now: () => 0,
    });
    buffer.record(1, 0);

    expect(buffer.windowEntries(50)).toEqual([1]);
    expect(buffer.windowEntries(150)).toEqual([]);
  });
});

describe('summarizeCivetPressure', () => {
  it('returns null for an empty window', () => {
    expect(summarizeCivetPressure([])).toBeNull();
  });

  it('reports current value and min/max across the window', () => {
    const summary = summarizeCivetPressure([10, 12, 8, 11]);
    expect(summary).toContain('当前 11.0kPa');
    expect(summary).toContain('8.0~12.0kPa');
  });

  it('classifies a rising trend from first-third vs last-third averages', () => {
    // First third ~10, last third ~20 — well past the 2kPa flat threshold.
    const samples = [10, 10, 10, 15, 15, 20, 20, 20];
    expect(summarizeCivetPressure(samples)).toContain('趋势上升');
  });

  it('classifies a falling trend', () => {
    const samples = [20, 20, 20, 15, 15, 10, 10, 10];
    expect(summarizeCivetPressure(samples)).toContain('趋势下降');
  });

  it('classifies small fluctuation as flat rather than a trend', () => {
    const samples = [10, 10.5, 10, 9.5, 10, 10.5, 10, 9.8];
    expect(summarizeCivetPressure(samples)).toContain('趋势平稳');
  });

  it('treats fewer than 3 samples as flat (not enough data for a trend)', () => {
    expect(summarizeCivetPressure([10, 20])).toContain('趋势平稳');
  });
});

describe('summarizePawPrintsTriggers', () => {
  it('returns null for an empty window', () => {
    expect(summarizePawPrintsTriggers([])).toBeNull();
  });

  it('reports count and most recent event id', () => {
    const summary = summarizePawPrintsTriggers([{ eventId: 1 }, { eventId: 2 }, { eventId: 5 }]);
    expect(summary).toBe('60s 内触发 3 次，最近事件5');
  });
});

describe('createCivetPressureBuffer / createPawPrintsTriggerBuffer', () => {
  it('civet buffer feeds a plausible summary end to end', () => {
    let now = 0;
    const buffer = createCivetPressureBuffer(() => now);
    for (const kPa of [10, 11, 12, 13, 14]) {
      buffer.record(kPa, now);
      now += 100;
    }
    expect(summarizeCivetPressure(buffer.windowEntries(now))).toContain('当前 14.0kPa');
  });

  it('paw-prints buffer feeds a plausible summary end to end', () => {
    let now = 0;
    const buffer = createPawPrintsTriggerBuffer(() => now);
    buffer.record({ eventId: 1 }, now);
    now += 1000;
    buffer.record({ eventId: 2 }, now);
    expect(summarizePawPrintsTriggers(buffer.windowEntries(now))).toBe(
      '60s 内触发 2 次，最近事件2',
    );
  });
});
