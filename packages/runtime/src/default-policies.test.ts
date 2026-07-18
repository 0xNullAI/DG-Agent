import { describe, expect, it } from 'vitest';
import type { OpossumState } from '@dg-kit/protocol';
import type { ActionContext, OpossumCommand } from '@dg-agent/core';
import { createDefaultOpossumPolicyRules } from './default-policies.js';
import { OpossumPolicyEngine } from './policy-engine.js';

const context: ActionContext = {
  sessionId: 's1',
  sourceType: 'cli',
  traceId: 't1',
};

function state(overrides: Partial<OpossumState> = {}): OpossumState {
  return { connected: true, battery: 100, intensityA: 0, intensityB: 0, ...overrides };
}

describe('createDefaultOpossumPolicyRules', () => {
  it('denies every command when the device is disconnected', () => {
    const engine = new OpossumPolicyEngine(createDefaultOpossumPolicyRules());
    const command: OpossumCommand = { type: 'vibrateStart', channel: 'A', intensity: 5 };

    const decision = engine.evaluate({
      context,
      command,
      deviceState: state({ connected: false }),
    });

    expect(decision).toEqual({ type: 'deny', reason: '设备未连接' });
  });

  it('clamps a cold-start intensity above the default cap', () => {
    const engine = new OpossumPolicyEngine(createDefaultOpossumPolicyRules());
    const command: OpossumCommand = { type: 'vibrateStart', channel: 'A', intensity: 50 };

    const decision = engine.evaluate({ context, command, deviceState: state() });

    expect(decision.type).toBe('clamp');
    if (decision.type !== 'clamp') throw new Error('expected clamp');
    expect(decision.command).toMatchObject({ type: 'vibrateStart', intensity: 10 });
  });

  it('does not clamp a cold start at or below the cap', () => {
    const engine = new OpossumPolicyEngine(createDefaultOpossumPolicyRules());
    const command: OpossumCommand = { type: 'vibrateStart', channel: 'A', intensity: 10 };

    const decision = engine.evaluate({ context, command, deviceState: state() });

    expect(decision.type).toBe('require-confirm');
  });

  it('does not treat a start on an already-running channel as a cold start', () => {
    const engine = new OpossumPolicyEngine(createDefaultOpossumPolicyRules());
    const command: OpossumCommand = { type: 'vibrateStart', channel: 'A', intensity: 50 };

    const decision = engine.evaluate({ context, command, deviceState: state({ intensityA: 20 }) });

    // Cold-start rule doesn't apply once current > 0; falls through to permission-gate.
    expect(decision.type).toBe('require-confirm');
  });

  it('clamps an adjust step above the default cap, preserving sign', () => {
    const engine = new OpossumPolicyEngine(createDefaultOpossumPolicyRules());
    const positive: OpossumCommand = { type: 'vibrateAdjust', channel: 'A', delta: 25 };
    const negative: OpossumCommand = { type: 'vibrateAdjust', channel: 'A', delta: -25 };

    const positiveDecision = engine.evaluate({
      context,
      command: positive,
      deviceState: state({ intensityA: 30 }),
    });
    const negativeDecision = engine.evaluate({
      context,
      command: negative,
      deviceState: state({ intensityA: 30 }),
    });

    expect(positiveDecision.type).toBe('clamp');
    expect(negativeDecision.type).toBe('clamp');
    if (positiveDecision.type !== 'clamp' || negativeDecision.type !== 'clamp') {
      throw new Error('expected clamps');
    }
    expect(positiveDecision.command).toMatchObject({ delta: 10 });
    expect(negativeDecision.command).toMatchObject({ delta: -10 });
  });

  it('requires confirmation for vibrateStart/vibrateAdjust but not vibrateStop', () => {
    const engine = new OpossumPolicyEngine(createDefaultOpossumPolicyRules());

    const stop = engine.evaluate({
      context,
      command: { type: 'vibrateStop' },
      deviceState: state({ intensityA: 20 }),
    });
    const start = engine.evaluate({
      context,
      command: { type: 'vibrateStart', channel: 'A', intensity: 5 },
      deviceState: state(),
    });

    expect(stop.type).toBe('allow');
    expect(start.type).toBe('require-confirm');
  });

  it('honors custom maxColdStartIntensity / maxAdjustStep options', () => {
    const engine = new OpossumPolicyEngine(
      createDefaultOpossumPolicyRules({ maxColdStartIntensity: 25, maxAdjustStep: 3 }),
    );

    const start = engine.evaluate({
      context,
      command: { type: 'vibrateStart', channel: 'B', intensity: 25 },
      deviceState: state(),
    });
    expect(start.type).toBe('require-confirm');

    const adjust = engine.evaluate({
      context,
      command: { type: 'vibrateAdjust', channel: 'B', delta: 10 },
      deviceState: state({ intensityB: 5 }),
    });
    expect(adjust.type).toBe('clamp');
    if (adjust.type !== 'clamp') throw new Error('expected clamp');
    expect(adjust.command).toMatchObject({ delta: 3 });
  });
});
