import { describe, expect, it } from 'vitest';
import type { CivetPressureReading, PawPrintsReading } from '@dg-kit/protocol';
import type { CivetEdgingClient, PawPrintsClient } from './device-clients.js';
import { SensorTriggerEngine, type SensorFiredTrigger } from './sensor-trigger-engine.js';

class FakePawPrintsClient implements PawPrintsClient {
  private readonly listeners = new Set<(reading: PawPrintsReading) => void>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState() {
    return { connected: true };
  }
  subscribe(listener: (reading: PawPrintsReading) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onStateChanged(): () => void {
    return () => {};
  }

  emit(reading: PawPrintsReading): void {
    for (const listener of this.listeners) listener(reading);
  }
}

class FakeCivetEdgingClient implements CivetEdgingClient {
  private readonly listeners = new Set<(reading: CivetPressureReading) => void>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState() {
    return { connected: true };
  }
  subscribe(listener: (reading: CivetPressureReading) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onStateChanged(): () => void {
    return () => {};
  }

  emit(kPa: number): void {
    for (const listener of this.listeners) listener({ type: 'pressure', kPa });
  }
}

function createClock(startAt = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startAt;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('SensorTriggerEngine', () => {
  describe('paw-prints', () => {
    it('fires on a discrete trigger reading', () => {
      const pawPrints = new FakePawPrintsClient();
      const triggers: SensorFiredTrigger[] = [];
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        pawPrints,
        onTrigger: (t) => triggers.push(t),
      });

      pawPrints.emit({ type: 'trigger', eventId: 12, parameterValue: 3 });

      expect(triggers).toHaveLength(1);
      expect(triggers[0]?.deviceKind).toBe('paw-prints');
      expect(triggers[0]?.summary).toBe('按钮触发（事件12）');
      engine.dispose();
    });

    it('never fires on the 100ms physical data stream', () => {
      const pawPrints = new FakePawPrintsClient();
      const triggers: SensorFiredTrigger[] = [];
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        pawPrints,
        onTrigger: (t) => triggers.push(t),
      });

      for (let i = 0; i < 50; i++) {
        pawPrints.emit({
          type: 'physical',
          sequence: i,
          pressState: 0,
          acceleration: 10,
          angleX: 0,
          angleY: 0,
          angleZ: 0,
          extVoltage: 100,
        });
      }
      // Other non-trigger reading kinds shouldn't fire either.
      pawPrints.emit({ type: 'status', color: 1, deviceType: 2, battery: 90 });
      pawPrints.emit({ type: 'triggerCancel', eventId: 1 });
      pawPrints.emit({ type: 'parameterChange', eventId: 1, value: 5 });
      pawPrints.emit({
        type: 'autoDetectResult',
        xRange: [0, 1],
        yRange: [0, 1],
        zRange: [0, 1],
      });

      expect(triggers).toHaveLength(0);
      engine.dispose();
    });

    it('stops firing after dispose', () => {
      const pawPrints = new FakePawPrintsClient();
      const triggers: SensorFiredTrigger[] = [];
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        pawPrints,
        onTrigger: (t) => triggers.push(t),
      });

      engine.dispose();
      pawPrints.emit({ type: 'trigger', eventId: 1, parameterValue: 0 });

      expect(triggers).toHaveLength(0);
    });
  });

  describe('civet-edging', () => {
    it('does not fire on the very first reading (establishes baseline only)', () => {
      const civetEdging = new FakeCivetEdgingClient();
      const triggers: SensorFiredTrigger[] = [];
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        civetEdging,
        onTrigger: (t) => triggers.push(t),
      });

      civetEdging.emit(10);

      expect(triggers).toHaveLength(0);
      engine.dispose();
    });

    it('does not fire when the delta stays below the threshold', () => {
      const civetEdging = new FakeCivetEdgingClient();
      const triggers: SensorFiredTrigger[] = [];
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        civetEdging,
        civetPressureDeltaThresholdKPa: 2,
        onTrigger: (t) => triggers.push(t),
      });

      civetEdging.emit(10); // baseline
      civetEdging.emit(10.5);
      civetEdging.emit(11.4);
      civetEdging.emit(11.9);

      expect(triggers).toHaveLength(0);
      engine.dispose();
    });

    it('fires once a delta exceeding the threshold arrives (debounce window elapsed since -Infinity)', () => {
      const civetEdging = new FakeCivetEdgingClient();
      const triggers: SensorFiredTrigger[] = [];
      const clock = createClock(0);
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        civetEdging,
        civetPressureDeltaThresholdKPa: 2,
        debounceMs: 1500,
        now: clock.now,
        onTrigger: (t) => triggers.push(t),
      });

      civetEdging.emit(10); // baseline, no fire
      clock.advance(50);
      civetEdging.emit(12.5); // +2.5kPa, exceeds threshold, debounce trivially satisfied

      expect(triggers).toHaveLength(1);
      expect(triggers[0]?.deviceKind).toBe('civet-edging');
      expect(triggers[0]?.summary).toBe('气压变化 +2.5kPa（当前 12.5kPa）');
      engine.dispose();
    });

    it('a rapid stream of small deltas within the debounce window does NOT fire repeatedly', () => {
      const civetEdging = new FakeCivetEdgingClient();
      const triggers: SensorFiredTrigger[] = [];
      const clock = createClock(0);
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        civetEdging,
        civetPressureDeltaThresholdKPa: 2,
        debounceMs: 1500,
        now: clock.now,
        onTrigger: (t) => triggers.push(t),
      });

      civetEdging.emit(10); // baseline
      clock.advance(10);
      civetEdging.emit(12.5); // first qualifying delta -> fires
      expect(triggers).toHaveLength(1);

      // Keep climbing well past the threshold, but all within the debounce
      // window from the first fire — none of these should produce a second
      // trigger.
      for (let i = 0; i < 10; i++) {
        clock.advance(50);
        civetEdging.emit(12.5 + i * 3);
      }
      expect(triggers).toHaveLength(1);
      engine.dispose();
    });

    it('fires again once a qualifying delta arrives after the debounce window has elapsed', () => {
      const civetEdging = new FakeCivetEdgingClient();
      const triggers: SensorFiredTrigger[] = [];
      const clock = createClock(0);
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        civetEdging,
        civetPressureDeltaThresholdKPa: 2,
        debounceMs: 1500,
        now: clock.now,
        onTrigger: (t) => triggers.push(t),
      });

      civetEdging.emit(10); // baseline
      clock.advance(10);
      civetEdging.emit(12.5); // fires, surfaced baseline is now 12.5
      expect(triggers).toHaveLength(1);

      // Still within the debounce window: blocked even though delta qualifies.
      clock.advance(200);
      civetEdging.emit(15.0);
      expect(triggers).toHaveLength(1);

      // Debounce window (1500ms since the first fire) has now elapsed.
      clock.advance(1500);
      civetEdging.emit(18.0); // +3.0kPa from the still-12.5 surfaced baseline
      expect(triggers).toHaveLength(2);
      expect(triggers[1]?.summary).toContain('+5.5kPa');
      engine.dispose();
    });

    it('also fires on a large negative delta (pressure release)', () => {
      const civetEdging = new FakeCivetEdgingClient();
      const triggers: SensorFiredTrigger[] = [];
      const clock = createClock(0);
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        civetEdging,
        civetPressureDeltaThresholdKPa: 2,
        debounceMs: 1500,
        now: clock.now,
        onTrigger: (t) => triggers.push(t),
      });

      civetEdging.emit(20); // baseline
      clock.advance(10);
      civetEdging.emit(17); // -3kPa

      expect(triggers).toHaveLength(1);
      expect(triggers[0]?.summary).toBe('气压变化 -3.0kPa（当前 17.0kPa）');
      engine.dispose();
    });

    it('uses default threshold/debounce when not configured', () => {
      const civetEdging = new FakeCivetEdgingClient();
      const triggers: SensorFiredTrigger[] = [];
      const engine = new SensorTriggerEngine({
        sessionId: 's1',
        civetEdging,
        onTrigger: (t) => triggers.push(t),
      });

      civetEdging.emit(10); // baseline
      civetEdging.emit(11); // +1kPa, below default 2kPa threshold

      expect(triggers).toHaveLength(0);
      engine.dispose();
    });
  });

  it('carries the sessionId and firedAt through to the trigger payload', () => {
    const pawPrints = new FakePawPrintsClient();
    const triggers: SensorFiredTrigger[] = [];
    const clock = createClock(12345);
    const engine = new SensorTriggerEngine({
      sessionId: 'session-abc',
      pawPrints,
      now: clock.now,
      onTrigger: (t) => triggers.push(t),
    });

    pawPrints.emit({ type: 'trigger', eventId: 1, parameterValue: 0 });

    expect(triggers[0]?.sessionId).toBe('session-abc');
    expect(triggers[0]?.firedAt).toBe(12345);
    engine.dispose();
  });

  it('subscribes to both sensors independently and tracks their debounce state separately', () => {
    const pawPrints = new FakePawPrintsClient();
    const civetEdging = new FakeCivetEdgingClient();
    const triggers: SensorFiredTrigger[] = [];
    const engine = new SensorTriggerEngine({
      sessionId: 's1',
      pawPrints,
      civetEdging,
      onTrigger: (t) => triggers.push(t),
    });

    civetEdging.emit(10); // baseline, no fire
    pawPrints.emit({ type: 'trigger', eventId: 1, parameterValue: 0 }); // fires
    civetEdging.emit(13); // +3kPa, exceeds default 2kPa threshold, fires

    expect(triggers).toHaveLength(2);
    expect(triggers.map((t) => t.deviceKind).sort()).toEqual(['civet-edging', 'paw-prints']);
    engine.dispose();
  });
});
